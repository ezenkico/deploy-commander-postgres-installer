# PostgreSQL Manager Database Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a new strict manager database boot successfully by defining both private state tables before recovery, while keeping one stable interface client and wire.

**Architecture:** A new `managerDatabase` module owns the two idempotent SurrealQL definitions and strict 0.3.5 result validation. `App` owns an effect-created client independently from repeatable boot attempts, initializes storage before recovery, and maps initialization failure differently for root and child modes.

**Tech Stack:** React 19.2, TypeScript 5.9, manager-interface 0.3.5, SurrealQL, Vitest 4, Testing Library, ESLint 9, Vite 7

**Spec:** `docs/superpowers/specs/2026-09-10-postgres-manager-database-bootstrap-design.md`

## Global Constraints

- Execute commands from `postgres-interface/` unless a step says otherwise.
- Use jCodeMunch for code navigation and symbol/reference discovery.
- Do not add runtime or development dependencies.
- Define exactly `postgres_state` and `postgres_operation` as schemaless tables with `IF NOT EXISTS`.
- Send each definition as its own one-statement `databaseQuery` call without bindings.
- Never log or render raw database results, errors, manager objects, or credentials.
- Preserve existing record IDs, record shapes, phases, transitions, and recovery semantics.
- Every behavior change starts with a failing test or failing static check.
- Keep commits scoped to the task that produced them.

---

### Task 1: Strict Manager Database Initializer

**Files:**
- Create: `postgres-interface/src/lib/managerDatabase.ts`
- Create: `postgres-interface/src/lib/managerDatabase.test.ts`

**Interfaces:**
- Consumes: `RPCCaller.databaseQuery(query: string, bindings?: Record<string, unknown>): Promise<RPC.DatabaseQueryResult>`.
- Produces: `ManagerDatabaseInitializationError` and `initializeManagerDatabase(caller: RPCCaller): Promise<void>`.

- [ ] **Step 1: Write failing tests for exact table definitions and ordering**

Create `src/lib/managerDatabase.test.ts` with the happy-path contract:

```ts
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
});
```

- [ ] **Step 2: Run the initializer tests and verify the missing module failure**

Run:

```bash
npx vitest run src/lib/managerDatabase.test.ts
```

Expected: FAIL because `./managerDatabase` does not exist.

- [ ] **Step 3: Add failing response-validation tests**

Append cases that exercise every rejected 0.3.5 response shape:

```ts
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
```

- [ ] **Step 4: Implement the minimal initializer**

Create `src/lib/managerDatabase.ts`:

```ts
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
```

- [ ] **Step 5: Run the focused tests and lint**

Run:

```bash
npx vitest run src/lib/managerDatabase.test.ts
npx eslint src/lib/managerDatabase.ts src/lib/managerDatabase.test.ts
```

Expected: all initializer tests PASS and ESLint exits zero.

- [ ] **Step 6: Commit the initializer**

```bash
git add src/lib/managerDatabase.ts src/lib/managerDatabase.test.ts
git commit -m "fix: initialize manager database tables"
```

---

### Task 2: Stable Application Client and Boot Ordering

**Files:**
- Modify: `postgres-interface/src/App.tsx:14-198`
- Modify: `postgres-interface/src/App.test.tsx:57-102`

**Interfaces:**
- Consumes: `initializeManagerDatabase(caller: RPCCaller): Promise<void>` from Task 1.
- Produces: an `App` that owns one client per factory, reuses it for retries, initializes storage before recovery, and renders or closes with fixed failures.

- [ ] **Step 1: Update the manager fixture and add a boot-order test**

In `src/App.test.tsx`, change the default manager fixture to the 0.3.5 shape:

```ts
getManager: vi.fn().mockResolvedValue('postgres-manager'),
```

Add the exact definition constants and a test that records database queries:

```ts
const STATE_DEFINITION =
  'DEFINE TABLE IF NOT EXISTS postgres_state SCHEMALESS;';
const OPERATION_DEFINITION =
  'DEFINE TABLE IF NOT EXISTS postgres_operation SCHEMALESS;';

it('initializes both tables before the first recovery read', async () => {
  const queries: string[] = [];
  const current = appClient({
    databaseQuery: vi.fn().mockImplementation(async (query: string) => {
      queries.push(query);
      return databaseResult([]);
    }),
  });

  render(<App createClient={() => current} />);
  await screen.findByRole('button', { name: 'Install PostgreSQL' });

  expect(queries.slice(0, 2)).toEqual([STATE_DEFINITION, OPERATION_DEFINITION]);
  expect(queries.findIndex((query) => query.startsWith('SELECT'))).toBeGreaterThan(1);
});
```

- [ ] **Step 2: Run the boot-order test and verify it fails**

Run:

