# Manager Interface 0.3.5 Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the PostgreSQL manager correctly reject resolved database statement errors under installer-interface 0.3.5, omit unused bindings, and restore a successful TypeScript production build.

**Architecture:** Retain the two domain-specific database adapters in `primaryState.ts` and `provisioningJournal.ts`, but make each validate the complete 0.3.5 single-statement envelope before returning application data. A typed test helper supplies ordinary successful envelopes across the suite; exceptional response tests remain explicit, and resource fixtures gain their already-required owner field.

**Tech Stack:** React 19, TypeScript 5.9, Vitest 4, ESLint 9, Vite 7, `@ezenki/deploy-commander-installer-interface` 0.3.5, SurrealQL manager-database RPC.

**Spec:** `docs/superpowers/specs/2026-09-10-manager-interface-0.3.5-compatibility-design.md`

## Global Constraints

- Accept `databaseQuery` data only when it returns exactly one statement with `statement === 0`, `status === "OK"`, string `time`, and an own `result` property.
- Treat a complete `status: "ERR"` primary-state statement as `Primary state database operation failed`; treat missing/unknown status or malformed time as `Invalid primary state database result`.
- Map every rejected, `"ERR"`, or malformed journal database response through the existing private `JournalDatabaseError` and public `OperationDatabaseError` boundary.
- Never expose query text, bindings, statement results, credentials, timing, or transport details in errors.
- Omit bindings only for `readPrimaryState`, `readOperation`, and the `acquireOperation` fallback read; preserve bindings on every mutation.
- Preserve all SurrealQL text, state transitions, compare-and-set checks, lock ordering, recovery behavior, and manager authorization boundaries.
- Do not add `updateConnection` or `deleteConnection` calls and do not change PostgreSQL teardown behavior.
- Do not fix the existing React ref-access lint failures in `src/App.tsx` or `src/components/PermissionDialog.tsx`.
- Do not stage or commit the user's existing changes to `docs/integrations/MANAGER_INTERFACE_GUIDE.md`, `postgres-interface/package.json`, or `postgres-interface/package-lock.json`.
- Use test-driven development: add each regression test first, observe the intended failure, then implement the smallest production change.
- Run npm, Vitest, Vite, ESLint, and `src/...` path commands from `postgres-interface`; run `git add`, `git commit`, `git show`, and `git status` from the repository root.

## File Structure

- Create `postgres-interface/src/test/databaseQuery.ts`: typed factory for ordinary one-statement `"OK"` database responses in tests.
- Modify `postgres-interface/src/lib/primaryState.ts`: optional binding dispatch and complete primary-state statement validation.
- Modify `postgres-interface/src/lib/provisioningJournal.ts`: optional binding dispatch and complete journal statement validation.
- Modify `postgres-interface/src/lib/primaryState.test.ts`: primary error-envelope coverage, omitted-binding assertion, complete response fixtures, and resource owner fields.
- Modify `postgres-interface/src/lib/provisioningJournal.test.ts`: journal error-envelope coverage, omitted-binding assertion, and complete response fixtures.
- Modify `postgres-interface/src/App.test.tsx`, `src/lib/createPostgresConnection.test.ts`, `src/lib/installationLifecycle.test.ts`, and `src/lib/recoverProvisioning.test.ts`: complete database response fixtures.
- Modify `postgres-interface/src/components/ManagerDashboard.test.tsx`, `src/lib/createPostgresConnection.test.ts`, `src/lib/installationLifecycle.test.ts`, and `src/lib/primaryState.test.ts`: complete resource fixtures.

---

### Task 1: Restore the `ResourceItem` test contract

**Files:**

- Modify: `postgres-interface/src/components/ManagerDashboard.test.tsx:6`
- Modify: `postgres-interface/src/lib/createPostgresConnection.test.ts:9`
- Modify: `postgres-interface/src/lib/installationLifecycle.test.ts:6`
- Modify: `postgres-interface/src/lib/primaryState.test.ts:23,148,183`

**Interfaces:**

- Consumes: `RPC.ResourceItem`, whose required fields include `manager: string`.
- Produces: canonical PostgreSQL resource fixtures owned by `postgres-manager`; no production interface changes.

- [ ] **Step 1: Reproduce the production-build type failure**

Run:

```bash
cd postgres-interface
npm run build
```

Expected: FAIL with ten `TS2741` diagnostics stating that property `manager` is missing from `ResourceItem` values in the four listed test files.

- [ ] **Step 2: Complete each canonical resource fixture**

In `src/components/ManagerDashboard.test.tsx`, use:

```ts
const resource = {
  id: 'resource-1', type: 'postgres', name: 'postgres', external: false,
  manager: 'postgres-manager',
  created_at: '2026-08-30T00:00:00.000Z', updated_at: '2026-08-30T00:00:00.000Z',
};
```

