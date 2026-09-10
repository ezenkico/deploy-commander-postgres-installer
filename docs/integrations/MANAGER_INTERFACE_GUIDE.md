# MANAGER_INTERFACE_GUIDE.md

## Purpose

This guide explains how to build a manager frontend that runs inside the Deploy Commander interface and communicates with Deploy Commander through:

`@ezenki/deploy-commander-installer-interface`

This document is intended for:

* Coding agents implementing a manager frontend
* Developers integrating an existing frontend with Deploy Commander
* Developers building parent and child manager workflows
* Developers using manager-scoped resources, connections, runs, events, and tokens

This guide is for consumers of the library.

It is not a guide for modifying the library itself.

## How the Integration Works

A manager frontend runs inside a page or frame controlled by the Deploy Commander frontend.

The manager frontend does not normally call the Deploy Commander HTTP API directly.

Instead, communication follows this path:

```text
Manager frontend
    ↓
Interface library
    ↓
window.postMessage
    ↓
Deploy Commander frontend
    ↓
Deploy Commander HTTP API
    ↓
Deploy Commander backend
```

The library provides:

* A wire transport
* Typed RPC methods
* Parent and child interface communication
* Child-interface lifecycle handling
* Run event delivery
* Manager-token refresh support

## Core Security Model

The manager frontend must not choose its own trusted manager identity.

Deploy Commander knows which manager interface is running and injects that manager context into scoped operations.

For manager-scoped calls, the library generally sends only the requested resource, run, or connection ID.

For example:

```ts
await caller.getConnection(connectionId);
```

The library sends the connection ID.

The Deploy Commander frontend injects the current manager ID and calls the manager-scoped backend endpoint.

Do not add a caller-controlled current-manager argument to scoped RPC calls.

The backend remains the final authorization boundary.

## Installation

Install the package:

```sh
npm install @ezenki/deploy-commander-installer-interface
```

The package provides:

* ESM output
* CommonJS output
* TypeScript declarations

## Basic Initialization

A manager frontend normally creates:

1. A wire instance
2. An RPC caller
3. An event handler
4. An incoming parent or child RPC handler
5. Cleanup behavior

Example:

```ts
import {
  createWire,
  type RPCCall,
  type RPCResponse,
} from "@ezenki/deploy-commander-installer-interface";

import {
  RPC,
  Events,
} from "@ezenki/deploy-commander-installer-interface";

async function handleIncomingCall(
  call: RPCCall
): Promise<RPCResponse> {
  switch (call.request) {
    case "ping":
      return {
        ok: true,
        result: {
          message: "pong",
        },
      };

    default:
      return {
        ok: false,
        error: {
          message: `Unknown interface request: ${call.request}`,
        },
      };
  }
}

function handleEvent(event: Events.InterfaceEvent) {
  switch (event.eventType) {
    case "run-start":
      console.log("Run started", event.data);
      break;

    case "run-update":
      if (event.data.type === "event") {
        console.log("Run event", event.data.payload);
      } else {
        console.log("Run log", event.data.payload);
      }
      break;
  }
}

const wire = createWire(
  handleIncomingCall,
  handleEvent
);

const caller = RPC.SetupRPCCaller(wire);
```

The same `wire` instance should be used for the lifetime of the manager interface.

## Cleanup

When the manager frontend is destroyed or unmounted, call:

```ts
wire.end();
```

This removes the browser message listener.

It does not close the manager interface.

It also does not currently reject pending RPC or child-interface promises.

Do not call `wire.end()` while the application still expects responses.

In a framework component, cleanup may look like:

```ts
return () => {
  wire.end();
};
```

## RPC Error Handling

RPC methods throw the structured error returned by Deploy Commander.

The thrown value is not guaranteed to be an `Error` instance.

Use defensive error handling:

```ts
try {
  const run = await caller.getRun(runId);
  console.log(run);
} catch (error: any) {
  console.error(
    error?.message ?? "RPC call failed",
    error?.status,
    error?.details
  );
}
```

Typical RPC errors use this shape:

```ts
{
  message: string;
  status?: number;
  details?: any;
}
```