```bash
npx vitest run src/App.test.tsx -t "initializes both tables"
```

Expected: FAIL because the first database query is currently a recovery read.

- [ ] **Step 3: Add failure, retry-stability, and action-abort tests**

Add tests using an `ERR` response:

```ts
const databaseError = {
  results: [{ statement: 0, status: 'ERR', time: '1ms', result: 'private detail' }],
};

it('shows a fixed retryable storage error in root mode', async () => {
  let stateDefinitions = 0;
  const current = appClient({
    databaseQuery: vi.fn().mockImplementation(async (query: string) => {
      if (query === STATE_DEFINITION && stateDefinitions++ === 0) return databaseError;
      return databaseResult([]);
    }),
  });
  const factory = vi.fn(() => current);

  render(<App createClient={factory} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Unable to initialize PostgreSQL manager storage',
  );
  expect(screen.queryByText('private detail')).not.toBeInTheDocument();

  screen.getByRole('button', { name: 'Retry' }).click();
  await screen.findByRole('button', { name: 'Install PostgreSQL' });
  expect(factory).toHaveBeenCalledTimes(1);
  expect(current.wire.end).not.toHaveBeenCalled();
});

it('closes child mode once with 503 when storage initialization fails', async () => {
  const current = appClient({
    databaseQuery: vi.fn().mockResolvedValue(databaseError),
  }, { action: 'create-connection' });

  render(<App createClient={() => current} />);
  await waitFor(() => expect(current.wire.close).toHaveBeenCalledWith({
    manager: 'postgres-manager',
    ok: false,
    error: { status: 503, message: 'PostgreSQL recovery is required' },
  }));
  expect(current.wire.close).toHaveBeenCalledTimes(1);
});

it('rejects the obsolete object manager shape without logging it', async () => {
  const current = appClient({
    getManager: vi.fn().mockResolvedValue({ id: 'obsolete-manager-shape' }),
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  render(<App createClient={() => current} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Unable to identify the PostgreSQL manager',
  );
  expect(log).not.toHaveBeenCalled();
});
```

Import the lifecycle module as a namespace:

```ts
import * as installationLifecycle from './lib/installationLifecycle';
```

Then assert that unmount aborts local lifecycle waiting:

```ts
it('aborts an in-flight lifecycle wait when the app unmounts', async () => {
  let actionSignal: AbortSignal | undefined;
  vi.spyOn(installationLifecycle, 'installPostgres').mockImplementation(
    async ({ signal }) => {
      actionSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    },
  );
  const current = appClient();
  const view = render(<App createClient={() => current} />);
  await screen.findByRole('button', { name: 'Install PostgreSQL' });

  screen.getByRole('button', { name: 'Install PostgreSQL' }).click();
  await waitFor(() => expect(actionSignal).toBeDefined());
  view.unmount();

  expect(actionSignal?.aborted).toBe(true);
});
```

- [ ] **Step 4: Separate client ownership from repeatable boot attempts**

Keep `clientRef`, but access it only inside effects. Add a renderable
presentation object so render never reads the ref:

```ts
interface AppPresentation {
  factory: AppClientFactory;
  client: AppClient;
  manager: string;
  view: BootView;
}

const [presentation, setPresentation] = useState<AppPresentation | null>(null);
const clientRef = useRef<AppClient | null>(null);
const actionControllerRef = useRef<AbortController | null>(null);
```

Remove the current effect that combines client creation, boot, retry, and wire
cleanup. Replace it with a client-ownership effect that does not depend on the
retry key:

```ts
useEffect(() => {
  const client = createClient(() => undefined);
  clientRef.current = client;
  return () => {
    actionControllerRef.current?.abort();
    client.wire.end();
    if (clientRef.current === client) clientRef.current = null;
  };
}, [createClient]);
```

Declare the boot effect after the ownership effect. React runs effect setup in
declaration order, so the client exists before each boot attempt:

```ts
useEffect(() => {
  const client = clientRef.current;
  if (!client) return undefined;
  let active = true;
  const controller = new AbortController();

  void boot(client, controller.signal).then((next) => {
    if (!active) return;
    const view: BootView = next.mode === 'connection'
      ? {
          kind: 'connection', resource: next.resource, primary: next.primary,
          callerId: next.callerId, error: next.error, result: next.result,
        }
      : {
          kind: 'dashboard', resource: next.resource, primary: next.primary,
          ambiguous: next.ambiguous, error: next.error,
        };
    setPresentation({
      factory: createClient,
      client,
      manager: next.currentManager,
      view,
    });
  }).catch((error: unknown) => {
    if (!active) return;
    setPresentation({
      factory: createClient,
      client,
      manager: '',
      view: {
        kind: 'error',
        message: error instanceof Error
          ? error.message
          : 'Unable to load PostgreSQL manager state',
      },
    });
  });

  return () => {
    active = false;
    controller.abort();
  };
}, [createClient, refreshKey]);
```

