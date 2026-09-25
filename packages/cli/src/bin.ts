#!/usr/bin/env node
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createCredentialStore, createOutput, createProjectConfig } from "@clifn/core";
import {
  beginDeviceAuthorization,
  OMRClient,
  OMRHttpError,
  pollDeviceAuthorization,
} from "@oh-my-router/client";
import type { ClientCapability } from "@oh-my-router/client-access";
import type { JsonValue, ToolEffect } from "@oh-my-router/tools";

const configRoot = process.env.OMR_CONFIG_DIR ?? join(homedir(), ".config", "oh-my-router");
const credentials = createCredentialStore(join(configRoot, "credentials"));
const output = createOutput({ mode: process.argv.includes("--json") ? "json" : "text" });

interface ProfileConfig extends Record<string, unknown> {
  workspaceId?: string;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function profileName(): string {
  return option("--profile") ?? process.env.OMR_PROFILE ?? "default";
}

function profileConfig(profile: string) {
  return createProjectConfig<ProfileConfig>(join(configRoot, "profiles", `${profile}.json`));
}

function client(profile: string): { api: OMRClient; workspaceId: string } {
  if (process.env.OMR_BACKEND && process.env.OMR_API_KEY && process.env.OMR_WORKSPACE_ID) {
    return {
      api: new OMRClient({
        baseUrl: process.env.OMR_BACKEND,
        credential: process.env.OMR_API_KEY,
      }),
      workspaceId: process.env.OMR_WORKSPACE_ID,
    };
  }
  const stored = credentials.getProfile(profile);
  const workspaceId = profileConfig(profile).get("workspaceId");
  if (typeof workspaceId !== "string" || !workspaceId) {
    throw new Error(`Profile ${profile} has no workspace; run omr login`);
  }
  return { api: new OMRClient({ baseUrl: stored.backend, credential: stored.key }), workspaceId };
}

function jsonParams(): JsonValue {
  const raw = option("--params") ?? "{}";
  const value = JSON.parse(raw) as unknown;
  if (value === undefined) throw new Error("--params must be JSON");
  return value as JsonValue;
}

async function login(): Promise<void> {
  const profile = profileName();
  const baseUrl = requiredOption("--url");
  const requestedKind = option("--kind") ?? "cli";
  if (requestedKind !== "cli" && requestedKind !== "mcp_stdio" &&
    requestedKind !== "mcp_remote") {
    throw new Error("--kind must be cli, mcp_stdio, or mcp_remote");
  }
  const kind = requestedKind;
  const requestedCapabilities: ClientCapability[] = [
    "connections:read",
    "tools:discover",
    "tools:read",
    "tools:write",
    "approvals:create",
  ];
  const authorization = await beginDeviceAuthorization({
    baseUrl,
    clientKind: kind,
    clientName: option("--name") ?? `OMR ${kind} on ${hostname()}`,
    requestedCapabilities,
  });
  output.info(`Open ${authorization.verificationUriComplete}`);
  output.info(`Confirm device code ${authorization.userCode}`);
  const deadline = Date.now() + authorization.expiresInSeconds * 1_000;
  while (Date.now() < deadline) {
    await delay(authorization.pollIntervalSeconds * 1_000);
    try {
      const approved = await pollDeviceAuthorization({ baseUrl, deviceCode: authorization.deviceCode });
      credentials.setProfile(profile, { backend: baseUrl, key: approved.credential });
      profileConfig(profile).write({ workspaceId: approved.workspaceId });
      output.success(`Saved OMR profile ${profile}`);
      return;
    } catch (error) {
      if (error instanceof OMRHttpError &&
        (error.body as { error?: unknown } | null)?.error === "DEVICE_AUTHORIZATION_PENDING") continue;
      throw error;
    }
  }
  throw new Error("Device authorization expired");
}

async function main(): Promise<void> {
  const [command, subcommand, subject] = process.argv.slice(2).filter((value) => !value.startsWith("--") &&
    ![option("--profile"), option("--url"), option("--kind"), option("--name"), option("--workspace"),
      option("--provider"), option("--query"), option("--effect"), option("--params"),
      option("--connection"), option("--idempotency")].includes(value));
  if (command === "login") return login();
  const { api, workspaceId: storedWorkspace } = client(profileName());
  const workspaceId = option("--workspace") ?? storedWorkspace;

  if (command === "tools" && subcommand === "list") {
    return output.json(await api.discoverTools({
      workspaceId,
      provider: option("--provider"),
      query: option("--query"),
      effect: option("--effect") as ToolEffect | undefined,
      limit: 100,
    }));
  }
  if (command === "tools" && subcommand === "get" && subject) {
    return output.json(await api.getTool(subject, workspaceId));
  }
  if (command === "tools" && subcommand === "run" && subject) {
    return output.json(await api.execute({
      workspaceId,
      toolId: subject,
      params: jsonParams(),
      ...(option("--connection") ? { connectionId: option("--connection") } : {}),
      ...(option("--idempotency") ? { idempotencyKey: option("--idempotency") } : {}),
    }));
  }
  if (command === "connections" && subcommand === "list") {
    return output.json(await api.listConnections(workspaceId, option("--provider")));
  }
  if (command === "connections" && subcommand === "select" && subject) {
    return output.json(await api.selectConnection({
      workspaceId, provider: requiredOption("--provider"), connectionId: subject,
    }));
  }
  if (command === "approvals" && subcommand === "request" && subject) {
    return output.json(await api.requestApproval({
      workspaceId,
      toolId: subject,
      params: jsonParams(),
      ...(option("--connection") ? { connectionId: option("--connection") } : {}),
      ...(option("--idempotency") ? { idempotencyKey: option("--idempotency") } : {}),
    }));
  }
  if (command === "approvals" && subcommand === "execute" && subject) {
    return output.json(await api.executeApproved(subject));
  }
  throw new Error("Usage: omr login|tools list|get|run|connections list|connections select|approvals request|execute");
}

main().catch((error) => {
  const details = error instanceof OMRHttpError ? error.body : undefined;
  output.error(error instanceof Error ? error.message : String(error), details);
  process.exitCode = 1;
});
