# PostgreSQL Manager Database Bootstrap Design

**Date:** 2026-09-10
**Status:** Approved

## Summary

The PostgreSQL manager reads private lifecycle state from two fixed SurrealDB
records, but it never defines their backing tables. A manager database running
in strict mode therefore rejects the first read and the interface cannot reach
the uninstalled state.

This change adds an explicit, idempotent database bootstrap before any recovery
or lifecycle work. It also corrects the application client lifecycle exposed by
the audit, aligns manager identity handling with manager-interface 0.3.5, and
extends the real-database contract test to cover both state stores.

## Goals

- Make the first boot succeed in a new strict manager database.
- Define both private state tables before either table is read or written.
- Preserve all existing records and support safe repeated or concurrent boots.
- Fail closed on transport, statement-status, and response-shape errors.
- Keep one interface client and wire for the mounted application's lifetime.
- Align `getManager()` handling and tests with the 0.3.5 string result.
- Remove alternate lifecycle entry points that bypass application bootstrap.
- Verify the primary-state and operation-journal contracts against the opt-in
  real manager database harness.

## Non-goals

- Migrating either table to `SCHEMAFULL` or defining individual fields.
- Changing the existing record formats, phases, transitions, or fixed record
  identifiers.
- Repairing corrupted lifecycle records automatically.
- Exposing raw SurrealDB errors or query details to users or child managers.
- Changing runner plans, PostgreSQL provisioning, or connection ownership.

## Current Failure

`readPrimaryState()` selects `postgres_state:primary`, and `readOperation()`
selects `postgres_operation:current`. The dashboard recovery path reads primary
state first; connection and teardown recovery can read the operation journal
first. Neither table is defined beforehand.

The strict database returns a successful RPC envelope containing a statement
with `status: "ERR"`. The 0.3.5-compatible adapters correctly reject that
statement, so the user sees a recovery or boot failure rather than the normal
empty installation state. Fixing only `postgres_state` would leave the same
failure waiting in `postgres_operation`.

## Manager Database Initializer

Add a focused manager-database module exposing:

```ts
initializeManagerDatabase(caller: RPCCaller): Promise<void>
```

It executes these statements in order, as two independent RPC calls with no
bindings:

```surql
DEFINE TABLE IF NOT EXISTS postgres_state SCHEMALESS;
DEFINE TABLE IF NOT EXISTS postgres_operation SCHEMALESS;
```

Separate calls preserve the repository's one-statement validation contract and
make the failed definition unambiguous. `IF NOT EXISTS` makes retries and
concurrent interface starts safe. `SCHEMALESS` preserves the current
application-validated record formats and does not overwrite an existing table
or its records.

Each response is accepted only when all of the following are true:

- The response is an object containing a `results` array.
- The array contains exactly one statement.
- The statement has `statement === 0`.
- `time` is a string.
- `status === "OK"`.
- The statement has its own `result` property.

A rejected RPC, `ERR` statement, unknown status, or malformed envelope throws a
dedicated initialization error with the fixed message:

```text
Unable to initialize PostgreSQL manager storage
```

The original error and database result must not be logged, rendered, or sent
through the child wire.

## Application and Client Lifecycle

`App` will separate interface-client ownership from boot/recovery execution.
The client is created when the component mounts (or its injected factory
changes), stored as renderable state, and ended only when that client is
replaced or the component unmounts. A retry reruns boot against the same client
and wire instead of replacing them.

This removes render-time access to `clientRef.current`, prevents a retry from
briefly rendering a closed client, and makes the existing comment that the root
owns one wire for its lifetime true in practice.

Each boot attempt owns an abort controller. Starting a new attempt or
unmounting aborts local recovery waits. An interrupted remote operation remains
represented by durable primary or journal state and is reconciled by the next
boot.

## Boot Sequence

Every root or child boot follows this order:

1. Resolve and validate the current manager ID.
2. Read interface metadata to determine root or connection mode.
3. Initialize both manager-database tables.
4. Run the mode-specific recovery functions.
5. Read authoritative resource and private state.
6. Produce a discriminated view state for rendering or wire closure.

No state read, state mutation, lifecycle start, or connection provisioning may
begin before step 3 succeeds.

`getManager()` is accepted only as a nonblank string, matching manager-interface
0.3.5. Invalid runtime values produce the existing fixed inability-to-identify
error. The legacy object fallback and diagnostic `console.log` are removed.

## Failure Mapping

In root/dashboard mode, an initialization failure renders a dedicated fatal
storage panel with the fixed message and a Retry action. Retrying runs the full
boot sequence against the same client.

In child connection mode, an initialization failure is converted to the
existing fixed close response:

```text
503 PostgreSQL recovery is required
```

The wire closes at most once. The child never receives database permissions,
query text, response contents, credentials, or other internal details.

Existing recovery-required mappings for valid but inconsistent records remain
unchanged.

## Lifecycle Entry Points

The production application is the bootstrap boundary. The standalone
`Install.tsx` and `Teardown.tsx` components are not imported by production code
and duplicate dashboard lifecycle behavior. Remove them so there is no
alternate UI route that can call a lifecycle workflow without completing boot.

The lower-level workflow functions remain independently testable. Tests that
invoke them directly provide initialized or mocked database behavior as an
explicit precondition.

## Testing

### Initializer unit tests

- Assert both exact statements and their order.
- Assert that neither call supplies bindings.
- Accept ordinary and repeated `OK` responses.
- Reject transport errors, `ERR`, unknown status, missing `result`, invalid
  statement index, invalid time, extra statements, and malformed envelopes.
- Assert the fixed non-secret error message.
- Assert the second statement is not attempted after the first fails.

### Application tests

- Assert initialization completes before the first primary-state or journal
  read in root and connection modes.
- Assert retries reuse the same client and wire.
- Assert root initialization failure exposes one retryable fixed error.
- Assert child initialization failure closes once with the fixed 503 response.
- Update manager fixtures to return a string and cover invalid runtime values.
- Assert no raw database error or manager object is logged or rendered.

### Real manager-database contract

The opt-in `MANAGER_DATABASE_HARNESS_MODULE` suite will call the initializer
first, then exercise create, read, compare-and-set transition, and delete for:

- `postgres_state:primary`
- `postgres_operation:current`

Cleanup remains conditional and runs in `finally`. The suite continues to skip
when no harness module is configured, but unit tests fully cover the bootstrap
response contract.

## Acceptance Criteria

- A new strict manager database reaches the uninstalled dashboard state.
- Existing installations boot without record or schema loss.
- Both tables exist before all production reads and writes.
- Repeated initialization is safe.
- Root and child initialization failures follow their fixed non-secret paths.
- The mounted application does not access or mutate refs during render.
- Retries do not replace the client or end the wire.
- No production import references the removed standalone components.
- All tests, ESLint, TypeScript, the production build, and
  `git diff --check` pass.

## Reference

- SurrealDB `DEFINE TABLE`: https://surrealdb.com/docs/reference/query-language/statements/define/table
