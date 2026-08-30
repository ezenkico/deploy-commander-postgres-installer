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
  | { kind: 'dashboard'; resource: RPC.ResourceItem | null; primary: PrimaryState | null; ambiguous: boolean; error: string | null }
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

function stateError(resource: RPC.ResourceItem | null, primary: PrimaryState | null): string | null {
  if (resource === null && primary === null) return null;
  if (resource !== null && primary === null) return null; // legacy install: teardown/reinstall
  if (resource !== null && isReadyPrimary(primary, resource)) return null;
  return 'PostgreSQL recovery is required';
}

/** Count exact resources independently of primary-state contents. */
async function countPrimaryResources(caller: ReturnType<typeof RPC.SetupRPCCaller>): Promise<number> {
  let offset = 0;
  let total = 0;
  while (true) {
    const page = await caller.getMyResources('postgres', false, 50, offset);
    if (!page || !Array.isArray(page.items) || typeof page.limit !== 'number' || typeof page.total !== 'number') {
      throw new Error('PostgreSQL resource lookup failed');
    }
    total += page.items.filter((item) => item.external === false && item.type === 'postgres' && item.name === 'postgres').length;
    if (page.items.length === 0 || offset + page.items.length >= page.total) return total;
    if (page.limit <= 0) throw new Error('PostgreSQL resource lookup failed');
    offset += page.limit;
  }
}

/** The root component keeps one wire/caller pair for its complete lifetime. */
export default function App({ createClient = productionClient }: AppProps) {
  const [loading, setLoading] = useState(true);
  const [manager, setManager] = useState<string | null>(null);
  const [view, setView] = useState<BootView | null>(null);
  const clientRef = useRef<AppClient | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const client = createClient(() => undefined);
    clientRef.current = client;

    const boot = async () => {
      const currentManager = managerId(await client.caller.getManager());
      if (!currentManager) throw new Error('Unable to identify the PostgreSQL manager');
      const metadata: unknown = await client.caller.getMetadata();
      const connectionMode = isCreateConnectionMetadata(metadata);

      if (connectionMode) {
        const callingManager = callerId(await client.caller.getCallingManager().catch(() => null));
        if (!callingManager) {
          return { currentManager, mode: 'connection' as const, resource: null, primary: null, callerId: null, error: 'A calling manager is required', result: null };
        }

        try {
          // Reconcile persisted operations before exposing a connection request.
          const recovery = await recoverConnectionOnBoot(client, controller.signal);
          const resource = await findPrimaryResource(client.caller);
          const primary = await readPrimaryState(client.caller);
          const resourceCount = await countPrimaryResources(client.caller);
          const problem = resourceCount > 1 ? 'PostgreSQL resource state is ambiguous; teardown and reinstall are required.' : stateError(resource, primary);
          return {
            currentManager, mode: 'connection' as const, resource,
            primary: isReadyPrimary(primary, resource) ? primary : null,
            callerId: callingManager,
            error: resourceCount > 1 ? 'PostgreSQL recovery is required' : problem ?? (recovery?.kind === 'busy' ? 'A PostgreSQL operation is already in progress' : null),
            result: recovery?.kind === 'connection' ? recovery.value : null,
          };
        } catch {
          return {
            currentManager, mode: 'connection' as const, resource: null, primary: null,
            callerId: callingManager,
            error: 'PostgreSQL recovery is required', result: null,
          };
        }
      }

      // Reconcile the manager-wide journal before rendering normal controls.
      const recovery = await recoverConnectionOnBoot(client, controller.signal);
      if (recovery?.kind === 'busy') throw new Error('A PostgreSQL operation is already in progress');
      const resource = await findPrimaryResource(client.caller);
      const primary = await readPrimaryState(client.caller);
      const resourceCount = await countPrimaryResources(client.caller);
      return {
        currentManager,
        mode: 'dashboard' as const,
        resource,
        primary,
        ambiguous: resourceCount > 1,
        error: resourceCount > 1 ? null : stateError(resource, primary),
      };
    };

    void boot().then((next) => {
      if (!active) return;
      setManager(next.currentManager);
      if (next.mode === 'connection') {
        setView({ kind: 'connection', resource: next.resource, primary: next.primary, callerId: next.callerId, error: next.error, result: next.result });
      } else {
        setView({ kind: 'dashboard', resource: next.resource, primary: next.primary, ambiguous: next.ambiguous, error: next.error });
      }
    }).catch((error: unknown) => {
      if (active) setView({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to load PostgreSQL manager state' });
    }).finally(() => {
      if (active) setLoading(false);
    });

    return () => {
      active = false;
      controller.abort();
      client.wire.end();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [createClient]);

  if (loading || view === null) return <div role="status">Loading</div>;
  if (view.kind === 'error') return <div role="alert">{view.message}</div>;
  if (view.kind === 'connection') {
    return <ConnectionRequest caller={clientRef.current?.caller} events={clientRef.current?.events} wire={clientRef.current?.wire} currentManagerId={manager ?? ''} callingManagerId={view.callerId} resource={view.resource} primary={view.primary} initialError={view.error} initialResult={view.result} />;
  }
  if (view.ambiguous) return <div role="alert">PostgreSQL resource state is ambiguous; teardown and reinstall are required.</div>;
  if (view.error) return <div role="alert">{view.error}</div>;
  const installed = view.resource !== null && isReadyPrimary(view.primary, view.resource);
  const legacy = view.resource !== null && view.primary === null;
  return <main className="p-6 text-xl font-semibold" data-installed={installed ? 'true' : 'false'}>
    {legacy && <p role="alert">This PostgreSQL installation predates private administrator state. Teardown and reinstall are required.</p>}
    {installed ? <Teardown wire={clientRef.current!.caller} /> : <Install wire={clientRef.current!.caller} />}
  </main>;
}
