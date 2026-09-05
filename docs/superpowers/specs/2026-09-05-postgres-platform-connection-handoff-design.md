# PostgreSQL Platform Connection Handoff Design

## Purpose

Make every successful PostgreSQL logical-connection response sufficient for a consuming Deploy Commander manager to attach its workload to the PostgreSQL resource network. The PostgreSQL manager must return the runner-compatible, authoritative Docker `Platform` connection together with the existing hostname and logical database credentials.

This work also corrects tightly related validation, recovery error mapping, module coupling, documentation, and test-execution issues found while auditing the connection workflow. Dependency upgrades and development-server host policy remain separate follow-up work.

## Confirmed Problem

The PostgreSQL manager currently creates a non-external Deploy Commander connection associated with the PostgreSQL resource. Its metadata contains only:

```ts
interface PostgresConnectionMetadata {
  host: "postgres";
  port: 5432;
  database: string;
  username: string;
  password: string;
}
```

The Deploy Commander runner does not infer Docker attachment from that connection record. A consuming service must receive a complete resolved resource connection in `services.<service>.connections`:

```ts
interface PlatformConnection {
  type: "Platform";
  data: {
    network: string;
  };
}
```

Creating a Deploy Commander connection record and attaching a service to a resolved platform network are separate operations. The current child-interface response therefore gives a consumer database configuration but not the runner input required to reach `postgres:5432`.

The audit also found that existing connection validation checks the connection envelope but accepts empty or malformed metadata. Consequently, duplicate detection and recovery can return a connection that does not satisfy the PostgreSQL consumer contract.

## Chosen Contract

Extend the connection metadata additively:

```ts
interface PostgresConnectionMetadata {
  host: "postgres";
  port: 5432;
  database: string;
  username: string;
  password: string;
  platform_connection: PlatformConnection;
}
```

For Docker, the serialized field is:

```json
{
  "type": "Platform",
  "data": {
    "network": "exact-runner-generated-network-name"
  }
}
```

The consuming manager passes the complete value directly to its runner plan:

```ts
const metadata = created.config.metadata as PostgresConnectionMetadata;

const plan = {
  services: {
    app: {
      image: "example/app:latest",
      connections: [metadata.platform_connection],
      environment: {
        PGHOST: metadata.host,
        PGPORT: String(metadata.port),
        PGDATABASE: metadata.database,
        PGUSER: metadata.username,
        PGPASSWORD: metadata.password,
      },
    },
  },
};
```

This is additive for consumers already reading the five existing metadata fields and keeps the success result as the shared `RPC.CreateConnection` type. It avoids a breaking response wrapper and does not require a new shared RPC.

## Trust and Authorization Boundary

The Docker network name must come only from the PostgreSQL resource's current `config.platform_connection`, retrieved through the resource-owning PostgreSQL manager's authorized `getResource(resourceId)` call.

The implementation must:

- Parse the value with the strict `PlatformConnection` validator.
- Preserve the exact validated network name except for the validator's existing surrounding-whitespace normalization.
- Never derive a network name from resource, manager, service, container, or connection identifiers.
- Never accept a network name from interface-open metadata or the calling manager.
- Never create a Docker network directly.
- Continue using Deploy Commander's trusted calling-manager context and the explicit user approval boundary before provisioning a new logical database.

The platform connection is not a credential, but it grants the information needed to request runner attachment to the resource network. It must therefore remain inside the authorized connection response and must not be displayed or logged casually.

## New Connection Flow

The normal creation flow remains provision-first and persist-second:

1. Validate the trusted current manager, calling manager, ready primary state, exact PostgreSQL resource, and initially resolved platform connection.
2. Look for an existing connection.
3. Obtain approval when no existing connection is present.
4. Acquire the manager-wide operation journal.
5. Revalidate primary state, resource identity, and `config.platform_connection` after acquiring the journal.
6. Provision the logical role and database using the revalidated platform connection.
7. Persist connection metadata containing the logical credentials and that same revalidated platform connection.
8. Return a normalized, validated `RPC.CreateConnection` result containing the platform connection.

