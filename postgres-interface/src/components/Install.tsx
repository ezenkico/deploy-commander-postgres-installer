import { useState } from 'react';
import type { RPCCaller } from '@ezenki/deploy-commander-installer-interface';
import { installPostgres } from '../lib/installationLifecycle';
import { createRunEventSource, type RunEventSource } from '../lib/runMonitor';

export interface InstallProps {
  caller?: RPCCaller;
  wire?: RPCCaller;
  events?: RunEventSource;
  onComplete?: () => void;
  onError?: (message: string) => void;
}

export default function Install({ caller, wire, events, onComplete, onError }: InstallProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = caller ?? wire;
  const run = async () => {
    if (!client || busy) return;
    setBusy(true);
    setError(null);
    try {
      await installPostgres({ caller: client, events: events ?? createRunEventSource(), signal: new AbortController().signal });
      onComplete?.();
    } catch (value) {
      const message = value instanceof Error && value.message.includes('requires recovery')
        ? 'PostgreSQL installation requires recovery'
        : value instanceof Error && value.message.includes('already exists')
          ? 'PostgreSQL installation already exists; teardown is required'
          : 'Unable to install PostgreSQL';
      setError(message);
      onError?.(message);
    } finally {
      setBusy(false);
    }
  };
  return <div>
    <button type="button" disabled={!client || busy} onClick={() => { void run(); }}>
      {busy ? 'Installing PostgreSQL…' : 'Install PostgreSQL'}
    </button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