In `src/lib/createPostgresConnection.test.ts`, preserve its timestamps and add:

```ts
manager: 'postgres-manager',
```

to the top-level `const resource: RPC.ResourceItem`.

In `src/lib/installationLifecycle.test.ts`, make the compact fixture:

```ts
const resource: RPC.ResourceItem = {
  id: 'resource-1', type: 'postgres', name: 'postgres', external: false,
  manager: 'postgres-manager', created_at: 'now', updated_at: 'now',
};
```

In `src/lib/primaryState.test.ts`, add `manager: 'postgres-manager'` to `pageResource` and to both locally declared `RPC.ResourceItem` values. Do not add the field to the deliberately malformed `{ id: 123, ... }` response.

- [ ] **Step 3: Verify the fixture changes**

Run:

```bash
npm test -- src/components/ManagerDashboard.test.tsx src/lib/createPostgresConnection.test.ts src/lib/installationLifecycle.test.ts src/lib/primaryState.test.ts
npm run build
```

Expected: the four focused test files PASS, and TypeScript plus Vite complete the production build.

- [ ] **Step 4: Check formatting and scope**

Run:

```bash
npx eslint src/components/ManagerDashboard.test.tsx src/lib/createPostgresConnection.test.ts src/lib/installationLifecycle.test.ts src/lib/primaryState.test.ts
git diff --check -- src/components/ManagerDashboard.test.tsx src/lib/createPostgresConnection.test.ts src/lib/installationLifecycle.test.ts src/lib/primaryState.test.ts
```

Expected: both commands exit successfully with no diagnostics.

- [ ] **Step 5: Commit only the fixture repair**

```bash
git add postgres-interface/src/components/ManagerDashboard.test.tsx postgres-interface/src/lib/createPostgresConnection.test.ts postgres-interface/src/lib/installationLifecycle.test.ts postgres-interface/src/lib/primaryState.test.ts
git commit -m "test: complete resource ownership fixtures"
```

Expected: the commit contains only these four test files; the user's integration-guide and package changes remain unstaged.

---

### Task 2: Enforce the 0.3.5 database result contract

**Files:**

- Create: `postgres-interface/src/test/databaseQuery.ts`
- Modify: `postgres-interface/src/lib/primaryState.ts:140-157,203-205`
- Modify: `postgres-interface/src/lib/provisioningJournal.ts:311-331,343-348,383-391`
- Modify: `postgres-interface/src/lib/primaryState.test.ts`
- Modify: `postgres-interface/src/lib/provisioningJournal.test.ts`
- Modify: `postgres-interface/src/App.test.tsx`
- Modify: `postgres-interface/src/lib/createPostgresConnection.test.ts`
- Modify: `postgres-interface/src/lib/installationLifecycle.test.ts`
- Modify: `postgres-interface/src/lib/recoverProvisioning.test.ts`

**Interfaces:**

- Consumes: `RPCCaller.databaseQuery(query: string, bindings?: Record<string, unknown>): Promise<RPC.DatabaseQueryResult>`.
- Produces: unchanged public state/journal function signatures and `databaseResult(result: unknown): RPC.DatabaseQueryResult` for tests.

- [ ] **Step 1: Add the failing primary-state error regression**

Add beside the malformed-result tests in `src/lib/primaryState.test.ts`:

```ts
it('rejects a resolved database ERR statement without exposing its result', async () => {
  const caller = {
    databaseQuery: vi.fn().mockResolvedValue({
      results: [{ statement: 0, status: 'ERR', time: '1ms', result: [{
        phase: 'ready', operation_id: 'operation-1',
        admin_username: 'admin', admin_password: 'password',
        run_id: 'run-1', resource_id: 'resource-1',
        initialized_at: '2026-08-30T00:00:00.000Z',
        updated_at: '2026-08-30T00:01:00.000Z',
      }] }],
    }),
  } as unknown as RPCCaller;

  await expect(readPrimaryState(caller))
    .rejects.toThrow('Primary state database operation failed');
  await expect(readPrimaryState(caller))
    .rejects.not.toThrow(/admin|password|resource-1/i);
});
```

Run `npm test -- src/lib/primaryState.test.ts`.

Expected: FAIL because the current adapter ignores `status` and resolves the valid-looking row.

- [ ] **Step 2: Add the failing journal error regression**

Add in `src/lib/provisioningJournal.test.ts`:

