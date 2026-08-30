import { useState } from 'react';
import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import { teardownPostgres } from '../lib/installationLifecycle';
import { createRunEventSource, type RunEventSource } from '../lib/runMonitor';

export interface TeardownProps {
  caller?: RPCCaller;
  wire?: RPCCaller;
  events?: RunEventSource;
  resource: RPC.ResourceItem;
  managerId?: string;
  storage?: Storage;
  onComplete?: () => void;
  onError?: (message: string) => void;
}

export default function Teardown({ caller, wire, events, resource, managerId, storage, onComplete, onError }: TeardownProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = caller ?? wire;
  const run = async () => {
    if (!client || busy) return;
    setBusy(true);
    setError(null);
    try {
      await teardownPostgres({ caller: client, events: events ?? createRunEventSource(), signal: new AbortController().signal, managerId, storage }, resource);
      onComplete?.();
    } catch (value) {
      const message = value instanceof Error && value.message.includes('requires recovery')
        ? 'PostgreSQL teardown requires recovery'
        : 'Unable to tear down PostgreSQL';
      setError(message);
      onError?.(message);
    } finally {
      setBusy(false);
    }
  };
  return <div>
    <button type="button" disabled={!client || busy} onClick={() => { void run(); }}>
      {busy ? 'Tearing down PostgreSQL…' : 'Teardown PostgreSQL'}
    </button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
