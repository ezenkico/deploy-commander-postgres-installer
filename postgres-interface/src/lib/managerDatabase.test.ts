import { describe, expect, it, vi } from 'vitest';
import type { RPCCaller } from '@ezenki/deploy-commander-installer-interface';
import { databaseResult } from '../test/databaseQuery';
import {
  initializeManagerDatabase,
  ManagerDatabaseInitializationError,
} from './managerDatabase';

const STATE_DEFINITION =
  'DEFINE TABLE IF NOT EXISTS postgres_state SCHEMALESS;';
const OPERATION_DEFINITION =
  'DEFINE TABLE IF NOT EXISTS postgres_operation SCHEMALESS;';

function callerWith(...responses: unknown[]) {
  return {
    databaseQuery: vi.fn().mockImplementation(async () => responses.shift()),
  } as unknown as RPCCaller & { databaseQuery: ReturnType<typeof vi.fn> };
}

describe('initializeManagerDatabase', () => {
  it('defines both schemaless tables in order without bindings', async () => {
    const caller = callerWith(databaseResult(null), databaseResult(null));

    await initializeManagerDatabase(caller);

    expect(caller.databaseQuery.mock.calls).toEqual([
      [STATE_DEFINITION],
      [OPERATION_DEFINITION],
    ]);
  });

  it('accepts idempotent repeated initialization', async () => {
    const caller = callerWith(
      databaseResult(null), databaseResult(null),
      databaseResult(null), databaseResult(null),
    );

    await expect(initializeManagerDatabase(caller)).resolves.toBeUndefined();
    await expect(initializeManagerDatabase(caller)).resolves.toBeUndefined();
    expect(caller.databaseQuery).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['ERR status', { results: [{ statement: 0, status: 'ERR', time: '1ms', result: 'table rejected' }] }],
    ['unknown status', { results: [{ statement: 0, status: 'WAIT', time: '1ms', result: null }] }],
    ['missing result', { results: [{ statement: 0, status: 'OK', time: '1ms' }] }],
    ['wrong statement', { results: [{ statement: 1, status: 'OK', time: '1ms', result: null }] }],
    ['invalid time', { results: [{ statement: 0, status: 'OK', time: 1, result: null }] }],
    ['extra statement', { results: [
      { statement: 0, status: 'OK', time: '1ms', result: null },
      { statement: 1, status: 'OK', time: '1ms', result: null },
    ] }],
    ['missing results', {}],
  ])('fails closed for %s', async (_name, response) => {
    const caller = callerWith(response);

    await expect(initializeManagerDatabase(caller)).rejects.toEqual(
      new ManagerDatabaseInitializationError(),
    );
    expect(caller.databaseQuery).toHaveBeenCalledTimes(1);
  });

  it('maps transport rejection to the fixed initialization error', async () => {
    const caller = {
      databaseQuery: vi.fn().mockRejectedValue(new Error('secret database detail')),
    } as unknown as RPCCaller;

    await expect(initializeManagerDatabase(caller)).rejects.toMatchObject({
      name: 'ManagerDatabaseInitializationError',
      message: 'Unable to initialize PostgreSQL manager storage',
    });
  });

  it('stops before defining the operation table when state definition fails', async () => {
    const caller = callerWith(
      { results: [{ statement: 0, status: 'ERR', time: '1ms', result: 'rejected' }] },
      databaseResult(null),
    );

    await expect(initializeManagerDatabase(caller))
      .rejects.toBeInstanceOf(ManagerDatabaseInitializationError);
    expect(caller.databaseQuery).toHaveBeenCalledTimes(1);
  });
});
