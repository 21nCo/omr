# Remote MCP host setup (nonproduction)

The configured canonical endpoint is
`https://omr-staging.21n.dev/mcp`. It is a Streamable HTTP endpoint.
Use that complete URL, including `/mcp`, for each host. This configuration is
for staging only; it does not enable a production OAuth deployment.
Staging runs in the `21n-dev` Cloudflare account and is deployed by CI on
pushes to `dev`. The Worker also answers on
`https://omr-web-staging.21n-dev.workers.dev`, but OAuth issuer, consent, and
management origin checks are pinned to `OMR_PUBLIC_ORIGIN`, so hosts should use
the custom domain above.

OMR's OAuth server advertises its authorization and token endpoints through
`/.well-known/oauth-authorization-server`. A host starting from `/mcp` receives
a `WWW-Authenticate` challenge pointing to
`/.well-known/oauth-protected-resource/mcp`. Consent requires S256 PKCE and a
workspace choice. Request `tools:discover` plus only the capabilities needed:
`tools:read`, `tools:write`, `approvals:create`, and optionally
`connections:read`. Hosts that require a refresh scope can also request
`offline_access`; that scope never becomes an OMR tool capability. Access and
refresh tokens are bound to the exact `/mcp` resource and the underlying OMR
grant expires after 30 days. A grant without `offline_access` receives only an
access token, which expires after one hour.

## OAuth-capable hosts

- **Claude and Claude Desktop:** On Free, Pro, or Max, use **Customize → Connectors**
  to add a custom connector with the canonical endpoint above. On Team or
  Enterprise, an Owner first adds it under **Organization settings →
  Connectors**; members then use **Customize → Connectors** to select
  **Connect**. Sign in to OMR, choose the workspace, inspect the requested
  capabilities, and approve.
  Configure remote connectors in Connectors, rather than in the local
  `claude_desktop_config.json` file. See [Anthropic's connector instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
- **VS Code:** Add this entry to your personal or workspace `mcp.json`, then
  start the server from **MCP: List Servers**. VS Code opens the browser for
  OAuth. Use the same URL in remote development environments. See the
  [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

  ```json
  {
    "servers": {
      "omr-staging": {
        "type": "http",
        "url": "https://omr-staging.21n.dev/mcp"
      }
    }
  }
  ```

- **Cursor:** Add a personal `~/.cursor/mcp.json` entry with `mcpServers` and
  the same URL. Open Cursor's MCP settings and complete the OAuth sign-in.
  A project `.cursor/mcp.json` can share the endpoint, but each person must
  authorize their own workspace. See [Cursor's MCP instructions](https://prod.cursor.com/help/customization/mcp).

  ```json
  {
    "mcpServers": {
      "omr-staging": {
        "url": "https://omr-staging.21n.dev/mcp"
      }
    }
  }
  ```

- **ChatGPT workspace apps:** If your workspace has developer mode access,
  create a draft app in **Settings → Apps → Create**, supply the canonical
  endpoint, choose OAuth, and run **Scan Tools**. Complete OMR consent when
  prompted. OMR advertises `offline_access` for refresh-capable hosts. The
  [ChatGPT app instructions](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
  describe the available plans and review controls. Real ChatGPT connection
  remains part of OMR-15's live acceptance.

## Manual bearer fallback

For hosts that can attach a private `Authorization` header but cannot perform
OAuth discovery, create a separate `mcp_remote` device grant:

```sh
omr login --url https://omr-staging.21n.dev --kind mcp_remote \
  --capabilities tools:discover,tools:read --profile host
```

Choose the minimum capabilities in `--capabilities` before starting the device
flow. `tools:discover` is required; without this option, a remote grant gets
only `tools:discover`. Add `tools:read` for read calls, and add `tools:write`
and `approvals:create` for approval-gated writes. Approve the device code in
OMR, selecting one workspace. Configure the host's Streamable HTTP URL as above
and set its private header to `Authorization: Bearer <device-grant>`. `omr login` saves the
grant in a private profile; it does not print the bearer. On the machine where
you logged in, retrieve the `key` from
`${OMR_CONFIG_DIR:-~/.config/oh-my-router}/profiles/default.json` (or
`profiles/<name>.json` if you used `--profile <name>`), then paste it into the
host's private secret/header field. The file must remain private (mode `0600`
on macOS/Linux; your account ACL on Windows). Keep it out of shell history,
logs, and shared host configuration. Never commit the credential to a shared
MCP configuration file. A CLI or local stdio grant will not authenticate at
`/mcp`. To retire a manual grant, run `omr logout --profile <name>` on the
machine holding its saved profile. The CLI removes that profile only after the
server confirms revocation; remove the header from the host as well.

Browser-host cross-origin requests require the host's exact HTTPS origin in
the staging Worker's `OMR_MCP_BROWSER_ORIGINS` comma-separated allowlist. Native
hosts do not send a browser `Origin` header. Consent and management forms still
require the OMR origin and their CSRF token.

OMR lists manual clients under `/app/clients` and OAuth connections under
`/oauth/manage`. Revoke there to stop subsequent MCP calls immediately. Tool
calls do not reconnect provider accounts: connect or repair providers in the
OMR control plane, then call `omr.catalog.refresh` or restart the host session
when the tool schema changes. Remote HTTP is stateless: each request reads the
current catalog, and `omr.catalog.refresh` sends `tools/list_changed` on its
response stream so a caching host re-lists after connection changes. Write and
destructive calls return an approval ID;
approve it in OMR and call `omr.approvals.execute` from the host.

## Staging rollback and deferred acceptance

To withdraw staging host access, revoke affected OMR clients in the two
management pages, including any manual bearer grants. For an OAuth deployment
rollback, remove the staging `OAUTH_KV` binding and `OMR_PUBLIC_ORIGIN` variable
from `apps/web/wrangler.jsonc`, build, and deploy that configuration with the
project-local `wrangler deploy --env staging` (authenticated to the `21n-dev`
account), or merge it to `dev` so the staging workflow deploys it. Removing bindings from a local
file alone does not change the deployed Worker. The previous `origin/dev`
Worker already has both settings, so redeploying it does not disable OAuth.
Confirm OAuth metadata and token routes return 503 and `/mcp` no longer
advertises OAuth discovery. Revoke manual bearer grants separately; removing
OAuth configuration does not revoke them. Retain any needed audit record
before deleting the KV namespace. OMR-15 owns observed staging rollback,
endpoint, two-host, consent, refresh, and revocation checks. Local contract
tests here are code evidence only.
