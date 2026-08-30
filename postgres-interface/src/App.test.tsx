import { describe, expect, it, vi } from 'vitest';
import type { RPCCaller } from '@ezenki/deploy-commander-installer-interface';
import { createRunEventSource } from './lib/runMonitor';
import { recoverConnectionOnBoot, type AppClient } from './lib/appRecovery';

const operation = {
  kind: 'connection', operation_id: 'operation-1', caller_id: 'manager-2', resource_id: 'resource-1',
  database: 'db_0123456789abcdef0123456789abcdef', username: 'pg_user_0123456789abcdef0123456789abcdef',
  phase: 'provision-running', cleanup_reason: 'provision-failed', provision_run_id: 'provision-run',
  cleanup_run_id: null, created_at: '2026-08-30T00:00:00.000Z', updated_at: '2026-08-30T00:00:00.000Z',
};
const primary = {
  phase: 'ready', operation_id: 'primary-1', admin_username: 'pg_admin_0123456789abcdef0123456789abcdef',
  admin_password: 'admin-password', run_id: 'install-run', resource_id: 'resource-1',
  initialized_at: '2026-08-30T00:00:00.000Z', updated_at: '2026-08-30T00:00:00.000Z',
};

function client(phase: string): AppClient {
  const caller = {
    databaseQuery: vi.fn().mockImplementation(async (query: string) => {
      if (query.startsWith('SELECT kind')) return { results: [{ statement: 0, result: [{ ...operation, phase }] }] };
      if (query.startsWith('SELECT phase')) return { results: [{ statement: 0, result: [primary] }] };
      return { results: [{ statement: 0, result: ['operation-1'] }] };
    }),
    getMyResources: vi.fn().mockResolvedValue({ items: [{ id: 'resource-1', type: 'postgres', name: 'postgres', external: false }], limit: 50, offset: 0, total: 1 }),
    getResource: vi.fn().mockResolvedValue({ config: { platform_connection: { type: 'Platform', data: { network: 'postgres-network' } } }, resource: {} }),
    getConnections: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
    getRun: vi.fn().mockImplementation(async (id: string) => ({ run: { id, status: id === 'provision-run' ? 1 : 2 } })),
    start: vi.fn().mockResolvedValue({ id: 'cleanup-run', queued_at: 'now', status: 0 }),
  } as unknown as RPCCaller;
  return { caller, wire: {} as AppClient['wire'], events: createRunEventSource() };
}

describe('App boot recovery call site', () => {
  it('blocks new dashboard work while a provisioning journal has an active run', async () => {
    const current = client('provision-running');
    await expect(recoverConnectionOnBoot(current)).resolves.toEqual({ kind: 'busy' });
    expect(current.caller.start).not.toHaveBeenCalled();
  });

  it('runs recorded cleanup during boot and releases the journal after success', async () => {
    const current = client('cleanup-required');
    await expect(recoverConnectionOnBoot(current)).resolves.toEqual({ kind: 'retry' });
    expect(current.caller.start).toHaveBeenCalledWith(
      'cleanup-connection', 'ezenki/deploy-commander-runner:latest', expect.anything(), 'postgres-cleanup:operation-1',
    );
  });
});
