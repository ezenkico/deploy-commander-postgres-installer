import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import type { LogicalCredentials } from './credentials';
import { buildConnectionMetadata, buildProvisionPlan } from './postgresPlans';
import { isPermissionRemembered, rememberPermission } from './permissionPreference';
import {
  acquireOperation,
  deleteOperation,
  transitionOperation,
  type ConnectionOperation,
  type OperationRecord,
} from './provisioningJournal';
import { parsePlatformConnection, type PlatformConnection } from './postgresContracts';
import type { PrimaryState } from './primaryState';
import type { RunEventSource, WaitOptions } from './runMonitor';

export type ReadyPrimaryState = PrimaryState & {
  phase: 'ready';
  resourceId: string;
};

export interface ConnectionRequest {
  currentManagerId: string;
  callingManagerId: string;
  resource: RPC.ResourceItem;
  platform: PlatformConnection;
  primary: ReadyPrimaryState;
}

export interface PermissionDecision {
  allowed: boolean;
  remember: boolean;
}

export interface ConnectionWorkflowDeps {
  caller: RPCCaller;
  events: RunEventSource;
  storage: Storage;
  requestPermission: () => Promise<PermissionDecision>;
  generateCredentials: () => LogicalCredentials;
  waitForRun: (
    caller: RPCCaller,
    events: RunEventSource,
    runId: string,
    options: WaitOptions,
  ) => Promise<RPC.GetRun>;
  signal: AbortSignal;
}

const PAGE_LIMIT = 50;
const RUNNER_IMAGE = 'ezenki/deploy-commander-runner:latest';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidConnection(): Error {
  return new Error('Invalid PostgreSQL connection response');
}

function assertRequest(request: ConnectionRequest): PlatformConnection {
  if (!isNonBlank(request.currentManagerId) || !isNonBlank(request.callingManagerId)) {
    throw new Error('A calling manager is required');
  }
  if (!isRecord(request.resource)
    || !isNonBlank(request.resource.id)
    || !isNonBlank(request.resource.type)
    || !isNonBlank(request.resource.name)
    || request.resource.type !== 'postgres'
    || request.resource.name !== 'postgres'
    || request.resource.external !== false) {
    throw new Error('Invalid PostgreSQL resource');
  }
  if (!isRecord(request.primary)
    || request.primary.phase !== 'ready'
    || !isNonBlank(request.primary.resourceId)
    || request.primary.resourceId !== request.resource.id) {
    throw new Error('Invalid ready PostgreSQL state');
  }
  return parsePlatformConnection(request.platform);
}

function abortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('Connection request aborted', 'AbortError');
  const error = new Error('Connection request aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function operationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('Secure operation identifiers are unavailable');
}

function validateSummary(value: unknown, callingManagerId: string, resourceId: string): value is RPC.ConnectionItem {
  return isRecord(value)
    && isNonBlank(value.id)
    && isNonBlank(value.manager)
    && isNonBlank(value.resource)
    && value.manager === callingManagerId
    && value.resource === resourceId
    && value.external === false
    && isNonBlank(value.created_at)
    && isNonBlank(value.updated_at);
}

function validatePage(value: unknown): { items: RPC.ConnectionItem[]; limit: number; offset: number; total: number } {
  if (!isRecord(value) || !Array.isArray(value.items) || !value.items.every((item) => isRecord(item))) {
    throw invalidConnection();
  }
  if (typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) || value.limit <= 0
    || typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0
    || typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < 0) {
    throw invalidConnection();
  }
  return {
    items: value.items as unknown as RPC.ConnectionItem[],
    limit: value.limit,
    offset: value.offset,
    total: value.total,
  };
}

function validateFullConnection(value: unknown, summary: RPC.ConnectionItem, callingManagerId: string, resourceId: string): RPC.CreateConnection {
  if (!isRecord(value) || !isRecord(value.connection) || !isRecord(value.config)
    || !validateSummary(value.connection, callingManagerId, resourceId)) {
    throw invalidConnection();
  }
  const config = value.config;
  if (!isNonBlank(config.id) || !isNonBlank(config.manager) || !isNonBlank(config.resource)
    || config.id !== summary.id || config.manager !== callingManagerId || config.resource !== resourceId) {
    throw invalidConnection();
  }
  return value as unknown as RPC.CreateConnection;
}

