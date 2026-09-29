# Remote MCP host setup (nonproduction)

The configured canonical endpoint is
`https://omr-web-staging.21n.workers.dev/mcp`. It is a Streamable HTTP endpoint.
Use that complete URL, including `/mcp`, for each host. This configuration is
for staging only; it does not enable a production OAuth deployment.

OMR's OAuth server advertises its authorization and token endpoints through
`/.well-known/oauth-authorization-server`. A host starting from `/mcp` receives
a `WWW-Authenticate` challenge pointing to
`/.well-known/oauth-protected-resource/mcp`. Consent requires S256 PKCE and a
workspace choice. Request `tools:discover` plus only the capabilities needed:
`tools:read`, `tools:write`, `approvals:create`, and optionally
`connections:read`. Hosts that require a refresh scope can also request
`offline_access`; that scope never becomes an OMR tool capability. Access and
refresh tokens are bound to the exact `/mcp` resource and the underlying OMR
grant expires after 30 days.

## OAuth-capable hosts

- **Claude and Claude Desktop:** In **Settings → Connectors**, add a custom
  connector with the canonical endpoint above. Select **Connect**, sign in to
  OMR, choose the workspace, inspect the requested capabilities, and approve.
  Configure remote connectors in Connectors, rather than in the local
  `claude_desktop_config.json` file. See [Anthropic's connector instructions](https://support.anthropic.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp).
- **VS Code:** Add this entry to your personal or workspace `mcp.json`, then
  start the server from **MCP: List Servers**. VS Code opens the browser for
  OAuth. Use the same URL in remote development environments. See the
  [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

  ```json
  {
    "servers": {
      "omr-staging": {
        "type": "http",
        "url": "https://omr-web-staging.21n.workers.dev/mcp"
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
        "url": "https://omr-web-staging.21n.workers.dev/mcp"
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
omr login --url https://omr-web-staging.21n.workers.dev --kind mcp_remote
```

Approve the device code in OMR, selecting one workspace and the minimum
capabilities. Configure the host's Streamable HTTP URL as above and set its
private header to `Authorization: Bearer <device-grant>`. Never commit the
credential to a shared MCP configuration file. A CLI or local stdio grant will
not authenticate at `/mcp`.

OMR lists manual clients under `/app/clients` and OAuth connections under
`/oauth/manage`. Revoke there to stop subsequent MCP calls immediately. Tool
calls do not reconnect provider accounts: connect or repair providers in the
OMR control plane, then call `omr.catalog.refresh` or restart the host session
when the tool schema changes. Write and destructive calls return an approval ID;
approve it in OMR and call `omr.approvals.execute` from the host.

## Staging rollback and deferred acceptance

To withdraw staging host access, revoke affected OMR clients in the two
management pages, including any manual bearer grants. For an OAuth deployment
rollback, remove the staging `OAUTH_KV` binding and `OMR_PUBLIC_ORIGIN`, or
redeploy the previous Worker version; then confirm OAuth metadata and tokens
are unavailable. Manual bearer access is independent and must be revoked
separately. Do not delete the KV namespace before retaining any needed audit
record. OMR-15 owns observed checks of the staging endpoint, two real hosts,
consent and refresh, revocation, and rollback. Local contract tests here are
code evidence only.
