import { describe, expect, it, vi } from 'vitest';
import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import type { LogicalCredentials } from './credentials';
import type { PlatformConnection } from './postgresContracts';
import { createPostgresConnection, findExistingConnection, type ConnectionWorkflowDeps, type ReadyPrimaryState } from './createPostgresConnection';

const resource: RPC.ResourceItem = {
  id: 'resource-1', type: 'postgres', name: 'postgres', external: false,
  created_at: '2026-08-30T00:00:00.000Z', updated_at: '2026-08-30T00:00:00.000Z',
};
const platform: PlatformConnection = { type: 'Platform', data: { network: 'postgres-network' } };
const primary: ReadyPrimaryState = {
  phase: 'ready', operationId: 'primary-1',
  credentials: { username: 'pg_admin_0123456789abcdef0123456789abcdef', password: 'admin-password' },
  runId: 'install-run-1', resourceId: 'resource-1', initializedAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
};
const logical: LogicalCredentials = {
  database: 'db_0123456789abcdef0123456789abcdef',
  username: 'pg_user_0123456789abcdef0123456789abcdef', password: 'logical-password',
};

function request(overrides: Partial<Parameters<typeof createPostgresConnection>[1]> = {}) {
  return { currentManagerId: 'manager-1', callingManagerId: 'manager-2', resource, platform, primary, ...overrides };
}

