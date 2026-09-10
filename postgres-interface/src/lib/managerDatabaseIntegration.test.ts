// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { RPCCaller } from '@ezenki/deploy-commander-installer-interface';
import { initializeManagerDatabase } from './managerDatabase';
import {
  createPrimaryState,
  deletePrimaryState,
  readPrimaryState,
  transitionPrimaryState,
  type PrimaryState,
} from './primaryState';
import {
  acquireOperation,
  deleteOperation,
  readOperation,
  transitionOperation,
  type ConnectionOperation,
} from './provisioningJournal';

const harnessModule = process.env.MANAGER_DATABASE_HARNESS_MODULE;

async function loadCaller(): Promise<RPCCaller> {
  const loaded: unknown = await import(harnessModule!);
  if (typeof loaded !== 'object' || loaded === null) throw new Error('Manager database harness is invalid');
  const record = loaded as Record<string, unknown>;
  const candidate = record.caller ?? record.default;
  if (typeof candidate !== 'object' || candidate === null || typeof (candidate as { databaseQuery?: unknown }).databaseQuery !== 'function') {
    throw new Error('Manager database harness is invalid');
  }
  return candidate as RPCCaller;
}

const state: PrimaryState = {
  phase: 'install-prepared', operationId: 'integration-primary-state',
  credentials: { username: 'integration_admin', password: 'integration_secret' },
  runId: null, resourceId: null, initializedAt: null,
  updatedAt: '2026-08-30T00:00:00.000Z',
};

const operation: ConnectionOperation = {
  kind: 'connection',
  operationId: 'integration-operation',
  callerId: 'integration-caller',
  resourceId: 'integration-resource',
  database: 'db_integration',
  username: 'pg_user_integration',
  phase: 'prepared',
  cleanupReason: null,
  provisionRunId: null,
  cleanupRunId: null,
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
};

describe.skipIf(!harnessModule)('opt-in manager database contract', () => {
  it('supports atomic state create, read, CAS, and delete shapes', async () => {
    const caller = await loadCaller();
    await initializeManagerDatabase(caller);
    try {
      await createPrimaryState(caller, state);
      const read = await readPrimaryState(caller);
      expect(read?.operationId).toBe(state.operationId);
      await transitionPrimaryState(caller, state.operationId, 'install-prepared', {
        phase: 'install-running', updatedAt: '2026-08-30T00:00:01.000Z',
      });
      await expect(readPrimaryState(caller)).resolves.toMatchObject({ phase: 'install-running' });
      await deletePrimaryState(caller, state.operationId);
      await expect(readPrimaryState(caller)).resolves.toBeNull();
    } finally {
      await caller.databaseQuery(
        'DELETE postgres_state:primary WHERE operation_id = $operation_id RETURN VALUE operation_id;',
        { operation_id: state.operationId },
      ).catch(() => undefined);
      await caller.databaseQuery(
        'DELETE postgres_operation:current WHERE operation_id = $operation_id RETURN VALUE operation_id;',
        { operation_id: 'integration-operation' },
      ).catch(() => undefined);
    }
  });

  it('supports operation journal create, read, CAS, and delete shapes', async () => {
    const caller = await loadCaller();
    await initializeManagerDatabase(caller);
    try {
      await acquireOperation(caller, operation);
      await expect(readOperation(caller)).resolves.toMatchObject({
        operationId: operation.operationId,
        phase: 'prepared',
      });
      await transitionOperation(
        caller,
        operation.operationId,
        'prepared',
        { phase: 'provision-starting', updatedAt: '2026-08-30T00:00:01.000Z' },
      );
      await expect(readOperation(caller)).resolves.toMatchObject({
        operationId: operation.operationId,
        phase: 'provision-starting',
      });
      await deleteOperation(caller, operation.operationId);
      await expect(readOperation(caller)).resolves.toBeNull();
    } finally {
      await caller.databaseQuery(
        'DELETE postgres_operation:current WHERE operation_id = $operation_id RETURN VALUE operation_id;',
        { operation_id: operation.operationId },
      ).catch(() => undefined);
    }
  });
});
