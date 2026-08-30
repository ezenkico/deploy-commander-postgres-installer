import type {
  RPCCaller,
  RPC,
} from '@ezenki/deploy-commander-installer-interface';
import type { AdminCredentials } from './credentials';

export type PrimaryPhase =
  | 'install-prepared'
  | 'install-running'
  | 'install-failed'
  | 'ready'
  | 'teardown-running'
  | 'teardown-failed';

export interface PrimaryState {
  phase: PrimaryPhase;
  operationId: string;
  credentials: AdminCredentials;
  runId: string | null;
  resourceId: string | null;
  initializedAt: string | null;
  updatedAt: string;
}

export interface PrimaryStateTransition {
  phase: PrimaryPhase;
  runId?: string | null;
  resourceId?: string | null;
  initializedAt?: string | null;
  updatedAt?: string;
}

type TransitionInput = PrimaryPhase | PrimaryStateTransition | PrimaryState;
type UnknownRecord = Record<string, unknown>;

const RESOURCE_PAGE_LIMIT = 50;
const CREATE_QUERY = `CREATE postgres_state:primary CONTENT {
  phase: $phase, operation_id: $operation_id,
  admin_username: $admin_username, admin_password: $admin_password,
  run_id: $run_id, resource_id: $resource_id,
  initialized_at: $initialized_at, updated_at: $updated_at
} RETURN VALUE operation_id;`;
const UPDATE_QUERY = 'UPDATE postgres_state:primary SET phase = $next_phase, run_id = $run_id, resource_id = $resource_id, initialized_at = $initialized_at, updated_at = $updated_at WHERE operation_id = $operation_id AND phase = $expected_phase RETURN VALUE operation_id;';
const DELETE_QUERY = 'DELETE postgres_state:primary WHERE operation_id = $operation_id RETURN VALUE operation_id;';
const READ_QUERY = 'SELECT phase, operation_id, admin_username, admin_password, run_id, resource_id, initialized_at, updated_at FROM postgres_state:primary;';

const LEGAL_TRANSITIONS: Readonly<Record<PrimaryPhase, readonly PrimaryPhase[]>> = {
  'install-prepared': ['install-running', 'install-failed'],
  'install-running': ['ready', 'install-failed'],
  'install-failed': ['teardown-running'],
  ready: ['teardown-running'],
  'teardown-running': ['teardown-failed'],
  'teardown-failed': ['teardown-running'],
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isNonBlankString(value);
}

function isPrimaryPhase(value: unknown): value is PrimaryPhase {
  return value === 'install-prepared'
    || value === 'install-running'
    || value === 'install-failed'
    || value === 'ready'
    || value === 'teardown-running'
    || value === 'teardown-failed';
}

function assertOperationId(operationId: unknown): asserts operationId is string {
  if (!isNonBlankString(operationId)) {
    throw new Error('Invalid primary state operation');
  }
}

function assertState(state: unknown): asserts state is PrimaryState {
  if (!isRecord(state)
    || !isPrimaryPhase(state.phase)
    || !isNonBlankString(state.operationId)
    || !isRecord(state.credentials)
    || !isNonBlankString(state.credentials.username)
    || !isNonBlankString(state.credentials.password)
    || !isNullableString(state.runId)
    || !isNullableString(state.resourceId)
    || !isNullableString(state.initializedAt)
    || !isNonBlankString(state.updatedAt)) {
    throw new Error('Invalid primary state');
  }
}

function parseStoredState(value: unknown): PrimaryState | null {
  if (!Array.isArray(value)) {
    throw new Error('Invalid primary state result');
  }
  if (value.length === 0) {
    return null;
  }
  if (value.length !== 1 || !isRecord(value[0])) {
    throw new Error('Invalid primary state result');
  }

  const record = value[0];
  if (!isPrimaryPhase(record.phase)
    || !isNonBlankString(record.operation_id)
    || !isNonBlankString(record.admin_username)
    || !isNonBlankString(record.admin_password)
    || !isNullableString(record.run_id)
    || !isNullableString(record.resource_id)
    || !isNullableString(record.initialized_at)
    || !isNonBlankString(record.updated_at)) {
    throw new Error('Invalid primary state result');
  }

  return {
    phase: record.phase,
    operationId: record.operation_id,
    credentials: {
      username: record.admin_username,
      password: record.admin_password,
    },
    runId: record.run_id,
    resourceId: record.resource_id,
    initializedAt: record.initialized_at,
    updatedAt: record.updated_at,
  };
}

async function runQuery(caller: RPCCaller, query: string, bindings: Record<string, unknown>): Promise<unknown> {
  let response: unknown;
  try {
    response = await caller.databaseQuery(query, bindings);
  } catch {
    throw new Error('Primary state database operation failed');
  }

  if (!isRecord(response)
    || !Array.isArray(response.results)
    || response.results.length !== 1
    || !isRecord(response.results[0])
    || response.results[0].statement !== 0
    || !Object.prototype.hasOwnProperty.call(response.results[0], 'result')) {
    throw new Error('Invalid primary state database result');
  }
  return response.results[0].result;
}

