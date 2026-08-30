# PostgreSQL Final Recovery Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the remaining teardown crash races, prevent stale journals from blocking future work, and make every unresolved lifecycle state fail closed in the manager dashboard.

**Architecture:** Keep the existing primary-state and manager-wide journal schemas. Correctness comes from ordering durable mutations so `teardown-release-required` has exactly one meaning: all terminal cleanup has completed and only journal deletion remains. Recovery must derive decisions from exact run IDs or exhaustive action/note correlation and must never infer success from an ambiguous state.

**Tech Stack:** React 19, TypeScript 5.9, Vitest, Deploy Commander manager RPC, SurrealDB manager database.

**Spec:** `docs/superpowers/specs/2026-08-30-postgres-logical-connections-design.md`

## Global Constraints

- Primary administrator credentials remain only in `postgres_state:primary` and manager-scoped runner configuration. Never place them in resource metadata, connection metadata, journals, logs, local storage, UI, or errors.
- `postgres_operation:current` remains non-secret and manager-wide.
- Run IDs are authoritative. Status values are queued `0`, running `1`, done `2`, failed `3`.
- Never start a second runner while an earlier exact or correlated run may still be queued or running.
- Never delete primary administrator state unless teardown success (`status === 2`) is proven for the exact teardown run.
- Never return a recovered connection to a caller whose manager ID differs from the journal's `callerId`.
- Do not add new journal phases or fields unless the existing ordering described below proves impossible.

---

## Required teardown state machine

Luna must implement this ordering exactly.

### Terminal success (`status === 2`)

Starting state: journal `teardown-running` with exact `teardownRunId`; primary state is normally `teardown-running`, or absent for a legacy installation.

1. Delete `postgres_state:primary` if it exists.
2. Clear only `deploy-commander:postgres:create-connection:<managerId>:<resourceId>`.
3. Transition the journal from `teardown-running` to `teardown-release-required`.
4. Delete the journal last.

Crash behavior:

- Before step 1: boot sees `teardown-running`, checks the exact run, and repeats terminal cleanup.
- Between steps 1 and 3: boot sees `teardown-running` plus exact status `2`; it retries permission cleanup and the remaining journal transitions.
- After step 3: all resource/private cleanup is already complete. Boot may only retry journal deletion.

### Terminal failure (`status === 3`)

Starting state: journal `teardown-running`; primary state is `teardown-running` when private state exists.

1. Transition primary state to `teardown-failed` using an object transition that preserves `resourceId` and `initializedAt`, and clears only `runId`.
2. Transition the journal from `teardown-running` to `teardown-release-required`.
3. Delete the journal last.

Use this exact shape:

```ts
await transitionPrimaryState(caller, state.operationId, 'teardown-running', {
  phase: 'teardown-failed',
  runId: null,
  resourceId: state.resourceId,
  initializedAt: state.initializedAt,
});
```

Never use `transitionPrimaryState(..., 'teardown-failed')`; the shorthand intentionally fills optional state fields with `null` and destroys retry identity.

### `teardown-release-required`

This phase means terminal cleanup is already complete. Recovery must only delete the matching journal. It must not delete primary state, clear credentials, or reinterpret the terminal outcome.

Journal deletion failures must not be swallowed. They must leave the journal intact and fail closed with the existing fixed recovery error.

---

### Task 1: Make teardown terminal ordering crash-safe

**Files:**
- Modify: `postgres-interface/src/lib/installationLifecycle.ts`
- Modify: `postgres-interface/src/lib/installationLifecycle.test.ts`

**Interfaces:**
- Keep `teardownPostgres(deps, expectedResource): Promise<void>`.
- Keep `recoverTeardownOnBoot(deps, managerId?, storage?): Promise<LifecycleRecoveryResult | null>`.
- Preserve the existing `PrimaryState` and `TeardownOperation` schemas.

- [ ] **Step 1: Add a failing live status-3 regression test**

Create a test where `waitForRun` rejects with `{ status: 3 }`. Assert the primary-state transition bindings contain:

```ts
expect.objectContaining({
  expected_phase: 'teardown-running',
  next_phase: 'teardown-failed',
  run_id: null,
  resource_id: 'resource-1',
  initialized_at: primaryRow.initialized_at,
})
```

Then assert the journal moves to `teardown-release-required` only after that primary transition and is deleted last. Assert a subsequent `teardownPostgres` call can pass the resource-identity check.

- [ ] **Step 2: Run the test and confirm the current shorthand loses `resource_id`**

Run:

```bash
cd postgres-interface
npm test -- --run src/lib/installationLifecycle.test.ts
```

Expected before implementation: FAIL because the status-3 path uses the string shorthand.

- [ ] **Step 3: Add failing crash-order tests for boot recovery**

Cover all of these cases separately:

