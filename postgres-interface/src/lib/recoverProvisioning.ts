import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import { findExistingConnection, type ConnectionWorkflowDeps, type ReadyPrimaryState } from './createPostgresConnection';
import { buildCleanupPlan } from './postgresPlans';
import {
  deleteOperation,
  readOperation,
  transitionOperation,
  type ConnectionOperation,
} from './provisioningJournal';
import type { PlatformConnection } from './postgresContracts';

const PAGE_LIMIT = 50;
const RUNNER_IMAGE = 'ezenki/deploy-commander-runner:latest';
const STATUS_QUEUED = 0;
const STATUS_RUNNING = 1;
const STATUS_DONE = 2;
const STATUS_FAILED = 3;

export interface ProvisioningRecoveryDeps extends Pick<ConnectionWorkflowDeps, 'caller' | 'events' | 'waitForRun' | 'signal'> {
  primary: ReadyPrimaryState;
  platform: PlatformConnection;
}

export type ProvisioningRecoveryResult =
  | { kind: 'retry' }
  | { kind: 'busy' }
  | { kind: 'connection'; value: RPC.CreateConnection };

/** Call-site adapter for boot/connection mode: recover the persisted journal
 * before the caller generates credentials or starts a new operation. */
export async function recoverJournalOperation(
  deps: ProvisioningRecoveryDeps,
): Promise<ProvisioningRecoveryResult | null> {
  let operation;
  try {
    operation = await readOperation(deps.caller);
  } catch {
    throw recoveryError();
  }
  if (operation === null) return null;
  if (operation.kind !== 'connection') return { kind: 'busy' };
  return recoverProvisioning(deps, operation);
}

export class RecoveryRequiredError extends Error {
  constructor() {
    super('PostgreSQL recovery is required');
    this.name = 'RecoveryRequiredError';
  }
}

type RunMatch = { kind: 'absent' } | { kind: 'ambiguous' } | { kind: 'found'; id: string };
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validLogicalIdentifier(value: unknown, prefix: 'db' | 'pg_user'): value is string {
  const pattern = prefix === 'db' ? /^db_[0-9a-f]{32}$/ : /^pg_user_[0-9a-f]{32}$/;
  return typeof value === 'string' && pattern.test(value);
}

function recoveryError(): RecoveryRequiredError {
  return new RecoveryRequiredError();
}

function validatePage(value: unknown, offset: number): { items: UnknownRecord[]; limit: number; total: number } {
  if (!isRecord(value) || !Array.isArray(value.items) || !value.items.every(isRecord)
    || typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) || value.limit <= 0
    || typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset !== offset
    || typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < 0
    || value.items.length > value.limit || value.items.length > value.total
    || value.offset > value.total || value.offset + value.items.length > value.total
    || (value.items.length === 0 && value.total > 0)
    || (value.items.length < value.limit && value.offset + value.items.length < value.total)) {
    throw recoveryError();
  }
  return { items: value.items, limit: value.limit, total: value.total };
}

/** Exhaustively finds exactly one accepted run for the operation's immutable note. */
export async function findCorrelatedRun(caller: RPCCaller, action: string, note: string): Promise<RunMatch> {
  let offset = 0;
  const matches: string[] = [];
  while (true) {
    let response: unknown;
    try {
      response = await caller.getRuns(undefined, undefined, undefined, undefined, PAGE_LIMIT, offset);
    } catch {
      throw recoveryError();
    }
    const page = validatePage(response, offset);
    for (const item of page.items) {
      if (item.action === action && item.note === note) {
        if (!nonBlank(item.id)) throw recoveryError();
        matches.push(item.id);
      }
    }
    if (page.items.length === 0 || offset + page.items.length >= page.total) break;
    offset += page.limit;
  }
  if (matches.length === 0) return { kind: 'absent' };
  if (matches.length !== 1) return { kind: 'ambiguous' };
  return { kind: 'found', id: matches[0] };
}

async function runStatus(caller: RPCCaller, runId: string): Promise<number> {
  let result: unknown;
  try {
    result = await caller.getRun(runId);
  } catch {
    throw recoveryError();
  }
  if (!isRecord(result) || !isRecord(result.run) || result.run.id !== runId
    || (result.run.status !== STATUS_QUEUED && result.run.status !== STATUS_RUNNING
      && result.run.status !== STATUS_DONE && result.run.status !== STATUS_FAILED)) {
    throw recoveryError();
  }
  return result.run.status;
}

async function monitoredStatus(
  deps: ProvisioningRecoveryDeps,
  runId: string,
): Promise<number> {
  const status = await runStatus(deps.caller, runId);
  if (status !== STATUS_QUEUED && status !== STATUS_RUNNING) return status;
  let result: unknown;
  try {
    result = await deps.waitForRun(deps.caller, deps.events, runId, { signal: deps.signal });
  } catch (error) {
    if (isRecord(error) && error.status === STATUS_FAILED) return STATUS_FAILED;
    throw recoveryError();
  }
  if (!isRecord(result) || !isRecord(result.run) || result.run.id !== runId
    || (result.run.status !== STATUS_DONE && result.run.status !== STATUS_FAILED)) {
    throw recoveryError();
  }
  return result.run.status;
}

