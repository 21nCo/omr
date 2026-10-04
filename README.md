# OMR

OMR is a portable tool integration layer for people and teams. Connect provider accounts in its web control plane, then use the same authorized tools through its CLI or MCP from external agents. The gated direct web playground tests connected tools without an OpenRouter key; OMR is not a general-purpose agent host.

## Local development

Requirements:

- Node.js 22+
- npm 10+
- the dedicated Super Functions worktree at `../../../worktrees/superfunctions/omr-upstream`, or `OMR_SUPERFUNCTIONS_WORKTREE` set to another path

Bootstrap OMR and its local Super Functions dependencies:

```sh
npm install
npm run sf:status
npm run sf:install
npm run sf:build
npm run sf:link
npm run sf:smoke
npm run test:phase-00
```

The Super Functions worktree uses branch `omr/upstream`, originally based on `origin/dev`. The lock pins the minimum required commit on that pushed branch so a fresh OMR checkout can use the same local packages. Reusable dependency fixes discovered during OMR development should be made there. OMR-specific behavior stays here.

## Runtime foundation

The current implementation includes:

- a SvelteKit Worker boundary built with the Cloudflare adapter;
- a DataFn schema restricted to workspace-scoped product records;
- separate `omr_app`, `omr_control`, and `omr_identity` PostgreSQL schemas;
- AuthFn password sessions, personal/team workspaces, and single-use invitations;
- hashed, expiring client credentials with explicit capabilities and immediate revocation;
- browser/device login with one-time encrypted credential delivery;
- personal and workspace provider-account ownership, readiness, selection, and revocation state.
- PlugFn-backed OAuth/API-key setup, refresh, health, and remote/local disconnect outcomes;
- deterministic, versioned tool manifests with namespaced IDs, schema hashes, search, and pagination;
- one shared execution contract with capability checks, idempotency receipts, safe-read retries, and
  encrypted single-use approval envelopes for write, destructive, and unknown-effect tools.
- a PostgreSQL-backed PlugFn runtime used by the actual Worker routes, with OAuth configuration
  readiness kept distinct from provider source availability;
- an `omr` CLI, an `omr-mcp` stdio server, and a stateless Streamable HTTP `/mcp`
  endpoint projected from the same authenticated catalog;
- an authenticated browser control plane for named workspace selection, team creation, encrypted
  API-key and provider OAuth connections, approval decisions, and actor-scoped execution history;
- a complete device-login handoff with a pre-filled verification URL and explicit workspace grant.

The v1 user-facing provider catalog is GitHub, Linear, Slack, and Notion. Other registered PlugFn
adapters are internal and are not discoverable or connectable via OMR v1. Catalog and tool
readiness are scoped to the selected workspace; see [the v1 catalog contract](docs/provider-catalog-v1.md)
for states, compatibility notes, and a reproducible response.

Internal packages use the `@oh-my-router/*` npm scope. The current CLI package is
`@oh-my-router/cli` and exposes the `omr` command; `@oh-my-router/mcp` exposes `omr-mcp`.

Apply migrations in numeric order from:

```text
packages/data/migrations/
packages/identity/migrations/
packages/client-access/migrations/
packages/connections/migrations/
packages/execution/migrations/
packages/plugfn-runtime/migrations/
```

Personal OpenRouter vault rollout, dedicated database grants, secret rotation and
rollback are described in [the vault plan](docs/openrouter-vault.md). Its settings
route stays disabled until OMR-15 completes disposable live acceptance.

The direct connected-tool playground lives at `/app/playground` and is hidden behind
`OMR_DIRECT_PLAYGROUND_ENABLED=true` until OMR-15 completes staged acceptance. It uses
the same workspace catalog, account selection, execution, approval and receipt API as
CLI/MCP. A personal OpenRouter key is not required. Reads return a result and receipt;
writes require a redacted approval review before execution. The page accepts JSON
arguments and shows the selected tool's input schema.

Optional single-turn assistance on that page uses only the signed-in user's saved
OpenRouter key. `OMR_ASSISTED_PLAYGROUND_ENABLED=true` also requires the vault
rollout and its verified cache-disabled binding; leave it off until OMR-15's live
acceptance. The user chooses a model. Each request offers at most 12 scoped tools,
limits prompt/schema/result and model output sizes, makes at most two model calls,
and selects at most one action.
Reads return a receipt and a bounded answer; writes stop at the existing approval
review. The page reports provider token counts and cost when available and allows
request cancellation. No conversation history or autonomous retries are kept.
Assisted turns use a PostgreSQL-backed per-user request and concurrency limit. See
[the assisted playground contract](docs/assisted-playground.md) for migration,
retry recovery and rollout details.

Run focused package tests with `npm run test --workspace=<package-name>`. Set
`OMR_TEST_DATABASE_URL` to a disposable PostgreSQL database to enable the real
database isolation and transaction canaries.