Do not rely only on:

```ts
error instanceof Error
```

## Available RPC Calls

## Runs

### Run Status Values

Run status fields and the `statuses` and `not_statuses` filters use these numeric values:

```ts
import {
  STATUS_QUEUED,
  STATUS_RUNNING,
  STATUS_DONE,
  STATUS_FAILED,
} from "@ezenki/deploy-commander-installer-interface";
```

### Start a Run

```ts
const result = await caller.start(
  "deploy",
  runnerId,
  {
    version: "1.2.3",
  },
  "Deploy version 1.2.3",
  "docker",
  {
    image: "example/app:1.2.3",
  }
);
```

Arguments:

```ts
start(
  action,
  runner,
  metadata,
  note?,
  platform?,
  platform_data?
)
```

Returns:

```ts
{
  id: string;
  queued_at: string;
  status: number;
}
```

The `metadata` and `platform_data` values are intentionally unstructured.

### List Runs

```ts
const result = await caller.getRuns(
  undefined,
  ["1", "2"],
  undefined,
  "-created_at",
  50,
  0
);
```

Arguments:

```ts
getRuns(
  user_id?,
  statuses?,
  not_statuses?,
  sort?,
  limit?,
  offset?
)
```

Returns:

```ts
{
  items: RunItem[];
  limit: number;
  offset: number;
  total: number;
}
```

### Get One Run

```ts
const result = await caller.getRun(runId);
```

Returns:

```ts
{
  run: RunItem;
  config: RunConfiguration;
}
```

The call is scoped to the current manager.

## Manager Context

### Get the Current Manager

```ts
const managerId = await caller.getManager();
```

The result is the current manager ID as a `string`. Use it when the application
needs to identify the manager whose interface is currently running.

### Get the Calling Manager

```ts
const callingManager = await caller.getCallingManager();
```

This returns the manager ID that opened the current manager interface.

For a root interface, there may be no calling manager.

Consumers should be prepared for a null-like runtime result even if the current public type is stricter.

Example:

```ts
const callingManager =
  await caller.getCallingManager();

if (callingManager) {
  console.log("Opened by manager", callingManager);
}
```

### Get Interface Metadata

```ts
const metadata = await caller.getMetadata();
```

This returns the metadata supplied when the current interface was opened.

Metadata is intentionally unrestricted.

Validate it before using it.

Example:

```ts
const metadata = await caller.getMetadata();

if (
  metadata &&
  typeof metadata === "object" &&
  typeof metadata.resourceId === "string"
) {
  console.log(metadata.resourceId);
}
```

## Resources

### List Resources

```ts
const result = await caller.getResources(
  "database",
  false,
  undefined,
  50,
  0
);
```

Arguments:

```ts
getResources(
  resourceType?,
  external?,
  manager?,
  limit?,
  offset?
)
```

This returns resource summaries.

Each item has the following shape:

```ts
interface ResourceItem {
  agent?: string;
  created_at: string;
  external: boolean;
  id: string;
  name: string;
  manager: string;
  type: string;
  updated_at: string;
}
```

The `manager` field identifies the manager that owns the resource.

It does not return full resource configuration.

The optional `manager` argument is a list filter.

It does not redefine the identity of the current interface.

### List Resources Owned by the Current Manager

```ts
const result = await caller.getMyResources(
  "database",
  false,
  50,
  0
);
```

Arguments:

```ts
getMyResources(
  resourceType?,
  external?,
  limit?,
  offset?
)
```

Deploy Commander injects the current manager scope.

### Get One Resource

```ts
const result = await caller.getResource(
  resourceId
);
```

Returns:

```ts
{
  resource: ResourceItem;
  config: ResourceConfiguration;
}
```

The returned `resource.manager` identifies the manager that owns the resource.

This call only succeeds when the resource is owned by the current manager.

A manager frontend cannot use this call to retrieve another manager's private resource configuration.

### Create a Resource

