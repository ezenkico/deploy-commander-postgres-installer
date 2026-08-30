import { describe, expect, it, vi } from 'vitest';
import type { RPCCaller } from '@ezenki/deploy-commander-installer-interface';
import type { PlatformConnection } from './postgresContracts';
import type { ConnectionOperation } from './provisioningJournal';
import type { ReadyPrimaryState } from './createPostgresConnection';
import { recoverProvisioning, type ProvisioningRecoveryDeps } from './recoverProvisioning';

const primary: ReadyPrimaryState = {
  phase: 'ready', operationId: 'primary-1',
  credentials: { username: 'pg_admin_0123456789abcdef0123456789abcdef', password: 'admin-password' },
  runId: 'install-run-1', resourceId: 'resource-1', initializedAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
};
const platform: PlatformConnection = { type: 'Platform', data: { network: 'postgres-network' } };
const operation: ConnectionOperation = {
  kind: 'connection', operationId: 'operation-1', callerId: 'manager-2', resourceId: 'resource-1',
  database: 'db_0123456789abcdef0123456789abcdef',
  username: 'pg_user_0123456789abcdef0123456789abcdef', phase: 'provision-running',
  cleanupReason: 'provision-failed', provisionRunId: 'provision-run', cleanupRunId: null,
  createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
};

function deps(overrides: Partial<ProvisioningRecoveryDeps> = {}): ProvisioningRecoveryDeps {
  const caller = {
    getConnections: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
    getRuns: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
    getRun: vi.fn().mockResolvedValue({ run: { id: 'provision-run', status: 1 } }),
    databaseQuery: vi.fn().mockResolvedValue({ results: [{ statement: 0, result: ['operation-1'] }] }),
    start: vi.fn().mockResolvedValue({ id: 'cleanup-run', queued_at: 'now', status: 0 }),
  } as unknown as RPCCaller;
  return {
    caller,
    events: { subscribe: vi.fn(() => () => undefined), publish: vi.fn() },
    waitForRun: vi.fn().mockResolvedValue({ run: { id: 'cleanup-run', status: 2 } }),
    signal: new AbortController().signal,
    primary,
    platform,
    ...overrides,
  };
}

