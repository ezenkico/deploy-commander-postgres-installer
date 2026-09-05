# PostgreSQL Platform Connection Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return an authoritative runner-compatible PostgreSQL platform connection on every successful logical-connection path while preserving legacy connections and fixing the related validation, recovery, lifecycle, and documentation gaps.

**Architecture:** Add a focused connection-contract module that validates and clones `RPC.CreateConnection` results with the current resource-owned `PlatformConnection`. Creation and recovery both depend on that module, persisted metadata includes the post-lock revalidated platform connection, and the child interface continues returning the shared `RPC.CreateConnection` shape.

**Tech Stack:** React 19, TypeScript 5.9, Vitest 4, Deploy Commander installer-interface RPC, Deploy Commander runner metadata, SurrealDB manager state.

**Spec:** `docs/superpowers/specs/2026-09-05-postgres-platform-connection-handoff-design.md`

## Global Constraints

- Obtain the network only from the PostgreSQL resource's authorized `config.platform_connection` and validate it with `parsePlatformConnection`.
- Never derive, construct, rename, or create the Docker network in manager code.
- Keep the child success result compatible with `RPC.CreateConnection`; do not introduce a wrapper response or shared RPC change.
- Keep `host: "postgres"`, `port: 5432`, generated database/role identifiers, and logical password in connection metadata.
- Add `platform_connection` to new persisted metadata and to every returned connection result.
- Enrich only otherwise-valid legacy metadata when `platform_connection` is absent; a present invalid field fails closed.
- Replace a valid but stale stored platform value only in the returned clone; never mutate an RPC object received from the caller.
- Never return a recovered connection to a child request whose trusted caller differs from the journal caller.
- Do not log or display administrator credentials, logical credentials, or platform connection details.
- Use fixed non-secret child errors: `400`, `409`, `499`, `503`, and `500` according to the approved spec.
- Preserve all existing journal phases, compare-and-set transitions, exact run correlation, cleanup ordering, and duplicate-race behavior.
- Dependency upgrades and development-server host policy are outside this plan.
- Use test-driven development: add each behavioral test first, observe the expected failure, then write the minimum implementation.

---

### Task 1: Add the PostgreSQL connection contract boundary

**Files:**

- Create: `postgres-interface/src/lib/postgresErrors.ts`
- Create: `postgres-interface/src/lib/postgresConnectionContract.ts`
- Create: `postgres-interface/src/lib/postgresConnectionContract.test.ts`

**Interfaces:**

- Consumes: `RPC.ConnectionItem`, `RPC.CreateConnection`, `RPCCaller`, `PlatformConnection`, and `parsePlatformConnection`.
- Produces: `PostgresRecoveryRequiredError`, `normalizePostgresConnection(value, expected, platform)`, and `findExistingConnection(caller, managerId, resourceId, platform)`.

- [ ] **Step 1: Write all failing contract tests**

Create `postgres-interface/src/lib/postgresConnectionContract.test.ts` with canonical fixtures and tests for legacy enrichment, stale replacement, immutability, and strict metadata validation:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import type { PlatformConnection } from './postgresContracts';
import {
  findExistingConnection,
  normalizePostgresConnection,
} from './postgresConnectionContract';
import { PostgresRecoveryRequiredError } from './postgresErrors';

const platform: PlatformConnection = {
  type: 'Platform',
  data: { network: 'current-postgres-network' },
};
const summary: RPC.ConnectionItem = {
  id: 'connection-1',
  manager: 'manager-2',
  resource: 'resource-1',
  external: false,
  created_at: 'now',
  updated_at: 'now',
};
const logicalMetadata = {
  host: 'postgres',
  port: 5432,
  database: 'db_0123456789abcdef0123456789abcdef',
  username: 'pg_user_0123456789abcdef0123456789abcdef',
  password: 'logical-password',
};

function full(metadata: Record<string, unknown>, id = summary.id) {
  return {
    connection: { ...summary, id },
    config: {
      id,
      manager: summary.manager,
      resource: summary.resource,
      metadata,
    },
  };
}

const expected = { managerId: 'manager-2', resourceId: 'resource-1' };