```ts
const result = await caller.createResource(
  {
    metadata: {
      engine: "postgres",
      version: "17",
    },
    name: "primary-database",
    platform_connection: {
      namespace: "production",
    },
    public_connection: {
      address: "db.example.com",
      port: 5432,
    },
  },
  false,
  "Primary Database",
  "database"
);
```

Arguments:

```ts
createResource(
  config,
  external,
  name,
  type
)
```

The current manager is injected by Deploy Commander.

Do not include or attempt to override the owning manager in the config.

The config field is:

```ts
metadata
```

Do not use the previous misspelling:

```ts
medatata
```

## Connections

Connections associate a manager with a resource.

A connection may be visible to the current manager because:

* The current manager owns the connection
* The current manager owns the resource attached to the connection

### List Connections

```ts
const result = await caller.getConnections(
  50,
  0,
  undefined,
  resourceId
);
```

Arguments:

```ts
getConnections(
  limit?,
  offset?,
  manager?,
  resource?
)
```

Optional filters:

* Connection-owning manager
* Resource
* Limit
* Offset

The manager filter only narrows the visible result set.

It does not allow the interface to escape its current authorization scope.

Returns:

```ts
{
  items: ConnectionItem[];
  limit: number;
  offset: number;
  total: number;
}
```

The list contains connection summaries and does not contain full connection configuration.

### Get One Connection

```ts
const result = await caller.getConnection(
  connectionId
);
```

Returns:

```ts
{
  connection: ConnectionItem;
  config: ConnectionConfiguration;
}
```

This call only succeeds when:

* The current manager owns the connection
* Or the current manager owns the attached resource

The library sends only the connection ID.

Deploy Commander injects the current manager identity.

### Create a Connection

```ts
const result = await caller.createConnection(
  {
    username: "manager-id",
    password: generatedPassword,
  },
  connectionOwningManagerId,
  false,
  resourceId
);
```

Arguments:

```ts
createConnection(
  config,
  manager,
  external,
  resource
)
```

The `manager` argument is the manager that will own the connection.

The current interface manager is treated as the resource-owning manager.

The resource-owner identity is injected by Deploy Commander and cannot be overridden by the embedded frontend.

### Update a Connection

```ts
const result = await caller.updateConnection(
  connectionId,
  {
    username: "updated-user",
    password: updatedPassword,
  }
);
```

Signature:

```ts
updateConnection(
  id: string,
  metadata: any
): Promise<UpdateConnection>
```

Returns:

```ts
{
  connection: ConnectionItem;
  config: {
    id: string;
    resource: string;
    manager: string;
    external: boolean;
    metadata: any;
    created_at: string;
    updated_at: string;
  };
}
```

The payload contains exactly `id` and `metadata`. Deploy Commander injects the trusted current manager identity when authorizing the update.

### Delete a Connection

```ts
await caller.deleteConnection(connectionId);
```

Signature:

```ts
deleteConnection(id: string): Promise<void>
```

The payload contains only `id`, and a successful response contains no data. Deploy Commander injects the trusted current manager identity when authorizing the deletion.

## Checking for an Existing Connection

Before creating a connection, use `getConnections` with manager and resource filters.

Example:

```ts
const existing = await caller.getConnections(
  1,
  0,
  connectionOwningManagerId,
  resourceId
);

if (existing.total > 0) {
  throw new Error(
    "A connection already exists for this manager and resource"
  );
}
```

This check improves user experience.

The backend should still enforce any required uniqueness rules.

Do not rely only on the frontend check for correctness under concurrent requests.

## Manager Database

Each manager has its own isolated SurrealDB database. The library exposes `databaseQuery` for running SurrealQL against the current manager's database.

```ts
const response = await caller.databaseQuery(
  `
    UPDATE setup_state:current
    SET status = $status,
        updated_at = time::now()
  `,
  {
    status: "ready",
  }
);
```

The method signature is:

```ts
databaseQuery(
  query: string,
  bindings?: Record<string, unknown>
): Promise<DatabaseQueryResult>
```

`query` is SurrealQL. Each entry in `bindings` is bound to the SurrealQL variable with the same name. In the example, `$status` receives the value of `bindings.status`. Use bindings for application values instead of constructing queries through string interpolation. Omit `bindings` when the query has no variables.

