# Task 2 report: stable application client and boot ordering

## Changed files

- `postgres-interface/src/App.tsx`
  - Split stable client/wire ownership from repeatable boot attempts.
  - Added renderable presentation state and factory selection guard.
  - Bootstraps both manager tables before recovery reads in root and child modes.
  - Maps child initialization failures to one 503 recovery close and root initialization failures to the fixed retryable storage message.
  - Requires a non-blank string manager identity and removes the old logging/object shape.
  - Reuses the same client for retries and only ends its wire on ownership cleanup.
  - Added abort-controller ownership for lifecycle actions and boot/recovery cleanup.
- `postgres-interface/src/App.test.tsx`
  - Updated the manager fixture to the 0.3.5 string shape.
  - Added boot-order, fixed-error/retry reuse, child-close, obsolete-manager-shape, and action-abort coverage.

## TDD evidence

### RED

Command:

```text
npx vitest run src/App.test.tsx -t "initializes both tables"
```

Result: 1 failed, 10 skipped. The first two recorded queries were the recovery `SELECT` statements instead of the expected `DEFINE TABLE` statements, confirming the test detected the missing behavior.

### GREEN

Command:

```text
npx vitest run src/App.test.tsx -t "initializes both tables|fixed retryable|closes child mode once|obsolete object|aborts an in-flight"
```

Result: 5 passed, 6 skipped.

Focused regression command:

```text
npx vitest run src/App.test.tsx src/lib/managerDatabase.test.ts
```

Result: 2 files passed, 22 tests passed.

## Verification commands and results

- `npx eslint src/App.tsx src/App.test.tsx src/lib/managerDatabase.ts src/lib/managerDatabase.test.ts` — passed with no diagnostics.
- `npm test` — 18 test files passed, 2 skipped; 205 tests passed, 2 skipped.
- `npm run build` — TypeScript and Vite production build passed.
- `git diff --check` — passed.
- `npm run lint` — reports two existing `react-hooks/refs` errors in `src/components/PermissionDialog.tsx` (lines 29–30), outside this task's changed files. The targeted lint for all changed/relevant files is clean.

## Commits

- `54c77309fd60f5bfc2be4731ef9e1a2c85e51b19` — `fix: bootstrap storage before manager recovery`
- Documentation report commit follows this report.

## Concerns

- Full-project lint remains blocked by the pre-existing ref writes during render in `src/components/PermissionDialog.tsx`; no changes were made there because it is outside Task 2 scope.
