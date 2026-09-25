# v1 provider catalog and readiness

MCP clients can call `omr.catalog.providers` for the same workspace-scoped four-provider
status list, schema version, and revision returned by HTTP discovery and CLI `tools list`.
This control tool remains available when no connection or action is usable. Its result
reflects the latest discovery response on each call, including configuration and
health transitions within a long-lived MCP session.

Connection selection checks v1 support and server configuration in addition to
binding health. A previously healthy binding cannot be selected after its adapter
or configuration is removed. `connections list` keeps the binding's stored
`readiness` and adds `providerState` and `selectable` to distinguish current
provider eligibility from connection health. The web control plane uses the
catalog's provider state when displaying bindings and offering “Select connection”.

The named v1 providers, in stable order, are GitHub, Linear, Slack, and Notion. Other PlugFn adapters remain registered internally but are not listed as v1 providers, cannot start new connections, and have no discoverable/executable OMR manifests. The provider policy in `packages/tools/src/providers.ts` is shared by connection setup, authenticated discovery, and execution. No database migration is required.

## Contract

`GET /api/tools?workspaceId=<id>` requires an authenticated actor with `tools:discover` and membership in the requested workspace. It returns `catalogSchemaVersion: "1.0.0"`, `revision`, `tools`, optional `nextCursor`, and `providers` with one status per named provider. `GET /api/tools/manifest?id=<tool-id>&workspaceId=<id>` requires the same scope and returns 404 unless the actor's effective ready connection grants that action's required scopes. The `providers` array is additive to the previous discovery response. The `workspaceId` query parameter is newly required: older raw HTTP clients must supply their active workspace; the shipped CLI and MCP clients now do so. The web control plane reads this same endpoint. CLI `tools list --json` returns the full discovery page; both stdio and Streamable HTTP MCP project its tool manifests and expose their hashes in tool metadata. Pagination cursors bind the catalog revision and the exact usable action ID set; changing grants or readiness invalidates an old cursor.

Cursor filter sets use code point ordering, independent of host locale. Equivalent grants can continue pagination on another instance; changed grants still require a fresh discovery. This changes only cursor encoding for mixed-case filter IDs, so clients should treat a rejected older cursor as a request to restart discovery.

`GET /api/connections/providers/readiness?provider=<id>&workspaceId=<id>` returns a scoped provider status; without `workspaceId` it returns configuration-only state (never claims a ready connection). The five states are:

- `unsupported`: not in v1, missing adapter, or unknown authentication mode. Never connect or execute.
- `unconfigured`: registered v1 OAuth adapter with no complete server-side client configuration. Never connect or execute.
- `disconnected`: configured adapter, but no accessible ready/expired binding. New OAuth connection may start; tools remain hidden.
- `expired`: accessible non-ready or reauthorization-required binding, with no ready binding. New OAuth connection may start; tools remain hidden until health/reauthorization restores readiness.
- `ready`: at least one accessible active/ready binding on a configured v1 adapter. Only actions whose required scopes are granted by the selected (or sole) ready connection are discoverable. Multiple ready connections without a selection cannot be executed implicitly, so no actions are advertised until one is selected. Explicit execution against an accessible binding still checks that binding's grants. Execution and approval requests recheck scopes after connection resolution; approval execution rechecks again after approval.

If the remote grant's scope list is unavailable, no actions are advertised or executable, including actions with an empty required-scope list. A verified empty grant can authorize only actions that genuinely require no scopes. Discovery, direct execution, approval creation, and approved execution apply this rule independently on each request.

`POST /api/connections/select` accepts `workspaceId`, `provider`, and `connectionId`. It requires a workspace-authenticated browser request from the same origin or a scoped client credential with `tools:write`; a `connections:read`-only credential receives `CLIENT_CAPABILITY_DENIED` (403). Selection is a persistent per-user choice that can affect later actions from other clients, so read access alone cannot change it. The connection authority verifies workspace membership, ownership visibility, provider match, and active/ready status before saving the choice. An inaccessible or unhealthy binding cannot be selected. The web control plane offers “Select connection”, CLI offers `omr connections select <id> --provider <provider>`, and MCP offers `omr.connections.select` after `omr.connections.list`. Selection does not change the default grant, bypass scope checks, or pick implicitly between accounts. Call `omr.catalog.refresh` on a long-lived MCP session after selecting.