1. Exact run status `3`: primary transition to `teardown-failed` occurs before journal transition to `teardown-release-required`; primary state is never deleted.
2. Exact run status `2`: primary deletion and permission clearing occur before journal transition to `teardown-release-required`.
3. Crash after primary deletion with journal still `teardown-running`: state is absent, exact status `2`, permission clearing and journal release complete successfully.
4. Journal already `teardown-release-required` with primary `teardown-failed`: only journal deletion occurs.
5. Journal already `teardown-release-required` with any unexpected primary state: do not delete primary state; delete only the journal or fail closed if the journal cannot be deleted.
6. Journal deletion rejects: recovery rejects with a fixed non-secret recovery error and does not report `{ kind: 'retry' }`.

- [ ] **Step 4: Implement the required ordering**

Refactor terminal handling into one focused helper if that makes the order explicit, for example:

```ts
async function finishTeardownRun(
  deps: InstallationWorkflowDeps,
  operation: TeardownOperation,
  state: PrimaryState | null,
  status: 2 | 3,
  managerId?: string,
  storage?: Storage,
): Promise<void>
```

The helper must implement the success/failure sequences documented above. Do not catch and ignore `deleteOperation` failure.

- [ ] **Step 5: Verify focused tests**

Run:

```bash
npm test -- --run src/lib/installationLifecycle.test.ts
```

Expected: PASS, including every crash window.

- [ ] **Step 6: Commit Task 1**

```bash
git add postgres-interface/src/lib/installationLifecycle.ts postgres-interface/src/lib/installationLifecycle.test.ts
git commit -m "fix: make postgres teardown recovery crash-safe"
```

---

### Task 2: Recover differing logical-connection journals instead of blocking forever

**Files:**
- Modify: `postgres-interface/src/lib/recoverProvisioning.ts`
- Modify: `postgres-interface/src/lib/recoverProvisioning.test.ts`

**Interfaces:**
- Keep `recoverProvisioning(deps, operation): Promise<ProvisioningRecoveryResult>`.
- Keep caller ownership checks through `requestedCallerId`.
- Keep exact correlation note `postgres-provision:<operationId>`.

- [ ] **Step 1: Add failing differing-object journal tests**

Create an existing valid Deploy Commander connection for the same `callerId` and `resourceId`, but with database/username metadata different from the journal.

Cover:

1. Journal `prepared`: clear the stale lock because no runner was started. Return `retry` for the journal caller; never return the unrelated connection to a different requested caller.
2. Journal `provision-starting`, correlation `absent`: clear the lock; do not start cleanup because provisioning absence is proven.
3. Journal `provision-starting`, correlation `found`: transition to `provision-running` with that exact run ID and continue recovery.
4. Journal `provision-starting`, correlation `ambiguous`: return `busy` and preserve the journal.
5. Journal `provision-running`, status `0` or `1`: return `busy` without cleanup.
6. Journal `provision-running`, status `2`: compensate the journal's own database/username; never alter or return the differing connection.
7. Journal `provisioned`, `persisting`, or `reconciliation-required`: compensate the journal's own objects unless a matching committed connection is found.

- [ ] **Step 2: Run tests and confirm the current early `busy` branch fails them**

Run:

```bash
npm test -- --run src/lib/recoverProvisioning.test.ts
```

- [ ] **Step 3: Remove the indefinite early-busy behavior**

The presence of a differing connection must not bypass normal phase recovery. Only a connection whose metadata matches the journal may clear the journal and be returned.

For a differing connection:

- Continue into `prepared`, `provision-starting`, `provision-running`, and compensation logic.
- Use exact action/note correlation for `provision-starting` before deciding absence or activity.
- Keep the current caller guard before returning any recovered connection.
- Never expose the differing connection's credentials to `requestedCallerId` when it does not match the journal caller.

- [ ] **Step 4: Verify focused tests**

```bash
npm test -- --run src/lib/recoverProvisioning.test.ts src/lib/createPostgresConnection.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add postgres-interface/src/lib/recoverProvisioning.ts postgres-interface/src/lib/recoverProvisioning.test.ts
git commit -m "fix: reconcile differing postgres connection journals"
```

---

### Task 3: Fail closed while lifecycle recovery or a stale lock remains

**Files:**
- Modify: `postgres-interface/src/App.tsx`
- Modify: `postgres-interface/src/App.test.tsx`
- Modify: `postgres-interface/src/components/ManagerDashboard.tsx`
- Modify: `postgres-interface/src/components/ManagerDashboard.test.tsx`
- Modify: `postgres-interface/src/lib/installationLifecycle.ts`

**Interfaces:**
- `recoverInstallationOnBoot` and `recoverTeardownOnBoot` continue returning `null`, `{ kind: 'busy' }`, or `{ kind: 'retry' }`.
- `ManagerDashboard` must treat any boot/recovery error or active operation as recovery state, never as installable state.