function deps(overrides: Partial<ConnectionWorkflowDeps> = {}): ConnectionWorkflowDeps {
  const databaseQuery = vi.fn().mockImplementation((_query: string, bindings: Record<string, unknown>) => ({
    results: [{ statement: 0, result: [bindings.operation_id ?? 'operation-1'] }],
  }));
  return {
    caller: {
      getConnections: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
      databaseQuery,
      start: vi.fn().mockResolvedValue({ id: 'run-1', queued_at: 'now', status: 0 }),
      createConnection: vi.fn().mockResolvedValue({ connection: { id: 'connection-1' }, config: {} }),
    } as unknown as RPCCaller,
    events: { subscribe: vi.fn(() => () => undefined), publish: vi.fn() },
    storage: { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn(), removeItem: vi.fn() } as unknown as Storage,
    requestPermission: vi.fn().mockResolvedValue({ allowed: true, remember: false }),
    generateCredentials: vi.fn().mockReturnValue(logical),
    waitForRun: vi.fn().mockResolvedValue({ run: { id: 'run-1', status: 2 }, config: {} }),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('createPostgresConnection validation and idempotency', () => {
  it('rejects a null or blank caller before doing work', async () => {
    const d = deps();
    await expect(createPostgresConnection(d, request({ callingManagerId: '  ' }))).rejects.toThrow('calling manager');
    expect(d.caller.getConnections).not.toHaveBeenCalled();
    expect(d.requestPermission).not.toHaveBeenCalled();
    expect(d.generateCredentials).not.toHaveBeenCalled();
  });

  it('rejects a primary/resource mismatch and malformed platform before work', async () => {
    const d = deps();
    await expect(createPostgresConnection(d, request({ primary: { ...primary, resourceId: 'other' } }))).rejects.toThrow();
    expect(d.requestPermission).not.toHaveBeenCalled();
    await expect(createPostgresConnection(d, request({ platform: { type: 'Platform', data: { network: ' ' } } as PlatformConnection }))).rejects.toThrow('platform');
  });

  it('returns a valid existing connection before permission or lock work', async () => {
    const existing = { id: 'connection-1', manager: 'manager-2', resource: 'resource-1', external: false,
      created_at: 'now', updated_at: 'now' };
    const d = deps({ caller: {
      getConnections: vi.fn().mockResolvedValue({ items: [existing], limit: 50, offset: 0, total: 1 }),
      getConnection: vi.fn().mockResolvedValue({ connection: existing, config: { id: existing.id, manager: existing.manager, resource: existing.resource, metadata: {} } }),
      start: vi.fn(),
    } as unknown as RPCCaller });
    await expect(createPostgresConnection(d, request())).resolves.toMatchObject({ connection: existing });
    expect(d.requestPermission).not.toHaveBeenCalled();
    expect(d.generateCredentials).not.toHaveBeenCalled();
    expect((d.caller.start as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('rejects malformed existing connections instead of reusing them', async () => {
    const d = deps({ caller: {
      getConnections: vi.fn().mockResolvedValue({ items: [{ id: 'connection-1', manager: 'manager-2', resource: 'resource-1', external: false, created_at: 'now', updated_at: 'now' }], limit: 50, offset: 0, total: 1 }),
      getConnection: vi.fn().mockResolvedValue({ connection: { id: ' ', manager: 'manager-2', resource: 'resource-1', external: false }, config: {} }),
    } as unknown as RPCCaller });
    await expect(createPostgresConnection(d, request())).rejects.toThrow('connection');
    expect(d.requestPermission).not.toHaveBeenCalled();
  });

  it('skips the dialog for remembered approval and continues if remembering throws', async () => {
    const d = deps({ storage: {
      getItem: vi.fn().mockReturnValue('allow'), setItem: vi.fn().mockImplementation(() => { throw new Error('storage'); }), removeItem: vi.fn(),
    } as unknown as Storage });
    await expect(createPostgresConnection(d, request())).resolves.toBeDefined();
    expect(d.requestPermission).not.toHaveBeenCalled();
  });

  it('cancellation performs no write or run', async () => {
    const controller = new AbortController();
    controller.abort();
    const d = deps({ signal: controller.signal });
    await expect(createPostgresConnection(d, request())).rejects.toMatchObject({ name: 'AbortError' });
    expect(d.caller.databaseQuery).not.toHaveBeenCalled();
    expect(d.caller.start).not.toHaveBeenCalled();
  });
});

describe('createPostgresConnection successful orchestration', () => {
  it('provisions, waits, persists the exact connection, and releases the lock', async () => {
    const d = deps();
    const result = await createPostgresConnection(d, request());
    expect(result).toMatchObject({ connection: { id: 'connection-1' } });
    expect(d.caller.start).toHaveBeenCalledWith('create-connection', 'ezenki/deploy-commander-runner:latest', expect.objectContaining({ services: expect.anything() }), expect.stringMatching(/^postgres-provision:/));
    expect(d.waitForRun).toHaveBeenCalledWith(d.caller, d.events, 'run-1', expect.objectContaining({ signal: d.signal }));
    expect(d.caller.createConnection).toHaveBeenCalledWith({ host: 'postgres', port: 5432, database: logical.database, username: logical.username, password: logical.password }, 'manager-2', false, 'resource-1');
    expect(d.caller.databaseQuery).toHaveBeenCalled();
  });

  it('allows only one concurrent caller to acquire the manager-wide operation lock', async () => {
    let owner: Record<string, unknown> | undefined;
    let acquired = false;
    const databaseQuery = vi.fn().mockImplementation(async (query: string, bindings: Record<string, unknown>) => {
      if (query.startsWith('CREATE postgres_operation')) {
        if (acquired) throw new Error('duplicate lock');
        acquired = true;
        owner = {
          kind: 'connection', operation_id: bindings.operation_id, caller_id: 'manager-2', resource_id: 'resource-1',
          database: logical.database, username: logical.username, phase: 'prepared', cleanup_reason: null,
          provision_run_id: null, cleanup_run_id: null, created_at: 'now', updated_at: 'now',
        };
      }
      if (query.startsWith('SELECT kind')) return { results: [{ statement: 0, result: owner ? [owner] : [] }] };
      return { results: [{ statement: 0, result: [bindings.operation_id] }] };
    });
    const starts = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { id: 'run-1', queued_at: 'now', status: 0 };
    });
    const creates = vi.fn().mockResolvedValue({ connection: { id: 'connection-1' }, config: {} });
    const makeDeps = (): ConnectionWorkflowDeps => ({
      ...deps(),
      caller: {
        getConnections: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
        databaseQuery, start: starts, createConnection: creates,
      } as unknown as RPCCaller,
    });
    const [first, second] = await Promise.allSettled([
      createPostgresConnection(makeDeps(), request()),
      createPostgresConnection(makeDeps(), request()),
    ]);
    expect(starts).toHaveBeenCalledTimes(1);
    expect(creates).toHaveBeenCalledTimes(1);
    expect([first.status, second.status]).toContain('fulfilled');
    expect([first.status, second.status]).toContain('rejected');
    const rejected = first.status === 'rejected' ? first : second.status === 'rejected' ? second : null;
    expect(rejected?.reason).toMatchObject({ name: 'OperationBusyError' });
  });
});

describe('findExistingConnection', () => {
  it('validates manager/resource ownership and external flag', async () => {
    const caller = {
      getConnections: vi.fn().mockResolvedValue({ items: [{ id: 'c1', manager: 'manager-2', resource: 'resource-1', external: false, created_at: 'now', updated_at: 'now' }], limit: 50, offset: 0, total: 1 }),
      getConnection: vi.fn().mockResolvedValue({ connection: { id: 'c1', manager: 'manager-2', resource: 'resource-1', external: false, created_at: 'now', updated_at: 'now' }, config: { id: 'c1', manager: 'manager-2', resource: 'resource-1', metadata: {} } }),
    } as unknown as RPCCaller;
    await expect(findExistingConnection(caller, 'manager-2', 'resource-1')).resolves.toMatchObject({ connection: { id: 'c1' } });
  });
});
