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
  const databaseQuery = vi.fn().mockImplementation((query: string, bindings: Record<string, unknown>) => {
    if (query.startsWith('SELECT phase')) {
      return { results: [{ statement: 0, result: [{
        phase: primary.phase,
        operation_id: primary.operationId,
        admin_username: primary.credentials.username,
        admin_password: primary.credentials.password,
        run_id: primary.runId,
        resource_id: primary.resourceId,
        initialized_at: primary.initializedAt,
        updated_at: primary.updatedAt,
      }] }] };
    }
    return { results: [{ statement: 0, result: [bindings.operation_id ?? 'operation-1'] }] };
  });
  return {
    caller: {
      getConnections: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
      getMyResources: vi.fn().mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      getResource: vi.fn().mockResolvedValue({ config: { platform_connection: platform } }),
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

  it('validates complete primary state and generated credentials before acquiring the lock', async () => {
    const incomplete = deps();
    await expect(createPostgresConnection(incomplete, request({ primary: { ...primary, runId: null } }))).rejects.toThrow('ready PostgreSQL state');
    expect(incomplete.caller.databaseQuery).not.toHaveBeenCalled();
    const malformed = deps({ generateCredentials: vi.fn().mockReturnValue({ ...logical, username: 'unsafe' }) });
    await expect(createPostgresConnection(malformed, request())).rejects.toThrow();
    expect(malformed.caller.databaseQuery).not.toHaveBeenCalled();
  });

  it('rejects a primary state with a malformed updated timestamp before locking', async () => {
    const d = deps();
    await expect(createPostgresConnection(d, request({ primary: { ...primary, updatedAt: 'not-a-timestamp' } }))).rejects.toThrow('ready PostgreSQL state');
    expect(d.caller.databaseQuery).not.toHaveBeenCalled();
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

  it('fails closed for a non-empty connection result with no items', async () => {
    const d = deps({ caller: {
      getConnections: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 1 }),
    } as unknown as RPCCaller });
    await expect(createPostgresConnection(d, request())).rejects.toThrow('connection');
    expect(d.requestPermission).not.toHaveBeenCalled();
  });

  it('rejects ambiguous duplicate pages with multiple valid connections', async () => {
    const first = { id: 'c1', manager: 'manager-2', resource: 'resource-1', external: false, created_at: 'now', updated_at: 'now' };
    const second = { ...first, id: 'c2' };
    const d = deps({ caller: {
      getConnections: vi.fn().mockResolvedValue({ items: [first, second], limit: 50, offset: 0, total: 2 }),
      getConnection: vi.fn().mockImplementation(async (id: string) => ({ connection: id === 'c1' ? first : second, config: { id, manager: 'manager-2', resource: 'resource-1', metadata: {} } })),
    } as unknown as RPCCaller });
    await expect(createPostgresConnection(d, request())).rejects.toThrow('connection');
    expect(d.requestPermission).not.toHaveBeenCalled();
  });
});

