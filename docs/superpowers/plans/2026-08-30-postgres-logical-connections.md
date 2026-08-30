# PostgreSQL Logical Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Securely install one PostgreSQL service and provision isolated logical databases and Deploy Commander connections for calling managers.

**Architecture:** The React manager owns UI, trusted RPC orchestration, private manager-database state, and exact run monitoring. Pure helpers generate credentials and runner metadata; a one-shot `postgres:15` runner performs PostgreSQL SQL, while manager-interface RPCs alone inspect and create Deploy Commander connections. A non-secret journal drives compensating cleanup after partial failures.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, Tailwind CSS 4, Vitest, jsdom, React Testing Library, `@ezenki/deploy-commander-installer-interface` 0.3.x, PostgreSQL 15 client, SurrealQL manager database.

**Spec:** `docs/superpowers/specs/2026-08-30-postgres-logical-connections-design.md`

## Global Constraints

- Keep exactly one persistent service: key/name/type `postgres`, image `postgres:15`, volume `postgres-data`.
- Interface metadata is exactly `{ "action": "create-connection" }`; it never supplies caller or resource identity.
- Runner image remains `ezenki/deploy-commander-runner:latest`; one-shot services use `role: "runner"` and non-empty `command: string[]` mapped to Docker `Config.Cmd`.
- Run statuses are queued `0`, running `1`, done `2`, and failed `3`; `getRun(id)` is the authoritative fallback.
- Docker platform connections serialize as `{ type: "Platform", data: { network: string } }` with a non-empty network.
- Primary administrator credentials live in `postgres_state:primary` and in access-controlled manager-scoped run configuration used to transport runner environment; resource metadata contains no secrets.
- Per-connection credentials live in the created Deploy Commander connection and the same manager-scoped run-configuration transport; the recovery lock/journal contains identifiers but no passwords.
- Never log, render in errors, or place secrets in run notes, local storage, resource metadata, or operation journals.
- Every production behavior follows a witnessed failing test before implementation.
- Preserve user changes already present in `docs/integrations/DEPLOY_COMMANDER_RUNNER_INTERFACE_GUIDE.md`.

---

### Task 1: Test Foundation, Contracts, and Credential Generation

**Files:**
- Modify: `postgres-interface/package.json`
- Modify: `postgres-interface/package-lock.json`
- Modify: `postgres-interface/vite.config.ts`
- Create: `postgres-interface/src/test/setup.ts`
- Create: `postgres-interface/src/lib/postgresContracts.ts`
- Create: `postgres-interface/src/lib/postgresContracts.test.ts`
- Create: `postgres-interface/src/lib/credentials.ts`
- Create: `postgres-interface/src/lib/credentials.test.ts`

**Interfaces:**
- Produces `isCreateConnectionMetadata(value: unknown): value is { action: "create-connection" }`.
- Produces `parsePlatformConnection(value: unknown): PlatformConnection` and `PlatformConnection = { type: "Platform"; data: { network: string } }`.
- Produces `generateAdminCredentials(random?: RandomBytes): AdminCredentials`.
- Produces `generateConnectionCredentials(random?: RandomBytes): LogicalCredentials`.
- `type RandomBytes = (length: number) => Uint8Array`; production implementation uses `crypto.getRandomValues`.
- Create local runner-boundary interfaces in `postgresContracts.ts`: `RunnerMetadata`, `RunnerService`, `PlatformConnection`, and `PostgresConnectionMetadata`; define every used nested field and no unused runner fields.

- [ ] **Step 1: Add the test runner and browser test environment**

Add scripts `"test": "vitest run"` and `"test:watch": "vitest"`. Install `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`, and `@testing-library/jest-dom` as dev dependencies. Configure Vitest with `environment: "jsdom"`, `setupFiles: ["./src/test/setup.ts"]`, and `restoreMocks: true`; import `@testing-library/jest-dom/vitest` in setup.

- [ ] **Step 2: Write failing contract-narrowing tests**

Cover the exact action object and reject null, arrays, wrong action, and every additional key. Accept the exact Platform connection and reject blank network, wrong type, or malformed data.

- [ ] **Step 3: Run contract tests and witness missing-module failure**

Run: `npm test -- src/lib/postgresContracts.test.ts`

Expected: FAIL because `postgresContracts.ts` does not exist.

- [ ] **Step 4: Implement the narrowers and pass their tests**

Use `Record<string, unknown>` narrowing without `any`. Require `Object.keys(value)` to equal `["action"]` and `action === "create-connection"`. Require exact case-sensitive `type === "Platform"` and a trimmed non-empty network.

- [ ] **Step 5: Write failing deterministic credential tests**

Inject a byte generator that returns known sequences and assert:

```ts
expect(admin.username).toMatch(/^pg_admin_[0-9a-f]{32}$/);
expect(logical.database).toMatch(/^db_[0-9a-f]{32}$/);
expect(logical.username).toMatch(/^pg_user_[0-9a-f]{32}$/);
expect(admin.password).not.toBe(logical.password);
expect(admin.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
```

