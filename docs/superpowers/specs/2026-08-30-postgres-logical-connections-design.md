# PostgreSQL Logical Connections Design

## Purpose

Extend the Deploy Commander PostgreSQL manager so one long-running PostgreSQL installation can provide isolated logical databases and roles to calling managers. The workflow provisions PostgreSQL first, persists a Deploy Commander connection second, and returns the resulting connection through the manager-interface close result.

The implementation also replaces fixed primary credentials, adds an installation-scoped permission prompt, derives installation state from the PostgreSQL resource, and refreshes the interface with focused Tailwind styling.

## Confirmed Existing Contracts

The installed `@ezenki/deploy-commander-installer-interface` package exposes:

- `getManager()` for the current PostgreSQL manager.
- `getCallingManager()` for the trusted caller identity. Although its declaration returns `Promise<string>`, the integration guide requires null-like runtime values to be rejected.
- `getMetadata()` for untrusted interface-open metadata.
- `getMyResources()`, `getResource()`, `getConnections()`, and `getConnection()` for resource and connection discovery.
- `createConnection(config, manager, external, resource)` for persistence.
- `databaseQuery(query, bindings)` for the current manager's isolated SurrealDB database.
- `start(action, runner, metadata, note?, platform?, platform_data?)` for runner work.
- `wire.close()` for returning child-workflow results and `wire.end()` for listener cleanup.

The current runner guide confirms that one-time services use `role: "runner"`, platform resource connections attach a container to the resource's Docker network, and dependency ordering does not establish application readiness.

The actual runner source is a prerequisite for implementation. Before installer code uses the new behavior, source inspection must confirm the service-model JSON field, Docker mapping, platform-connection representation, and run-status success/failure values.

## Runner Enhancement

Add one generic optional service field:

```go
Command *[]string `json:"command,omitempty"`
```

The exact Go type must follow the runner model's existing optional-slice convention after source inspection. Map a present command to Docker `Config.Cmd`. An omitted command preserves the image default. An explicitly present empty command must follow the Docker client and repository's existing optional-field semantics rather than inventing a special case.

Do not add entrypoint support unless source inspection demonstrates that command mapping cannot satisfy the one-shot PostgreSQL client workflow.

Add model/decoding tests and Docker container-configuration tests. Confirm that runner-role containers still exit, are removed, and make the run fail on nonzero exit.

## Primary Installation and Private State

Generate credentials in the browser with `crypto.getRandomValues` at the moment installation is submitted:

- Administrator role: `pg_admin_` plus 32 lowercase hexadecimal characters.
- Administrator password: 32 random bytes encoded as base64url.

Use the generated values as `POSTGRES_USER` and `POSTGRES_PASSWORD`. Set `POSTGRES_DB=postgres`. Preserve the service key, resource type, resource name, image, and volume name as `postgres`, `postgres`, `postgres`, `postgres:15`, and `postgres-data`. Give the service the stable alias `postgres` and mount `postgres-data` at `/var/lib/postgresql/data`.

The resource metadata describes the resource without secrets. It must not contain administrator credentials.

Persist all private primary state as one record in the PostgreSQL manager's isolated SurrealDB database:

```text
postgres_state:primary
  admin_username
  admin_password
  resource_id
  initialized_at
```

Use `databaseQuery` with bindings for every application value. Follow confirmed repository SurrealDB record/schema conventions once the relevant source is available. Do not put administrator credentials in local storage, logs, UI output, runner notes, connection metadata, error details, or resource metadata.

Because the resource ID is created asynchronously by the installation run, primary-state persistence is a post-run initialization step: await the exact successful installation run, discover the exact owned `postgres` resource, then create or update the single state record. If state persistence fails, present a non-secret recovery error and do not report installation initialization as complete.

Installation state is derived from the exact owned resource (`type === "postgres"`, `name === "postgres"`), not from the latest run action.

## Interface Modes

At startup, retain both the stable wire and RPC caller, retrieve the current manager and interface metadata, and discover the primary resource.

Metadata is treated as untrusted. Only this exact contract selects the connection workflow:

```json
{
  "action": "create-connection"
}
```

No caller identity or resource ID is accepted through metadata. Other metadata selects the normal manager dashboard.

In connection mode, retrieve the caller with `getCallingManager()` and reject null, non-string, or empty values with a structured close error. The current PostgreSQL manager returned by `getManager()` is the `manager` field used in `wire.close()`.

## Permission Preference

Before presenting a prompt, check for an existing connection for the calling-manager/resource pair. An existing connection is returned immediately and never provisions another database.

For a new connection, show an accessible modal explaining that the named calling manager requests a logical database and credentials from this PostgreSQL installation. It provides Allow, Cancel, and a “Don't ask me again” checkbox.

Scope the preference to the installation:

```text
deploy-commander:postgres:create-connection:<current-manager-id>:<resource-id>
```

Store only the literal value `allow`, and only when Allow is selected while the checkbox is checked. Cancel never stores approval. Storage read/write failures fall back to prompting. The normal dashboard exposes a control that removes this exact key and re-enables prompts.

## Generated Logical Credentials

For each new provisioning operation generate independent values:

- Database: `db_` plus 32 lowercase hexadecimal characters.
- Role: `pg_user_` plus 32 lowercase hexadecimal characters.
- Password: 32 random bytes encoded as base64url.

Identifiers remain below PostgreSQL's 63-byte limit and satisfy a strict application-generated lowercase identifier allowlist. Never accept database or role identifiers from interface metadata or form input in this iteration.

## One-Shot PostgreSQL Provisioning

Read the single private primary-state record and validate it. Read the exact resource and validate its platform connection. Start action `create-connection` with one stable `postgres-admin` service:

- Image `postgres:15`.
- Role `runner`.
- The confirmed platform connection for the existing primary resource.
- A `command` array that invokes `sh -ceu` with the fixed administration script.
- `PGHOST=postgres`, `PGPORT=5432`, `PGDATABASE=postgres`, and administrator credentials in environment variables.
- Generated database, role, and password in separate environment variables.

The fixed script uses no shell tracing and never echoes secrets. It performs bounded `pg_isready -q` retries, then invokes `psql -X --quiet --set=ON_ERROR_STOP=1`. Application values enter `psql` through variables. Dynamic SQL uses PostgreSQL server-side `format('%I', ...)` for identifiers and `format('%L', ...)` for literals, executed through `\gexec`; values are never concatenated into raw SQL in TypeScript or shell.

Provisioning conditionally creates or repairs the role, enforces `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`, conditionally creates the database with that owner, repairs ownership, revokes database privileges from `PUBLIC`, grants access to the role, and revokes `CREATE` on the target database's public schema from `PUBLIC`.

The plan includes only the temporary runner service. It never includes or replaces the primary `postgres` service and never creates another persistent server.

## Run Monitoring

Confirm named run-status constants or exact values from source before implementation. Do not infer success from undocumented numeric values.

Monitor only the run ID returned by `start`:

- Accept events only when `payload.id` equals the expected run ID.
- Ignore unrelated and ID-less updates.
- Poll `getRun(expectedRunId)` as the authoritative fallback because an event can be early, absent, or incomplete.
- Support timeout and abort cleanup.
- Treat confirmed failure as failure even if some SQL statements may already have completed.

Installation, provisioning, and cleanup operations use the same run-monitoring boundary but keep separate UI state.

## Deploy Commander Connection

Immediately before persistence, repeat the filtered duplicate query to reduce race impact. If another workflow created the connection, compensate for this workflow's newly provisioned database and return the existing connection.

The connection is owned by the calling manager, is non-external, and references the existing primary PostgreSQL resource. Its project contract is:

```ts
interface PostgresConnectionMetadata {
  host: "postgres";
  port: 5432;
  database: string;
  username: string;
  password: string;
}
```

Do not add an unconfirmed TLS field. The stable alias is the hostname and the resource association provides the platform relationship. Administrator credentials never appear in this object.

After `createConnection` succeeds, close with the exact returned `{ connection, config }` result:

```ts
wire.close({
  manager: currentPostgresManager.id,
  ok: true,
  result: createdConnection,
});
```

## Recovery and Compensation

Use a separate non-secret operation journal in the manager database, written through bound parameters. It records the calling manager, resource, generated database/role identifiers, run ID, and phase, but never either administrator or per-connection passwords.

Failure behavior:

- Cancel: close with a structured cancellation result; do not journal or start a run.
- Runner start rejection: remove the new journal; do not create a connection.
- Provisioning failure: do not create a connection. Run idempotent cleanup because SQL may have partially succeeded.
- Connection creation rejection: query once more for the exact connection to reconcile an ambiguous response. If it exists, return it without cleanup. Otherwise run cleanup and await its exact run ID.
- Cleanup terminates sessions for the generated database, safely drops the database, then safely drops the role.
- Successful cleanup deletes the journal and returns the original structured error.
- Failed cleanup marks the journal `cleanup-required`, returns a fixed non-secret error, and prevents new provisioning until cleanup succeeds.
- A later invocation first checks for an existing connection. If one exists, it removes stale journal state and returns it. Otherwise it retries required cleanup before generating new credentials.

The runner is not assumed to provide transactional rollback.

## UI

Use the existing React/Vite/Tailwind stack. Configure Tailwind 4 through `@import "tailwindcss"`. Replace starter styles with a responsive centered container, focused installation/status cards, consistent buttons and form controls, accessible loading indicators, readable success/error panels, the permission modal, and the permission-reset setting.

Preserve installation and teardown behavior. Keep installation lifecycle, connection workflow, and individual runner-operation state explicit rather than deriving all behavior from one boolean.

## Testing and Verification

Add Vitest, jsdom, React Testing Library, user-event, and jest-dom following Vite conventions. Use test-driven development for each behavior.

Coverage includes:

- Random and independent primary credentials; no resource-metadata secret.
- Primary installation plan, volume mount, alias, and private manager-state persistence.
- Resource-derived installation state.
- Exact metadata-mode detection and missing caller rejection.
- Permission allow, cancel, skip, storage failure, and prompt re-enabling.
- Duplicate connection reuse before permission and before persistence.
- Logical credential generation and identifier constraints.
- Exact provisioning/cleanup runner metadata and safe fixed SQL script.
- Readiness retry and exact run-ID monitoring.
- Provisioning failure without connection persistence.
- Connection-persistence failure, reconciliation, cleanup success, cleanup failure, and retry recovery.
- Correct connection owner/resource/configuration and close result.
- Administrator and connection secrets absent from logs, resource metadata, journal data, UI errors, and runner notes.
- Existing installation and teardown behavior.

Completion requires fresh successful frontend tests, lint, TypeScript/Vite build, representative generated Tailwind CSS verification, runner tests/build, a real PostgreSQL integration smoke test, and final SOL review focused on secrets, SQL quoting, run correlation, recovery ordering, and duplicate races.

## Scope Boundaries

Do not create per-connection PostgreSQL containers, add entrypoint support without demonstrated need, redesign the runner, accept trusted IDs through metadata, expose administrator credentials, add a new encryption subsystem, bypass manager-interface RPCs, add hypothetical metadata options, or perform unrelated refactors.
