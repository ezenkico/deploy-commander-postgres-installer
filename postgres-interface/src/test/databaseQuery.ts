import type { RPC } from '@ezenki/deploy-commander-installer-interface';

export function databaseResult(result: unknown): RPC.DatabaseQueryResult {
  return {
    results: [{ statement: 0, status: 'OK', time: '0s', result }],
  };
}
