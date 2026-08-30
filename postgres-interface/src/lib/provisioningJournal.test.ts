import { describe, expect, it, vi } from 'vitest';
import type { RPCCaller } from '@ezenki/deploy-commander-installer-interface';
import {
  acquireOperation,
  deleteOperation,
  readOperation,
  transitionOperation,
  type ConnectionOperation,
  type TeardownOperation,
} from './provisioningJournal';

const connection: ConnectionOperation = {
  kind: 'connection',
  operationId: 'operation-1',
  callerId: 'caller-1',
  resourceId: 'resource-1',
  database: 'db_abc',
  username: 'pg_user_abc',
  phase: 'prepared',
  cleanupReason: null,
  provisionRunId: null,
  cleanupRunId: null,
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
};

const teardown: TeardownOperation = {
  kind: 'teardown',
  operationId: 'operation-2',
  resourceId: 'resource-1',
  phase: 'teardown-starting',
  teardownRunId: null,
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
};

function callerWithQuery(result: unknown): RPCCaller & { databaseQuery: ReturnType<typeof vi.fn> } {
  return {
    databaseQuery: vi.fn().mockResolvedValue({ results: [{ statement: 0, result }] }),
  } as unknown as RPCCaller & { databaseQuery: ReturnType<typeof vi.fn> };
}