describe('recoverProvisioning', () => {
  it('reports a recorded queued or running provision as busy without cleanup', async () => {
    const d = deps();
    await expect(recoverProvisioning(d, operation)).resolves.toEqual({ kind: 'busy' });
    expect(d.caller.start).not.toHaveBeenCalled();
    expect(d.waitForRun).not.toHaveBeenCalled();
  });

  it('moves a failed provision to cleanup, waits for cleanup, and permits retry', async () => {
    const d = deps({
      caller: {
        ...(deps().caller as unknown as Record<string, unknown>),
        getRun: vi.fn().mockImplementation(async (id: string) => ({ run: { id, status: id === 'provision-run' ? 3 : 2 } })),
      } as unknown as RPCCaller,
    });
    await expect(recoverProvisioning(d, operation)).resolves.toEqual({ kind: 'retry' });
    expect(d.caller.start).toHaveBeenCalledWith(
      'cleanup-connection', 'ezenki/deploy-commander-runner:latest',
      expect.anything(), 'postgres-cleanup:operation-1',
    );
    expect(d.caller.getRun).toHaveBeenCalledWith('cleanup-run');
  });

  it('correlates an ambiguous provision-starting operation by exact action and note', async () => {
    const starting: ConnectionOperation = { ...operation, phase: 'provision-starting', provisionRunId: null };
    const d = deps({
      caller: {
        ...(deps().caller as unknown as Record<string, unknown>),
        getRuns: vi.fn().mockResolvedValue({
          items: [{ id: 'provision-run', action: 'create-connection', note: 'postgres-provision:operation-1', status: 2 }],
          limit: 50, offset: 0, total: 1,
        }),
        getRun: vi.fn().mockImplementation(async (id: string) => ({ run: { id, status: 2 } })),
      } as unknown as RPCCaller,
    });
    await expect(recoverProvisioning(d, starting)).resolves.toEqual({ kind: 'retry' });
    expect(d.caller.databaseQuery).toHaveBeenCalled();
  });

  it('retains an ambiguous starting phase when correlation is inconclusive', async () => {
    const starting: ConnectionOperation = { ...operation, phase: 'provision-starting', provisionRunId: null };
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      getRuns: vi.fn().mockResolvedValue({ items: [
        { id: 'run-a', action: 'create-connection', note: 'postgres-provision:operation-1', status: 1 },
        { id: 'run-b', action: 'create-connection', note: 'postgres-provision:operation-1', status: 1 },
      ], limit: 50, offset: 0, total: 2 }),
    } as unknown as RPCCaller });
    await expect(recoverProvisioning(d, starting)).resolves.toEqual({ kind: 'busy' });
    expect(d.caller.start).not.toHaveBeenCalled();
  });

  it('resumes a queued cleanup run and deletes the lock only after completion', async () => {
    const cleanup: ConnectionOperation = { ...operation, phase: 'cleanup-running', cleanupRunId: 'cleanup-run' };
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      getRun: vi.fn().mockResolvedValue({ run: { id: 'cleanup-run', status: 1 } }),
    } as unknown as RPCCaller });
    await expect(recoverProvisioning(d, cleanup)).resolves.toEqual({ kind: 'retry' });
    expect(d.waitForRun).toHaveBeenCalledWith(d.caller, d.events, 'cleanup-run', expect.anything());
    expect(d.caller.start).not.toHaveBeenCalled();
  });

  it('marks a failed cleanup for explicit retry and does not launch another run', async () => {
    const cleanup: ConnectionOperation = { ...operation, phase: 'cleanup-running', cleanupRunId: 'cleanup-run' };
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      getRun: vi.fn().mockResolvedValue({ run: { id: 'cleanup-run', status: 3 } }),
    } as unknown as RPCCaller });
    await expect(recoverProvisioning(d, cleanup)).resolves.toEqual({ kind: 'busy' });
    expect(d.caller.start).not.toHaveBeenCalled();
    expect(d.caller.databaseQuery).toHaveBeenCalled();
  });

  it('keeps an active provisioning run untouched and never overlaps cleanup', async () => {
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      getRun: vi.fn().mockResolvedValue({ run: { id: 'provision-run', status: 0 } }),
    } as unknown as RPCCaller });
    await expect(recoverProvisioning(d, operation)).resolves.toEqual({ kind: 'busy' });
    expect(d.caller.start).not.toHaveBeenCalled();
    expect(d.caller.databaseQuery).not.toHaveBeenCalled();
  });

  it('returns a valid existing connection and treats lock deletion as best effort', async () => {
    const full = { connection: {
      id: 'connection-1', manager: operation.callerId, resource: operation.resourceId,
      external: false, created_at: 'now', updated_at: 'now',
    }, config: { id: 'connection-1', manager: operation.callerId, resource: operation.resourceId,
      metadata: { database: operation.database, username: operation.username } } };
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      getConnections: vi.fn().mockResolvedValue({ items: [full.connection], limit: 50, offset: 0, total: 1 }),
      getConnection: vi.fn().mockResolvedValue(full),
      databaseQuery: vi.fn().mockRejectedValue(new Error('lock unavailable')),
    } as unknown as RPCCaller });
    await expect(recoverProvisioning(d, operation)).resolves.toEqual({ kind: 'connection', value: full });
    expect(d.caller.start).not.toHaveBeenCalled();
  });

  it('retains a journal when the existing connection has different logical identifiers', async () => {
    const full = { connection: {
      id: 'connection-other', manager: operation.callerId, resource: operation.resourceId,
      external: false, created_at: 'now', updated_at: 'now',
    }, config: { id: 'connection-other', manager: operation.callerId, resource: operation.resourceId,
      metadata: { database: 'db_other', username: 'pg_user_other' } } };
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      getConnections: vi.fn().mockResolvedValue({ items: [full.connection], limit: 50, offset: 0, total: 1 }),
      getConnection: vi.fn().mockResolvedValue(full),
    } as unknown as RPCCaller });
    await expect(recoverProvisioning(d, operation)).resolves.toEqual({ kind: 'busy' });
    expect(d.caller.databaseQuery).not.toHaveBeenCalled();
    expect(d.caller.start).not.toHaveBeenCalled();
  });
});