Also assert separate random calls for every identifier/password and a thrown error for a random provider returning the wrong byte length.

- [ ] **Step 6: Run credential tests and witness failure**

Run: `npm test -- src/lib/credentials.test.ts`

Expected: FAIL because generators are missing.

- [ ] **Step 7: Implement minimal cryptographic generators**

Use 16 random bytes rendered as lowercase hex for identifiers and 32 independent bytes rendered with base64url characters for passwords. Do not use `Math.random`, timestamps, manager IDs, or caller IDs.

- [ ] **Step 8: Verify and commit Task 1**

Run: `npm test -- src/lib/postgresContracts.test.ts src/lib/credentials.test.ts`

Expected: PASS.

Commit with `git add package.json package-lock.json vite.config.ts src/test/setup.ts src/lib/postgresContracts.ts src/lib/postgresContracts.test.ts src/lib/credentials.ts src/lib/credentials.test.ts && git commit -m "test: establish postgres manager contracts"`.

---

### Task 2: Installation Plan and Private Primary State

**Files:**
- Create: `postgres-interface/src/lib/installPlan.ts`
- Create: `postgres-interface/src/lib/installPlan.test.ts`
- Create: `postgres-interface/src/lib/primaryState.ts`
- Create: `postgres-interface/src/lib/primaryState.test.ts`

**Interfaces:**
- Consumes `AdminCredentials` from Task 1.
- Produces `buildInstallPlan(credentials: AdminCredentials): RunnerMetadata`.
- Produces `findPrimaryResource(caller: RPCCaller): Promise<RPC.ResourceItem | null>` using paginated `getMyResources("postgres", false, limit, offset)` and exact name/type matching; multiple matches fail closed.
- Produces `readPrimaryState(caller): Promise<PrimaryState | null>`, `createPrimaryState(caller, state): Promise<void>`, `transitionPrimaryState(caller, operationId, expectedPhase, next): Promise<void>`, and `deletePrimaryState(caller, operationId): Promise<void>`.
- `PrimaryPhase = "install-prepared" | "install-running" | "install-failed" | "ready" | "teardown-running" | "teardown-failed"`. `PrimaryState` always has phase, operation ID, credentials, nullable run/resource/initialized fields, and updated time in one record.
- Legal transitions are install-prepared→install-running/install-failed; install-running→ready/install-failed; install-failed→teardown-running; ready→teardown-running; teardown-running→teardown-failed/delete; teardown-failed→teardown-running.

- [ ] **Step 1: Write failing install-plan tests**

Assert exact image, alias `postgres`, `POSTGRES_DB=postgres`, supplied admin environment, resource `{ resource_type: "postgres", name: "postgres", metadata: { engine: "postgres", version: "15" } }`, declared volume, and mount `{ name: "postgres-data", mount_path: "/var/lib/postgresql/data" }`. Recursively assert the resource metadata contains neither credential value.

- [ ] **Step 2: Run and witness the missing builder**

Run: `npm test -- src/lib/installPlan.test.ts`

Expected: FAIL because `buildInstallPlan` is missing.

- [ ] **Step 3: Implement and pass the install-plan tests**

Return JSON-compatible typed local interfaces matching the documented runner contract. Do not duplicate the full runner model.

- [ ] **Step 4: Write failing manager-state tests**

Mock `databaseQuery` and assert the initial atomic write exactly follows:

```sql
CREATE postgres_state:primary CONTENT {
  phase: $phase, operation_id: $operation_id,
  admin_username: $admin_username, admin_password: $admin_password,
  run_id: $run_id, resource_id: $resource_id,
  initialized_at: $initialized_at, updated_at: $updated_at
} RETURN VALUE operation_id;
```

CAS transitions use `UPDATE postgres_state:primary SET phase = $next_phase, run_id = $run_id, resource_id = $resource_id, initialized_at = $initialized_at, updated_at = $updated_at WHERE operation_id = $operation_id AND phase = $expected_phase RETURN VALUE operation_id;`; conditional deletion uses `DELETE postgres_state:primary WHERE operation_id = $operation_id RETURN VALUE operation_id;`. Reads use `SELECT phase, operation_id, admin_username, admin_password, run_id, resource_id, initialized_at, updated_at FROM postgres_state:primary;`. Require exactly one statement at index zero; reads accept `[]` or one validated object, while create/CAS/delete must return `[operationId]` and `[]` means lost ownership. Resource discovery paginates, validates ID/type/name/external, and fails closed on multiple exact resources.

- [ ] **Step 5: Run state tests and witness failure**

Run: `npm test -- src/lib/primaryState.test.ts`

Expected: FAIL because state helpers are missing.

- [ ] **Step 6: Implement strict manager-state parsing and resource discovery**