describe('provisioning journal', () => {
  it('atomically acquires the fixed lock with a bound operation kind and no credentials', async () => {
    const caller = callerWithQuery(['operation-1']);

    await acquireOperation(caller, connection);

    const [query, bindings] = caller.databaseQuery.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toMatch(/^CREATE postgres_operation:current CONTENT /);
    expect(query).toMatch(/RETURN VALUE operation_id;/);
    expect(bindings).toMatchObject({ kind: 'connection', operation_id: 'operation-1' });
    expect(JSON.stringify({ query, bindings })).not.toMatch(/password|secret/i);
  });

  it('maps a rejected create to a busy operation when the fixed record is present', async () => {
    const caller = {
      databaseQuery: vi.fn()
        .mockRejectedValueOnce(new Error('duplicate'))
        .mockResolvedValueOnce({ results: [{ statement: 0, result: [{
          kind: 'connection', operation_id: connection.operationId, caller_id: connection.callerId,
          resource_id: connection.resourceId, database: connection.database, username: connection.username,
          phase: connection.phase, cleanup_reason: connection.cleanupReason,
          provision_run_id: connection.provisionRunId, cleanup_run_id: connection.cleanupRunId,
          created_at: connection.createdAt, updated_at: connection.updatedAt,
        }] }] }),
    } as unknown as RPCCaller;

    await expect(acquireOperation(caller, connection)).rejects.toMatchObject({
      name: 'OperationBusyError',
    });
    expect(caller.databaseQuery).toHaveBeenCalledTimes(2);
  });

  it('maps confirmed absence or a failed read after create rejection to database failure', async () => {
    const absent = {
      databaseQuery: vi.fn()
        .mockRejectedValueOnce(new Error('duplicate'))
        .mockResolvedValueOnce({ results: [{ statement: 0, result: [] }] }),
    } as unknown as RPCCaller;
    await expect(acquireOperation(absent, connection)).rejects.toMatchObject({
      name: 'OperationDatabaseError',
    });

    const failedRead = {
      databaseQuery: vi.fn().mockRejectedValue(new Error('database down')),
    } as unknown as RPCCaller;
    await expect(acquireOperation(failedRead, connection)).rejects.toMatchObject({
      name: 'OperationDatabaseError',
    });
  });

  it('strictly reads no record or one discriminated operation record', async () => {
    await expect(readOperation(callerWithQuery([]))).resolves.toBeNull();
    await expect(readOperation(callerWithQuery([{
      kind: 'teardown', operation_id: 'operation-2', resource_id: 'resource-1',
      phase: 'teardown-starting', teardown_run_id: null,
      created_at: teardown.createdAt, updated_at: teardown.updatedAt,
    }]))).resolves.toEqual(teardown);

    const malformed = callerWithQuery([{
      kind: 'connection', operation_id: 'operation-1', caller_id: 'caller-1',
      resource_id: 'resource-1', database: 'db_abc', username: 'pg_user_abc',
      phase: 'teardown-running', cleanup_reason: null,
      provision_run_id: null, cleanup_run_id: null,
      created_at: connection.createdAt, updated_at: connection.updatedAt,
    }]);
    await expect(readOperation(malformed)).rejects.toThrow('Invalid PostgreSQL operation result');

    const unexpected = callerWithQuery([{
      kind: 'connection', operation_id: 'operation-1', caller_id: 'caller-1',
      resource_id: 'resource-1', database: 'db_abc', username: 'pg_user_abc',
      phase: 'prepared', cleanup_reason: null,
      provision_run_id: null, cleanup_run_id: null,
      created_at: connection.createdAt, updated_at: connection.updatedAt,
      unexpected: 'must not be normalized',
    }]);
    await expect(readOperation(unexpected)).rejects.toThrow('Invalid PostgreSQL operation result');
  });

  it('uses an operation-and-phase compare-and-set for legal transitions', async () => {
    const caller = callerWithQuery(['operation-1']);

    await transitionOperation(caller, 'operation-1', 'prepared', {
      phase: 'provision-starting',
      updatedAt: '2026-08-30T00:00:01.000Z',
    });

    const [query, bindings] = caller.databaseQuery.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toMatch(/^UPDATE postgres_operation:current SET /);
    expect(query).toMatch(/WHERE operation_id = \$operation_id AND phase = \$expected_phase RETURN VALUE operation_id;/);
    expect(bindings).toMatchObject({
      operation_id: 'operation-1', expected_phase: 'prepared', next_phase: 'provision-starting',
      updated_at: '2026-08-30T00:00:01.000Z',
    });
  });

  it('rejects illegal transitions before querying and treats an empty CAS result as lost ownership', async () => {
    const caller = callerWithQuery(['operation-1']);
    await expect(transitionOperation(caller, 'operation-1', 'prepared', 'cleanup-running'))
      .rejects.toThrow('Invalid PostgreSQL operation transition');
    expect(caller.databaseQuery).not.toHaveBeenCalled();

    const lost = callerWithQuery([]);
    await expect(transitionOperation(lost, 'operation-1', 'prepared', 'provision-starting'))
      .rejects.toThrow('PostgreSQL operation ownership was lost');
  });

  it('rejects transition fields from the other operation kind before querying', async () => {
    const caller = callerWithQuery(['operation-1']);

    await expect(transitionOperation(caller, 'operation-1', 'teardown-starting', {
      phase: 'teardown-running',
      cleanupReason: 'abandoned',
    })).rejects.toThrow('Invalid PostgreSQL operation transition');
    await expect(transitionOperation(caller, 'operation-1', 'teardown-starting', {
      phase: 'teardown-running',
      provisionRunId: 'run-1',
    })).rejects.toThrow('Invalid PostgreSQL operation transition');
    await expect(transitionOperation(caller, 'operation-1', 'teardown-starting', {
      phase: 'teardown-running',
      cleanupRunId: 'run-1',
    })).rejects.toThrow('Invalid PostgreSQL operation transition');

    await expect(transitionOperation(caller, 'operation-1', 'prepared', {
      phase: 'provision-starting',
      teardownRunId: 'run-1',
    })).rejects.toThrow('Invalid PostgreSQL operation transition');
    expect(caller.databaseQuery).not.toHaveBeenCalled();
  });

  it('conditionally deletes the fixed lock and supports the complete legal transition graph', async () => {
    const caller = callerWithQuery(['operation-1']);
    await deleteOperation(caller, 'operation-1');
    expect(caller.databaseQuery.mock.calls[0][0]).toBe(
      'DELETE postgres_operation:current WHERE operation_id = $operation_id RETURN VALUE operation_id;',
    );

    const legal: Array<[Parameters<typeof transitionOperation>[2], Parameters<typeof transitionOperation>[3]]> = [
      ['prepared', 'provision-starting'],
      ['provision-starting', 'provision-running'],
      ['provision-running', 'provisioned'],
      ['provision-running', 'cleanup-required'],
      ['provisioned', 'persisting'],
      ['provisioned', 'cleanup-required'],
      ['persisting', 'reconciliation-required'],
      ['reconciliation-required', 'cleanup-required'],
      ['cleanup-required', 'cleanup-starting'],
      ['cleanup-starting', 'cleanup-running'],
      ['cleanup-starting', 'cleanup-required'],
      ['cleanup-running', 'cleanup-required'],
      ['teardown-starting', 'teardown-running'],
      ['teardown-running', 'teardown-release-required'],
    ];
    for (const [from, to] of legal) {
      await expect(transitionOperation(caller, 'operation-1', from, to)).resolves.toBeUndefined();
    }
  });
});
