import type { RPC } from '@ezenki/deploy-commander-installer-interface';
import type { PrimaryState } from '../lib/primaryState';

export interface ManagerDashboardProps {
  resource: RPC.ResourceItem | null;
  primary: PrimaryState | null;
  busy: boolean;
  error: string | null;
  permissionRemembered: boolean;
  onInstall: () => void;
  onTeardown: () => void;
  onRetry: () => void;
  onResetPermission: () => void;
  resourceAmbiguous?: boolean;
}

function isReady(resource: RPC.ResourceItem | null, primary: PrimaryState | null): boolean {
  return resource !== null
    && primary?.phase === 'ready'
    && primary.resourceId === resource.id;
}

function buttonClass(kind: 'primary' | 'secondary' | 'danger'): string {
  const base = 'inline-flex items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
  if (kind === 'danger') return `${base} bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-500`;
  if (kind === 'secondary') return `${base} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus:ring-slate-400`;
  return `${base} bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-500`;
}

export default function ManagerDashboard({
  resource,
  primary,
  busy,
  error,
  permissionRemembered,
  onInstall,
  onTeardown,
  onRetry,
  onResetPermission,
  resourceAmbiguous = false,
}: ManagerDashboardProps) {
  const ready = isReady(resource, primary);
  const legacy = resource !== null && primary === null;
  const recovery = resourceAmbiguous || (!ready && !legacy && (resource !== null || primary !== null));

  let content;
  if (resourceAmbiguous) {
    content = (
      <section className="rounded-2xl border border-rose-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">PostgreSQL requires recovery</h2>
        <p className="mt-3 text-sm text-rose-700">Multiple PostgreSQL resources were found. Teardown and reinstall are required.</p>
        <button type="button" disabled={busy} onClick={onRetry} className={`${buttonClass('secondary')} mt-6`}>Retry recovery</button>
      </section>
    );
  } else if (ready) {
    content = (
      <section className="rounded-2xl border border-emerald-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium uppercase tracking-wide text-emerald-700">PostgreSQL service</p>
            <h2 className="mt-1 text-2xl font-semibold text-slate-900">PostgreSQL is installed</h2>
          </div>
          <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">Ready</span>
        </div>
        <p className="mt-4 text-sm text-slate-600">The service is ready for logical database connections.</p>
        <p className="mt-3 text-xs text-slate-500">Resource: <span className="font-mono">{resource?.id}</span></p>
        {permissionRemembered && <p className="mt-2 text-sm text-slate-600">Installation-wide connection approval is remembered.</p>}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button type="button" disabled={busy} onClick={onTeardown} className={buttonClass('danger')}>Teardown PostgreSQL</button>
          {permissionRemembered ? (
            <button type="button" disabled={busy} onClick={onResetPermission} className={buttonClass('secondary')}>
              Reset remembered connection approval
            </button>
          ) : (
            <span className="text-sm text-slate-500">Connection approval is requested per caller.</span>
          )}
        </div>
      </section>
    );
  } else if (legacy) {
    content = (
      <section className="rounded-2xl border border-amber-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium uppercase tracking-wide text-amber-700">Action required</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-900">PostgreSQL requires reinstall</h2>
        <p className="mt-3 text-sm text-amber-800">This installation predates private administrator state. Teardown and reinstall are required.</p>
        <button type="button" disabled={busy} onClick={onTeardown} className={`${buttonClass('danger')} mt-6`}>Teardown PostgreSQL</button>
      </section>
    );
  } else if (recovery) {
    content = (
      <section className="rounded-2xl border border-amber-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium uppercase tracking-wide text-amber-700">Recovery</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-900">PostgreSQL installation needs recovery</h2>
        <p className="mt-3 text-sm text-amber-800">The installation state is incomplete. Resolve recovery before starting another operation.</p>
        <button type="button" disabled={busy} onClick={onRetry} className={`${buttonClass('secondary')} mt-6`}>Retry recovery</button>
      </section>
    );
  } else {
    content = (
      <section className="rounded-2xl border border-indigo-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium uppercase tracking-wide text-indigo-700">PostgreSQL service</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-900">Install PostgreSQL</h2>
        <p className="mt-3 text-sm text-slate-600">Install a private PostgreSQL service with persistent storage.</p>
        <button type="button" disabled={busy} onClick={onInstall} className={`${buttonClass('primary')} mt-6`}>Install PostgreSQL</button>
      </section>
    );
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 lg:px-8" aria-busy={busy}>
      <header className="mb-6">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-indigo-600">Deploy Commander</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">PostgreSQL manager</h1>
        <p className="mt-2 text-sm text-slate-600">Manage the shared service and its logical connections.</p>
      </header>
      {busy && <p role="status" aria-live="polite" className="mb-4 rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-700">Working…</p>}
      {error && <p role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</p>}
      {content}
    </main>
  );
}
