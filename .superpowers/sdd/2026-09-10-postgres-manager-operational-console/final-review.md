# Final review: PostgreSQL manager reliability and operational console

## Result

CHANGES REQUESTED

Reviewed the approved reliability and console specifications and plans, all
available task reports and console task reviews, both execution ledgers, and
the complete `7a416cf..dd59992` review package. No production or test source was
modified by this review.

## Strengths

- Both exact, idempotent table definitions complete before production root and
  child recovery reads. Strict statement-response validation and fixed public
  failures are covered by focused tests, including the added child ordering test.
- Client ownership is separate from refresh, and render uses the completed
  presentation's client. Retry preserves the wire and action cleanup aborts
  local waits.
- The shared Tailwind components are small and presentation-only. Normal
  installation and teardown have explicit progress text, and all visible
  teardown entry points require confirmation.
- Error details and credential fields are kept out of rendered content and
  child error responses. No UI dependency or remote visual asset was added.
- The existing suite, lint, production build, and patch checks pass.

## Findings

### Important — Ready badge overrides failure and recovery state

**File:** `postgres-interface/src/components/ManagerDashboard.tsx:61`

Badge selection checks `ready` before `resourceAmbiguous || error`, while panel
selection checks ambiguity and errors before ready. A ready resource with an
active operation or failed action therefore displays a green **Ready** badge
above an attention/recovery alert. The same contradictory output occurs when
`resourceAmbiguous` is supplied with matching ready state. The first two cases
are reachable from App's boot and action-error paths.

Read-only SSR reproduction with matching ready resource/primary state confirmed
`readyBadge: true` for each of these inputs:

- `error: 'A PostgreSQL operation is already in progress'`
- `error: 'Unable to complete PostgreSQL lifecycle action'`
- `resourceAmbiguous: true`

Derive badge and content from the same resolved state, or give errors/ambiguity
the same precedence in both branches. Add ready-plus-error and ambiguity badge
regressions. This is necessary for the console's truthful health presentation.

### Important — A newly failed teardown loses its teardown retry action

**Files:** `postgres-interface/src/App.tsx:284` and
`postgres-interface/src/components/ManagerDashboard.tsx:94`

When an accepted teardown run fails, `teardownPostgres` writes
`teardown-failed`, releases the journal, and rejects
(`installationLifecycle.ts:208`). App's catch only sets the generic
`actionError`; it retains the old ready `view.primary` and then clears
`activeAction`. The dashboard consequently selects its generic error branch
and offers **Retry recovery**, not the specified **Retry teardown**. The user
must first perform an unrelated recovery refresh to expose the intended
teardown retry. Even a supplied teardown-failed primary is hidden when a
non-null action error remains, because the error branch precedes it.

Reconcile authoritative state after a terminal action failure, or preserve the
failed action kind explicitly so a confirmed teardown retry is offered when
safe. Keep unresolved/ambiguous operations on the recovery path. Add an App
regression covering ready -> confirmed teardown -> terminal run failure ->
Retry teardown, including the confirmation requirement. The current dashboard
test starts directly in persisted `teardown-failed` state and misses this
cross-task handoff. The plan's supplied generic catch also has this gap; the
approved specification explicitly requires the specific retry action.

### Important — Dialog content can become unreachable on narrow/short viewports

**Files:** `postgres-interface/src/components/PermissionDialog.tsx:22` and
`postgres-interface/src/components/ConfirmDialog.tsx:13`

Both overlays are fixed to the viewport and center an unconstrained panel.
Neither the overlay nor panel has a scrolling region or a viewport-relative
maximum height. When wrapped caller text, stacked mobile actions, zoom, or a
short embedded viewport makes the panel taller than the available height, it
extends beyond the viewport; part of the title and the bottom actions can be
clipped. Scrolling the underlying page does not move a fixed centered panel.
The permission dialog's unbounded wrapping caller ID makes this especially
easy to trigger. This conflicts with the required usable narrow layout.

Constrain the panel to the available viewport with vertical scrolling, or use
an overlay layout that allows the complete panel to scroll from its top. Check
both dialogs with a long caller ID at 320px width and a short viewport, as well
as desktop. The task reports describe class inspection and an HTML curl check;
they contain no actual browser viewport evidence. This finding follows from
the layout constraints, not a claimed browser measurement.

### Minor — Non-storage boot errors are labelled as storage failures

**File:** `postgres-interface/src/App.tsx:257`

Every fatal boot view gets the title **Manager storage is unavailable**, even
when the safe message says manager identification failed or lifecycle recovery
is required. The safe error mapping is correct, but the new heading attributes
unrelated failures to database storage. Select that title only for the storage
initialization case, and use a general startup/recovery title for other boot
failures. The plan's sample markup also uses this unconditional title.

## Independent verification

From `postgres-interface/` at `dd59992`:

- `npm test` — 20 files passed, 2 skipped; 223 tests passed, 3 skipped.
- `npm run lint` — exit 0; no ESLint diagnostics.
- `npm run build` — exit 0; TypeScript and Vite succeeded.
- `git diff --check 7a416cf..dd59992` — exit 0.
- A read-only Vite SSR render reproduced the badge/panel inconsistency above.

The opt-in manager-database and PostgreSQL integration harnesses were not
configured, so this is not evidence from a live strict database. Browser
viewport rendering was not performed in this review. jCodeMunch resolved the
worktree as unindexed; source inspection used the supplied diff and local
files to ensure review of the actual implementation revision.

## Assessment

The bootstrap foundation, error privacy, and common console structure are
sound, and automated checks are clean. Fix the three important user-visible
state/layout issues and add focused regressions before considering the
operational-console specification complete. The pre-existing synthetic
`integration_secret` fixture is not a production credential and remains
non-blocking.