Keep `boot` inside this effect or extract it as a module-level function taking
`client` and `signal`; in both cases it must use only the explicitly selected
client. The boot cleanup aborts recovery but never ends the wire.

Add a single event-safe refresh function:

```ts
const requestRefresh = () => {
  setPresentation(null);
  setRefreshKey((value) => value + 1);
};
```

Use it for Retry and after a completed lifecycle action. This shows loading
immediately while retaining the same client.

- [ ] **Step 5: Insert initialization at the mode-aware boot boundary**

Import Task 1:

```ts
import {
  initializeManagerDatabase,
  ManagerDatabaseInitializationError,
} from './lib/managerDatabase';
```

Replace `managerId` with the documented string validation:

```ts
function managerId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
```

After `getMetadata()`, initialize inside the mode-aware flow:

```ts
if (connectionMode) {
  const callingManager = callerId(
    await client.caller.getCallingManager().catch(() => null),
  );
  if (!callingManager) {
    return {
      currentManager, mode: 'connection' as const,
      resource: null, primary: null, callerId: null,
      error: 'A calling manager is required', result: null,
    };
  }
  try {
    await initializeManagerDatabase(client.caller);
  } catch {
    return {
      currentManager, mode: 'connection' as const,
      resource: null, primary: null, callerId: callingManager,
      error: 'PostgreSQL recovery is required', result: null,
    };
  }
}

await initializeManagerDatabase(client.caller);
```

Keep the current connection recovery and authoritative reads immediately after
the child-mode `try`/`catch`. Keep the current installation, teardown, and
connection recovery calls immediately after the root-mode initialization call.
This placement makes both definitions complete before the first state query.

In the root catch, preserve `ManagerDatabaseInitializationError.message`; map
all unrelated non-`Error` values to `Unable to load PostgreSQL manager state`.

- [ ] **Step 6: Render only from the selected state client**

Select only a presentation produced by the current factory, then pass its
client directly:

```tsx
const current = presentation?.factory === createClient ? presentation : null;
if (!current) return <div role="status">Loading</div>;
const { client, manager, view } = current;
if (view.kind === 'error') {
  return <div>
    <p role="alert">{view.message}</p>
    <button type="button" onClick={requestRefresh}>
      Retry
    </button>
  </div>;
}
if (view.kind === 'connection') {
  return <ConnectionRequest
    caller={client.caller}
    events={client.events}
    wire={client.wire}
    currentManagerId={manager ?? ''}
    callingManagerId={view.callerId}
    resource={view.resource}
    primary={view.primary}
    initialError={view.error}
    initialResult={view.result}
  />;
}
const appClient = client;
```

Remove the old `loading`, `manager`, and `view` state variables. Keep the
existing dashboard storage behavior, reading manager and view from `current`.
Change `runAction` to own an abort controller:

```ts
const runAction = async (action: (signal: AbortSignal) => Promise<void>) => {
  if (actionBusy) return;
  const controller = new AbortController();
  actionControllerRef.current = controller;
  setActionBusy(true);
  setActionError(null);
  try {
    await action(controller.signal);
    requestRefresh();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return;
    setActionError(
      error instanceof Error && error.message.includes('recovery')
        ? 'PostgreSQL recovery is required'
        : 'Unable to complete PostgreSQL lifecycle action',
    );
  } finally {
    if (actionControllerRef.current === controller) {
      actionControllerRef.current = null;
    }
    setActionBusy(false);
  }
};
```

Pass its signal to the existing workflows:

```tsx
onInstall={() => {
  void runAction((signal) => installPostgres({
    caller: appClient.caller,
    events: appClient.events,
    signal,
  }));
}}
onTeardown={() => {
  if (!view.resource) return;
  void runAction((signal) => teardownPostgres({
    caller: appClient.caller,
    events: appClient.events,
    signal,
    managerId: manager || undefined,
    storage,
  }, view.resource));
}}
```

- [ ] **Step 7: Run App tests and targeted lint**

Run:

```bash
npx vitest run src/App.test.tsx src/lib/managerDatabase.test.ts
npx eslint src/App.tsx src/App.test.tsx src/lib/managerDatabase.ts src/lib/managerDatabase.test.ts
```

Expected: all focused tests PASS; `App.tsx` has no `react-hooks/refs` errors.

- [ ] **Step 8: Commit boot integration**

```bash
git add src/App.tsx src/App.test.tsx
git commit -m "fix: bootstrap storage before manager recovery"
```

---

### Task 3: Real Database Contract for Both State Stores

**Files:**
- Modify: `postgres-interface/src/lib/managerDatabaseIntegration.test.ts:1-56`

