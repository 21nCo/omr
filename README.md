# OMR

OMR is a portable tool integration layer for people and teams. Connect provider accounts in its web control plane, then use the same authorized tools through its CLI or MCP from external agents. A limited web playground is planned for testing connected tools with each user's OpenRouter key; OMR is not a general-purpose agent host.

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
GitHub connections request only the read-only `read:user` profile scope by default, not
PlugFn's write-capable repository scopes. Private repository access is not available through
this default flow.

Authenticate a local CLI profile with:

```sh
npm exec -- omr login --url http://localhost:5173
```

The CLI stores credentials under `~/.config/oh-my-router`, outside the repository.
Run `npm exec -- omr tools list --json` to inspect the catalog. A logged-in profile also powers
`npm exec -- omr-mcp`; `OMR_BACKEND`, `OMR_API_KEY`, and `OMR_WORKSPACE_ID` provide an explicit
headless alternative. The MCP server exposes `omr.connections.list` for workspace connection
discovery. Read tools execute immediately; write, destructive, and unknown-effect tools create a
pending approval and return its id without invoking the provider. After a workspace owner approves
the request in the browser control plane, call `omr.approvals.execute` with that approval id.

For a remote MCP client, issue a separate workspace-scoped device grant:

```sh
npm exec -- omr login --url https://your-omr-worker.example --kind mcp_remote
```

Approve the code in OMR, then configure an MCP client that supports custom HTTP headers to
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
An OAuth token refreshed with fewer scopes is rejected at `/mcp` rather than given the broader
underlying grant; reconnect with the desired scopes instead. The manual bearer flow above remains
available for hosts that supply custom headers.

Signed-in users can review and revoke their own OAuth MCP connections at `/oauth/manage` (also
linked from the control plane). Re-authorizing a client retires its earlier OMR grant. Revocation
is available to the person who authorized the connection even after they leave its workspace;
it invalidates both the OMR client and associated OAuth tokens. This page does not list the
manual bearer grants, which are managed at `/app/clients`. OMR records OAuth-to-client links in
PostgreSQL so the management listing and client replacement do not depend on Workers KV
listing consistency; OAuth token storage remains in the provider's KV namespace.