All application values use SurrealQL bindings. Convert snake_case database fields only after runtime validation. Never include state, bindings, or raw database results in thrown error messages.

- [ ] **Step 7: Verify Task 2**

Run: `npm test -- src/lib/installPlan.test.ts src/lib/primaryState.test.ts`

Expected: PASS.

Commit with `git add src/lib/installPlan.ts src/lib/installPlan.test.ts src/lib/primaryState.ts src/lib/primaryState.test.ts && git commit -m "feat: secure primary postgres installation state"`.

---

### Task 3: Exact Run Monitoring and Stable Interface Boundary

**Files:**
- Create: `postgres-interface/src/lib/runMonitor.ts`
- Create: `postgres-interface/src/lib/runMonitor.test.ts`
- Create: `postgres-interface/src/lib/interfaceClient.ts`
- Create: `postgres-interface/src/lib/interfaceClient.test.ts`

**Interfaces:**
- Produces `RunEventSource` with `subscribe(listener): () => void` and `publish(event): void`.
- Produces `waitForRun(caller, source, runId, options): Promise<RPC.GetRun>` and reads only `result.run.status`; it never copies `result.config.metadata` into errors.
- `WaitOptions = { pollIntervalMs?: number; timeoutMs?: number; signal?: AbortSignal }`, defaulting in production to 1,000 ms polling and 300,000 ms timeout.
- Produces `createInterfaceClient(onEvent): { wire: Wire; caller: RPCCaller }` with a structured unsupported-request response.

- [ ] **Step 1: Write failing event-source and run-monitor tests using fake timers**

Cover status `0` and `1` continuing, exact-ID status `2` resolving, exact-ID status `3` rejecting with `RunFailedError` containing only run ID/status, unrelated/ID-less events ignored, polling `getRun(runId)` resolving missed completion, any `getRun` RPC rejection stopping without changing durable running phase, unknown statuses rejecting, blank returned run IDs rejecting, timeout, abort, and unsubscribe cleanup.

- [ ] **Step 2: Run and witness missing monitor failure**

Run: `npm test -- src/lib/runMonitor.test.ts`

Expected: FAIL because `runMonitor.ts` is missing.

- [ ] **Step 3: Implement the monitor with named local constants**

Define `STATUS_QUEUED = 0`, `STATUS_RUNNING = 1`, `STATUS_DONE = 2`, and `STATUS_FAILED = 3`. Events read `event.data.payload.id/status`; polling reads `result.run.status`. Never resolve from an event without the expected ID. Poll `getRun` until its authoritative status is terminal and accept no unknown numeric value.

- [ ] **Step 4: Write failing interface-client tests**

Assert a stable pair retains the raw wire for `close/end`, exposes the caller, forwards events, and responds to inbound unsupported RPCs with `{ ok: false, error: { message: "Unsupported request: <request>" } }` without logging payloads.

- [ ] **Step 5: Implement the boundary and verify Task 3**

Run: `npm test -- src/lib/runMonitor.test.ts src/lib/interfaceClient.test.ts`

Expected: PASS.

Commit with `git add src/lib/runMonitor.ts src/lib/runMonitor.test.ts src/lib/interfaceClient.ts src/lib/interfaceClient.test.ts && git commit -m "feat: monitor deploy commander runs by id"`.

---

### Task 4: Permission Preference and Accessible Dialog

**Files:**
- Create: `postgres-interface/src/lib/permissionPreference.ts`
- Create: `postgres-interface/src/lib/permissionPreference.test.ts`
- Create: `postgres-interface/src/components/PermissionDialog.tsx`
- Create: `postgres-interface/src/components/PermissionDialog.test.tsx`

**Interfaces:**
- Produces `permissionKey(managerId, resourceId): string`.
- Produces `isPermissionRemembered(storage: Storage, managerId: string, resourceId: string): boolean`, `rememberPermission(storage: Storage, managerId: string, resourceId: string): boolean`, and `clearPermission(storage: Storage, managerId: string, resourceId: string): boolean`; mutation functions return whether storage succeeded.
- `PermissionDialog` props: `{ callerId: string; busy: boolean; onAllow(remember: boolean): void; onCancel(): void }`; no RPC provides a trusted caller display name.

- [ ] **Step 1: Write failing preference tests**

Assert exact key `deploy-commander:postgres:create-connection:<manager>:<resource>`, isolation across manager/resource pairs, only literal `allow` accepted, clear removes only the scoped key, and get/set/remove exceptions never grant permission or crash.

- [ ] **Step 2: Implement preference helpers and pass tests**

Run: `npm test -- src/lib/permissionPreference.test.ts`

Expected: PASS after implementation.

- [ ] **Step 3: Write failing accessible-dialog tests**