**Interfaces:**
- Consumes: `initializeManagerDatabase`, primary-state CRUD, and operation-journal CRUD.
- Produces: opt-in integration evidence for table creation and both fixed records.

- [ ] **Step 1: Extend imports and add a journal fixture**

Add these imports:

```ts
import { initializeManagerDatabase } from './managerDatabase';
import {
  acquireOperation,
  deleteOperation,
  readOperation,
  transitionOperation,
  type ConnectionOperation,
} from './provisioningJournal';
```

Add a non-secret journal fixture:

```ts
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
```

- [ ] **Step 2: Make the primary contract initialize a new database first**

Immediately after `const caller = await loadCaller();`, add:

```ts
await initializeManagerDatabase(caller);
```

Keep the existing primary create/read/CAS/delete assertions and `finally`
cleanup unchanged.

- [ ] **Step 3: Add the operation-journal integration contract**

Add a second test inside the opt-in describe block:

```ts
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
```

- [ ] **Step 4: Run the integration test in default skip mode**

Run:

```bash
npx vitest run src/lib/managerDatabaseIntegration.test.ts
```

Expected without `MANAGER_DATABASE_HARNESS_MODULE`: the file reports two skipped
tests and exits zero. When the harness is available, rerun with that environment
variable and require both tests to PASS.

- [ ] **Step 5: Commit the integration contract**

```bash
git add src/lib/managerDatabaseIntegration.test.ts
git commit -m "test: cover manager database bootstrap contract"
```

---

### Task 4: Eliminate Remaining Render-Time Ref Mutations and Dead Entry Points

**Files:**
- Modify: `postgres-interface/src/components/PermissionDialog.tsx:25-31`
- Delete: `postgres-interface/src/components/Install.tsx`
- Delete: `postgres-interface/src/components/Teardown.tsx`

**Interfaces:**
- Consumes: existing `PermissionDialog` props and behavior.
- Produces: unchanged dialog behavior without render-time ref writes and one production lifecycle entry point through `App`.

- [ ] **Step 1: Confirm the two remaining static failures**

Run:

```bash
npx eslint src/components/PermissionDialog.tsx
```

Expected: FAIL at the render-time assignments to `busyRef.current` and
`cancelRef.current`.

- [ ] **Step 2: Move current-value synchronization into effects**

Replace the two render-time assignments with:

```ts
useEffect(() => {
  busyRef.current = busy;
}, [busy]);

useEffect(() => {
  cancelRef.current = onCancel;
}, [onCancel]);
```

Keep the mount-only focus and keyboard effect unchanged so rerenders do not
restore and recapture focus.

- [ ] **Step 3: Verify dialog behavior and lint**

Run:

```bash
npx vitest run src/components/PermissionDialog.test.tsx
npx eslint src/components/PermissionDialog.tsx
```

Expected: all dialog tests PASS and ESLint exits zero.

- [ ] **Step 4: Confirm the standalone components have no importers**

Use jCodeMunch `find_references` for identifiers `Install` and `Teardown` and
`find_importers` for both component files.

Expected: no production or test importers. Do not delete either file if an
importer is discovered; report the conflict for review.

- [ ] **Step 5: Delete the unused entry points**

Delete:

```text
src/components/Install.tsx
src/components/Teardown.tsx
```

Then run:

```bash
npx tsc -b
```

Expected: PASS with no unresolved imports.

- [ ] **Step 6: Commit the cleanup**

```bash
git add src/components/PermissionDialog.tsx src/components/Install.tsx src/components/Teardown.tsx
git commit -m "refactor: enforce initialized lifecycle entry point"
```

---

### Task 5: Reliability Verification

**Files:**
- Verify only; modify files only to correct a failure caused by Tasks 1-4.

**Interfaces:**
- Consumes: all deliverables from Tasks 1-4.
- Produces: independently releasable reliability foundation for the console plan.

- [ ] **Step 1: Run the complete test suite**

```bash
npm test
```

Expected: all non-opt-in tests PASS; only explicitly configured integration
suites may skip.

- [ ] **Step 2: Run the complete lint suite**

```bash
npm run lint
```

Expected: zero errors and zero warnings.

- [ ] **Step 3: Run the production build**

```bash
npm run build
```

Expected: TypeScript and Vite both complete successfully.

- [ ] **Step 4: Check patch integrity and secret exposure**

From the repository root, run:

```bash
git diff --check
git status --short
```

Inspect the task commits and confirm that no query response, database error,
manager object, administrator username, or password was added to logging or UI
output.

- [ ] **Step 5: Record verification without creating an empty commit**

If verification required a source correction, commit that correction with the
smallest relevant files and a message describing the defect. If no correction
was required, leave the task commits unchanged and report the exact commands
and results to the reviewer.