```ts
it('maps a resolved database ERR statement to the public database error', async () => {
  const caller = {
    databaseQuery: vi.fn().mockResolvedValue({
      results: [{ statement: 0, status: 'ERR', time: '1ms', result: [{
        kind: 'connection', operation_id: connection.operationId,
        caller_id: connection.callerId, resource_id: connection.resourceId,
        database: connection.database, username: connection.username,
        phase: connection.phase, cleanup_reason: connection.cleanupReason,
        provision_run_id: connection.provisionRunId,
        cleanup_run_id: connection.cleanupRunId,
        created_at: connection.createdAt, updated_at: connection.updatedAt,
      }] }],
    }),
  } as unknown as RPCCaller;

  await expect(readOperation(caller)).rejects.toMatchObject({
    name: 'OperationDatabaseError',
    message: 'PostgreSQL operation database operation failed',
  });
});
```

Run `npm test -- src/lib/provisioningJournal.test.ts`.

Expected: FAIL because the current adapter ignores `status` and resolves the valid-looking row.

- [ ] **Step 3: Add the typed successful-response helper**

Create `src/test/databaseQuery.ts`:

```ts
import type { RPC } from '@ezenki/deploy-commander-installer-interface';

export function databaseResult(result: unknown): RPC.DatabaseQueryResult {
  return {
    results: [{ statement: 0, status: 'OK', time: '0s', result }],
  };
}
```

Use this helper only for ordinary successful responses. Keep malformed and `"ERR"` cases explicit.

- [ ] **Step 4: Implement primary-state validation and optional bindings**

Replace the local adapter in `src/lib/primaryState.ts` with:

```ts
async function runQuery(
  caller: RPCCaller,
  query: string,
  bindings?: Record<string, unknown>,
): Promise<unknown> {
  let response: unknown;
  try {
    response = bindings === undefined
      ? await caller.databaseQuery(query)
      : await caller.databaseQuery(query, bindings);
  } catch {
    throw new Error('Primary state database operation failed');
  }

  if (!isRecord(response)
    || !Array.isArray(response.results)
    || response.results.length !== 1
    || !isRecord(response.results[0])
    || response.results[0].statement !== 0
    || typeof response.results[0].time !== 'string'
    || !Object.prototype.hasOwnProperty.call(response.results[0], 'result')) {
    throw new Error('Invalid primary state database result');
  }
  if (response.results[0].status === 'ERR') {
    throw new Error('Primary state database operation failed');
  }
  if (response.results[0].status !== 'OK') {
    throw new Error('Invalid primary state database result');
  }
  return response.results[0].result;
}
```

Change `readPrimaryState` to `runQuery(caller, READ_QUERY)`. Leave every mutation binding unchanged.

- [ ] **Step 5: Implement journal validation and optional bindings**

Replace the local adapter in `src/lib/provisioningJournal.ts` with:

```ts
async function runQuery(
  caller: RPCCaller,
  query: string,
  bindings?: Record<string, unknown>,
): Promise<unknown> {
  let response: unknown;
  try {
    response = bindings === undefined
      ? await caller.databaseQuery(query)
      : await caller.databaseQuery(query, bindings);
  } catch {
    throw new JournalDatabaseError();
  }
  if (!isRecord(response)
    || !Array.isArray(response.results)
    || response.results.length !== 1
    || !isRecord(response.results[0])
    || response.results[0].statement !== 0
    || response.results[0].status !== 'OK'
    || typeof response.results[0].time !== 'string'
    || !Object.prototype.hasOwnProperty.call(response.results[0], 'result')) {
    throw new JournalDatabaseError();
  }
  return response.results[0].result;
}
```

Change both `parseStoredOperation(await runQuery(caller, READ_QUERY, {}))` calls—one in `readOperation`, one in the `acquireOperation` recovery branch—to `parseStoredOperation(await runQuery(caller, READ_QUERY))`. Leave the create query binding unchanged.

- [ ] **Step 6: Cover malformed envelopes and omitted bindings**

Add these explicit responses to the malformed table in `src/lib/primaryState.test.ts`:

```ts
{ results: [{ statement: 0, time: '0s', result: [] }] },
{ results: [{ statement: 0, status: 'UNKNOWN', time: '0s', result: [] }] },
{ results: [{ statement: 0, status: 'OK', time: 1, result: [] }] },
```

Change the successful primary read assertion to expect only its exact query argument, with no `{}`. Add a successful journal read assertion using `toHaveBeenCalledWith(expect.stringContaining('SELECT kind, operation_id'))`. In `src/lib/recoverProvisioning.test.ts`, change the startup-adapter assertion from `(expect.stringContaining(...), {})` to the same one-argument form. Retain all mutation assertions that expect bindings.

- [ ] **Step 7: Migrate ordinary mocks to complete success envelopes**

Import the helper as follows:

```ts
import { databaseResult } from './test/databaseQuery'; // src/App.test.tsx
import { databaseResult } from '../test/databaseQuery'; // each src/lib/*.test.ts
```