Use role queries to assert `role="dialog"`, `aria-modal="true"`, accessible title/description, caller ID, initial focus, trapped Tab focus, restored focus, Allow, Cancel, checkbox copy explaining installation-wide approval for all future callers, unchecked allow, checked allow returning `true`, cancel never approving, disabled/loading/live status while busy, and Escape cancellation when not busy. A storage-write failure after explicit Allow continues the current request but is not remembered. Test that a remembered approval for caller A also applies to caller B on the same manager/resource key.

- [ ] **Step 4: Implement the dialog and verify Task 4**

Run: `npm test -- src/components/PermissionDialog.test.tsx src/lib/permissionPreference.test.ts`

Expected: PASS.

Commit with `git add src/lib/permissionPreference.ts src/lib/permissionPreference.test.ts src/components/PermissionDialog.tsx src/components/PermissionDialog.test.tsx && git commit -m "feat: add scoped postgres permission prompt"`.

---

### Task 5: Safe PostgreSQL Provisioning and Cleanup Plans

**Files:**
- Create: `postgres-interface/src/lib/postgresPlans.ts`
- Create: `postgres-interface/src/lib/postgresPlans.test.ts`

**Interfaces:**
- Consumes `PlatformConnection`, `PrimaryState`, and `LogicalCredentials`.
- Produces `buildProvisionPlan(primary, logical, platform): RunnerMetadata`.
- Produces `buildCleanupPlan(primary, database, username, platform): RunnerMetadata`.
- Produces `buildConnectionMetadata(logical): PostgresConnectionMetadata` with literal host `postgres` and port `5432`.

The provision command is exactly `["sh", "-ceu", PROVISION_SCRIPT]`, where `PROVISION_SCRIPT` is a fixed source constant with no TypeScript interpolation:

```sh
attempt=1
while ! pg_isready -q; do
  if [ "$attempt" -ge 60 ]; then
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 2
done
if ! psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
\getenv target_database TARGET_DATABASE
\getenv target_username TARGET_USERNAME
\getenv target_password TARGET_PASSWORD
SELECT format('CREATE ROLE %I', :'target_username')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_username')
\gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'target_username', :'target_password')
\gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'target_database', :'target_username')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_database')
\gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'target_database', :'target_username')
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC', :'target_database')
\gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'target_database', :'target_username')
\gexec
SQL
then
  echo "PostgreSQL provisioning failed" >&2
  exit 1
fi
if ! PGDATABASE="$TARGET_DATABASE" psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
\getenv target_username TARGET_USERNAME
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'target_username')
\gexec
SQL
then
  echo "PostgreSQL provisioning failed" >&2
  exit 1
fi
```

The cleanup command is `["sh", "-ceu", CLEANUP_SCRIPT]` with this fixed constant:

```sh
attempt=1
while ! pg_isready -q; do
  if [ "$attempt" -ge 60 ]; then
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 2
done
if ! psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
\getenv target_database TARGET_DATABASE
\getenv target_username TARGET_USERNAME
SELECT format('ALTER DATABASE %I WITH ALLOW_CONNECTIONS false', :'target_database')
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_database')
\gexec
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'target_database' AND pid <> pg_backend_pid();
SELECT format('DROP DATABASE IF EXISTS %I', :'target_database')
\gexec
SELECT format('DROP ROLE IF EXISTS %I', :'target_username')
\gexec
SQL
then
  echo "PostgreSQL cleanup failed" >&2
  exit 1
fi
```

- [ ] **Step 1: Write failing provisioning-plan tests**

Assert exactly one service `postgres-admin`, image `postgres:15`, role `runner`, exact validated platform connection, non-empty command beginning `sh`, `-ceu`, and a fixed script, plus `PGHOST`, `PGPORT`, `PGDATABASE`, admin and target environment variables. Assert no primary service/resource/volume and no secret in the action note or script literal.

- [ ] **Step 2: Assert SQL safety and readiness behavior**

Test the complete fixed constants byte-for-byte, including 60 two-second readiness attempts, `\getenv`, raw psql stdout/stderr redirection, fixed failure messages, `format('%I', ...)`, `format('%L', ...)`, and `\gexec`. Assert no semicolon terminates a generating `SELECT` before `\gexec`, no `set -x`, no generated value in either script, database creation/drop outside explicit transactions, role restrictions, database ownership, least-privilege grants, and a second connection to the generated database before public-schema changes. The integration test deliberately supplies an invalid generated role operation and asserts captured output contains neither administrator nor per-connection password.

- [ ] **Step 3: Assert cleanup and connection metadata**

Require cleanup to terminate matching database sessions, safely `DROP DATABASE IF EXISTS`, then safely `DROP ROLE IF EXISTS`. Require connection metadata to equal `{ host: "postgres", port: 5432, database, username, password }` and exclude every admin field.

- [ ] **Step 4: Run and witness missing-plan failure**

Run: `npm test -- src/lib/postgresPlans.test.ts`

Expected: FAIL because builders are missing.

- [ ] **Step 5: Implement fixed scripts and metadata builders**