async function existingConnection(
  deps: ProvisioningRecoveryDeps,
  operation: ConnectionOperation,
): Promise<RPC.CreateConnection | null> {
  try {
    return await findExistingConnection(deps.caller, operation.callerId, operation.resourceId);
  } catch {
    throw recoveryError();
  }
}

function connectionBelongsToOperation(
  value: RPC.CreateConnection,
  operation: ConnectionOperation,
): boolean {
  if (!isRecord(value) || !isRecord(value.config) || !isRecord(value.config.metadata)) return false;
  return value.config.metadata.database === operation.database
    && value.config.metadata.username === operation.username;
}

async function clearLock(deps: ProvisioningRecoveryDeps, operation: ConnectionOperation): Promise<void> {
  try {
    await deleteOperation(deps.caller, operation.operationId);
  } catch {
    // A confirmed connection/cleanup is authoritative; retain only a stale lock.
  }
}

async function cleanupRun(
  deps: ProvisioningRecoveryDeps,
  operation: ConnectionOperation,
): Promise<ProvisioningRecoveryResult> {
  if (operation.phase === 'cleanup-required') {
    try {
      await transitionOperation(deps.caller, operation.operationId, 'cleanup-required', 'cleanup-starting');
    } catch {
      throw recoveryError();
    }
  }

  let cleanupRunId = operation.cleanupRunId;
  if (!cleanupRunId) {
    const note = `postgres-cleanup:${operation.operationId}`;
    let started: unknown;
    try {
      started = await deps.caller.start(
        'cleanup-connection', RUNNER_IMAGE,
        buildCleanupPlan(deps.primary, operation.database, operation.username, deps.platform), note,
      );
    } catch {
      const match = await findCorrelatedRun(deps.caller, 'cleanup-connection', note);
      if (match.kind === 'ambiguous') return { kind: 'busy' };
      if (match.kind === 'absent') {
        try {
          await transitionOperation(deps.caller, operation.operationId, 'cleanup-starting', {
            phase: 'cleanup-required', cleanupRunId: null,
          });
        } catch { throw recoveryError(); }
        return { kind: 'busy' };
      }
      cleanupRunId = match.id;
    }
    if (!cleanupRunId && isRecord(started) && nonBlank(started.id)) cleanupRunId = started.id;
    if (!cleanupRunId) {
      const match = await findCorrelatedRun(deps.caller, 'cleanup-connection', note);
      if (match.kind === 'found') cleanupRunId = match.id;
      else if (match.kind === 'ambiguous') return { kind: 'busy' };
      else {
        try {
          await transitionOperation(deps.caller, operation.operationId, 'cleanup-starting', {
            phase: 'cleanup-required', cleanupRunId: null,
          });
        } catch { throw recoveryError(); }
        return { kind: 'busy' };
      }
    }
    try {
      await transitionOperation(deps.caller, operation.operationId, 'cleanup-starting', {
        phase: 'cleanup-running', cleanupRunId,
      });
    } catch {
      // A failed CAS is safe to reconcile through the recorded run below.
    }
  }

  let status: number;
  try {
    status = await monitoredStatus(deps, cleanupRunId);
  } catch (error) {
    try {
      await transitionOperation(deps.caller, operation.operationId, 'cleanup-running', {
        phase: 'cleanup-required', cleanupRunId: null,
      });
    } catch {
      throw recoveryError();
    }
    throw error;
  }
  if (status === STATUS_FAILED) {
    try {
      await transitionOperation(deps.caller, operation.operationId, 'cleanup-running', {
        phase: 'cleanup-required', cleanupRunId: null,
      });
    } catch { throw recoveryError(); }
    return { kind: 'busy' };
  }
  await clearLock(deps, operation);
  return { kind: 'retry' };
}