The response contains the result of each statement in the query:

```ts
interface DatabaseQueryResult {
  results: Array<{
    statement: number;
    status: "OK" | "ERR";
    time: string;
    result: unknown;
  }>;
}
```

The exact value of each `result` depends on the SurrealQL statement that produced it. A statement with `status: "ERR"` is returned as part of a successful RPC response; inspect every statement status. Transport, protocol, and policy failures still reject the call.

## Manager Tokens

Manager frontends may need a short-lived manager token for calling another authenticated service.

### Retrieve a Token Directly

```ts
const response =
  await caller.getManagerToken();

console.log(
  response.token,
  response.expires_at
);
```

### Use the Token Manager

The higher-level token manager automatically refreshes the token before expiration.

```ts
import {
  Caller,
} from "@ezenki/deploy-commander-installer-interface";

const tokenManager =
  await Caller.generateTokenManager(caller);

const initialToken =
  tokenManager.getToken();
```

Register for updates:

```ts
const handleTokenUpdate = (
  token: string
) => {
  console.log("Token updated", token);
};

tokenManager.addTokenUpdateEvent(
  handleTokenUpdate
);
```

Remove a listener:

```ts
tokenManager.removeTokenUpdateEvent(
  handleTokenUpdate
);
```

Dispose the manager:

```ts
tokenManager.dispose();
```

Always dispose the token manager when the application no longer needs it.

The token manager currently refreshes 30 seconds before expiration.

A failed scheduled refresh may stop automatic refreshing, so consuming applications should handle authentication failures from services using the token.

## Receiving Events

Pass an event callback to `createWire`.

```ts
function handleEvent(
  event: Events.InterfaceEvent
) {
  switch (event.eventType) {
    case "run-start":
      handleRunStart(event.data);
      break;

    case "run-update":
      handleRunUpdate(event.data);
      break;
  }
}
```

## Run-Start Events

A run-start event has:

```ts
{
  type: "event";
  eventType: "run-start";
  data: {
    id: string;
    manager: string;
    action: string;
    note?: string;
    created?: string;
  };
}
```

Example:

```ts
function handleRunStart(
  data: Events.RunStartEventData
) {
  console.log(
    `Run ${data.id} started for ${data.manager}`
  );
}
```

## Run Updates

A run update contains either:

* A structured event
* A log entry

Example:

```ts
function handleRunUpdate(
  update: Events.RunUpdateData
) {
  if (update.type === "event") {
    const event = update.payload;

    console.log(
      event.seq,
      event.phase,
      event.status,
      event.message
    );

    return;
  }

  const log = update.payload;

  console.log(
    log.seq,
    log.stream,
    log.level,
    log.message
  );
}
```

Live event payload fields are optional.

Do not assume values such as `seq`, `message`, or `at` are always present.

## Parent and Child Interface Calls

A manager interface may communicate with the interface that opened it or with interfaces it opened.

## Send a Call to the Parent

```ts
const response =
  await wire.sendToParent({
    request: "registrationComplete",
    payload: {
      resourceId,
    },
  });
```

Handle the response:

```ts
if (!response.ok) {
  throw response.error;
}
```

A root interface has no parent.

In that case Deploy Commander returns a failed RPC response.

## Send a Call to a Child

```ts
const response =
  await wire.sendToChild(
    childId,
    {
      request: "getStatus",
      payload: {},
    }
  );
```

The child must be a valid interface opened through the current parent relationship.

## Handle Incoming Parent or Child Calls

The first argument passed to `createWire` handles incoming interface RPC calls.

Example:

```ts
async function handleIncomingCall(
  call: RPCCall
): Promise<RPCResponse> {
  try {
    switch (call.request) {
      case "getStatus":
        return {
          ok: true,
          result: {
            ready: true,
          },
        };

      case "setConfiguration":
        await applyConfiguration(
          call.payload
        );

        return {
          ok: true,
          result: null,
        };

      default:
        return {
          ok: false,
          error: {
            message:
              `Unknown request: ${call.request}`,
          },
        };
    }
  } catch (error: any) {
    return {
      ok: false,
      error: {
        message:
          error?.message ??
          "Incoming call failed",
      },
    };
  }
}
```

