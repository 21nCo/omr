#!/usr/bin/env node
import { OMRProfileStore, ProfileMissingError, assertProfileName } from "@oh-my-router/client/profile-store";

import { createOMRMcpServer } from "./server.js";

/** Resolve the host's explicit profile without reading or changing stored credentials. */
function selectedProfile(args: string[]): string | undefined {
  if (args.length === 0) return process.env.OMR_PROFILE;
  if (args.length === 2 && args[0] === "--profile" && args[1]) return assertProfileName(args[1]);
  if (args.length === 1 && args[0]?.startsWith("--profile=")) {
    return assertProfileName(args[0].slice("--profile=".length));
  }
  throw new Error("Usage: omr-mcp [--profile <name>]");
}

/** Select one authorized grant, then own the stdio session for this host process. */
async function main(): Promise<void> {
  const requestedProfile = selectedProfile(process.argv.slice(2));
  const profiles = new OMRProfileStore();
  const backend = process.env.OMR_BACKEND;
  const key = process.env.OMR_API_KEY;
  const workspace = process.env.OMR_WORKSPACE_ID;
  if (Boolean(backend) !== Boolean(key) || (workspace && !backend)) {
    throw new Error("Set OMR_BACKEND and OMR_API_KEY together; OMR_WORKSPACE_ID requires both");
  }

  let selected: { backend: string; key: string; workspaceId: string };
  if (backend && key) {
    // Older MCP hosts kept the workspace in profile metadata while supplying
    // their grant through the environment. An explicit workspace takes priority.
    let workspaceId = workspace;
    if (!workspaceId) {
      const name = requestedProfile ?? "default";
      try { workspaceId = profiles.workspaceId(name); }
      catch (error) {
        if (error instanceof ProfileMissingError) {
          throw new Error("OMR_WORKSPACE_ID is required for headless MCP when no saved profile supplies a workspace");
        }
        throw error;
      }
    }
    selected = { backend, key, workspaceId };
  } else {
    const name = requestedProfile ?? profiles.activeName();
    selected = profiles.get(name);
  }

  let server: Awaited<ReturnType<typeof createOMRMcpServer>> | undefined;
  let authFailed = false;
  const authenticatedFetch: typeof fetch = async (request, init) => {
    const response = await fetch(request, init);
    // A revoked or expired grant cannot keep an already-open local host session.
    if (response.status === 401 && server && !authFailed) {
      authFailed = true;
      setImmediate(() => { void server?.close().catch(() => undefined); });
    }
    return response;
  };
  server = await createOMRMcpServer({
    baseUrl: selected.backend,
    credential: selected.key,
    workspaceId: selected.workspaceId,
    fetchImpl: authenticatedFetch,
  });
  await server.serveStdio();
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(`omr-mcp: ${error instanceof Error ? error.message : "launch failed"}\n`);
  process.exitCode = 1;
}