describe('createPostgresConnection successful orchestration', () => {
  it('rereads the primary state, resource, and platform after acquiring the lock', async () => {
    const latestPlatform: PlatformConnection = { type: 'Platform', data: { network: 'latest-postgres-network' } };
    const d = deps({
      caller: {
        ...(deps().caller as unknown as Record<string, unknown>),
        getResource: vi.fn().mockResolvedValue({ config: { platform_connection: latestPlatform } }),
      } as unknown as RPCCaller,
    });

    await createPostgresConnection(d, request());

    expect(d.caller.getMyResources).toHaveBeenCalledWith('postgres', false, 50, 0);
    expect(d.caller.getResource).toHaveBeenCalledWith('resource-1');
    expect(d.caller.start).toHaveBeenCalledWith(
      'create-connection',
      'ezenki/deploy-commander-runner:latest',
      expect.objectContaining({
        services: {
          'postgres-admin': expect.objectContaining({
            connections: [latestPlatform],
          }),
        },
      }),
      expect.stringMatching(/^postgres-provision:/),
    );
  });

  it('fails closed when the installation changes after the lock is acquired', async () => {
    const d = deps({
      caller: {
        ...(deps().caller as unknown as Record<string, unknown>),
        getMyResources: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
      } as unknown as RPCCaller,
    });

    await expect(createPostgresConnection(d, request())).rejects.toThrow('ready PostgreSQL state');
    expect(d.caller.start).not.toHaveBeenCalled();
    expect((d.caller.databaseQuery as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([query]) => String(query).startsWith('DELETE postgres_operation'))).toBe(true);
  });

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
      if (query.startsWith('SELECT phase')) return { results: [{ statement: 0, result: [{
        phase: primary.phase, operation_id: primary.operationId,
        admin_username: primary.credentials.username, admin_password: primary.credentials.password,
        run_id: primary.runId, resource_id: primary.resourceId,
        initialized_at: primary.initializedAt, updated_at: primary.updatedAt,
      }] }] };
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
        getMyResources: vi.fn().mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
        getResource: vi.fn().mockResolvedValue({ config: { platform_connection: platform } }),
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

  it('cleans up a provisioned database before returning a raced existing connection', async () => {
    const existing = { id: 'connection-2', manager: 'manager-2', resource: 'resource-1', external: false, created_at: 'now', updated_at: 'now' };
    const getConnections = vi.fn()
      .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
      .mockResolvedValueOnce({ items: [existing], limit: 50, offset: 0, total: 1 });
    const full = { connection: existing, config: { id: existing.id, manager: existing.manager, resource: existing.resource,
      metadata: { database: 'db_other', username: 'pg_user_other' } } };
    const start = vi.fn()
      .mockResolvedValueOnce({ id: 'provision-run', queued_at: 'now', status: 0 })
      .mockResolvedValueOnce({ id: 'cleanup-run', queued_at: 'now', status: 0 });
    const waitForRun = vi.fn()
      .mockResolvedValueOnce({ run: { id: 'provision-run', status: 2 }, config: {} })
      .mockResolvedValueOnce({ run: { id: 'cleanup-run', status: 2 }, config: {} });
    const d = deps({ caller: {
      getConnections, getConnection: vi.fn().mockResolvedValue(full), start,
      getMyResources: vi.fn().mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      getResource: vi.fn().mockResolvedValue({ config: { platform_connection: platform } }),
      createConnection: vi.fn(),
      databaseQuery: vi.fn().mockImplementation((query: string, bindings: Record<string, unknown>) => query.startsWith('SELECT phase')
        ? { results: [{ statement: 0, result: [{ phase: primary.phase, operation_id: primary.operationId, admin_username: primary.credentials.username, admin_password: primary.credentials.password, run_id: primary.runId, resource_id: primary.resourceId, initialized_at: primary.initializedAt, updated_at: primary.updatedAt }] }] }
        : { results: [{ statement: 0, result: [bindings.operation_id] }] }),
    } as unknown as RPCCaller, waitForRun });
    await expect(createPostgresConnection(d, request())).resolves.toEqual(full);
    expect(start).toHaveBeenNthCalledWith(2, 'cleanup-connection', 'ezenki/deploy-commander-runner:latest', expect.objectContaining({ services: expect.anything() }), expect.stringMatching(/^postgres-cleanup:/));
    expect(waitForRun).toHaveBeenCalledTimes(2);
    const queries = (d.caller.databaseQuery as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([query]) => query as string);
    expect(queries.some((query) => query.includes('phase = $next_phase'))).toBe(true);
    expect((d.caller.createConnection as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('compensates a failed provision run before returning a fixed failure', async () => {
    const d = deps({ waitForRun: vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('runner details'), { status: 3 }))
      .mockResolvedValueOnce({ run: { id: 'cleanup-run', status: 2 }, config: {} }) });
    await expect(createPostgresConnection(d, request())).rejects.toThrow('PostgreSQL provisioning failed');
    expect(d.caller.start).toHaveBeenCalledTimes(2);
    expect(d.caller.start).toHaveBeenNthCalledWith(2, 'cleanup-connection', 'ezenki/deploy-commander-runner:latest', expect.anything(), expect.stringMatching(/^postgres-cleanup:/));
    expect(d.caller.createConnection).not.toHaveBeenCalled();
  });

  it('clears the cleanup run id when live cleanup reports failure', async () => {
    const d = deps({ waitForRun: vi.fn()
      .mockResolvedValueOnce({ run: { id: 'run-1', status: 2 }, config: {} })
      .mockRejectedValueOnce(Object.assign(new Error('cleanup failed'), { status: 3 })),
      caller: {
        ...(deps().caller as unknown as Record<string, unknown>),
        createConnection: vi.fn().mockRejectedValueOnce(new Error('save failed')),
      } as unknown as RPCCaller });
    await expect(createPostgresConnection(d, request())).rejects.toThrow('clean up');
    const cleanupReset = (d.caller.databaseQuery as unknown as ReturnType<typeof vi.fn>).mock.calls
      .find(([, bindings]) => (bindings as Record<string, unknown>).next_phase === 'cleanup-required'
        && Object.prototype.hasOwnProperty.call(bindings, 'cleanup_run_id'));
    expect(cleanupReset?.[1]).toMatchObject({ cleanup_run_id: null });
  });

  it('reconciles a rejected connection save and cleans up confirmed absence', async () => {
    const d = deps();
    (d.caller.createConnection as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('save details'));
    await expect(createPostgresConnection(d, request())).rejects.toThrow('Unable to save the PostgreSQL connection');
    expect(d.caller.start).toHaveBeenCalledTimes(2);
    expect(d.caller.start).toHaveBeenNthCalledWith(2, 'cleanup-connection', 'ezenki/deploy-commander-runner:latest', expect.anything(), expect.stringMatching(/^postgres-cleanup:/));
  });

  it('returns a matching connection after rejected persistence without cleanup', async () => {
    const existing = { id: 'connection-race', manager: 'manager-2', resource: 'resource-1', external: false, created_at: 'now', updated_at: 'now' };
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      getConnections: vi.fn()
        .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
        .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
        .mockResolvedValueOnce({ items: [existing], limit: 50, offset: 0, total: 1 }),
      getConnection: vi.fn().mockResolvedValue({
        connection: existing,
        config: { id: existing.id, manager: existing.manager, resource: existing.resource,
          metadata: { database: logical.database, username: logical.username } },
      }),
      createConnection: vi.fn().mockRejectedValueOnce(new Error('ambiguous save')),
    } as unknown as RPCCaller });
    await expect(createPostgresConnection(d, request())).resolves.toMatchObject({ connection: existing });
    expect(d.caller.start).toHaveBeenCalledTimes(1);
  });

  it('does not start after cancellation wins immediately before runner start and retains the starting journal', async () => {
    const controller = new AbortController();
    const d = deps({ signal: controller.signal });
    const originalTransition = d.caller.databaseQuery as unknown as ReturnType<typeof vi.fn>;
    originalTransition.mockImplementation((query: string, bindings: Record<string, unknown>) => {
      if (query.startsWith('SELECT phase')) return Promise.resolve({ results: [{ statement: 0, result: [{
        phase: primary.phase, operation_id: primary.operationId,
        admin_username: primary.credentials.username, admin_password: primary.credentials.password,
        run_id: primary.runId, resource_id: primary.resourceId,
        initialized_at: primary.initializedAt, updated_at: primary.updatedAt,
      }] }] });
      if (query.startsWith('UPDATE postgres_operation') && bindings.next_phase === 'provision-starting') controller.abort();
      return Promise.resolve({ results: [{ statement: 0, result: [bindings.operation_id] }] });
    });
    await expect(createPostgresConnection(d, request())).rejects.toMatchObject({ name: 'AbortError' });
    expect(d.caller.start).not.toHaveBeenCalled();
    expect(originalTransition.mock.calls.some(([query]) => String(query).startsWith('DELETE postgres_operation'))).toBe(false);
  });

  it.each([
    ['start', (d: ConnectionWorkflowDeps) => { (d.caller.start as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('password leaked')); }],
    ['wait', (d: ConnectionWorkflowDeps) => { (d.waitForRun as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('secret leaked')); }],
    ['persist', (d: ConnectionWorkflowDeps) => { (d.caller.createConnection as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('password leaked')); }],
  ])('maps %s failures to a fixed non-secret error', async (_kind, configure) => {
    const d = deps();
    configure(d);
    await expect(createPostgresConnection(d, request())).rejects.not.toThrow(/password|secret/i);
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

  it('rejects multiple valid connections across pages instead of reusing either', async () => {
    const first = { id: 'c1', manager: 'manager-2', resource: 'resource-1', external: false, created_at: 'now', updated_at: 'now' };
    const second = { ...first, id: 'c2' };
    const caller = {
      getConnections: vi.fn()
        .mockResolvedValueOnce({ items: [first], limit: 1, offset: 0, total: 2 })
        .mockResolvedValueOnce({ items: [second], limit: 1, offset: 1, total: 2 }),
      getConnection: vi.fn().mockImplementation(async (id: string) => ({ connection: id === 'c1' ? first : second, config: { id, manager: 'manager-2', resource: 'resource-1', metadata: {} } })),
    } as unknown as RPCCaller;
    await expect(findExistingConnection(caller, 'manager-2', 'resource-1')).rejects.toThrow('connection');
  });

  it.each([
    { items: [{ id: 'c1' }], limit: 50, offset: 1, total: 1 },
    { items: [{ id: 'c1' }], limit: 50, offset: 0, total: 0 },
    { items: [{ id: 'c1' }, { id: 'c2' }], limit: 50, offset: 0, total: 1 },
    { items: [], limit: 50, offset: 1, total: 0 },
    { items: [], limit: 50, offset: 0, total: 1 },
    { items: [{ id: 'c1', manager: 'manager-2', resource: 'resource-1', external: false, created_at: 'now', updated_at: 'now' }], limit: 50, offset: 0, total: 100 },
  ])('rejects inconsistent connection page metadata %#', async (page) => {
    const caller = { getConnections: vi.fn().mockResolvedValue(page) } as unknown as RPCCaller;
    await expect(findExistingConnection(caller, 'manager-2', 'resource-1')).rejects.toThrow('connection');
    expect(caller.getConnections).toHaveBeenCalledTimes(1);
  });
});