The handler must return a complete `RPCResponse`.

Do not throw deliberately for normal validation failures.

Return a structured failed response instead.

## Starting a Child Manager Interface

Use:

```ts
const child =
  await wire.startInterface({
    manager: childManagerId,
    metadata: {
      resourceId,
      purpose: "configure",
    },
  });
```

The result contains:

```ts
{
  id: string;
  close: Promise<InterfaceResponse>;
}
```

The child ID may be used with:

```ts
wire.sendToChild(...)
```

Wait for the child to close:

```ts
const closeResponse =
  await child.close;

if (!closeResponse.ok) {
  console.error(
    closeResponse.error
  );
} else {
  console.log(
    closeResponse.result
  );
}
```

## Closing the Current Interface

When the current manager workflow is complete, call:

```ts
wire.close({
  manager: managerId,
  ok: true,
  result: {
    resourceId,
  },
});
```

To close with an error:

```ts
wire.close({
  manager: managerId,
  ok: false,
  error: {
    message:
      "A connection already exists",
    status: 409,
  },
});
```

Closing the interface is different from throwing an exception.

Use a close response when the manager workflow itself has completed or failed and the parent interface needs the result.

## Recommended Application Startup Flow

A typical manager frontend startup flow is:

1. Create the wire.
2. Create the RPC caller.
3. Retrieve manager context.
4. Retrieve interface metadata.
5. Validate metadata.
6. Load required resources and connections.
7. Initialize optional token management.
8. Render the application.
9. Close with a result or error when the workflow finishes.
10. Dispose timers and end the wire listener during final cleanup.

Example:

```ts
import {
  createWire,
  RPC,
  Caller,
  type RPCCall,
  type RPCResponse,
} from "@ezenki/deploy-commander-installer-interface";

async function handleIncomingCall(
  call: RPCCall
): Promise<RPCResponse> {
  return {
    ok: false,
    error: {
      message:
        `Unsupported request: ${call.request}`,
    },
  };
}

async function startApplication() {
  const wire = createWire(
    handleIncomingCall,
    (event) => {
      console.log("Interface event", event);
    }
  );

  const caller =
    RPC.SetupRPCCaller(wire);

  let tokenManager:
    | Awaited<
        ReturnType<
          typeof Caller.generateTokenManager
        >
      >
    | undefined;

  try {
    const managerId =
      await caller.getManager();

    const metadata =
      await caller.getMetadata();

    tokenManager =
      await Caller.generateTokenManager(
        caller
      );

    return {
      wire,
      caller,
      managerId,
      metadata,
      tokenManager,
    };
  } catch (error) {
    tokenManager?.dispose();
    wire.end();
    throw error;
  }
}
```

## Recommended Manager Workflow Pattern

For a manager that configures a resource and connection:

```ts
async function configureManager(
  caller: ReturnType<
    typeof RPC.SetupRPCCaller
  >,
  wire: ReturnType<
    typeof createWire
  >
) {
  const currentManager =
    await caller.getManager();

  const callingManager =
    await caller.getCallingManager();

  const metadata =
    await caller.getMetadata();

  if (
    !metadata ||
    typeof metadata !== "object" ||
    typeof metadata.resourceId !== "string"
  ) {
    wire.close({
      manager: currentManager.id,
      ok: false,
      error: {
        message:
          "metadata.resourceId is required",
      },
    });

    return;
  }

  const existing =
    await caller.getConnections(
      1,
      0,
      callingManager || undefined,
      metadata.resourceId
    );

  if (existing.total > 0) {
    wire.close({
      manager: currentManager.id,
      ok: false,
      error: {
        message:
          "A connection already exists",
        status: 409,
      },
    });

    return;
  }

  const created =
    await caller.createConnection(
      {
        username:
          callingManager,
        password:
          generatePassword(),
      },
      callingManager,
      false,
      metadata.resourceId
    );

  wire.close({
    manager: currentManager.id,
    ok: true,
    result: created,
  });
}
```