Pass all dynamic values through environment and import them with psql `\getenv`; validate generated identifiers again before building plans. Use the documented command argument array without entrypoint metadata. Redirect raw psql output and emit only fixed provisioning/cleanup failure messages.

- [ ] **Step 6: Verify and commit Task 5**

Run: `npm test -- src/lib/postgresPlans.test.ts`

Expected: PASS.

Commit with `git add src/lib/postgresPlans.ts src/lib/postgresPlans.test.ts && git commit -m "feat: build safe postgres administration runs"`.

---

### Task 6: Atomic Provisioning Lock and Recovery Journal

**Files:**
- Create: `postgres-interface/src/lib/provisioningJournal.ts`
- Create: `postgres-interface/src/lib/provisioningJournal.test.ts`

**Interfaces:**
- Produces `acquireOperation`, `readOperation`, `transitionOperation`, and `deleteOperation` for fixed manager-wide lock record `postgres_operation:current`.
- `OperationKind = "connection" | "teardown"`.
- `OperationPhase = "prepared" | "provision-starting" | "provision-running" | "provisioned" | "persisting" | "reconciliation-required" | "cleanup-required" | "cleanup-starting" | "cleanup-running" | "teardown-starting" | "teardown-running" | "teardown-release-required"`.
- `CleanupReason = "provision-failed" | "duplicate-race" | "persistence-failed" | "abandoned"`.
- Connection records have kind, operation/caller/resource/database/username IDs, phase, nullable cleanup reason, nullable provision/cleanup run IDs, and timestamps; teardown records have kind, operation/resource IDs, phase, nullable teardown run ID, and timestamps. Neither contains passwords.
- Connection transitions: prepared→provision-starting or delete when post-lock revalidation fails; provision-starting→provision-running or delete when exhaustive correlation proves no accepted run; provision-running→provisioned/cleanup-required; provisioned→persisting/cleanup-required; persisting→reconciliation-required; reconciliation-required→cleanup-required; cleanup-required→cleanup-starting; cleanup-starting→cleanup-running or cleanup-required when exhaustive correlation proves no accepted cleanup; cleanup-running→cleanup-required. Teardown transitions teardown-starting→teardown-running; a terminal run transitions to teardown-release-required before lock deletion. Lock deletion is also allowed after confirmed matching connection or successful cleanup.

- [ ] **Step 1: Write failing journal tests**

Assert atomic acquisition includes bound `kind` and maps a create rejection by reading the fixed record: a valid record means busy/recovery, confirmed absence means database failure, and read failure means database failure. Every transition uses `WHERE operation_id = $operation_id AND phase = $expected_phase RETURN VALUE operation_id`; reads return `[]` or one strict discriminated object; deletion is conditional. Require one statement at index zero, legal transitions, and no `/password|secret/i` journal data.

- [ ] **Step 2: Implement journal helpers and pass tests**

Run: `npm test -- src/lib/provisioningJournal.test.ts`

Expected: PASS after implementation.

- [ ] **Step 3: Verify and commit Task 6**

Run: `npm test -- src/lib/provisioningJournal.test.ts`

Expected: PASS.

Commit with `git add src/lib/provisioningJournal.ts src/lib/provisioningJournal.test.ts && git commit -m "feat: add postgres provisioning recovery lock"`.

---

### Task 7: Successful Connection Orchestration

**Files:**
- Create: `postgres-interface/src/lib/createPostgresConnection.ts`
- Create: `postgres-interface/src/lib/createPostgresConnection.test.ts`

**Interfaces:**
- `ConnectionRequest = { currentManagerId: string; callingManagerId: string; resource: RPC.ResourceItem; platform: PlatformConnection; primary: ReadyPrimaryState }`.
- `PermissionDecision = { allowed: boolean; remember: boolean }`.
- `ConnectionWorkflowDeps = { caller: RPCCaller; events: RunEventSource; storage: Storage; requestPermission(): Promise<PermissionDecision>; generateCredentials(): LogicalCredentials; waitForRun(caller: RPCCaller, events: RunEventSource, runId: string, options: WaitOptions): Promise<RPC.GetRun>; signal: AbortSignal }`.
- Produces `createPostgresConnection(deps: ConnectionWorkflowDeps, request: ConnectionRequest): Promise<RPC.CreateConnection>`.
- `findExistingConnection` validates the summary and full connection: nonblank IDs, `manager === callingManagerId`, `resource === resourceId`, and `external === false`.

- [ ] **Step 1: Write failing validation/idempotency tests**

Cover null/blank caller rejected before work, primary/resource mismatch, malformed platform data, existing connection returned before permission/lock, malformed existing connection rejected, remembered installation approval skipping dialog, cancellation doing no write/run, and explicit Allow continuing when preference storage throws.

- [ ] **Step 2: Run the focused tests and witness failure**

Run: `npm test -- src/lib/createPostgresConnection.test.ts -t "validation|existing|permission"`

Expected: FAIL because the workflow module is absent.

