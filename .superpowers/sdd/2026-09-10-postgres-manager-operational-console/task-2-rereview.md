# Task 2 scoped re-review — lifecycle refresh error fix

## Result

ADDRESSED

The fix clears `actionError` inside `requestRefresh`, which is the shared
refresh path used by recovery retry, permission reset, and successful lifecycle
completion. This removes the stale action error before the next boot view is
presented, so a successful recovery can expose the recovered dashboard and its
controls.

The regression test is sound: it makes the first install fail with a private
error, verifies the fixed safe error text, clicks `Retry recovery`, waits for
the install control from the successful refresh, and asserts the stale error is
absent. The focused test passes.

## Verification

From `postgres-interface/`:

- `npm test -- --run src/App.test.tsx -t "clears a failed lifecycle action"` — 1 test passed.

No remaining finding from the prior Task 2 review was identified.
