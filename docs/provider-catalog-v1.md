# v1 provider catalog and readiness

The named v1 providers, in stable order, are GitHub, Linear, Slack, and Notion. Other PlugFn adapters remain registered internally but are not listed as v1 providers, cannot start new connections, and have no discoverable/executable OMR manifests. The provider policy in `packages/tools/src/providers.ts` is shared by connection setup, authenticated discovery, and execution. No database migration is required.

## Contract

`GET /api/tools?workspaceId=<id>` requires an authenticated actor with `tools:discover` and membership in the requested workspace. It returns `catalogSchemaVersion: "1.0.0"`, `revision`, `tools`, optional `nextCursor`, and `providers` with one status per named provider. `GET /api/tools/manifest?id=<tool-id>&workspaceId=<id>` requires the same scope and returns 404 unless the actor's effective ready connection grants that action's required scopes. The `providers` array is additive to the previous discovery response. The `workspaceId` query parameter is newly required: older raw HTTP clients must supply their active workspace; the shipped CLI and MCP clients now do so. The web control plane reads this same endpoint. CLI `tools list --json` returns the full discovery page; both stdio and Streamable HTTP MCP project its tool manifests and expose their hashes in tool metadata. Pagination cursors bind the catalog revision and the exact usable action ID set; changing grants or readiness invalidates an old cursor.

`GET /api/connections/providers/readiness?provider=<id>&workspaceId=<id>` returns a scoped provider status; without `workspaceId` it returns configuration-only state (never claims a ready connection). The five states are:

- `unsupported`: not in v1, missing adapter, or unknown authentication mode. Never connect or execute.
- `unconfigured`: registered v1 OAuth adapter with no complete server-side client configuration. Never connect or execute.
- `disconnected`: configured adapter, but no accessible ready/expired binding. New OAuth connection may start; tools remain hidden.
- `expired`: accessible non-ready or reauthorization-required binding, with no ready binding. New OAuth connection may start; tools remain hidden until health/reauthorization restores readiness.
- `ready`: at least one accessible active/ready binding on a configured v1 adapter. Only actions whose required scopes are granted by the selected (or sole) ready connection are discoverable. Multiple ready connections without a selection cannot be executed implicitly, so no actions are advertised until one is selected. Explicit execution against an accessible binding still checks that binding's grants. Execution and approval requests recheck scopes after connection resolution; approval execution rechecks again after approval.

Readiness is based on stored binding health, not a live provider probe on every catalog request. Catalog discovery does inspect the effective ready binding's remote grant: if PlugFn reports the connection missing, it marks only that binding as needing reauthorization and omits its tools; other providers remain discoverable. Other remote or authorization failures are errors, not silently treated as missing grants. `POST /api/connections/health` updates the binding; a remote credential that expires between checks may not be reflected until then, and execution/provider errors still fail safely. Revocation is terminal, including when a health probe or refresh was already in flight; a second healthy binding can still make a provider ready.

Tool IDs remain `<provider>.<action>` and individual manifest hashes are SHA-256 over the canonical versioned manifest (including input/output schemas and effect contract). Registration order does not change IDs/hashes; a schema or contract edit changes the hash and catalog revision. Configured-adapter changes alter the revision. Approval execution rechecks the manifest hash and current connection readiness. The currently recorded schema version stays `1.0.0`; readiness is an additive response field, while requiring workspace context is the documented raw-HTTP compatibility change.

Long-lived stdio MCP sessions initially register the currently usable actions. After a new connection or scope upgrade, call `omr.catalog.refresh` on the same session to register newly available tools; this sends `tools/list_changed`. Every subsequent `tools/list` and `tools/call` checks the live authenticated catalog, so revocation or scope downgrade hides old tools and blocks calls even before refresh. If a registered action's manifest hash changes, it is hidden and refresh returns an error requesting an MCP session restart (old schemas are never advertised as current). Streamable HTTP sessions also check current readiness on each request. MCP clients that cache lists should refresh/re-list after connection changes.

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

This is a credential-free local fixture, not a successful OAuth/provider-sandbox or staging check. The exact revision depends on which adapters are configured and the pinned manifest sources. Tests in `tests/acceptance/catalog-parity.test.ts` exercise one ready fixture through the HTTP router, compiled CLI, and MCP SDK and compare ID, schema, hash, and the full CLI response. Live browser, database-backed provider state, provider sandbox, and staging remain separate release gates.
