import { describe, expect, it, vi } from 'vitest';
import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import type { AdminCredentials } from './credentials';
import { databaseResult } from '../test/databaseQuery';
import {
  createPrimaryState,
  deletePrimaryState,
  findPrimaryResource,
  readPrimaryState,
  transitionPrimaryState,
  type PrimaryState,
} from './primaryState';

const credentials: AdminCredentials = { username: 'admin', password: 'password' };
const state: PrimaryState = {
  phase: 'install-prepared',
  operationId: 'operation-1',
  credentials,
  runId: null,
  resourceId: null,
  initializedAt: null,
  updatedAt: '2026-08-30T00:00:00.000Z',
};
const pageResource: RPC.ResourceItem = {
  id: 'resource-1',
  type: 'postgres',
  name: 'postgres',
  external: false,
  manager: 'postgres-manager',
  created_at: '2026-08-30T00:00:00.000Z',
  updated_at: '2026-08-30T00:00:00.000Z',
};

function callerWithQuery(result: unknown): RPCCaller & { databaseQuery: ReturnType<typeof vi.fn> } {
  return {
    databaseQuery: vi.fn().mockResolvedValue(databaseResult(result)),
  } as unknown as RPCCaller & { databaseQuery: ReturnType<typeof vi.fn> };
}