- [ ] **Step 1: Add failing dashboard fail-closed tests**

Cover:

1. No resource and no primary state, but teardown journal deletion failed: render recovery/error UI; do not render or enable Install.
2. `recoverInstallationOnBoot` returns `busy`: render working/recovery UI; do not render Install or Teardown controls.
3. `recoverTeardownOnBoot` returns `busy`: render working/recovery UI; do not render lifecycle action buttons.
4. An unresolved `install-running`, `install-failed`, `teardown-running`, or `teardown-failed` primary state reaches `ManagerDashboard` with the correct recovery/teardown action rather than a plain dead-end alert.
5. Legacy resource plus no primary state renders Teardown, never Install.

- [ ] **Step 2: Make recovery results part of App boot state**

Do not ignore results from:

```ts
recoverInstallationOnBoot(...)
recoverTeardownOnBoot(...)
recoverConnectionOnBoot(...)
```

If any returns `busy`, set an explicit dashboard busy/recovery state. If journal deletion or database access throws, preserve a fixed non-secret error and fail closed.

- [ ] **Step 3: Make `ManagerDashboard` fail closed on errors**

The install card is allowed only when all are true:

```ts
resource === null
primary === null
resourceAmbiguous === false
error === null
busy === false
```

Any `error`, unresolved state, ambiguity, or active recovery must render a recovery card with no Install action.

- [ ] **Step 4: Prevent install while any manager-wide journal exists**

At the beginning of `installPostgres`, call `readOperation(caller)`. If it returns any connection or teardown operation, throw `OperationBusyError` before generating credentials, creating primary state, or calling `start`.

Add a test asserting all three side effects are absent when a stale journal exists.

- [ ] **Step 5: Verify App/dashboard tests**

```bash
npm test -- --run src/App.test.tsx src/components/ManagerDashboard.test.tsx src/lib/installationLifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add postgres-interface/src/App.tsx postgres-interface/src/App.test.tsx postgres-interface/src/components/ManagerDashboard.tsx postgres-interface/src/components/ManagerDashboard.test.tsx postgres-interface/src/lib/installationLifecycle.ts postgres-interface/src/lib/installationLifecycle.test.ts
git commit -m "fix: fail closed during postgres lifecycle recovery"
```

---

### Task 4: Final security and recovery verification

**Files:**
- Modify only if a failing check proves necessary.

- [ ] **Step 1: Run the complete test suite**

```bash
cd postgres-interface
npm test
```

Expected: all normal tests pass; only the two explicitly opt-in integration tests may skip.

- [ ] **Step 2: Run lint and build**

```bash
npm run lint
npm run build
```

Expected: zero lint errors and successful TypeScript/Vite build. The known `ConnectionRequest` hook warning may remain only if unchanged by this work.

- [ ] **Step 3: Run source security searches**

```bash
rg -n 'test_user|strongpassword|console\.(log|error)' src --glob '!**/*.test.*'
rg -n 'admin_password|POSTGRES_PASSWORD|PGPASSWORD' src --glob '!**/*.test.*'
```

Expected:

- No fixed development credentials or console logging.
- Administrator passwords appear only in private primary-state bindings and manager-scoped runner environment construction.
- No administrator credentials appear in resource metadata, logical connection metadata, journals, notes, UI, or error strings.

- [ ] **Step 4: Audit exact terminal order manually**

Verify from source and tests:

- Status `2`: primary deletion → permission cleanup → release-required → journal deletion.
- Status `3`: primary `teardown-failed` transition preserving identity → release-required → journal deletion.
- Existing release-required: journal deletion only.
- Any failed durable mutation leaves the lock/state needed for the next boot retry.

- [ ] **Step 5: Request final SOL review**

Provide SOL with this plan, the main feature spec, and the full diff from `72cb5aa`. Require an explicit pass on:

- teardown status-2/status-3 crash windows;
- differing logical journal recovery;
- cross-caller credential isolation;
- fail-closed dashboard behavior;
- primary administrator credential storage boundaries.

Fix every Critical and Important finding, then rerun Steps 1–4.

- [ ] **Step 6: Commit any verification-driven fixes**

Use a focused commit message describing the actual fix. Do not create an empty verification commit.

---

## Completion criteria

Luna must not report completion until all of the following are true:

- Every Task 1–3 regression test was observed failing before its implementation and passes afterward.
- Full tests, lint, and build pass.
- A failed teardown can be retried with the original resource identity.
- No crash window can convert teardown status `3` into deletion of primary administrator credentials.
- A stale journal prevents Install from starting.
- A differing logical journal either recovers, compensates, or releases after proven absence; it cannot remain busy forever without an active/ambiguous run.
- SOL reports no Critical or Important findings.