The platform connection used for persistence must be the post-lock revalidated value, not a stale value captured before permission or lock acquisition.

## Existing and Legacy Connections

Duplicate detection must validate the full PostgreSQL metadata contract rather than only the outer connection/configuration identifiers.

A current connection is valid when:

- The summary and full connection have the expected nonblank ID.
- The owning manager equals the trusted calling manager.
- The resource equals the exact PostgreSQL resource ID.
- The connection is non-external.
- The configuration ID, manager, and resource agree with the summary.
- Metadata contains `host: "postgres"` and `port: 5432`.
- Database and username satisfy the generated logical-identifier formats.
- Password is a nonblank string.
- `platform_connection`, when present, is a valid Docker `Platform` connection.

Connections created by earlier versions may contain valid PostgreSQL credentials but no `platform_connection`. They must not be destroyed or duplicated. The manager returns a cloned response whose metadata is enriched with the current authoritative resource platform connection. The stored legacy record remains unchanged because the installed interface exposes no connection-update RPC.

An existing platform connection that differs from the current authoritative resource platform connection must be replaced in the returned cloned response. This prevents a stale network snapshot from being handed to a new runner invocation after platform reconciliation. New connections persist the current value.

A present but structurally invalid `platform_connection` is not a legacy omission and must fail closed. Only an absent field on otherwise valid historical metadata qualifies for response-time enrichment.

Malformed credentials, ownership, resource association, external state, or configuration identity fail closed. The manager must not provision a second logical database when an existing record is present but malformed; it returns a fixed non-secret connection/recovery error for administrative resolution.

## Recovery and Race Reconciliation

Every path that returns a connection must apply the same normalization and enrichment helper:

- Initial duplicate detection.
- The duplicate check immediately before persistence.
- Reconciliation after an ambiguous `createConnection` response.
- Boot recovery of a committed connection.
- Recovery invoked by a child request for the same caller.

Recovery already receives the current validated platform connection from the current PostgreSQL resource. It must use that value when returning a connection and retain the existing caller guard: a recovered connection is never returned to a child request for a different calling manager.

Connection-to-journal matching continues to compare the generated database and username. The new platform field does not identify a provisioning operation and must not weaken or replace those checks.

## Module Boundaries

Create a focused connection-contract module responsible for:

- Validating connection summaries, pages, full configurations, and PostgreSQL metadata.
- Normalizing a valid connection result with the current authoritative platform connection.
- Finding the unique existing connection for a calling-manager/resource pair.

Both creation and recovery import this module. The contract module must not import either workflow. This removes the current circular dependency between `createPostgresConnection.ts` and `recoverProvisioning.ts` while keeping lifecycle orchestration separate from data validation.

The PostgreSQL plan module remains responsible for building runner plans and persisted metadata. Its metadata builder accepts logical credentials and the validated platform connection.

## Error Contract

The child interface continues returning fixed, non-secret errors.

- `400`: missing or invalid trusted calling-manager context.
- `409`: another manager-wide PostgreSQL operation owns the journal.
- `499`: the user cancelled the permission prompt.
- `503`: primary state, resource identity, platform connection, recovery state, or an existing connection contract requires administrative recovery.
- `500`: provisioning, cleanup, or persistence failed without a more specific safe classification.

Introduce or consistently use a typed recovery-required error at workflow boundaries. Do not depend on several internal error-message strings to classify a `503`. Detailed RPC, database, runner, network, and secret-bearing errors remain normalized and are never returned through `wire.close()`.

## React Lifecycle Correction

Make the `ConnectionRequest` close function referentially stable, include it in the effect dependency list, and preserve exactly-once close behavior through `closedRef`. This removes the existing hook warning without allowing a rerender to restart provisioning or close the child interface twice.

