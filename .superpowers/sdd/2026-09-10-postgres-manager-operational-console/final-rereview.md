# Final operational console re-review

## Scope

Reviewed `fdd39c5..5c66066` and the final fix report against the four findings
from the final operational-console review. No source files were edited.

## Findings

### Badge precedence — ADDRESSED

`ManagerDashboard` now evaluates ambiguous resource state first, then teardown
failure/recovery, then generic errors, before the not-installed fallback. A
ready resource accompanied by an error or an ambiguous resource therefore
cannot render a contradictory `Ready` badge. A teardown failure also renders
the specific teardown-retry panel before the generic error panel.

Regression tests cover ready-plus-error, ready-plus-ambiguous, and teardown
failure plus generic action error.

### Failed teardown retry state — ADDRESSED

`App` preserves a terminal teardown failure using `failedAction` when the
lifecycle's fixed `PostgreSQL teardown failed` error is returned. The state is
cleared before a new action and after a successful refresh. The dashboard uses
it to retain the specific `Retry teardown` action, which still opens the
confirmation dialog before invoking teardown again.

The App regression test covers confirmed teardown, terminal failure, and the
confirmed retry path.

### Dialog viewport scrolling — ADDRESSED

Both `ConfirmDialog` and `PermissionDialog` constrain their panels with
`max-h-[calc(100dvh-2rem)] overflow-y-auto`. Their fixed overlays also have
`overflow-y-auto`, so long content and narrow/short viewports remain reachable.
Both component tests assert the panel classes.

### Generic fatal heading safety — ADDRESSED

`bootErrorTitle` reserves `Manager storage is unavailable` for the specific
manager-storage initialization error. Other safe boot messages use the generic
`Manager startup requires attention` heading. The existing `bootErrorMessage`
mapping continues to replace unexpected errors with a fixed public message, so
arbitrary backend details are not exposed.

The App test asserts the generic heading and absence of a private backend detail.

## Verification

- `npm test -- --run src/App.test.tsx src/components/ManagerDashboard.test.tsx src/components/ConfirmDialog.test.tsx src/components/PermissionDialog.test.tsx`: 4 files passed, 46 tests passed.
- `npm run lint`: passed.
- `git diff --check`: passed.

## Conclusion

ADDRESSED. No remaining findings in this scoped re-review.
