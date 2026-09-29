# Local OMR MCP host

`omr-mcp` is a Node.js 22+ stdio server. It reads an OMR device grant from the
same private profile store as `omr`, then forwards discovery, tool calls, and
approval requests to the OMR server. Provider credentials stay on that server.
The separate `/mcp` Streamable HTTP endpoint has a different host setup and
requires a `mcp_remote` grant.

## Build and install

From an OMR checkout with its Super Functions dependencies linked:

```sh
npm pack --workspace=@oh-my-router/mcp
npm install -g ./oh-my-router-mcp-0.0.0.tgz
```

`prepack` builds the executable and its workspace dependencies. The archive
contains a bundled `dist/bin.js` with no runtime workspace dependencies.
Resolve the installed executable with `command -v omr-mcp` on macOS/Linux or
`where omr-mcp` in Windows Command Prompt. Put the resulting absolute path in
the host configuration; do not rely on the host inheriting your interactive
shell's `PATH`. Use `npm uninstall -g @oh-my-router/mcp` to remove it. Keep
your OMR profile until its grant has been revoked with `omr logout` or in
`/app/clients`.

## Select a grant

Create a local stdio grant with the CLI, approve the device code in OMR, and
choose the workspace there:

```sh
omr login --url https://your-omr-worker.example --kind mcp_stdio --profile host
omr profiles show --profile host
```

Launch `omr-mcp --profile host`, or set `OMR_PROFILE=host` in the host's
private environment. With neither selection, the CLI's active profile is used.
The profile's workspace is the device grant's authorized workspace; a host
cannot select another workspace by changing its MCP requests. An expired or
revoked grant disconnects the stdio session on a 401 response; restart only
after obtaining a new grant. Revoke with `omr logout --profile host` or in
`/app/clients`. Existing sessions cannot keep making calls after revocation.

For an explicitly managed headless grant, set **all three** host-private
environment values: `OMR_BACKEND`, `OMR_API_KEY`, and `OMR_WORKSPACE_ID`.
The server enforces the grant's workspace and capabilities. Never put
`OMR_API_KEY` in command arguments or a shared host configuration file.
For compatibility with earlier MCP setup, `OMR_BACKEND` and `OMR_API_KEY` may
omit `OMR_WORKSPACE_ID` only when the selected profile (or `default`) already
contains a workspace. An incomplete pair is rejected before server startup.
`OMR_CONFIG_DIR` can point both `omr` and `omr-mcp` at a different private
profile directory.

## Host configuration

Add one entry alongside existing entries in the host's MCP configuration.
Replace the path below with the absolute result from `command -v` or `where`:

```json
{
  "mcpServers": {
    "existing-server": { "command": "/absolute/path/to/existing-server" },
    "omr": {
      "command": "/absolute/path/to/omr-mcp",
      "args": ["--profile", "host"]
    }
  }
}
```

Claude Desktop and Cursor use the `mcpServers` map; VS Code uses a `servers`
map with the same `command` and `args` fields and `"type": "stdio"`. Edit only
the OMR entry so other servers and their executable paths remain intact. On
Windows, use the absolute `omr-mcp.cmd` path returned by `where`, with escaped
backslashes in JSON. Restart the host after editing its configuration.

The host discovers provider tools and OMR control tools. Read tools execute
through the server. Write, destructive, and unknown-effect tools require the
caller to supply a stable `_omrIdempotencyKey`; OMR returns an approval ID
without executing. Approve in the web control plane, then call
`omr.approvals.execute` with that ID. Reuse the same idempotency key after an
uncertain response. `omr.catalog.refresh` discovers newly connected tools;
restart the session if a tool schema changes. Closing the host's stdin closes
the local server. No provider credentials are copied to the host.

## Evidence boundary

The archive install and fixture-backed stdio contract are checked in OMR-7.
OMR-15 owns two observed real host installations, macOS/Linux/Windows package
and upgrade/uninstall smoke, staged authenticated stdio calls, and live grant
revocation. This guide is a configuration example, not evidence that those
external checks passed.