- [ ] **Step 3: Implement validation through atomic acquisition**

After duplicate and permission checks, generate credentials and atomically acquire `postgres_operation:current` before runner work. An `OperationBusyError` returns a fixed busy error; a losing caller discards generated values and starts nothing.

- [ ] **Step 4: Write failing successful-path and concurrency tests**

Assert prepared→provision-starting immediately before `start`; a returned nonblank run ID transitions to provision-running. Verify action `create-connection`, note `postgres-provision:<operationId>`, runner image, exact plan, status 2, provisioned, second duplicate check, persisting, exact `createConnection(metadata, callerId, false, resourceId)`, and lock deletion. Revalidate ready primary/resource identity after lock acquisition. Start two workflow promises against one atomic mock and assert exactly one `start` and one `createConnection` call.

- [ ] **Step 5: Implement the successful state machine**

Use fixed non-secret notes containing only operation/resource/caller IDs. Manager-scoped run configuration is the approved credential transport; never copy it to errors. If deletion fails after connection success, return the created connection because the next existing-connection path can clear stale state.

- [ ] **Step 6: Verify and commit Task 7**

Run: `npm test -- src/lib/createPostgresConnection.test.ts`

Expected: PASS.

Commit with `git add src/lib/createPostgresConnection.ts src/lib/createPostgresConnection.test.ts && git commit -m "feat: create logical postgres connections"`.

---

### Task 8: Compensation and Crash Recovery

**Files:**
- Modify: `postgres-interface/src/lib/createPostgresConnection.ts`
- Modify: `postgres-interface/src/lib/createPostgresConnection.test.ts`
- Create: `postgres-interface/src/lib/recoverProvisioning.ts`
- Create: `postgres-interface/src/lib/recoverProvisioning.test.ts`

**Interfaces:**
- Produces `recoverProvisioning(deps, operation): Promise<{ kind: "retry" } | { kind: "busy" } | { kind: "connection"; value: RPC.CreateConnection }>`; `retry` means cleanup completed and the caller restarts once from duplicate/permission checks, `busy` closes with 409, and `connection` is returned directly.
- Recovery always checks for a valid existing connection first. It reads `getRun(provisioningRunId|cleanupRunId).run.status` for recorded active runs.

- [ ] **Step 1: Write failing provisioning-failure tests**

Start rejection or a crash in provision-starting retains that phase until exhaustive lookup by exact action `create-connection` and note `postgres-provision:<operationId>` proves no accepted run or finds its ID. Proven absence deletes the unused prepared operation; ambiguity never cleans up or retries. Provision status 3 transitions to cleanup-required without calling `createConnection`; status 0/1 remains provision-running and never cleans up. Failure to save a returned run ID is recovered through the same correlation lookup.

- [ ] **Step 2: Write failing persistence-reconciliation tests**

Second-check race transitions to cleanup then returns the existing connection only after cleanup. `createConnection` rejection transitions to `reconciliation-required`; a failed reconciliation query retains that phase. A valid existing connection returns it without cleanup; confirmed absence transitions to cleanup.

- [ ] **Step 3: Write failing cleanup/reload tests**

Cleanup-required transitions to cleanup-starting immediately before `start`; a nonblank returned ID and note `postgres-cleanup:<operationId>` transition to cleanup-running. A crash/ambiguous response uses exhaustive action/note correlation and never launches another cleanup until absence is proven; proven absence returns to cleanup-required for an explicit retry. Cleanup status 0/1 resumes monitoring; status 2 deletes the operation; status 3 returns to cleanup-required. Reload tests cover every phase and prove no cleanup overlaps queued/running provisioning. A recovered provisioned operation lacks the password by design, so it cleans up and permits a fresh request. Existing connections delete a stale journal only when caller/resource/database/username all match; differing journal objects recover first, and another caller/resource's journal is retained.

- [ ] **Step 4: Run and witness recovery failures**

Run: `npm test -- src/lib/recoverProvisioning.test.ts src/lib/createPostgresConnection.test.ts`

Expected: FAIL on missing recovery behavior.

- [ ] **Step 5: Implement phase-specific recovery**

Never interpret an RPC/database failure as absence. Preserve fixed non-secret errors. Cleanup uses action `cleanup-connection`, runner `ezenki/deploy-commander-runner:latest`, the exact cleanup plan, and the same run monitor. Do not delete the lock until confirmed cleanup or connection existence.

- [ ] **Step 6: Add secret-boundary tests**

Assert credentials appear only in approved `start` metadata and their intended primary-state/connection destinations. Assert they are absent from resource metadata, notes, journal bindings, localStorage, UI/error strings, and logger calls.

- [ ] **Step 7: Verify and commit Task 8**

Run: `npm test -- src/lib/recoverProvisioning.test.ts src/lib/createPostgresConnection.test.ts src/lib/provisioningJournal.test.ts`

Expected: PASS.