/** Find and validate the caller-owned, non-external connection for a resource. */
export async function findExistingConnection(
  caller: RPCCaller,
  callingManagerId: string,
  resourceId: string,
): Promise<RPC.CreateConnection | null> {
  if (!isNonBlank(callingManagerId) || !isNonBlank(resourceId)) throw invalidConnection();
  let offset = 0;
  while (true) {
    let response: unknown;
    try {
      response = await caller.getConnections(PAGE_LIMIT, offset, callingManagerId, resourceId);
    } catch {
      throw new Error('PostgreSQL connection lookup failed');
    }
    const page = validatePage(response);
    for (const summary of page.items) {
      if (!validateSummary(summary, callingManagerId, resourceId)) throw invalidConnection();
      let full: unknown;
      try {
        full = await caller.getConnection(summary.id);
      } catch {
        throw new Error('PostgreSQL connection lookup failed');
      }
      return validateFullConnection(full, summary, callingManagerId, resourceId);
    }
    if (page.items.length === 0 || offset + page.items.length >= page.total) return null;
    offset += page.limit;
  }
}

function makeOperation(request: ConnectionRequest, credentials: LogicalCredentials): ConnectionOperation {
  const now = new Date().toISOString();
  return {
    kind: 'connection',
    operationId: operationId(),
    callerId: request.callingManagerId,
    resourceId: request.resource.id,
    database: credentials.database,
    username: credentials.username,
    phase: 'prepared',
    cleanupReason: null,
    provisionRunId: null,
    cleanupRunId: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function discardOperation(caller: RPCCaller, operation: OperationRecord): Promise<void> {
  try {
    await deleteOperation(caller, operation.operationId);
  } catch {
    // The original validation error is more useful and lock recovery handles stale state.
  }
}

function isPermissionDecision(value: unknown): value is PermissionDecision {
  return isRecord(value) && typeof value.allowed === 'boolean' && typeof value.remember === 'boolean';
}

export async function createPostgresConnection(
  deps: ConnectionWorkflowDeps,
  request: ConnectionRequest,
): Promise<RPC.CreateConnection> {
  throwIfAborted(deps.signal);
  const platform = assertRequest(request);
  throwIfAborted(deps.signal);

  const existing = await findExistingConnection(deps.caller, request.callingManagerId, request.resource.id);
  if (existing) return existing;
  throwIfAborted(deps.signal);

  let allowed = isPermissionRemembered(deps.storage, request.currentManagerId, request.resource.id);
  if (!allowed) {
    const decision: unknown = await deps.requestPermission();
    if (!isPermissionDecision(decision)) throw new Error('Invalid permission decision');
    allowed = decision.allowed;
    if (!allowed) throw new Error('Database access was cancelled');
    if (decision.remember) rememberPermission(deps.storage, request.currentManagerId, request.resource.id);
  }
  throwIfAborted(deps.signal);

  const credentials = deps.generateCredentials();
  const operation = makeOperation(request, credentials);
  // Generated credentials are local values and are deliberately not attached to errors.
  await acquireOperation(deps.caller, operation);

  // Revalidate the caller-provided ready identity after taking the manager-wide lock.
  const revalidatedPlatform = assertRequest(request);
  if (revalidatedPlatform.data.network !== platform.data.network) {
    await discardOperation(deps.caller, operation);
    throw new Error('Invalid ready PostgreSQL state');
  }
  const plan = buildProvisionPlan(request.primary, credentials, revalidatedPlatform);
  await transitionOperation(deps.caller, operation.operationId, 'prepared', 'provision-starting');
  const started = await deps.caller.start(
    'create-connection',
    RUNNER_IMAGE,
    plan,
    `postgres-provision:${operation.operationId}`,
  );
  if (!isRecord(started) || !isNonBlank(started.id)) throw new Error('Invalid provisioning run response');
  await transitionOperation(deps.caller, operation.operationId, 'provision-starting', {
    phase: 'provision-running', provisionRunId: started.id,
  });
  await deps.waitForRun(deps.caller, deps.events, started.id, { signal: deps.signal });
  await transitionOperation(deps.caller, operation.operationId, 'provision-running', 'provisioned');

  await transitionOperation(deps.caller, operation.operationId, 'provisioned', 'persisting');
  const raced = await findExistingConnection(deps.caller, request.callingManagerId, request.resource.id);
  if (raced) {
    await discardOperation(deps.caller, operation);
    return raced;
  }
  const created = await deps.caller.createConnection(
    buildConnectionMetadata(credentials),
    request.callingManagerId,
    false,
    request.resource.id,
  );
  try {
    await deleteOperation(deps.caller, operation.operationId);
  } catch {
    // The connection is authoritative; a later duplicate check can clear stale journal state.
  }
  return created;
}