describe('normalizePostgresConnection', () => {
  it('enriches otherwise-valid legacy metadata without mutating the RPC result', () => {
    const received = full(logicalMetadata);
    const before = structuredClone(received);

    const normalized = normalizePostgresConnection(received, expected, platform);

    expect(normalized.config.metadata).toEqual({
      ...logicalMetadata,
      platform_connection: platform,
    });
    expect(received).toEqual(before);
    expect(normalized).not.toBe(received);
    expect(normalized.config).not.toBe(received.config);
    expect(normalized.config.metadata).not.toBe(received.config.metadata);
  });

  it('replaces a valid stale platform connection with the authoritative value', () => {
    const normalized = normalizePostgresConnection(full({
      ...logicalMetadata,
      platform_connection: {
        type: 'Platform',
        data: { network: 'stale-network' },
      },
    }), expected, platform);

    expect(normalized.config.metadata).toMatchObject({
      platform_connection: platform,
    });
  });

  it.each([
    ['host', { ...logicalMetadata, host: 'database' }],
    ['port', { ...logicalMetadata, port: 5433 }],
    ['database', { ...logicalMetadata, database: 'postgres' }],
    ['username', { ...logicalMetadata, username: 'postgres' }],
    ['password', { ...logicalMetadata, password: '' }],
    ['platform', {
      ...logicalMetadata,
      platform_connection: { type: 'Platform', data: { network: '' } },
    }],
  ])('rejects malformed %s metadata', (_field, metadata) => {
    expect(() => normalizePostgresConnection(full(metadata), expected, platform))
      .toThrow(PostgresRecoveryRequiredError);
  });

  it('rejects a full connection whose id differs from its configuration id', () => {
    const received = full(logicalMetadata);
    received.config.id = 'connection-other';
    expect(() => normalizePostgresConnection(received, expected, platform))
      .toThrow(PostgresRecoveryRequiredError);
  });

  it('rejects a looked-up result whose id differs from the summary id', () => {
    expect(() => normalizePostgresConnection(
      full(logicalMetadata, 'connection-other'),
      { ...expected, connectionId: summary.id },
      platform,
    )).toThrow(PostgresRecoveryRequiredError);
  });
});
```

In the same test file, add lookup tests before running the suite:

```ts
describe('findExistingConnection', () => {
  it('returns one authorized connection enriched with the current platform', async () => {
    const caller = {
      getConnections: vi.fn().mockResolvedValue({
        items: [summary], limit: 50, offset: 0, total: 1,
      }),
      getConnection: vi.fn().mockResolvedValue(full(logicalMetadata)),
    } as unknown as RPCCaller;

    await expect(findExistingConnection(
      caller, 'manager-2', 'resource-1', platform,
    )).resolves.toMatchObject({
      config: { metadata: { platform_connection: platform } },
    });
  });

  it('rejects multiple matching connections across pages', async () => {
    const second = { ...summary, id: 'connection-2' };
    const caller = {
      getConnections: vi.fn()
        .mockResolvedValueOnce({ items: [summary], limit: 1, offset: 0, total: 2 })
        .mockResolvedValueOnce({ items: [second], limit: 1, offset: 1, total: 2 }),
      getConnection: vi.fn().mockImplementation(async (id: string) =>
        full(logicalMetadata, id)),
    } as unknown as RPCCaller;

    await expect(findExistingConnection(
      caller, 'manager-2', 'resource-1', platform,
    )).rejects.toThrow(PostgresRecoveryRequiredError);
  });

  it.each([
    { items: [], limit: 50, offset: 0, total: 1 },
    { items: [summary], limit: 0, offset: 0, total: 1 },
    { items: [summary], limit: 50, offset: 1, total: 1 },
  ])('rejects inconsistent page data %#', async (page) => {
    const caller = {
      getConnections: vi.fn().mockResolvedValue(page),
    } as unknown as RPCCaller;
    await expect(findExistingConnection(
      caller, 'manager-2', 'resource-1', platform,
    )).rejects.toThrow(PostgresRecoveryRequiredError);
  });

  it('rejects a connection owned by another manager', async () => {
    const caller = {
      getConnections: vi.fn().mockResolvedValue({
        items: [{ ...summary, manager: 'manager-other' }],
        limit: 50, offset: 0, total: 1,
      }),
    } as unknown as RPCCaller;
    await expect(findExistingConnection(
      caller, 'manager-2', 'resource-1', platform,
    )).rejects.toThrow(PostgresRecoveryRequiredError);
  });

  it('normalizes a connection lookup transport failure', async () => {
    const caller = {
      getConnections: vi.fn().mockRejectedValue(new Error('secret transport detail')),
    } as unknown as RPCCaller;
    await expect(findExistingConnection(
      caller, 'manager-2', 'resource-1', platform,
    )).rejects.toThrow('PostgreSQL connection lookup failed');
  });
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
cd postgres-interface
npm test -- --maxWorkers=1 src/lib/postgresConnectionContract.test.ts
```

Expected: FAIL because `postgresConnectionContract.ts` and `postgresErrors.ts` do not exist.

- [ ] **Step 3: Add the typed recovery error**

Create `postgres-interface/src/lib/postgresErrors.ts`:

```ts
export class PostgresRecoveryRequiredError extends Error {
  constructor() {
    super('PostgreSQL recovery is required');
    this.name = 'PostgresRecoveryRequiredError';
  }
}
```

- [ ] **Step 4: Implement strict normalization without mutation**

Create `postgres-interface/src/lib/postgresConnectionContract.ts` with this public surface:

```ts
import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import { PostgresRecoveryRequiredError } from './postgresErrors';
import {
  parsePlatformConnection,
  type PlatformConnection,
} from './postgresContracts';

export interface ExpectedConnectionIdentity {
  managerId: string;
  resourceId: string;
  connectionId?: string;
}

export function normalizePostgresConnection(
  value: unknown,
  expected: ExpectedConnectionIdentity,
  platform: PlatformConnection,
): RPC.CreateConnection;

export async function findExistingConnection(
  caller: RPCCaller,
  managerId: string,
  resourceId: string,
  platform: PlatformConnection,
): Promise<RPC.CreateConnection | null>;
```

Implement these exact private validation rules:

```ts
const PAGE_LIMIT = 50;
const DATABASE_PATTERN = /^db_[0-9a-f]{32}$/;
const USERNAME_PATTERN = /^pg_user_[0-9a-f]{32}$/;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidConnection(): PostgresRecoveryRequiredError {
  return new PostgresRecoveryRequiredError();
}
```

`normalizePostgresConnection` must:

1. Parse the authoritative `platform` first.
2. Require object-valued `connection`, `config`, and `config.metadata`.
3. Require the full connection and config to have the same nonblank ID.
4. When `expected.connectionId` is present, require both IDs to equal it.
5. Require full connection/config manager and resource fields to equal `expected.managerId` and `expected.resourceId`.
6. Require `connection.external === false` and nonblank `created_at`/`updated_at`.
7. Require exact host/port, generated database/username patterns, and a nonblank password.
8. If metadata owns a `platform_connection` field, validate it even though the authoritative value replaces it.
9. Return a new outer object, new `connection`, new `config`, and new metadata containing `platform_connection: authoritativePlatform`.

Use this return shape after validation:

```ts
return {
  ...value,
  connection: { ...value.connection },
  config: {
    ...value.config,
    metadata: {
      ...value.config.metadata,
      platform_connection: authoritativePlatform,
    },
  },
} as unknown as RPC.CreateConnection;
```

Port the existing page checks from `createPostgresConnection.ts` into this module. `findExistingConnection` must continue paging with `getConnections(PAGE_LIMIT, offset, managerId, resourceId)`, require one unique valid summary across all pages, retrieve it with `getConnection(summary.id)`, and normalize it with `{ managerId, resourceId, connectionId: summary.id }`. RPC lookup failures remain fixed `Error('PostgreSQL connection lookup failed')`; malformed results throw `PostgresRecoveryRequiredError`.

- [ ] **Step 5: Run all contract tests and verify GREEN**

Run:

```bash
npm test -- --maxWorkers=1 src/lib/postgresConnectionContract.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the existing connection workflow tests for regression safety**

Run:

```bash
npm test -- --maxWorkers=1 \
  src/lib/postgresConnectionContract.test.ts \
  src/lib/createPostgresConnection.test.ts
```

Expected: PASS. The old workflow still uses its original lookup implementation in this task.

- [ ] **Step 7: Commit the contract boundary**

```bash
git add postgres-interface/src/lib/postgresErrors.ts \
  postgres-interface/src/lib/postgresConnectionContract.ts \
  postgres-interface/src/lib/postgresConnectionContract.test.ts
git commit -m "feat: add postgres connection contract validation"
```

### Task 2: Persist the authoritative platform connection in new metadata

**Files:**

- Modify: `postgres-interface/src/lib/postgresContracts.ts:8-14`
- Modify: `postgres-interface/src/lib/postgresPlans.ts:187-196`
- Modify: `postgres-interface/src/lib/postgresPlans.test.ts:142-152`

**Interfaces:**

- Consumes: `LogicalCredentials`, `PlatformConnection`, and `parsePlatformConnection`.
- Produces: `buildConnectionMetadata(logical, platform): PostgresConnectionMetadata` where metadata includes `platform_connection`.

- [ ] **Step 1: Change the metadata-builder test first**

Replace the existing metadata assertion with:

```ts
it('returns runner-ready logical connection metadata', () => {
  expect(buildConnectionMetadata(logical, platform)).toEqual({
    host: 'postgres',
    port: 5432,
    database: logical.database,
    username: logical.username,
    password: logical.password,
    platform_connection: platform,
  });
  expect(buildConnectionMetadata(logical, platform)).not.toHaveProperty('PGUSER');
  expect(buildConnectionMetadata(logical, platform)).not.toHaveProperty('PGPASSWORD');
});

it('rejects malformed platform data before building connection metadata', () => {
  expect(() => buildConnectionMetadata(logical, {
    type: 'Platform', data: { network: '   ' },
  })).toThrow('Invalid platform connection');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- --maxWorkers=1 src/lib/postgresPlans.test.ts
```

Expected: FAIL because `buildConnectionMetadata` accepts one argument and omits `platform_connection`.

- [ ] **Step 3: Extend the metadata type and builder**

Add the field in `postgresContracts.ts`:

```ts
export interface PostgresConnectionMetadata {
  host: 'postgres';
  port: 5432;
  database: string;
  username: string;
  password: string;
  platform_connection: PlatformConnection;
}
```

Change the builder to:

```ts
export function buildConnectionMetadata(
  logical: LogicalCredentials,
  platform: PlatformConnection,
): PostgresConnectionMetadata {
  validateLogical(logical);
  const platformConnection = parsePlatformConnection(platform);
  return {
    host: 'postgres',
    port: 5432,
    database: logical.database,
    username: logical.username,
    password: logical.password,
    platform_connection: platformConnection,
  };
}
```

- [ ] **Step 4: Run the metadata tests and verify GREEN**

Run:

```bash
npm test -- --maxWorkers=1 src/lib/postgresPlans.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit persisted metadata support**

```bash
git add postgres-interface/src/lib/postgresContracts.ts \
  postgres-interface/src/lib/postgresPlans.ts \
  postgres-interface/src/lib/postgresPlans.test.ts
git commit -m "feat: include platform connection in postgres metadata"
```

### Task 3: Integrate normalization into creation, races, and recovery

**Files:**

- Modify: `postgres-interface/src/lib/primaryState.ts`
- Modify: `postgres-interface/src/lib/createPostgresConnection.ts`
- Modify: `postgres-interface/src/lib/createPostgresConnection.test.ts`
- Modify: `postgres-interface/src/lib/recoverProvisioning.ts`
- Modify: `postgres-interface/src/lib/recoverProvisioning.test.ts`
- Modify: `postgres-interface/src/lib/appRecovery.ts`
- Modify: `postgres-interface/src/App.tsx`
- Modify: `postgres-interface/src/components/ConnectionRequest.tsx`

**Interfaces:**

- Consumes: Task 1 contract functions and error class; Task 2 `buildConnectionMetadata(logical, platform)`.
- Produces: all creation/recovery connection results normalized with the current platform; `ReadyPrimaryState` exported from `primaryState.ts`; no value or type dependency from recovery to creation.

- [ ] **Step 1: Add failing creation-flow assertions**

Update the successful orchestration test so the mocked `createConnection` echoes the supplied configuration and assert the post-lock value is both persisted and returned:

```ts
const latestPlatform: PlatformConnection = {
  type: 'Platform',
  data: { network: 'latest-postgres-network' },
};
const createConnection = vi.fn(async (
  metadata: Record<string, unknown>,
  manager: string,
  external: boolean,
  resourceId: string,
) => ({
  connection: {
    id: 'connection-1', manager, resource: resourceId, external,
    created_at: 'now', updated_at: 'now',
  },
  config: {
    id: 'connection-1', manager, resource: resourceId, metadata,
  },
}));
```

Use `getResource` to return `latestPlatform`, then assert:

```ts
expect(createConnection).toHaveBeenCalledWith({
  host: 'postgres',
  port: 5432,
  database: logical.database,
  username: logical.username,
  password: logical.password,
  platform_connection: latestPlatform,
}, 'manager-2', false, 'resource-1');

expect(result).toMatchObject({
  config: { metadata: { platform_connection: latestPlatform } },
});
```

Update the existing-connection test fixture to contain valid legacy PostgreSQL metadata instead of `{}` and assert it returns `platform_connection: platform` without permission, start, or persistence. Add a separate malformed-metadata test using `{}` that expects `PostgresRecoveryRequiredError` and no side effects.

- [ ] **Step 2: Add failing recovery assertions**

In `recoverProvisioning.test.ts`, make every committed connection fixture contain valid logical metadata. For the matching committed-connection cases, assert:

```ts
await expect(recoverProvisioning(d, operation)).resolves.toMatchObject({
  kind: 'connection',
  value: {
    config: {
      metadata: {
        database: operation.database,
        username: operation.username,
        platform_connection: platform,
      },
    },
  },
});
```

Add a stale-network fixture and assert recovery returns `deps.platform`, leaves the original fixture unchanged, releases only the matching journal, and retains the existing different-caller guard.

- [ ] **Step 3: Run the focused workflow tests and verify RED**

Run:

```bash
npm test -- --maxWorkers=1 \
  src/lib/createPostgresConnection.test.ts \
  src/lib/recoverProvisioning.test.ts \
  src/App.test.tsx
```

Expected: FAIL because workflow calls still omit the platform argument, existing/recovered results are not normalized, and new persistence omits the post-lock platform value.

- [ ] **Step 4: Move the ready-state type out of the creation workflow**

Add to `primaryState.ts` immediately after `PrimaryState`:

```ts
export type ReadyPrimaryState = PrimaryState & {
  phase: 'ready';
  resourceId: string;
};
```

Remove the local definition from `createPostgresConnection.ts`. Update type imports in `App.tsx`, `ConnectionRequest.tsx`, `appRecovery.ts`, `createPostgresConnection.test.ts`, and `recoverProvisioning.test.ts` to import `ReadyPrimaryState` from `primaryState.ts`.

- [ ] **Step 5: Route creation through the contract module**

In `createPostgresConnection.ts`:

1. Import `findExistingConnection` and `normalizePostgresConnection` from `postgresConnectionContract.ts`.
2. Import `PostgresRecoveryRequiredError` from `postgresErrors.ts`.
3. Delete the local `PAGE_LIMIT`, `invalidConnection`, `validateSummary`, `validatePage`, `validateFullConnection`, and `findExistingConnection` implementations.
4. Throw `PostgresRecoveryRequiredError` for invalid resource, ready-state, or platform-connection conditions that require administrative recovery; preserve the `400` missing-caller error. Wrap `parsePlatformConnection(request.platform)` so its validation detail does not escape as a generic `500`.
5. Change every lookup call to pass the authoritative platform available at that point:

```ts
const existing = await findExistingConnection(
  deps.caller,
  request.callingManagerId,
  request.resource.id,
  platform,
);
```

Use `revalidatedInstallation.platform` for the pre-persistence race lookup and rejected-persistence reconciliation lookup.

6. Persist the post-lock value:

```ts
created = await deps.caller.createConnection(
  buildConnectionMetadata(
    credentials,
    revalidatedInstallation.platform,
  ),
  request.callingManagerId,
  false,
  request.resource.id,
);
```

7. Normalize the created result before releasing the journal and returning:

```ts
created = normalizePostgresConnection(created, {
  managerId: request.callingManagerId,
  resourceId: request.resource.id,
}, revalidatedInstallation.platform);
```

Do not normalize before `createConnection` resolves, and do not delete the journal if result validation fails; that ambiguous persistence state must remain recoverable.

In `createPostgresConnection.test.ts`, stop importing `findExistingConnection` from the workflow module and remove its final standalone lookup/pagination describe block. Task 1 now owns that coverage in `postgresConnectionContract.test.ts`; keep orchestration-specific duplicate tests in the workflow test.

- [ ] **Step 6: Route recovery through the contract module and remove the cycle**

In `recoverProvisioning.ts`:

- Import `findExistingConnection` from `postgresConnectionContract.ts`.
- Import `PostgresRecoveryRequiredError` from `postgresErrors.ts`.
- Import `ReadyPrimaryState` from `primaryState.ts`.
- Import `RunEventSource` and `WaitOptions` directly from `runMonitor.ts`.
- Delete the import from `createPostgresConnection.ts` entirely.
- Replace the `Pick<ConnectionWorkflowDeps, ...>` inheritance with explicit fields:

```ts
export interface ProvisioningRecoveryDeps {
  caller: RPCCaller;
  events: RunEventSource;
  waitForRun: (
    caller: RPCCaller,
    events: RunEventSource,
    runId: string,
    options: WaitOptions,
  ) => Promise<RPC.GetRun>;
  signal: AbortSignal;
  primary: ReadyPrimaryState;
  platform: PlatformConnection;
  requestedCallerId?: string;
}
```

Replace the local recovery error class with:

```ts
function recoveryError(): PostgresRecoveryRequiredError {
  return new PostgresRecoveryRequiredError();
}
```

Pass `deps.platform` to both recovery lookup sites:

```ts
return await findExistingConnection(
  deps.caller,
  operation.callerId,
  operation.resourceId,
  deps.platform,
);
```

Do not alter caller guards, journal matching, cleanup decisions, or phase transitions.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```bash
npm test -- --maxWorkers=1 \
  src/lib/postgresConnectionContract.test.ts \
  src/lib/postgresPlans.test.ts \
  src/lib/createPostgresConnection.test.ts \
  src/lib/recoverProvisioning.test.ts \
  src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Verify the module cycle is gone**

Use jCodeMunch:

```text
order("get_dependency_cycles", {
  repo: "ezenki-hq/deploy-commander-postgres-installer"
})
```

Expected: no cycle between `createPostgresConnection.ts` and `recoverProvisioning.ts`. If the index is stale, first run `order("register_edit", { repo, file_paths: [...] })` with every file changed in this task, then repeat the cycle check.

- [ ] **Step 9: Commit workflow integration**

```bash
git add postgres-interface/src/lib/primaryState.ts \
  postgres-interface/src/lib/createPostgresConnection.ts \
  postgres-interface/src/lib/createPostgresConnection.test.ts \
  postgres-interface/src/lib/recoverProvisioning.ts \
  postgres-interface/src/lib/recoverProvisioning.test.ts \
  postgres-interface/src/lib/appRecovery.ts \
  postgres-interface/src/App.tsx \
  postgres-interface/src/components/ConnectionRequest.tsx
git commit -m "feat: return platform connection across postgres workflows"
```

### Task 4: Correct child error mapping and React close lifecycle

**Files:**

- Create: `postgres-interface/src/components/ConnectionRequest.test.tsx`
- Modify: `postgres-interface/src/components/ConnectionRequest.tsx`

**Interfaces:**

- Consumes: `PostgresRecoveryRequiredError`, current `ConnectionRequestProps`, and normalized `RPC.CreateConnection` results.
- Produces: stable exactly-once child closing and typed recovery-to-`503` mapping.

- [ ] **Step 1: Write failing component tests**

Create `ConnectionRequest.test.tsx` with `afterEach(cleanup)` and these cases:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { RPCCaller, RPC, Wire } from '@ezenki/deploy-commander-installer-interface';
import ConnectionRequest from './ConnectionRequest';
import type { ReadyPrimaryState } from '../lib/primaryState';
import { createRunEventSource } from '../lib/runMonitor';

afterEach(cleanup);

const resource = {
  id: 'resource-1', type: 'postgres', name: 'postgres', external: false,
  created_at: 'now', updated_at: 'now',
} as RPC.ResourceItem;
const primary: ReadyPrimaryState = {
  phase: 'ready', operationId: 'primary-1',
  credentials: {
    username: 'pg_admin_0123456789abcdef0123456789abcdef',
    password: 'admin-password',
  },
  runId: 'run-1', resourceId: resource.id,
  initializedAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
};

function baseProps(caller: RPCCaller, wire: Wire) {
  return {
    caller,
    wire,
    events: createRunEventSource(),
    currentManagerId: 'postgres-manager',
    callingManagerId: 'consumer-manager',
    resource,
    primary,
    storage: {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    } as unknown as Storage,
  };
}

describe('ConnectionRequest', () => {
  it('maps an invalid authoritative platform connection to recovery-required', async () => {
    const wire = { close: vi.fn() } as unknown as Wire;
    const caller = {
      getResource: vi.fn().mockResolvedValue({
        config: { platform_connection: { type: 'Platform', data: { network: '' } } },
      }),
    } as unknown as RPCCaller;

    render(<ConnectionRequest {...baseProps(caller, wire)} />);

    await waitFor(() => expect(wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager',
      ok: false,
      error: { status: 503, message: 'PostgreSQL recovery is required' },
    }));
  });

  it('closes an initial success exactly once across a rerender', async () => {
    const wire = { close: vi.fn() } as unknown as Wire;
    const caller = {} as RPCCaller;
    const initialResult = {
      connection: { id: 'connection-1' },
      config: { metadata: {} },
    } as RPC.CreateConnection;
    const props = { ...baseProps(caller, wire), initialResult };
    const view = render(<ConnectionRequest {...props} />);

    await waitFor(() => expect(wire.close).toHaveBeenCalledTimes(1));
    view.rerender(<ConnectionRequest {...props} />);
    await waitFor(() => expect(wire.close).toHaveBeenCalledTimes(1));
  });
});
```

- [ ] **Step 2: Run the component test and verify RED**

Run:

```bash
npm test -- --maxWorkers=1 src/components/ConnectionRequest.test.tsx
```

Expected: the invalid platform case closes with `500`, not `503`.

- [ ] **Step 3: Use the typed recovery error and stabilize `closeOnce`**

In `ConnectionRequest.tsx`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { PostgresRecoveryRequiredError } from '../lib/postgresErrors';
```

Map typed recovery before the generic fallback:

```ts
if (error instanceof PostgresRecoveryRequiredError
  || error instanceof Error && error.message === 'PostgreSQL recovery is required') {
  return { status: 503, message: 'PostgreSQL recovery is required' };
}
```

Wrap authoritative platform parsing:

```ts
let platform;
try {
  platform = parsePlatformConnection(config.platform_connection);
} catch {
  throw new PostgresRecoveryRequiredError();
}
```

Make closing stable:

```ts
const closeOnce = useCallback((response: {
  ok: boolean;
  result?: RPC.CreateConnection;
  status?: number;
  message?: string;
}) => {
  if (closedRef.current || !wire) return;
  closedRef.current = true;
  if (response.ok) {
    wire.close({ manager: currentManagerId, ok: true, result: response.result });
  } else {
    closeError(
      wire,
      currentManagerId,
      response.status ?? 500,
      response.message ?? 'Unable to create the PostgreSQL connection',
    );
  }
}, [currentManagerId, wire]);
```

Add `closeOnce` to the effect dependency array. Do not remove `closedRef`, and do not make permission callbacks effect dependencies.

- [ ] **Step 4: Run component/App tests and lint**

Run:

```bash
npm test -- --maxWorkers=1 \
  src/components/ConnectionRequest.test.tsx \
  src/App.test.tsx
npm run lint -- --max-warnings=0
```

Expected: tests PASS and ESLint reports zero warnings.

- [ ] **Step 5: Commit child-interface corrections**

```bash
git add postgres-interface/src/components/ConnectionRequest.tsx \
  postgres-interface/src/components/ConnectionRequest.test.tsx
git commit -m "fix: classify postgres recovery responses"
```

### Task 5: Make the supported test command deterministic

**Files:**

- Modify: `postgres-interface/vite.config.ts:14-18`

**Interfaces:**

- Consumes: Vitest project configuration.
- Produces: `npm test` runs with one file worker by default while preserving concurrency inside individual tests.

- [ ] **Step 1: Reproduce the configuration failure**

Run without a CLI worker override:

```bash
cd postgres-interface
npm test
```

Expected in the supported constrained container before the change: FAIL with Vitest fork workers timing out before test execution. If the environment happens to provide enough worker capacity, record that the red condition is environment-dependent and continue using the previously captured failure from the approved spec; do not manufacture an application test failure.

- [ ] **Step 2: Limit file-level workers in project configuration**

Add one field to the existing `test` block in `vite.config.ts`:

```ts
test: {
  environment: "jsdom",
  setupFiles: ["./src/test/setup.ts"],
  restoreMocks: true,
  maxWorkers: 1,
},
```

Do not change fake-timer behavior, test isolation, or the explicit concurrent connection-locking test.

- [ ] **Step 3: Run the default command and verify GREEN**

Run:

```bash
npm test
```

Expected: 15 test files pass, 2 opt-in integration files skip, and all 156 existing runnable tests plus the new tests pass. Use the actual new test count in the execution report because Tasks 1-4 add cases.

- [ ] **Step 4: Commit deterministic test configuration**

```bash
git add postgres-interface/vite.config.ts
git commit -m "test: limit vitest worker fanout"
```

### Task 6: Document the runner-ready consumer contract

**Files:**

- Modify: `docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md:82-159`
- Modify: `docs/superpowers/specs/2026-08-30-postgres-logical-connections-design.md:149-165`

**Interfaces:**

- Consumes: implemented `PostgresConnectionMetadata` and the runner `ResourceConnection` contract.
- Produces: copyable consumer guidance showing direct service network attachment.

- [ ] **Step 1: Add the platform field to the successful-result schema**

In `POSTGRES_MANAGER_INTERFACE_GUIDE.md`, extend `config.metadata`:

```ts
platform_connection: {
  type: "Platform",
  data: {
    network: string,
  },
},
```

Add a metadata table row:

```markdown
| `platform_connection` | `PlatformConnection` | Authoritative runner-generated Docker resource connection; pass the complete value to the consuming service's `connections` array |
```

- [ ] **Step 2: Replace the consumer example with a runner-ready example**

The guide must show both application configuration and runner attachment:

```ts
const metadata = created.config.metadata as {
  host: "postgres";
  port: 5432;
  database: string;
  username: string;
  password: string;
  platform_connection: {
    type: "Platform";
    data: { network: string };
  };
};

const plan = {
  services: {
    app: {
      image: "your-application-image",
      connections: [metadata.platform_connection],
      environment: {
        PGHOST: metadata.host,
        PGPORT: String(metadata.port),
        PGDATABASE: metadata.database,
        PGUSER: metadata.username,
        PGPASSWORD: metadata.password,
      },
    },
  },
};
```

State explicitly:

- The full `PlatformConnection` is runner input; the Docker network string is not an application environment variable.
- Consumers must not reconstruct or prefix `data.network`.
- `postgres` resolves only for a workload whose runner service includes this connection.
- The child workflow enriches otherwise-valid legacy records at response time; consumers should re-open the child workflow instead of assuming a separately cached historical `getConnection` response has the field.
- The complete metadata object contains credentials and must not be logged.

- [ ] **Step 3: Correct the older design statement**

Replace:

```markdown
The stable alias is the hostname and the resource association provides the platform relationship.
```

With:

```markdown
The stable alias is the hostname. The resource association authorizes the platform relationship, while the connection metadata's resolved `platform_connection` provides the concrete runner input required to attach a consuming service to the resource network.
```

Also update that older design's `PostgresConnectionMetadata` example to contain `platform_connection: PlatformConnection` so the two approved design documents do not contradict one another.

- [ ] **Step 4: Verify documentation contract text**

Run:

```bash
rg -n "platform_connection|connections: \[metadata\.platform_connection\]|must not reconstruct|legacy" \
  docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md \
  docs/superpowers/specs/2026-08-30-postgres-logical-connections-design.md
rg -n "resource association provides the platform relationship" \
  docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md \
  docs/superpowers/specs/2026-08-30-postgres-logical-connections-design.md
```

Expected: the first command shows the new schema, example, and cautions. The second command returns no matches.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md \
  docs/superpowers/specs/2026-08-30-postgres-logical-connections-design.md
git commit -m "docs: explain postgres runner network attachment"
```

### Task 7: Run full verification and record audit follow-ups

**Files:**

- Modify only if a verification failure exposes a defect in an already-touched file; use a new failing regression test before any production-code correction.

**Interfaces:**

- Consumes: all preceding tasks and the approved spec checklist.
- Produces: fresh evidence for tests, lint, build, dependency status, module boundaries, and repository cleanliness.

- [ ] **Step 1: Run the complete unit suite through the supported command**

```bash
cd postgres-interface
npm test
```

Expected: all runnable tests PASS and the two opt-in integration suites SKIP unless their required environment variables are present.

- [ ] **Step 2: Run strict lint and production build**

```bash
npm run lint -- --max-warnings=0
npm run build
```

Expected: both commands exit `0`; lint reports zero warnings and Vite emits the production bundle.

- [ ] **Step 3: Recheck dependency audit evidence without broadening scope**

```bash
npm audit --omit=dev
npm audit
npm ls vite postcss brace-expansion browserslist js-yaml nanoid esbuild
```

Expected from the pre-implementation audit:

- Production audit: zero vulnerabilities.
- Full audit: development-only advisories remain and are reported, not silently fixed in this change.
- `npm ls`: the restored dependency-tree mismatch remains recorded for a separate clean-install/upgrade task.

Do not run `npm audit fix`, change dependency ranges, or rewrite the lockfile as part of this plan.

- [ ] **Step 4: Reindex changed files and verify dependency boundaries**

Use jCodeMunch:

```text
order("register_edit", {
  repo: "ezenki-hq/deploy-commander-postgres-installer",
  file_paths: [
    "postgres-interface/src/lib/postgresErrors.ts",
    "postgres-interface/src/lib/postgresConnectionContract.ts",
    "postgres-interface/src/lib/primaryState.ts",
    "postgres-interface/src/lib/createPostgresConnection.ts",
    "postgres-interface/src/lib/recoverProvisioning.ts",
    "postgres-interface/src/lib/appRecovery.ts",
    "postgres-interface/src/components/ConnectionRequest.tsx",
    "postgres-interface/src/App.tsx"
  ]
})
order("get_dependency_cycles", {
  repo: "ezenki-hq/deploy-commander-postgres-installer"
})
```

Expected: no creation/recovery dependency cycle.

- [ ] **Step 5: Run the opt-in PostgreSQL integration test when available**

If `POSTGRES_INTEGRATION_CONTAINER` and `POSTGRES_INTEGRATION_PASSWORD` are already set to a suitable test container and its administrator password:

```bash
npm test -- src/lib/postgresIntegration.test.ts
```

Expected: provisioning runs twice idempotently, privilege assertions pass, cleanup removes the logical database and role, and no credential appears in output. If no container is supplied, report this test as skipped rather than claiming it passed.

- [ ] **Step 6: Verify repository diff and requirement coverage**

```bash
cd ..
git status --short
git diff HEAD~6 --check
git log -7 --oneline
```

Review the diff against every Global Constraint and every Testing Strategy bullet in the spec. Confirm no administrator credential, caller-controlled network, new RPC, dependency update, or dev-server policy change entered the patch.

- [ ] **Step 7: Commit any verification-only regression correction**

Only when Step 1 or Step 2 exposed a real defect and a new failing test was added first:

```bash
git add postgres-interface/src/lib/postgresErrors.ts \
  postgres-interface/src/lib/postgresConnectionContract.ts \
  postgres-interface/src/lib/postgresConnectionContract.test.ts \
  postgres-interface/src/lib/postgresContracts.ts \
  postgres-interface/src/lib/postgresPlans.ts \
  postgres-interface/src/lib/postgresPlans.test.ts \
  postgres-interface/src/lib/primaryState.ts \
  postgres-interface/src/lib/createPostgresConnection.ts \
  postgres-interface/src/lib/createPostgresConnection.test.ts \
  postgres-interface/src/lib/recoverProvisioning.ts \
  postgres-interface/src/lib/recoverProvisioning.test.ts \
  postgres-interface/src/lib/appRecovery.ts \
  postgres-interface/src/components/ConnectionRequest.tsx \
  postgres-interface/src/components/ConnectionRequest.test.tsx \
  postgres-interface/src/App.tsx \
  postgres-interface/vite.config.ts \
  docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md \
  docs/superpowers/specs/2026-08-30-postgres-logical-connections-design.md
git commit -m "fix: address postgres handoff verification finding"
```

If verification is clean, make no empty commit.

## Execution Notes for Luna Subagents

- Use one fresh Luna implementation subagent per numbered task through `superpowers:subagent-driven-development`.
- Give each implementer only the approved spec, this plan, the task number, and current repository state; do not ask one agent to implement multiple tasks concurrently.
- Run tasks sequentially because Tasks 2-4 depend on Task 1 interfaces and Task 3 depends on Task 2.
- After each task, use the subagent-driven workflow's specification-compliance review followed by code-quality review before starting the next task.
- The controlling agent independently runs the task's verification commands and checks the diff before accepting reviewer conclusions.
- Use Luna for implementers and reviewers only after the user switches the active execution model/configuration as requested.