Commit with `git add src/lib/createPostgresConnection.ts src/lib/createPostgresConnection.test.ts src/lib/recoverProvisioning.ts src/lib/recoverProvisioning.test.ts && git commit -m "feat: recover postgres provisioning failures"`.

---

### Task 9: Application Boot, Routing, and Close Semantics

**Files:**
- Rewrite: `postgres-interface/src/App.tsx`
- Create: `postgres-interface/src/components/ConnectionRequest.tsx`
- Create: `postgres-interface/src/App.test.tsx`

**Interfaces:**
- `App` accepts an optional interface-client factory only for tests. Production creates the client inside an effect and pairs each instance with `wire.end()` cleanup, which is verified under React StrictMode.
- `ConnectionRequest` adapts the permission dialog to Tasks 7–8 and closes with the current PostgreSQL manager ID.
- `closeOnce` guards cancel/error/success races and emits at most one `wire.close`.

- [ ] **Step 1: Write failing App routing and lifecycle tests**

Cover initial loading, exact metadata selecting child mode, every extra/wrong field selecting dashboard, resource-based installed state, no-resource state, legacy resource without primary state showing teardown/reinstall-required, multiple resources failing closed, effect-created client cleanup under StrictMode, AbortSignal on unmount, and unrelated runs not changing installation state.

- [ ] **Step 2: Write failing child close tests**

Assert missing caller closes with status 400/message `A calling manager is required`; cancel uses 499/`Database access was cancelled`; active lock uses 409/`A PostgreSQL operation is already in progress`; recovery-required uses 503/`PostgreSQL recovery is required`; all other internal failures use 500/`Unable to create the PostgreSQL connection`. Success closes with the exact connection result; simultaneous cancel/success closes once; close never contains administrator state.

- [ ] **Step 3: Refactor App and ConnectionRequest to pass behavior tests**

Use explicit boot, dashboard, child-request, busy, success, and error states. Route events through the shared source and recover `postgres_operation:current` before allowing a new child workflow.

- [ ] **Step 4: Verify and commit Task 9**

Run: `npm test -- src/App.test.tsx src/components/PermissionDialog.test.tsx`

Expected: PASS.

Commit with `git add src/App.tsx src/App.test.tsx src/components/ConnectionRequest.tsx && git commit -m "feat: route postgres manager workflows"`.

---

### Task 10: Installation/Teardown Dashboard and Tailwind UI

**Files:**
- Modify: `postgres-interface/src/App.tsx`
- Rewrite: `postgres-interface/src/App.css`
- Rewrite: `postgres-interface/src/index.css`
- Rewrite: `postgres-interface/src/components/Teardown.tsx`
- Rewrite: `postgres-interface/src/components/Install.tsx`
- Create: `postgres-interface/src/components/ManagerDashboard.tsx`
- Create: `postgres-interface/src/components/ManagerDashboard.test.tsx`
- Create: `postgres-interface/src/components/Teardown.test.tsx`
- Create: `postgres-interface/src/components/Install.test.tsx`

**Interfaces:**
- Dashboard receives reconciled primary/resource state, install/teardown actions, prompt preference state, and reset action.

- [ ] **Step 1: Write failing lifecycle tests**

Assert one install click generates credentials/operation ID, atomically saves install-prepared before action `create`, uses exact correlation note, saves returned run ID as install-running, disables duplicates, and never renders credentials. Status 2 with temporarily absent resource retains recovery and retries discovery; status 2 plus resource transitions ready; status 3 retains credentials as install-failed. Reload reconciles install-prepared through exhaustive action/note lookup and install-running by exact ID. Teardown atomically acquires kind teardown/phase teardown-starting, uses note `postgres-teardown:<operationId>`, and transitions primary/lock to running only after a valid response or correlated exact run ID. Crash/ambiguity performs exhaustive action/note lookup; proven absence leaves primary phase unchanged (`ready` or retryable `teardown-failed`), moves the lock to teardown-release-required, and releases it. Status 2 deletes primary state and scoped permission key, sets teardown-release-required, then releases the lock last. Confirmed status 3 alone transitions teardown-running primary state to teardown-failed, sets teardown-release-required, and releases the lock so retry can acquire anew. If deletion fails, boot sees teardown-release-required plus the recorded terminal/proven-absent result and retries release without starting teardown. Connection workflows revalidate ready state after their lock; active connection journals are never deleted to begin teardown.

- [ ] **Step 2: Write failing dashboard/preference tests**

Cover install/installed/recovery/legacy cards, loading and non-secret alerts, disabled controls, destructive teardown copy, remembered-prompt status, and reset removing only the exact current manager/resource key.

- [ ] **Step 3: Implement lifecycle and dashboard behavior**

Do not offer a new install while any primary record is unresolved. Require explicit successful teardown before deleting retained administrator credentials.

- [ ] **Step 4: Apply Tailwind 4 UI**

