# Manager Interface 0.3.5 Compatibility Design

## Purpose

Update the PostgreSQL manager to honor the `@ezenki/deploy-commander-installer-interface` 0.3.5 database-query contract and restore a type-safe production build after the dependency refresh. The change must preserve the manager's existing lifecycle, recovery, authorization, and non-secret error behavior.

## Confirmed Contract Changes

Version 0.3.5 changes the public interface in three relevant ways:

- `databaseQuery(query, bindings?)` accepts optional `Record<string, unknown>` bindings. When bindings are omitted, the interface library sends a payload containing only `query`.
- Each successful RPC response contains database statement envelopes with `statement`, `status`, `time`, and `result`. A statement with `status: "ERR"` is returned inside a successful RPC response instead of rejecting the call.
- `getCallingManager()` is typed as `Promise<string | null>`.

The package also corrects the `createResource` configuration property spelling from `medatata` to `metadata`. This manager does not call `createResource`, so that correction requires no source change.

`updateConnection` and `deleteConnection` are newly documented but were already present in 0.3.4. Their documentation does not by itself require the PostgreSQL manager to alter connection lifecycle behavior.

## Confirmed Current Behavior

The PostgreSQL manager routes all production manager-database operations through one of two local `runQuery` adapters:

- `src/lib/primaryState.ts` for persistent installation state.
- `src/lib/provisioningJournal.ts` for the manager-wide operation journal.

Both adapters already reject malformed and multi-statement result collections, but they currently inspect only `statement` and `result`. They can therefore accept a resolved `status: "ERR"` statement when its `result` happens to satisfy a later parser or mutation check.

The connection-mode boot path already normalizes `getCallingManager()` through a nullable validator and fails closed when the value is null or blank. No production change is required for that signature update.

The current TypeScript build also reports ten test-fixture errors because several objects declared or inferred as `RPC.ResourceItem` omit the required `manager` field. The field was already required by 0.3.4, but these fixtures must be corrected before the updated dependency can be considered build-clean.

## Database Statement Validation

Keep the existing two domain-specific adapters rather than introducing a new production abstraction. Their validation rules and public error mappings are intentionally different, and the duplicated envelope check is small.

Each adapter will accept bindings as an optional argument:

```ts
async function runQuery(
  caller: RPCCaller,
  query: string,
  bindings?: Record<string, unknown>,
): Promise<unknown>
```

When `bindings` is undefined, the adapter must invoke `caller.databaseQuery(query)` with one argument. When bindings are present, it must invoke `caller.databaseQuery(query, bindings)`.

A response is valid only when all of the following are true:

- The response is a non-array object.
- `results` is an array containing exactly one item.
- The item is a non-array object.
- `statement === 0`.
- `status === "OK"`.
- `time` is a string.
- The item has its own `result` property, including when the value is `undefined` or null.

Missing, unknown, or `"ERR"` status values must never be interpreted as application data. The adapter must not include the statement's `result`, timing, query, bindings, or thrown RPC details in an error exposed to the UI or a calling manager.

## Error Mapping

Preserve the established error boundaries:

- A rejected `primaryState` RPC continues to throw `Primary state database operation failed`.
- A resolved primary-state statement with `status: "ERR"` also throws `Primary state database operation failed`, because it represents a database execution failure rather than a malformed success payload.
- A structurally malformed primary-state envelope, including a missing/unknown status or non-string time, continues to throw `Invalid primary state database result`.
- Any rejected, `"ERR"`, or malformed journal database response becomes the private `JournalDatabaseError`, which existing public boundaries map to `OperationDatabaseError` without internal details.

This distinction keeps operational database failures separate from malformed interface responses while retaining the manager's fixed, non-secret messages.

## Optional Bindings

The three production reads with no SurrealQL variables must omit bindings:

- `readPrimaryState`.
- `readOperation`.
- The fallback `READ_QUERY` inside `acquireOperation` after a failed create.

All create, update, compare-and-set, and delete queries continue passing explicit bindings. Query text, variables, record IDs, and state-machine ordering do not change.

## Test Response Fixtures

All mocked successful database responses must represent the 0.3.5 public contract. Add a focused test utility under `src/test/` that returns a typed one-statement success envelope:

```ts
export function databaseResult(result: unknown): RPC.DatabaseQueryResult {
  return {
    results: [{
      statement: 0,
      status: 'OK',
      time: '0s',
      result,
    }],
  };
}
```

Use this helper for ordinary successful mocks in the primary-state, journal, lifecycle, connection, recovery, and application tests. Tests that intentionally exercise malformed, multi-statement, or `"ERR"` envelopes should construct those responses explicitly so their exceptional shape remains visible.

Add regression coverage proving that:

- A primary-state `"ERR"` envelope with otherwise valid state-shaped data is rejected as an operational database failure.
- A journal `"ERR"` envelope with otherwise valid operation-shaped data is rejected as `OperationDatabaseError`.
- Missing status, unknown status, and malformed time are rejected.
- No-variable reads call `databaseQuery` with only the query argument.
- Bound mutations continue calling `databaseQuery` with both query and bindings.

## Resource Fixtures

Add `manager: "postgres-manager"` to the canonical PostgreSQL resource fixtures used by:

- `src/components/ManagerDashboard.test.tsx`.
- `src/lib/createPostgresConnection.test.ts`.
- `src/lib/installationLifecycle.test.ts`.
- `src/lib/primaryState.test.ts`.

Derived fixture copies inherit the same field. Production resource filtering and validation do not change because the dependency update did not introduce this field and the manager does not use it to make a new authorization decision; `getMyResources` remains the trusted manager-scoped resource lookup.

## Security and Recovery Invariants

The implementation must preserve these invariants:

- Never interpret an RPC rejection, database `"ERR"` statement, malformed envelope, or failed lookup as confirmed absence.
- Never expose query text, bindings, administrator credentials, logical credentials, database result details, or transport errors.
- Preserve all existing primary-state and journal transition graphs, compare-and-set checks, lock-release ordering, and recovery behavior.
- Preserve the trusted current-manager and calling-manager boundaries.
- Do not add caller-controlled manager identity to `updateConnection` or `deleteConnection` payloads.

## Scope Boundaries

This change does not:

- Add calls to `updateConnection` or `deleteConnection`.
- Delete connection records during PostgreSQL teardown.
- Change resource, connection, runner, or wire payloads other than omitting unused database bindings through the updated library behavior.
- Change SurrealQL statements or manager-database record schemas.
- Fix the existing React ref-access lint failures in `App.tsx` or `PermissionDialog.tsx`.
- Change package versions beyond the user's existing 0.3.5 dependency update.
- Refactor lifecycle or recovery state machines.

## Verification

Implementation is complete when:

- Focused red/green tests cover primary-state and journal `"ERR"` handling.
- All mocked successful database statements include `status` and `time` through the shared test helper or an explicit complete envelope.
- `npm test` passes the full runnable suite.
- `npm run build` completes successfully.
- ESLint reports no errors in files changed by this compatibility implementation.
- A full `npm run lint` is run and its known unrelated React ref-access baseline is reported without being misrepresented as introduced or fixed by this work.
