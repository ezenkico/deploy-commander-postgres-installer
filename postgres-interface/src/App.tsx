import { useEffect, useRef, useState } from 'react';
import './App.css';
import { RPC, type Events } from '@ezenki/deploy-commander-installer-interface';
import Install from './components/Install';
import Teardown from './components/Teardown';
import ConnectionRequest from './components/ConnectionRequest';
import { createInterfaceClient } from './lib/interfaceClient';
import { createRunEventSource } from './lib/runMonitor';
import { findPrimaryResource, readPrimaryState, type PrimaryState } from './lib/primaryState';
import { isCreateConnectionMetadata } from './lib/postgresContracts';
import { recoverConnectionOnBoot, type AppClient } from './lib/appRecovery';
import type { ReadyPrimaryState } from './lib/createPostgresConnection';

export type AppClientFactory = (onEvent: (event: Events.InterfaceEvent) => void) => AppClient;

export interface AppProps {
  /** Injectable only to make the wire lifecycle deterministic in tests. */
  createClient?: AppClientFactory;
}

type BootView =
  | { kind: 'dashboard'; resource: RPC.ResourceItem | null; primary: PrimaryState | null; ambiguous: boolean }
  | { kind: 'connection'; resource: RPC.ResourceItem | null; primary: ReadyPrimaryState | null; callerId: string | null; error: string | null; result: RPC.CreateConnection | null }
  | { kind: 'error'; message: string };

function managerId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id.trim().length > 0 ? id : null;
}

function callerId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isReadyPrimary(value: PrimaryState | null, resource: RPC.ResourceItem | null): value is ReadyPrimaryState {
  return value !== null && value.phase === 'ready'
    && typeof value.resourceId === 'string'
    && resource !== null && value.resourceId === resource.id;
}

function productionClient(onEvent: (event: Events.InterfaceEvent) => void): AppClient {
  const events = createRunEventSource();
  const interfaceClient = createInterfaceClient((event) => {
    events.publish(event);
    onEvent(event);
  });
  return { ...interfaceClient, events };
}

/** The root component keeps one wire/caller pair for its complete lifetime. */
export default function App({ createClient = productionClient }: AppProps) {
  const [loading, setLoading] = useState(true);
  const [manager, setManager] = useState<string | null>(null);
  const [view, setView] = useState<BootView | null>(null);
  const clientRef = useRef<AppClient | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    const client = createClient(() => undefined);
    clientRef.current = client;

    const boot = async () => {
      const currentManager = managerId(await client.caller.getManager());
      if (!currentManager) throw new Error('Unable to identify the PostgreSQL manager');
      const metadata: unknown = await client.caller.getMetadata();
      const connectionMode = isCreateConnectionMetadata(metadata);
      const resource = await findPrimaryResource(client.caller);
      const primary = await readPrimaryState(client.caller);

      if (connectionMode) {
        const calling = await client.caller.getCallingManager().catch(() => null);
        const callingManager = callerId(calling);
        if (!callingManager) {
          return { currentManager, mode: 'connection' as const, resource, primary, callerId: null, error: 'A calling manager is required', result: null };
        }

        let recoveryResult: Awaited<ReturnType<typeof recoverConnectionOnBoot>> = null;
        let recoveryError: string | null = null;
        try {
          recoveryResult = await recoverConnectionOnBoot(client, controller.signal);
        } catch (error: unknown) {
          recoveryError = error instanceof Error ? error.message : 'PostgreSQL recovery is required';
        }
        return {
          currentManager,
          mode: 'connection' as const,
          resource,
          primary,
          callerId: callingManager,
          error: recoveryError ?? (recoveryResult?.kind === 'busy' ? 'A PostgreSQL operation is already in progress' : null),
          result: recoveryResult?.kind === 'connection' ? recoveryResult.value : null,
        };
      }

      // A connection run must never determine installation state. Resource and
      // private primary state are the only lifecycle signals used here.
      const ambiguous = resource === null && primary === null
        ? await hasMultiplePrimaryResources(client.caller)
        : false;
      return { currentManager, mode: 'dashboard' as const, resource, primary, ambiguous };
    };

    void boot().then((next) => {
      if (!mountedRef.current) return;
      setManager(next.currentManager);
      if (next.mode === 'connection') {
        setView({ kind: 'connection', resource: next.resource, primary: isReadyPrimary(next.primary, next.resource) ? next.primary : null, callerId: next.callerId, error: next.error, result: next.result });
      } else {
        setView({ kind: 'dashboard', resource: next.resource, primary: next.primary, ambiguous: next.ambiguous });
      }
    }).catch(() => {
      if (mountedRef.current) setView({ kind: 'error', message: 'Unable to load PostgreSQL manager state' });
    }).finally(() => {
      if (mountedRef.current) setLoading(false);
    });

    return () => {
      mountedRef.current = false;
      controller.abort();
      client.wire.end();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [createClient]);

  if (loading || view === null) return <div role="status">Loading</div>;
  if (view.kind === 'error') return <div role="alert">{view.message}</div>;

  if (view.kind === 'connection') {
    return (
      <ConnectionRequest
        caller={clientRef.current?.caller}
        events={clientRef.current?.events}
        wire={clientRef.current?.wire}
        currentManagerId={manager ?? ''}
        callingManagerId={view.callerId}
        resource={view.resource}
        primary={view.primary}
        initialError={view.error}
        initialResult={view.result}
      />
    );
  }

  if (view.ambiguous) return <div role="alert">PostgreSQL resource state is ambiguous; teardown and reinstall are required.</div>;
  const installed = view.resource !== null && isReadyPrimary(view.primary, view.resource);
  const legacy = view.resource !== null && view.primary === null;
  return (
    <main className="p-6 text-xl font-semibold" data-installed={installed ? 'true' : 'false'}>
      {legacy && <p role="alert">This PostgreSQL installation predates private administrator state. Teardown and reinstall are required.</p>}
      {installed ? <Teardown wire={clientRef.current!.caller} /> : <Install wire={clientRef.current!.caller} />}
    </main>
  );
}

/** A second read distinguishes an empty resource collection from the helper's
 * fail-closed result for multiple exact resources. */
async function hasMultiplePrimaryResources(caller: ReturnType<typeof RPC.SetupRPCCaller>): Promise<boolean> {
  try {
    const page = await caller.getMyResources('postgres', false, 50, 0);
    if (!page || !Array.isArray(page.items)) return true;
    return page.items.filter((item) => item.external === false && item.type === 'postgres' && item.name === 'postgres').length > 1
      || page.total > page.items.length;
  } catch {
    return true;
  }
}