Use it in `src/App.test.tsx`, `src/lib/primaryState.test.ts`, `src/lib/provisioningJournal.test.ts`, `src/lib/createPostgresConnection.test.ts`, `src/lib/installationLifecycle.test.ts`, and `src/lib/recoverProvisioning.test.ts`.

Replace each ordinary successful mock:

```ts
{ results: [{ statement: 0, result: value }] }
```

with:

```ts
databaseResult(value)
```

For branch-dependent mocks, preserve the existing result value and wrap it once, for example:

```ts
if (query.startsWith('SELECT phase')) return databaseResult([primaryRow]);
return databaseResult([bindings.operation_id ?? 'operation-1']);
```

Do not convert malformed tables, multi-statement cases, explicit `"ERR"` regressions, or the real-harness cleanup calls in `managerDatabaseIntegration.test.ts`.

- [ ] **Step 8: Run the focused compatibility suite**

Run:

```bash
npm test -- src/lib/primaryState.test.ts src/lib/provisioningJournal.test.ts src/lib/createPostgresConnection.test.ts src/lib/installationLifecycle.test.ts src/lib/recoverProvisioning.test.ts src/App.test.tsx
```

Expected: all six files PASS, including the new error-envelope and one-argument assertions.

- [ ] **Step 9: Build, lint, and check whitespace**

Run:

```bash
npm run build
npx eslint src/test/databaseQuery.ts src/lib/primaryState.ts src/lib/provisioningJournal.ts src/lib/primaryState.test.ts src/lib/provisioningJournal.test.ts src/lib/createPostgresConnection.test.ts src/lib/installationLifecycle.test.ts src/lib/recoverProvisioning.test.ts src/App.test.tsx
git diff --check -- src/test/databaseQuery.ts src/lib/primaryState.ts src/lib/provisioningJournal.ts src/lib/primaryState.test.ts src/lib/provisioningJournal.test.ts src/lib/createPostgresConnection.test.ts src/lib/installationLifecycle.test.ts src/lib/recoverProvisioning.test.ts src/App.test.tsx
```

Expected: all three commands complete successfully.

- [ ] **Step 10: Commit only the database compatibility change**

```bash
git add postgres-interface/src/test/databaseQuery.ts postgres-interface/src/lib/primaryState.ts postgres-interface/src/lib/provisioningJournal.ts postgres-interface/src/lib/primaryState.test.ts postgres-interface/src/lib/provisioningJournal.test.ts postgres-interface/src/lib/createPostgresConnection.test.ts postgres-interface/src/lib/installationLifecycle.test.ts postgres-interface/src/lib/recoverProvisioning.test.ts postgres-interface/src/App.test.tsx
git commit -m "fix: honor database statement status"
```

Expected: only the helper, two production adapters, and affected tests are committed; user-owned integration-guide and package changes remain unstaged.

---

### Task 3: Verify the integrated compatibility patch

**Files:**

- Verify only; do not modify unrelated files to make baseline checks green.

**Interfaces:**

- Consumes: the completed Task 1 and Task 2 commits.
- Produces: evidence for tests, build, changed-file lint, known full-lint baseline, commit scope, and preserved user changes.

- [ ] **Step 1: Run the full suite and production build**

Run:

```bash
cd postgres-interface
npm test
npm run build
```

Expected: every runnable test passes; the two opt-in integration tests may remain skipped when their external harnesses are unavailable; TypeScript and Vite build successfully.

- [ ] **Step 2: Verify changed-file lint cleanliness**

Run:

```bash
npx eslint src/test/databaseQuery.ts src/lib/primaryState.ts src/lib/provisioningJournal.ts src/lib/primaryState.test.ts src/lib/provisioningJournal.test.ts src/lib/createPostgresConnection.test.ts src/lib/installationLifecycle.test.ts src/lib/recoverProvisioning.test.ts src/App.test.tsx src/components/ManagerDashboard.test.tsx
```

Expected: PASS with no warnings or errors.

- [ ] **Step 3: Record the full lint baseline without expanding scope**

Run `npm run lint`.

Expected baseline: FAIL only with the existing eight `react-hooks/refs` errors in `src/App.tsx` and `src/components/PermissionDialog.tsx`. If any new file or rule appears, return the responsible implementation task for correction; do not repair the two baseline files under this plan.

- [ ] **Step 4: Verify commits and worktree scope**

Run from the repository root:

```bash
git show --check --stat --oneline HEAD~2..HEAD
git status --short
```

Expected: the two implementation commits contain only files named by Tasks 1 and 2. `docs/integrations/MANAGER_INTERFACE_GUIDE.md`, `postgres-interface/package.json`, and `postgres-interface/package-lock.json` remain modified and unstaged as the user's pre-existing work; no unexpected files are changed.
