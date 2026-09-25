#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { createCredentialStore, createProjectConfig } from "@clifn/core";

import { createOMRMcpServer } from "./server.js";

const configRoot = process.env.OMR_CONFIG_DIR ?? join(homedir(), ".config", "oh-my-router");
const profile = process.env.OMR_PROFILE ?? "default";
const stored = process.env.OMR_BACKEND && process.env.OMR_API_KEY
  ? { backend: process.env.OMR_BACKEND, key: process.env.OMR_API_KEY }
  : createCredentialStore(join(configRoot, "credentials")).getProfile(profile);
const workspaceId = process.env.OMR_WORKSPACE_ID ??
  createProjectConfig<{ workspaceId?: string }>(join(configRoot, "profiles", `${profile}.json`))
    .get("workspaceId");
if (!workspaceId) throw new Error("OMR_WORKSPACE_ID or a logged-in OMR profile is required");

const server = await createOMRMcpServer({
  baseUrl: stored.backend,
  credential: stored.key,
  workspaceId,
});
await server.serveStdio();