describe('primary state', () => {
  it('writes one private state record using bindings', async () => {
    const caller = callerWithQuery(['operation-1']);

    await createPrimaryState(caller, state);

    expect(caller.databaseQuery).toHaveBeenCalledWith(
      `CREATE postgres_state:primary CONTENT {
  phase: $phase, operation_id: $operation_id,
  admin_username: $admin_username, admin_password: $admin_password,
  run_id: $run_id, resource_id: $resource_id,
  initialized_at: $initialized_at, updated_at: $updated_at
} RETURN VALUE operation_id;`,
      {
        phase: 'install-prepared',
        operation_id: 'operation-1',
        admin_username: 'admin',
        admin_password: 'password',
        run_id: null,
        resource_id: null,
        initialized_at: null,
        updated_at: '2026-08-30T00:00:00.000Z',
      },
    );
  });

  it('reads and converts a validated state record', async () => {
    const caller = callerWithQuery([{
      phase: 'ready',
      operation_id: 'operation-1',
      admin_username: 'admin',
      admin_password: 'password',
      run_id: 'run-1',
      resource_id: 'resource-1',
      initialized_at: '2026-08-30T00:00:00.000Z',
      updated_at: '2026-08-30T00:01:00.000Z',
    }]);

    await expect(readPrimaryState(caller)).resolves.toEqual({
      phase: 'ready',
      operationId: 'operation-1',
      credentials,
      runId: 'run-1',
      resourceId: 'resource-1',
      initializedAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:01:00.000Z',
    });
    expect(caller.databaseQuery).toHaveBeenCalledWith(
      'SELECT phase, operation_id, admin_username, admin_password, run_id, resource_id, initialized_at, updated_at FROM postgres_state:primary;',
    );
  });

  it('rejects a resolved database ERR statement without exposing its result', async () => {
    const caller = {
      databaseQuery: vi.fn().mockResolvedValue({
        results: [{ statement: 0, status: 'ERR', time: '1ms', result: [{
          phase: 'ready', operation_id: 'operation-1',
          admin_username: 'admin', admin_password: 'password',
          run_id: 'run-1', resource_id: 'resource-1',
          initialized_at: '2026-08-30T00:00:00.000Z',
          updated_at: '2026-08-30T00:01:00.000Z',
        }] }],
      }),
    } as unknown as RPCCaller;

    await expect(readPrimaryState(caller))
      .rejects.toThrow('Primary state database operation failed');
    await expect(readPrimaryState(caller))
      .rejects.not.toThrow(/admin|password|resource-1/i);
  });

  it.each([
    { results: [{ statement: 1, result: [] }] },
    { results: [{ statement: 0, result: [] }, { statement: 1, result: [] }] },
    { results: [] },
    { results: [{ statement: 0, time: '0s', result: [] }] },
    { results: [{ statement: 0, status: 'UNKNOWN', time: '0s', result: [] }] },
    { results: [{ statement: 0, status: 'OK', time: 1, result: [] }] },
  ])('rejects malformed or multi-statement database results without exposing data', async (response) => {
    const caller = {
      databaseQuery: vi.fn().mockResolvedValue(response),
    } as unknown as RPCCaller;

    await expect(readPrimaryState(caller)).rejects.toThrow('Invalid primary state database result');
  });

  it('performs a compare-and-set transition and treats an empty result as lost ownership', async () => {
    const caller = callerWithQuery(['operation-1']);

    await transitionPrimaryState(caller, 'operation-1', 'install-prepared', {
      phase: 'install-running',
      runId: 'run-1',
      resourceId: null,
      initializedAt: null,
      updatedAt: '2026-08-30T00:00:01.000Z',
    });

    expect(caller.databaseQuery).toHaveBeenCalledWith(
      `UPDATE postgres_state:primary SET phase = $next_phase, run_id = $run_id, resource_id = $resource_id, initialized_at = $initialized_at, updated_at = $updated_at WHERE operation_id = $operation_id AND phase = $expected_phase RETURN VALUE operation_id;`,
      {
        next_phase: 'install-running',
        run_id: 'run-1',
        resource_id: null,
        initialized_at: null,
        updated_at: '2026-08-30T00:00:01.000Z',
        operation_id: 'operation-1',
        expected_phase: 'install-prepared',
      },
    );

    const lost = callerWithQuery([]);
    await expect(transitionPrimaryState(lost, 'operation-1', 'install-prepared', 'install-running'))
      .rejects.toThrow('Primary state ownership was lost');
  });

  it('rejects illegal phase transitions before issuing a database query', async () => {
    const caller = callerWithQuery(['operation-1']);

    await expect(transitionPrimaryState(caller, 'operation-1', 'ready', 'install-running'))
      .rejects.toThrow('Invalid primary state transition');
    expect(caller.databaseQuery).not.toHaveBeenCalled();
  });

  it('conditionally deletes state and discovers one exact owned resource across pages', async () => {
    const caller = callerWithQuery(['operation-1']);
    await deletePrimaryState(caller, 'operation-1');
    expect(caller.databaseQuery).toHaveBeenCalledWith(
      'DELETE postgres_state:primary WHERE operation_id = $operation_id RETURN VALUE operation_id;',
      { operation_id: 'operation-1' },
    );

    const resource: RPC.ResourceItem = {
      id: 'resource-1',
      type: 'postgres',
      name: 'postgres',
      external: false,
      manager: 'postgres-manager',
      created_at: '2026-08-30T00:00:00.000Z',
      updated_at: '2026-08-30T00:00:00.000Z',
    };
    const resourcesCaller = {
      getMyResources: vi.fn()
        .mockResolvedValueOnce({
          items: Array.from({ length: 50 }, (_, index) => ({ ...resource, id: `resource-other-${index}`, name: 'other' })),
          limit: 50,
          offset: 0,
          total: 51,
        })
        .mockResolvedValueOnce({ items: [resource], limit: 50, offset: 50, total: 51 }),
    } as unknown as RPCCaller;

    await expect(findPrimaryResource(resourcesCaller)).resolves.toEqual(resource);
    expect(resourcesCaller.getMyResources).toHaveBeenNthCalledWith(1, 'postgres', false, 50, 0);
    expect(resourcesCaller.getMyResources).toHaveBeenNthCalledWith(2, 'postgres', false, 50, 50);
  });

  it('rejects resource pages with malformed identity fields and fails closed on ambiguity', async () => {
    const malformedCaller = {
      getMyResources: vi.fn().mockResolvedValue({
        items: [{ id: 123, type: 'postgres', name: 'postgres', external: false }],
        limit: 50,
        offset: 0,
        total: 1,
      }),
    } as unknown as RPCCaller;
    await expect(findPrimaryResource(malformedCaller)).rejects.toThrow('Invalid PostgreSQL resource response');

    const resource: RPC.ResourceItem = {
      id: 'resource-1',
      type: 'postgres',
      name: 'postgres',
      external: false,
      manager: 'postgres-manager',
      created_at: '2026-08-30T00:00:00.000Z',
      updated_at: '2026-08-30T00:00:00.000Z',
    };
    const ambiguousCaller = {
      getMyResources: vi.fn().mockResolvedValue({
        items: [resource, { ...resource, id: 'resource-2' }],
        limit: 50,
        offset: 0,
        total: 2,
      }),
    } as unknown as RPCCaller;
    await expect(findPrimaryResource(ambiguousCaller)).resolves.toBeNull();
  });

  it.each([
    { items: [pageResource], limit: 50, offset: 1, total: 1 },
    { items: [pageResource], limit: 50, offset: 0, total: 0 },
    { items: [pageResource, { ...pageResource, id: 'resource-2' }], limit: 50, offset: 0, total: 1 },
    { items: [], limit: 50, offset: 1, total: 0 },
    { items: [], limit: 50, offset: 0, total: 1 },
    { items: [pageResource], limit: 50, offset: 0, total: 100 },
  ])('rejects inconsistent resource page metadata %#', async (page) => {
    const caller = { getMyResources: vi.fn().mockResolvedValue(page) } as unknown as RPCCaller;
    await expect(findPrimaryResource(caller)).rejects.toThrow('Invalid PostgreSQL resource response');
    expect(caller.getMyResources).toHaveBeenCalledTimes(1);
  });
});