The Worker expects a production `HYPERDRIVE` binding and the required
`DEVICE_CREDENTIAL_WRAPPING_KEY`, `EXECUTION_RESULT_WRAPPING_KEY`, and
`PLUGFN_ENCRYPTION_KEY` secrets. Local workerd runs may use
`DATABASE_URL` instead of Hyperdrive; see `.env.example`. Copy those values to
`apps/web/.dev.vars` or pass `DATABASE_URL` with Wrangler's `--var` option—an
unbound process environment variable is not exposed to the Worker. Never commit
the wrapping key or provider credentials.

Persistent execution receipts and approvals additionally require a distinct 32-byte
`EXECUTION_RESULT_WRAPPING_KEY`; provider results and approved parameters are encrypted before
PostgreSQL storage.

The control plane's **Connect with OAuth** form uses the existing PlugFn authorization flow.
Configure the chosen provider's `PLUGFN_*_CLIENT_ID` and `PLUGFN_*_CLIENT_SECRET` on the Worker,
and register `https://<OMR-origin>/app/oauth/callback` as that provider application's redirect
URI. The provider choice, workspace and label are kept in the initiating browser tab for the
short callback handoff; if that tab or session is lost, start authorization again. A provider
without configured credentials is reported as unavailable before redirect. Live provider
authorization still requires a separately verified sandbox/provider account.
GitHub connections request only `read:user` by default. Users can choose a
public-comment or private-repository grant explicitly; see [the GitHub v1 journey](docs/github-v1.md).
Slack connections are bot-only in this release and request joined public-channel access by tier;
see [the Slack v1 journey](docs/slack-v1.md). Slack v1 exposure defaults off until OMR-15
records live provider evidence.
Notion connections use the provider's shared-content picker and bounded page actions;
see [the Notion v1 journey](docs/notion-v1.md). Notion v1 exposure defaults off until OMR-15
records live provider evidence.

Build and install the portable CLI archive as documented in [the CLI command contract](packages/cli/README.md).
Its `omr` command supports device login, profiles, workspace and provider-account selection,
tool search and execution, JSON input, approval status, and remote-revoking logout. A logged-in
profile also powers the separately installable `omr-mcp` archive; see
[the local stdio host guide](packages/mcp/README.md). The CLI archive does not
contain `omr-mcp`. `OMR_BACKEND`, `OMR_API_KEY`, and `OMR_WORKSPACE_ID` provide
an explicit headless alternative. Browser-controlled approvals still use the
same execution policy.

For a remote MCP client, issue a separate workspace-scoped device grant. From a repository
checkout use `npm exec` as below; after installing the CLI archive, run the same arguments
with `omr` directly:

```sh
npm exec -- omr login --url https://your-omr-worker.example --kind mcp_remote \
  --capabilities tools:discover,tools:read --profile host
```

This example grants discovery and read calls. Select only the capabilities the host needs;
the [remote MCP host guide](docs/remote-mcp-v1.md#manual-bearer-fallback) explains write and
approval scopes and how to retrieve the private credential. Approve the code in OMR, then
configure an MCP client that supports custom HTTP headers to
connect to `https://your-omr-worker.example/mcp` with `Authorization: Bearer <device-grant>`.
The remote endpoint checks the grant, its `mcp_remote` client kind, and `tools:discover` on
every request; individual tool calls still enforce their own capabilities and approval policy.
Keep the credential out of logs and revoke the client when it is no longer needed. Signed-in
users can list and revoke their own active device/manual clients at `/app/clients`, including
clients for workspaces they have since left. The list is paginated and never returns credential
hashes. Revocation invalidates every grant on that client immediately.

Remote MCP also supports OAuth on a Worker configured with `OAUTH_KV` and a canonical
`OMR_PUBLIC_ORIGIN` (currently the staging Worker). Point an OAuth-capable MCP host at its
`/mcp` endpoint. The unauthenticated challenge links protected-resource and authorization-server
metadata; clients can use Client ID Metadata Documents or dynamic registration. Authorization
uses S256 PKCE, requires `tools:discover`, and shows a consent screen where the user selects a
workspace and approves the requested OMR capabilities. The OAuth access token is bound to the
`/mcp` resource; the underlying 30-day OMR grant is checked on every request. Refresh tokens
and grants expire after 30 days, and revoking the OMR client or grant stops access immediately.
An OAuth refresh requesting fewer scopes is rejected at the token endpoint rather than given the broader
underlying grant; reconnect with the desired scopes instead. The manual bearer flow above remains
available for hosts that supply custom headers.

Signed-in users can review and revoke their own OAuth MCP connections at `/oauth/manage` (also
linked from the control plane). Re-authorizing a client retires its earlier OMR grant. Revocation
is available to the person who authorized the connection even after they leave its workspace;
it invalidates both the OMR client and associated OAuth tokens. This page does not list the
manual bearer grants, which are managed at `/app/clients`. OMR records OAuth-to-client links in
PostgreSQL so the management listing and client replacement do not depend on Workers KV
listing consistency; OAuth token storage remains in the provider's KV namespace.
For Claude, VS Code, Cursor, ChatGPT, manual bearer setup, and staging rollback,
see the [remote MCP host guide](docs/remote-mcp-v1.md).
