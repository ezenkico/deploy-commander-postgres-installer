import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { RPCCaller, Wire } from '@ezenki/deploy-commander-installer-interface';
import App, { type AppClientFactory } from './App';
import { createRunEventSource } from './lib/runMonitor';
import { recoverConnectionOnBoot, type AppClient } from './lib/appRecovery';

afterEach(() => cleanup());

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

function appClient(overrides: Partial<RPCCaller> = {}, metadata: unknown = {}) {
  const wire = { close: vi.fn(), end: vi.fn() } as unknown as Wire;
  const caller = {
    getManager: vi.fn().mockResolvedValue({ id: 'postgres-manager', kind: 'manager', name: 'Postgres' }),
    getMetadata: vi.fn().mockResolvedValue(metadata),
    getCallingManager: vi.fn().mockResolvedValue('calling-manager'),
    getMyResources: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
    databaseQuery: vi.fn().mockResolvedValue({ results: [{ statement: 0, result: [] }] }),
    ...overrides,
  } as unknown as RPCCaller;
  return { caller, wire, events: createRunEventSource() };
}

describe('App lifecycle and resource routing', () => {
  it('uses resource and private state instead of unrelated run events', async () => {
    const client = appClient();
    const factory: AppClientFactory = () => client;
    render(<App createClient={factory} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Install Postgres' })).toBeInTheDocument());
    client.events.publish({ eventType: 'run-start', event: 'event', data: { id: 'other-run', manager: 'other', action: 'create' } } as never);
    expect(screen.getByRole('button', { name: 'Install Postgres' })).toBeInTheDocument();
  });

  it('fails closed when private primary state is unresolved', async () => {
    const client = appClient({ databaseQuery: vi.fn().mockImplementation(async (query: string) => ({
      results: [{ statement: 0, result: query.startsWith('SELECT phase') ? [{
        phase: 'install-running', operation_id: 'op', admin_username: 'admin', admin_password: 'secret',
        run_id: 'run', resource_id: 'resource', initialized_at: null, updated_at: 'now',
      }] : [] }],
    })) });
    render(<App createClient={() => client} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('recovery is required'));
  });

  it('fails closed for multiple exact resources even with stale state', async () => {
    const resources = [{ id: 'r1', type: 'postgres', name: 'postgres', external: false }, { id: 'r2', type: 'postgres', name: 'postgres', external: false }];
    const client = appClient({ getMyResources: vi.fn().mockResolvedValue({ items: resources, limit: 50, offset: 0, total: 2 }) });
    render(<App createClient={() => client} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('ambiguous'));
  });

  it('closes child mode through the wire when boot cannot find an installation', async () => {
    const client = appClient({}, { action: 'create-connection' });
    render(<App createClient={() => client} />);
    await waitFor(() => expect(client.wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager', ok: false,
      error: { status: 503, message: 'PostgreSQL recovery is required' },
    }));
  });
});
