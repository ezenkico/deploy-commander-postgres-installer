# Task 8 report: compensation and crash recovery

## Status

Implemented in the Task 8 worktree; pending parent integration.

## Changes

- Added `recoverProvisioning` with fixed `{ retry | busy | connection }` outcomes and a fixed non-secret `RecoveryRequiredError`.
- Added exhaustive exact action/note run correlation for ambiguous provision and cleanup starts, including paginated response validation and fail-closed ambiguity handling.
- Added phase-aware recovery for prepared, starting, running, provisioned, persisting, reconciliation, and cleanup phases.
- Recorded queued/running provisioning remains untouched; failed provisioning transitions to cleanup and never persists a connection.
- Cleanup resumes queued/running runs through the existing run monitor, handles terminal success/failure, and only releases the journal after confirmed cleanup or a matching existing connection.
- Updated live provisioning to reconcile start failures, run-ID persistence races, failed runner status, connection persistence races, and cleanup-start ambiguity with fixed non-secret errors.
- Added recovery tests covering active/failed runs, exact correlation, cleanup resume/failure, no overlap, stale lock release, and mismatched journal identifiers.

## Verification

- `npm test` — PASS (12 files, 121 tests).
- Focused Task 8 + journal tests — PASS (44 tests).
- Focused ESLint for changed source/tests — PASS.
- Project TypeScript/build remains blocked by the pre-existing `src/App.tsx` unused `wire` diagnostic; no Task 8 diagnostics remain.

## Concerns

The recovery API requires the ready primary state and validated platform connection in its dependency object so it can build the exact cleanup plan. Parent integration should invoke recovery before generating credentials or offering a new provisioning request.
