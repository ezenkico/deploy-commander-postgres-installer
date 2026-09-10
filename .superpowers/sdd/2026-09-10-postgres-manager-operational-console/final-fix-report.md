# Final UI review fix report

## Findings addressed

- Unified `ManagerDashboard` badge and panel precedence. Ambiguous resources remain
  `Attention`, persisted or newly failed teardown remains `Recovery`, and neither
  can display a contradictory `Ready` badge. Teardown failure also takes precedence
  over a generic action error so the dashboard keeps its specific retry action.
- Preserved a terminal teardown failure in `App` with an explicit failed-action
  state. The state is cleared on a successful refresh or before a new action, and
  only the fixed public `PostgreSQL teardown failed` lifecycle error activates it.
  The resulting UI requires confirmation before offering a teardown retry.
- Constrained both destructive and permission dialog panels to the viewport with
  `max-h-[calc(100dvh-2rem)] overflow-y-auto`; the fixed overlays also scroll.
- Changed fatal boot headings so only manager-storage initialization failures use
  `Manager storage is unavailable`; other fixed safe startup errors use
  `Manager startup requires attention` without exposing raw details.

## Regression coverage

- Ready-plus-error and ready-plus-ambiguous dashboard states do not show `Ready`.
- Teardown-failed state retains `Retry teardown` even with a generic action error.
- App covers ready → confirmed teardown → terminal failure → confirmed `Retry teardown`.
- Confirm and permission dialogs assert viewport-constrained scroll classes.
- Unexpected boot failures assert the general startup heading and safe message.

## Verification

- `npm test`: 20 files passed, 2 skipped; 229 tests passed, 3 skipped.
- `npm run lint`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