Readiness is based on stored binding health, not a live provider probe on every catalog request. Catalog discovery does inspect the effective ready binding's remote grant: if PlugFn reports the connection missing, it marks only that binding as needing reauthorization and omits its tools; other providers remain discoverable. Other remote or authorization failures are errors, not silently treated as missing grants. `POST /api/connections/health` updates the binding; a remote credential that expires between checks may not be reflected until then, and execution/provider errors still fail safely. Revocation is terminal, including when a health probe or refresh was already in flight; a second healthy binding can still make a provider ready.

Direct execution, approval requests, and approved execution use the same missing-remote transition when checking current action scopes. A remote deletion after that check is also translated at action execution. The affected binding becomes `needs_reauth`/`unavailable` and the caller receives `CONNECTION_UNAVAILABLE` (HTTP 409); unrelated providers remain usable. An approval already claimed for execution becomes failed, and a reserved execution receipt records `connection_unavailable` without storing PlugFn error details. Other remote errors still surface as errors. The web control plane clears a previous workspace's catalog before loading another; if discovery fails, it shows provider readiness as unknown and offers no selection until discovery recovers.

Tool IDs remain `<provider>.<action>` and individual manifest hashes are SHA-256 over the canonical versioned manifest (including input/output schemas and effect contract). Registration order does not change IDs/hashes; a schema or contract edit changes the hash and catalog revision. Configured-adapter changes alter the revision. Approval execution rechecks the manifest hash and current connection readiness. The currently recorded schema version stays `1.0.0`; readiness is an additive response field, while requiring workspace context is the documented raw-HTTP compatibility change.

Long-lived stdio MCP sessions initially register the currently usable actions. After a connection, selection, or scope change, call `omr.catalog.refresh` on the same session to register newly available tools; it sends `tools/list_changed` whenever the visible set differs from the last refresh, including hiding and restoring an already-registered tool. Every subsequent `tools/list` and `tools/call` checks the live authenticated catalog, so revocation or scope downgrade hides old tools and blocks calls even before refresh. If a registered action's manifest hash changes, it is hidden and refresh returns an error requesting an MCP session restart (old schemas are never advertised as current). Streamable HTTP sessions also check current readiness on each request. MCP clients that cache lists should refresh/re-list after connection changes.

If discovery is temporarily unavailable after session start, `tools/list` retains the reserved control tools and hides projected actions; projected action calls fail closed. Connection listing/selection and approved-execution controls continue to use their own endpoints. Provider readiness and refresh return structured tool errors until discovery recovers.

## Reproducible local response

Run `node scripts/catalog-example.mjs` after building packages. Against the pinned local PlugFn providers with no OAuth configuration or stored connections, it returned:

```json
{
  "catalogSchemaVersion": "1.0.0",
  "revision": "sha256-4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "tools": [],
  "providers": [
    { "provider": "github", "displayName": "GitHub", "providerVersion": "1.0.0", "description": "Integration with GitHub for managing repositories, issues, and pull requests", "authMode": "oauth", "actionCount": 20, "state": "unconfigured", "available": false },
    { "provider": "linear", "displayName": "Linear", "providerVersion": "1.0.0", "description": "Integration with Linear for issue tracking and project management", "authMode": "oauth", "actionCount": 14, "state": "unconfigured", "available": false },
    { "provider": "slack", "displayName": "Slack", "providerVersion": "1.0.0", "description": "Integration with Slack for messaging and collaboration", "authMode": "oauth", "actionCount": 9, "state": "unconfigured", "available": false },
    { "provider": "notion", "displayName": "Notion", "providerVersion": "1.0.0", "description": "Integration with Notion pages, databases, users, and search", "authMode": "oauth", "actionCount": 12, "state": "unconfigured", "available": false }
  ]
}
```

This is a credential-free local fixture, not a successful OAuth/provider-sandbox or staging check. This example passes an empty allowed-provider set, so its empty tools array and revision are fixed by that filter. In a configured catalog, the revision depends on adapter configuration and pinned manifest sources. Tests in `tests/acceptance/catalog-parity.test.ts` exercise one ready fixture through the HTTP router, compiled CLI, and MCP SDK and compare ID, schema, hash, and the full CLI response. Live browser, database-backed provider state, provider sandbox, and staging remain separate release gates.
