import type { RPCCaller, Wire } from '@ezenki/deploy-commander-installer-interface';
import { findPrimaryResource, readPrimaryState } from './primaryState';
import { parsePlatformConnection, type PlatformConnection } from './postgresContracts';
import { readOperation } from './provisioningJournal';
import { recoverJournalOperation, type ProvisioningRecoveryResult } from './recoverProvisioning';
import { waitForRun, type RunEventSource } from './runMonitor';

export interface AppClient {
  wire: Wire;
  caller: RPCCaller;
  events: RunEventSource;
}

function isReadyPrimary(value: Awaited<ReturnType<typeof readPrimaryState>>): value is Awaited<ReturnType<typeof readPrimaryState>> & { phase: 'ready'; resourceId: string } {
  return value !== null && value.phase === 'ready' && typeof value.resourceId === 'string' && value.resourceId.trim().length > 0;
}

/** Boot call site used by the production App before rendering new work. */
export async function recoverConnectionOnBoot(client: AppClient, signal = new AbortController().signal, requestedCallerId?: string): Promise<ProvisioningRecoveryResult | null> {
  const operation = await readOperation(client.caller);
  if (operation === null) return null;
  if (operation.kind !== 'connection') return { kind: 'busy' };
  const primary = await readPrimaryState(client.caller);
  if (!isReadyPrimary(primary)) throw new Error('PostgreSQL recovery is required');
  const resource = await findPrimaryResource(client.caller);
  if (!resource || resource.id !== primary.resourceId) throw new Error('PostgreSQL recovery is required');
  let resourceDetails: unknown;
  try {
    resourceDetails = await client.caller.getResource(resource.id);
  } catch {
    throw new Error('PostgreSQL recovery is required');
  }
  if (typeof resourceDetails !== 'object' || resourceDetails === null || !('config' in resourceDetails)
    || typeof resourceDetails.config !== 'object' || resourceDetails.config === null
    || !('platform_connection' in resourceDetails.config)) {
    throw new Error('PostgreSQL recovery is required');
  }
  const platform: PlatformConnection = parsePlatformConnection(resourceDetails.config.platform_connection);
  return recoverJournalOperation({
    caller: client.caller,
    events: client.events,
    waitForRun,
    signal,
    primary,
    platform,
    requestedCallerId,
  });
}
