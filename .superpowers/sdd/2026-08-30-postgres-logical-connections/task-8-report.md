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

## Review fixes

- Persisting recovery now records `reconciliation-required` before compensation.
- Rejected connection persistence returns a matching committed connection without cleanup; mismatched identifiers are treated as absence and cleaned up safely.
- Cleanup failures from status 3 return the journal to `cleanup-required`.
- Cleanup-running records without a run ID correlate exact action/note before any start, including ambiguous/absent handling.
- Reconciliation and stale-journal deletion require matching caller/resource/database/username identity and validated logical identifiers.
- Added `recoverJournalOperation` as the startup call-site adapter that reads the journal before new connection work.

Review-fix verification: full suite — PASS (127 tests); focused changed-file ESLint — PASS; TypeScript reports only the pre-existing `App.tsx` unused `wire` diagnostic.

## Final review fixes

- Wired boot recovery into `App` through `recoverConnectionOnBoot`/`recoverJournalOperation`; active journals block dashboard work and cleanup journals resume before rendering controls.
- Cleanup status 3 and wait failures now clear `cleanupRunId` when returning to `cleanup-required`, allowing safe correlation or retry.
- Live duplicate-race second checks treat any valid caller/resource connection as the winner and compensate this operation; logical identifier matching remains enforced for stale-journal recovery only.
- Added App boot, cleanup retry, and duplicate-race regressions.

Final verification: `npm test` — PASS (13 files, 130 tests); `npm run lint` — PASS with two existing React hook dependency warnings; `npm run build` — PASS.