The exact metadata and connection configuration depend on the manager implementation.

## Input Validation

Treat the following as untrusted:

* Interface metadata
* Parent RPC payloads
* Child RPC payloads
* RPC error details
* Optional backend fields
* Platform-specific configuration
* Resource metadata
* Connection metadata

Validate required fields before using them.

Example:

```ts
function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
```

Use named validation functions for complex metadata instead of repeated type assertions.

## Do Not Call Deploy Commander APIs Directly

Do not bypass the library with calls such as:

```ts
fetch(
  "/api/v1/resources/..."
);
```

unless the application has a deliberate separate API integration approved by the Deploy Commander design.

Direct API calls can:

* Bypass interface context injection
* Depend on undocumented routes
* Break manager ownership assumptions
* Duplicate RPC behavior
* Make the manager frontend harder to run outside one Deploy Commander deployment

Use `RPCCaller` for platform operations.

## Do Not Supply Trusted Manager Identity

Do not design calls like:

```ts
getResource(
  currentManagerId,
  resourceId
);
```

or:

```ts
getConnection(
  currentManagerId,
  connectionId
);
```

The current manager identity belongs to Deploy Commander.

The library should only send the requested object ID for these scoped operations.

## Application State Guidance

Manager frontends should separate:

* Local UI state
* Deploy Commander data
* Interface metadata
* Parent or child interface state
* Temporary manager tokens

Do not store temporary tokens in long-term browser storage unless there is a specific reason.

Prefer in-memory storage through the token manager.

Do not treat the manager database as a replacement for resource configuration owned by Deploy Commander.

Use the manager database for manager-owned application data.

## Framework Integration

The library is framework-independent.

Framework code should wrap it at the application boundary.

For React, a provider or top-level hook may own:

* `Wire`
* `RPCCaller`
* Event dispatch
* Token manager
* Cleanup

For Vue or Svelte, use an equivalent application-level service or store.

Do not create a new wire instance during every component render.

Use one stable instance for the manager interface lifecycle.

## Agent Implementation Checklist

An agent implementing a manager frontend should confirm:

* The package is installed.
* A single wire instance is created.
* An incoming RPC handler is provided.
* An event handler is provided when run events are needed.
* `RPC.SetupRPCCaller` is used.
* Interface metadata is validated.
* Scoped calls do not include a caller-selected current manager ID.
* Resource ownership restrictions are understood.
* Connection visibility restrictions are understood.
* Existing connections are checked before creation when required.
* RPC errors are handled as structured objects.
* Child-interface close responses are handled.
* Manager workflows close with `wire.close`.
* Local listeners are removed with `wire.end`.
* Token managers are disposed.
* Direct Deploy Commander API calls are avoided.
* Public connection and resource types match the library.
* The application handles optional event fields.

## Important Access Rules

Keep these rules visible when implementing manager workflows:

### Resources

`getResource(id)` only retrieves resources owned by the current manager.

### Connections

`getConnections(...)` only lists connections:

* Owned by the current manager
* Or attached to resources owned by the current manager

`getConnection(id)` follows the same visibility rule and includes full connection configuration.

`updateConnection(id, metadata)` and `deleteConnection(id)` also rely on this trusted interface context. Their payloads must not include a caller-controlled manager identity.

### Manager Identity

The current manager identity is injected by Deploy Commander.

It must not be supplied or overridden by the embedded interface.

### Connection Creation

The manager argument to `createConnection` is the manager that will own the connection.

The current interface manager is the trusted resource-owning manager.

## Final Guidance

Use the library as the platform boundary for manager frontend code.

A well-structured manager frontend should:

* Create one wire
* Create one typed caller
* Validate all incoming metadata
* Use RPC calls instead of direct platform fetches
* Respect manager-scoped resource and connection rules
* Handle structured errors
* Clean up timers and listeners
* Close the interface with a meaningful result or error

The most important rule is that the manager frontend may request actions, but Deploy Commander owns the trusted manager context and authorization boundary.