function assertMutationResult(result: unknown, operationId: string): void {
  if (Array.isArray(result) && result.length === 0) {
    throw new Error('Primary state ownership was lost');
  }
  if (!Array.isArray(result) || result.length !== 1 || result[0] !== operationId) {
    throw new Error('Invalid primary state mutation result');
  }
}

function transitionValues(next: TransitionInput): {
  phase: PrimaryPhase;
  runId: string | null;
  resourceId: string | null;
  initializedAt: string | null;
  updatedAt: string;
} {
  if (typeof next === 'string') {
    if (!isPrimaryPhase(next)) {
      throw new Error('Invalid primary state transition');
    }
    return {
      phase: next,
      runId: null,
      resourceId: null,
      initializedAt: null,
      updatedAt: new Date().toISOString(),
    };
  }

  if (!isRecord(next) || !isPrimaryPhase(next.phase)) {
    throw new Error('Invalid primary state transition');
  }
  const runId = next.runId === undefined ? null : next.runId;
  const resourceId = next.resourceId === undefined ? null : next.resourceId;
  const initializedAt = next.initializedAt === undefined ? null : next.initializedAt;
  const updatedAt = next.updatedAt === undefined ? new Date().toISOString() : next.updatedAt;
  if (!isNullableString(runId)
    || !isNullableString(resourceId)
    || !isNullableString(initializedAt)
    || !isNonBlankString(updatedAt)) {
    throw new Error('Invalid primary state transition');
  }
  return { phase: next.phase, runId, resourceId, initializedAt, updatedAt };
}

export async function readPrimaryState(caller: RPCCaller): Promise<PrimaryState | null> {
  return parseStoredState(await runQuery(caller, READ_QUERY, {}));
}

export async function createPrimaryState(caller: RPCCaller, state: PrimaryState): Promise<void> {
  assertState(state);
  const result = await runQuery(caller, CREATE_QUERY, {
    phase: state.phase,
    operation_id: state.operationId,
    admin_username: state.credentials.username,
    admin_password: state.credentials.password,
    run_id: state.runId,
    resource_id: state.resourceId,
    initialized_at: state.initializedAt,
    updated_at: state.updatedAt,
  });
  assertMutationResult(result, state.operationId);
}

export async function transitionPrimaryState(
  caller: RPCCaller,
  operationId: string,
  expectedPhase: PrimaryPhase,
  next: TransitionInput,
): Promise<void> {
  assertOperationId(operationId);
  if (!isPrimaryPhase(expectedPhase)) {
    throw new Error('Invalid primary state transition');
  }
  const values = transitionValues(next);
  if (!LEGAL_TRANSITIONS[expectedPhase].includes(values.phase)) {
    throw new Error('Invalid primary state transition');
  }
  const result = await runQuery(caller, UPDATE_QUERY, {
    next_phase: values.phase,
    run_id: values.runId,
    resource_id: values.resourceId,
    initialized_at: values.initializedAt,
    updated_at: values.updatedAt,
    operation_id: operationId,
    expected_phase: expectedPhase,
  });
  assertMutationResult(result, operationId);
}

export async function deletePrimaryState(caller: RPCCaller, operationId: string): Promise<void> {
  assertOperationId(operationId);
  const result = await runQuery(caller, DELETE_QUERY, { operation_id: operationId });
  assertMutationResult(result, operationId);
}

function validateResource(value: unknown): value is RPC.ResourceItem {
  return isRecord(value)
    && isNonBlankString(value.id)
    && isNonBlankString(value.type)
    && isNonBlankString(value.name)
    && typeof value.external === 'boolean';
}

function validateResourcePage(value: unknown): { items: RPC.ResourceItem[]; limit: number; offset: number; total: number } {
  if (!isRecord(value) || !Array.isArray(value.items) || !value.items.every(validateResource)) {
    throw new Error('Invalid PostgreSQL resource response');
  }
  const { limit, offset, total } = value;
  if (!Number.isSafeInteger(limit) || limit <= 0
    || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(total) || total < 0) {
    throw new Error('Invalid PostgreSQL resource response');
  }
  return {
    items: value.items,
    limit,
    offset,
    total,
  };
}

export async function findPrimaryResource(caller: RPCCaller): Promise<RPC.ResourceItem | null> {
  const matches: RPC.ResourceItem[] = [];
  let offset = 0;

  while (true) {
    let response: unknown;
    try {
      response = await caller.getMyResources('postgres', false, RESOURCE_PAGE_LIMIT, offset);
    } catch {
      throw new Error('PostgreSQL resource lookup failed');
    }
    const page = validateResourcePage(response);
    for (const resource of page.items) {
      if (!resource.external && resource.type === 'postgres' && resource.name === 'postgres') {
        matches.push(resource);
      }
    }

    if (page.items.length === 0 || offset + page.items.length >= page.total) {
      break;
    }
    offset += page.limit;
  }

  return matches.length === 1 ? matches[0] : null;
}