## Test Execution Reliability

The current default Vitest worker fan-out fails to start in the constrained project container, while a single-worker run executes all runnable tests successfully. Configure the project test command or Vitest settings to use one worker by default so `npm test` is deterministic in the supported development environment.

This setting changes file-level test parallelism only. It must not remove or serialize the explicit in-test concurrency case that verifies manager-wide operation locking.

## Documentation Changes

Update the PostgreSQL manager consumer guide to:

- Show `platform_connection` in the successful connection metadata.
- State that the value is the authoritative runner-generated resource connection.
- Show a complete consuming service plan with `connections: [metadata.platform_connection]`.
- Explain that the runner attaches the consumer to the exact existing Docker network and that `postgres` resolves only after attachment.
- Explain legacy behavior: callers should obtain the connection through the child workflow rather than assume an independently cached old `getConnection` result contains the platform field.
- Preserve warnings against logging credentials or reconstructing network names.

Update the existing logical-connections design documentation where it currently states only that resource association provides the platform relationship. Clarify that association authorizes the relationship, while the resolved platform connection in the response supplies the concrete runner input.

The generic runner and manager interface guides already describe the separation correctly. Change them only if a cross-reference is needed; do not redefine runner behavior in PostgreSQL-specific documentation.

## Testing Strategy

Use test-driven development for each behavior.

Unit coverage must prove:

- Connection metadata includes the exact validated platform connection.
- The post-lock revalidated platform value is persisted instead of the initial value.
- A valid existing connection is returned with the current platform connection.
- A legacy connection with otherwise valid metadata is enriched without provisioning, persistence, or permission prompting.
- A stored stale platform connection is replaced only in the returned clone.
- The original RPC object is not mutated during normalization.
- Malformed host, port, database, username, password, platform data, ownership, resource, or external state fails closed.
- Duplicate-page ambiguity and pagination validation remain fail-closed.
- Race reconciliation returns an enriched connection and does not clean up the committed logical database.
- Boot recovery returns an enriched connection only to the matching caller.
- Recovery errors map to `503` without leaking internal details.
- `ConnectionRequest` still closes exactly once across rerenders and unmount aborts.
- The default `npm test` command runs in the supported container.

Verification requires:

- Focused red/green tests for connection metadata, creation, recovery, and the React child workflow.
- The complete frontend unit suite.
- ESLint with zero warnings.
- TypeScript and Vite production build.
- Production and full dependency audits reported separately; development-only advisories do not silently block this contract change but remain recorded as follow-up work.
- The opt-in real PostgreSQL integration test when a suitable Docker container is provided.

## Audit Findings Outside This Change

The following findings are intentionally not repaired by this implementation:

- Development dependency advisories reported by `npm audit`: six high and one low, with no production dependency advisories.
- The restored `node_modules` tree is inconsistent with `package.json`, including an installed Vite major version outside the declared range and an extraneous esbuild package. A clean dependency installation and deliberate upgrade review are required before changing the lockfile.
- The development server binds to all interfaces and allows every host. Restricting host policy requires confirming the Deploy Commander/dev-container embedding hostnames so local access is not broken.
- Several orchestration functions have high cyclomatic complexity. This change extracts the connection contract needed to remove the concrete workflow cycle but does not broadly rewrite proven lifecycle and recovery state machines.

These items should be handled in one or more dedicated follow-up changes with their own verification.

## Scope Boundaries

This change does not:

- Change Deploy Commander runner behavior.
- Add or modify a shared installer-interface RPC.
- Introduce a breaking wrapper around `RPC.CreateConnection`.
- Recreate or delete legacy connections solely to add platform metadata.
- Put platform data in PostgreSQL resource metadata.
- Expose administrator credentials.
- Accept caller, resource, database, username, password, or network values from interface-open metadata.
- Create, rename, or infer Docker networks.
- Fix unrelated dependency, dev-server, UI, or lifecycle complexity findings.
