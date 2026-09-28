#!/usr/bin/env node
import { OMRProfileStore, ProfileMissingError } from "@oh-my-router/client/profile-store";

import { createOMRMcpServer } from "./server.js";

const profiles = new OMRProfileStore();
const profile = process.env.OMR_PROFILE ?? (process.env.OMR_BACKEND && process.env.OMR_API_KEY
  ? "default" : profiles.activeName());
const stored = process.env.OMR_BACKEND && process.env.OMR_API_KEY
  ? { backend: process.env.OMR_BACKEND, key: process.env.OMR_API_KEY }
  : profiles.get(profile);
// Older MCP launches supplied the backend/key through the environment but kept
// their workspace selection in the local profile. Preserve that configuration.
let workspaceId = process.env.OMR_WORKSPACE_ID ?? ("workspaceId" in stored ? stored.workspaceId : undefined);
if (!workspaceId) {
  try { workspaceId = profiles.workspaceId(profile); }
  catch (error) {
    if (process.env.OMR_BACKEND && process.env.OMR_API_KEY && error instanceof ProfileMissingError) {
      throw new Error("OMR_WORKSPACE_ID is required for headless MCP when no saved profile supplies a workspace");
    }
    throw error;
  }
}
if (!workspaceId) throw new Error("OMR_WORKSPACE_ID or a logged-in OMR profile is required");

const server = await createOMRMcpServer({
  baseUrl: stored.backend,
  credential: stored.key,
  workspaceId,
});
await server.serveStdio();
