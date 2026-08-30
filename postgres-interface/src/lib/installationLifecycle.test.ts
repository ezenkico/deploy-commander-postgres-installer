import { describe, expect, it, vi } from 'vitest';
import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import { installPostgres, teardownPostgres, type InstallationWorkflowDeps } from './installationLifecycle';
import { createRunEventSource } from './runMonitor';

const resource: RPC.ResourceItem = { id: 'resource-1', type: 'postgres', name: 'postgres', external: false, created_at: 'now', updated_at: 'now' };
const platform = { type: 'Platform' as const, data: { network: 'postgres-network' } };
const primaryRow = {
  phase: 'ready', operation_id: 'install-1', admin_username: 'pg_admin_0123456789abcdef0123456789abcdef', admin_password: 'secret',
  run_id: 'install-run', resource_id: 'resource-1', initialized_at: 'now', updated_at: 'now',
};

function deps(overrides: Partial<InstallationWorkflowDeps> = {}): InstallationWorkflowDeps {
  const caller = {
    getMyResources: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
    getResource: vi.fn().mockResolvedValue({ config: { platform_connection: platform } }),
    getRun: vi.fn().mockResolvedValue({ run: { id: 'run-1', status: 2 } }),
    getRuns: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
    databaseQuery: vi.fn().mockImplementation((query: string, bindings: Record<string, unknown>) => {
      if (query.startsWith('SELECT phase')) return { results: [{ statement: 0, result: [] }] };
      return { results: [{ statement: 0, result: [bindings.operation_id ?? 'operation-1'] }] };
    }),
    start: vi.fn().mockResolvedValue({ id: 'run-1', status: 0 }),
  } as unknown as RPCCaller;
  return {
    caller, events: createRunEventSource(), waitForRun: vi.fn().mockResolvedValue({ run: { id: 'run-1', status: 2 } }),
    signal: new AbortController().signal, generateCredentials: vi.fn().mockReturnValue({ username: 'pg_admin_0123456789abcdef0123456789abcdef', password: 'secret' }),
    managerId: 'manager-1', storage: { removeItem: vi.fn() } as unknown as Storage,
    ...overrides,
  };
}

describe('installPostgres', () => {
  it('persists private credentials before starting and transitions ready without resource secrets', async () => {
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      getMyResources: vi.fn().mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      databaseQuery: vi.fn().mockImplementation((query: string, bindings: Record<string, unknown>) => {
        if (query.startsWith('SELECT phase')) return { results: [{ statement: 0, result: [] }] };
        return { results: [{ statement: 0, result: [bindings.operation_id ?? 'operation-1'] }] };
      }),
    } as unknown as RPCCaller });
    await expect(installPostgres(d)).rejects.toThrow('already exists');
  });

  it('creates a private state record and never places credentials in runner resource metadata', async () => {
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      getMyResources: vi.fn()
        .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
        .mockResolvedValueOnce({ items: [resource], limit: 50, offset: 0, total: 1 }),
      databaseQuery: vi.fn().mockImplementation((query: string, bindings: Record<string, unknown>) => {
        if (query.startsWith('SELECT phase')) return { results: [{ statement: 0, result: [] }] };
        return { results: [{ statement: 0, result: [bindings.operation_id ?? 'operation-1'] }] };
      }),
    } as unknown as RPCCaller });
    await installPostgres(d);
    const start = d.caller.start as unknown as ReturnType<typeof vi.fn>;
    expect(start).toHaveBeenCalledWith('create', 'ezenki/deploy-commander-runner:latest', expect.objectContaining({ services: expect.anything() }), expect.stringMatching(/^postgres-install:/));
    expect(JSON.stringify(start.mock.calls[0][2].services.postgres.resources)).not.toContain('secret');
    expect((d.caller.databaseQuery as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([query]) => String(query).startsWith('CREATE postgres_state:primary'))).toBe(true);
  });

  it('marks a failed run install-failed and does not expose run details', async () => {
    const d = deps({ waitForRun: vi.fn().mockRejectedValue(Object.assign(new Error('private output'), { status: 3 })) });
    await expect(installPostgres(d)).rejects.not.toThrow(/private|secret/i);
    expect((d.caller.databaseQuery as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([, b]) => (b as Record<string, unknown>).next_phase === 'install-failed')).toBe(true);
  });
});

describe('teardownPostgres', () => {
  it('uses a teardown journal and removes private state only after successful completion', async () => {
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      getMyResources: vi.fn().mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      databaseQuery: vi.fn().mockImplementation((query: string, bindings: Record<string, unknown>) => {
        if (query.startsWith('SELECT phase')) return { results: [{ statement: 0, result: [primaryRow] }] };
        return { results: [{ statement: 0, result: [bindings.operation_id ?? 'operation-1'] }] };
      }),
    } as unknown as RPCCaller });
    await teardownPostgres(d, resource);
    expect(d.caller.start).toHaveBeenCalledWith('teardown', 'ezenki/deploy-commander-runner:latest', { remove_services: ['postgres'], remove_volumes: ['postgres-data'] }, expect.stringMatching(/^postgres-teardown:/));
    expect((d.caller.databaseQuery as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([query]) => String(query).startsWith('DELETE postgres_state'))).toBe(true);
    expect((d.storage?.removeItem as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('retains the teardown operation on a transient monitoring failure', async () => {
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      getMyResources: vi.fn().mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      databaseQuery: vi.fn().mockImplementation((query: string, bindings: Record<string, unknown>) => {
        if (query.startsWith('SELECT phase')) return { results: [{ statement: 0, result: [primaryRow] }] };
        return { results: [{ statement: 0, result: [bindings.operation_id ?? 'operation-1'] }] };
      }),
    } as unknown as RPCCaller, waitForRun: vi.fn().mockRejectedValue(new Error('temporary')) });
    await expect(teardownPostgres(d, resource)).rejects.toThrow('teardown');
    expect((d.caller.databaseQuery as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([, b]) => (b as Record<string, unknown>).next_phase === 'teardown-release-required')).toBe(false);
  });
});
