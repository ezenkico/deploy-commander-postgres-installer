# Task 2 review — Explicit Lifecycle Progress and Redesigned Dashboard

## Result

CHANGES REQUESTED

The explicit install/teardown state and dashboard composition are otherwise
consistent with the task, and the focused tests, ESLint, and TypeScript checks
pass. One recovery-path issue remains:

- **Important — stale action errors survive retry** (`postgres-interface/src/App.tsx:298`, with the state combination at `249-277`): after an install or teardown rejects, `setActionError` leaves a non-null error in state. The dashboard's Retry recovery callback calls `requestRefresh`, but `requestRefresh` never clears `actionError`. When boot succeeds, the new ready/not-installed view is still rendered with `actionError ?? view.error`, so the old error panel masks the recovered dashboard and its lifecycle controls. The user can become stuck on the error panel after a successful retry (and a remembered-permission reset has the same stale-error behavior). Clear the action error as part of an intentional refresh/retry, or otherwise replace it with the newly booted view, and add a regression test covering a failed action followed by a successful retry.

## Verification

From `postgres-interface/`:

- `npx vitest run src/components/ManagerDashboard.test.tsx src/App.test.tsx` — 23 tests passed.
- `npx eslint src/App.tsx src/components/ManagerDashboard.tsx src/components/ManagerDashboard.test.tsx` — passed.
- `npx tsc --noEmit` — passed.

The finding is behavioral and is not covered by the current focused tests.