async function moveProvisionToCleanup(
  deps: ProvisioningRecoveryDeps,
  operation: ConnectionOperation,
  failed = false,
): Promise<ProvisioningRecoveryResult> {
  try {
    if (failed && operation.phase === 'provision-running') {
      await transitionOperation(deps.caller, operation.operationId, 'provision-running', {
        phase: 'cleanup-required', cleanupReason: operation.cleanupReason ?? 'provision-failed',
      });
      return cleanupRun(deps, { ...operation, phase: 'cleanup-required', cleanupRunId: null });
    } else if (operation.phase === 'provision-running') {
      await transitionOperation(deps.caller, operation.operationId, 'provision-running', 'provisioned');
      await transitionOperation(deps.caller, operation.operationId, 'provisioned', 'persisting');
      await transitionOperation(deps.caller, operation.operationId, 'persisting', 'reconciliation-required');
    } else if (operation.phase === 'provisioned') {
      await transitionOperation(deps.caller, operation.operationId, 'provisioned', 'persisting');
      await transitionOperation(deps.caller, operation.operationId, 'persisting', 'reconciliation-required');
    } else if (operation.phase === 'persisting') {
      await transitionOperation(deps.caller, operation.operationId, 'persisting', 'reconciliation-required');
    }
    await transitionOperation(deps.caller, operation.operationId, 'reconciliation-required', {
      phase: 'cleanup-required', cleanupReason: operation.cleanupReason ?? 'provision-failed',
    });
  } catch {
    throw recoveryError();
  }
  return cleanupRun({ ...deps }, { ...operation, phase: 'cleanup-required', cleanupRunId: null });
}

export async function recoverProvisioning(
  deps: ProvisioningRecoveryDeps,
  operation: ConnectionOperation,
): Promise<ProvisioningRecoveryResult> {
  if (!operation || operation.kind !== 'connection' || !nonBlank(operation.operationId)
    || !nonBlank(operation.callerId) || !nonBlank(operation.resourceId)
    || !validLogicalIdentifier(operation.database, 'db')
    || !validLogicalIdentifier(operation.username, 'pg_user')) throw recoveryError();

  const existing = await existingConnection(deps, operation);
  if (existing) {
    // A stale lock may not be released on the strength of a connection that
    // belongs to a different logical database/role. Keep the lock for its own
    // recovery instead of deleting another operation's journal.
    if (connectionBelongsToOperation(existing, operation)) {
      await clearLock(deps, operation);
      return { kind: 'connection', value: existing };
    }
    if (operation.phase === 'provision-running' || operation.phase === 'provision-starting') {
      return { kind: 'busy' };
    }
  }

  if (operation.phase === 'prepared') {
    await clearLock(deps, operation);
    return { kind: 'retry' };
  }

  if (operation.phase === 'provision-starting') {
    const match = await findCorrelatedRun(deps.caller, 'create-connection', `postgres-provision:${operation.operationId}`);
    if (match.kind === 'ambiguous') return { kind: 'busy' };
    if (match.kind === 'absent') {
      await clearLock(deps, operation);
      return { kind: 'retry' };
    }
    try {
      await transitionOperation(deps.caller, operation.operationId, 'provision-starting', {
        phase: 'provision-running', provisionRunId: match.id,
      });
    } catch {
      throw recoveryError();
    }
    operation = { ...operation, phase: 'provision-running', provisionRunId: match.id };
  }

  if (operation.phase === 'provision-running') {
    if (!operation.provisionRunId) throw recoveryError();
    const status = await runStatus(deps.caller, operation.provisionRunId);
    // A provision run is deliberately left alone while queued/running. A later
    // invocation (or the host's run event) can resume it without compensating
    // against a database that may still be coming up.
    if (status === STATUS_QUEUED || status === STATUS_RUNNING) return { kind: 'busy' };
    return moveProvisionToCleanup(deps, operation, status === STATUS_FAILED);
  }

  if (operation.phase === 'provisioned' || operation.phase === 'persisting' || operation.phase === 'reconciliation-required') {
    if (operation.phase === 'reconciliation-required') {
      try {
        const raced = await findExistingConnection(deps.caller, operation.callerId, operation.resourceId);
        if (raced && connectionBelongsToOperation(raced, operation)) {
          await clearLock(deps, operation);
          return { kind: 'connection', value: raced };
        }
      } catch { throw recoveryError(); }
    }
    return moveProvisionToCleanup(deps, operation);
  }

  if (operation.phase === 'cleanup-required' || operation.phase === 'cleanup-starting' || operation.phase === 'cleanup-running') {
    if ((operation.phase === 'cleanup-starting' || operation.phase === 'cleanup-running') && !operation.cleanupRunId) {
      const match = await findCorrelatedRun(deps.caller, 'cleanup-connection', `postgres-cleanup:${operation.operationId}`);
      if (match.kind === 'ambiguous') return { kind: 'busy' };
      if (match.kind === 'absent') {
        try {
          await transitionOperation(
            deps.caller, operation.operationId, operation.phase, {
              phase: 'cleanup-required', cleanupRunId: null,
            },
          );
        }
        catch { throw recoveryError(); }
        return { kind: 'busy' };
      }
      try {
        await transitionOperation(deps.caller, operation.operationId, operation.phase, {
          phase: 'cleanup-running', cleanupRunId: match.id,
        });
      } catch {
        throw recoveryError();
      }
      operation = { ...operation, phase: 'cleanup-running', cleanupRunId: match.id };
    }
    return cleanupRun(deps, operation);
  }

  throw recoveryError();
}