Keep the existing Tailwind Vite plugin and use `@import "tailwindcss";`. Build a responsive neutral/slate shell, PostgreSQL-accent cards, consistent primary/secondary/danger buttons, focus rings, disabled states, live alerts, loading indicators, and modal overlay. Remove starter demo CSS.

- [ ] **Step 5: Verify and commit Task 10**

Run: `npm test -- src/components/Install.test.tsx src/components/ManagerDashboard.test.tsx src/components/Teardown.test.tsx src/App.test.tsx`

Expected: PASS.

Run: `npm run build`

Expected: exit 0.

Run: `rg -q '\\.max-w-4xl|\\.rounded-2xl' dist/assets/*.css`

Expected: exit 0, proving representative Tailwind utilities were generated.

Commit with `git add src/App.tsx src/App.css src/index.css src/components/Install.tsx src/components/Install.test.tsx src/components/ManagerDashboard.tsx src/components/ManagerDashboard.test.tsx src/components/Teardown.tsx src/components/Teardown.test.tsx && git commit -m "feat: build postgres manager dashboard"`.

---

### Task 11: Documentation, Integration Test, and Full Verification

**Files:**
- Create: `postgres-interface/README.md`
- Create: `postgres-interface/src/lib/postgresIntegration.test.ts`
- Create: `postgres-interface/src/lib/managerDatabaseIntegration.test.ts`
- Modify only when a failing verification demonstrates the need: files introduced in Tasks 1–10

**Interfaces:**
- The integration test begins with `// @vitest-environment node`, is opt-in with `POSTGRES_INTEGRATION_CONTAINER`, and skips when unset. It uses `child_process.spawn` with argument arrays to run `docker exec -i` against that `postgres:15` container, passes scripts on stdin, supplies environment with Docker `-e`, captures output for redaction assertions, and never requires a host `psql` binary.
- The manager-database integration test is opt-in with `MANAGER_DATABASE_HARNESS_MODULE`, dynamically imports that local module's exported real `RPCCaller`, exercises atomic create/read/CAS/delete through `databaseQuery`, verifies one statement at index zero and the exact `[]`/`[operationId]` shapes, and cleans both fixed records in `finally`. It skips when no Deploy Commander integration harness module is supplied.

- [ ] **Step 1: Add an opt-in real PostgreSQL test**

Execute the fixed provisioning script against a disposable PostgreSQL 15 instance, verify the role/database exist and ownership/privileges are scoped, rerun to prove idempotency, execute cleanup, and verify both objects are absent. Pass secrets through process environment without printing command environments.

- [ ] **Step 2: Run the integration test when Docker/PostgreSQL is available**

From `postgres-interface`, run:

```bash
integration_container=dc-postgres-installer-integration
docker run --name "$integration_container" -e POSTGRES_USER=integration_admin -e POSTGRES_PASSWORD=integration_only_password -e POSTGRES_DB=postgres -p 127.0.0.1:55432:5432 -d postgres:15
trap 'docker rm -f "$integration_container" >/dev/null 2>&1 || true' EXIT
for attempt in $(seq 1 60); do docker exec "$integration_container" pg_isready -U integration_admin -d postgres >/dev/null 2>&1 && break; [ "$attempt" -lt 60 ] || exit 1; sleep 1; done
POSTGRES_INTEGRATION_CONTAINER="$integration_container" npm test -- src/lib/postgresIntegration.test.ts
```

Expected: PASS. If Docker is unavailable, record the environmental limitation and retain the skipped-by-default test.

- [ ] **Step 3: Document the final manager contract**

Document metadata `{ "action": "create-connection" }`, resource identity, private `postgres_state:primary`, non-secret operation journal, connection metadata fields, permission-key scope/reset behavior, runner command requirement, status mapping, recovery behavior, local commands, and the opt-in integration test. State explicitly where both credential classes may and may not appear.

- [ ] **Step 4: Run fresh complete verification**

From `postgres-interface` run:

```bash
npm test
npm run lint
npm run build
```

Expected: every command exits 0 with no test failures, lint errors, TypeScript errors, or Vite build errors.

- [ ] **Step 5: Audit requirements and secrets**

Run repository searches for old fixed credentials, `console.log`, `Math.random`, administrator fields in resource/connection builders, and password fields in journal builders. Inspect the built UI and verify every requirement in the spec maps to a passing test or documented integration check.

- [ ] **Step 6: Commit Task 11**

Commit with `git add README.md src/lib/postgresIntegration.test.ts src/lib/managerDatabaseIntegration.test.ts && git commit -m "docs: document postgres logical connections"`.

- [ ] **Step 7: Request final SOL review and fix all Critical/Important findings**

Give SOL the spec, this plan, full diff from the pre-implementation base, and verification output. Require explicit review of secret paths, SQL/shell quoting, exact run correlation, journal recovery ordering, duplicate races, RPC ownership, and UI permission scope. Re-run Step 4 after every fix round.
