import type { RPCCaller } from '@ezenki/deploy-commander-installer-interface';

type UnknownRecord = Record<string, unknown>;

const TABLE_DEFINITIONS = [
  'DEFINE TABLE IF NOT EXISTS postgres_state SCHEMALESS;',
  'DEFINE TABLE IF NOT EXISTS postgres_operation SCHEMALESS;',
] as const;

export class ManagerDatabaseInitializationError extends Error {
  constructor() {
    super('Unable to initialize PostgreSQL manager storage');
    this.name = 'ManagerDatabaseInitializationError';
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validDefinitionResponse(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length !== 1) {
    return false;
  }
  const statement = value.results[0];
  return isRecord(statement)
    && statement.statement === 0
    && statement.status === 'OK'
    && typeof statement.time === 'string'
    && Object.prototype.hasOwnProperty.call(statement, 'result');
}

async function defineTable(caller: RPCCaller, query: string): Promise<void> {
  let response: unknown;
  try {
    response = await caller.databaseQuery(query);
  } catch {
    throw new ManagerDatabaseInitializationError();
  }
  if (!validDefinitionResponse(response)) {
    throw new ManagerDatabaseInitializationError();
  }
}

export async function initializeManagerDatabase(caller: RPCCaller): Promise<void> {
  for (const definition of TABLE_DEFINITIONS) {
    await defineTable(caller, definition);
  }
}
