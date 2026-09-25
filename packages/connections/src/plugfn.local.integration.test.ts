import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAdapter, mockProvider, plugFn } from "plugfn";
import { githubProvider } from "@plugfn/providers";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";

import { ConnectionAuthority } from "./connections.js";
import { PlugFnConnectionOrchestrator, type PlugFnConnectionPort } from "./plugfn.js";
import { MemoryConnectionBindingStore } from "./testing.js";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const REDIRECT_URI = "https://omr.local/app/oauth/callback";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("local PlugFn integration", () => {
  it("completes a read-only GitHub OAuth connection, reads, and disconnects", async () => {
    const database = new MemoryAdapter();
    const requests: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "sandbox-access-token", token_type: "bearer", scope: "" });
      }
      if (url.startsWith("https://api.github.com/user/repos?")) {
        requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        return Response.json([]);
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof fetch;

    const runtime = plugFn({
      database,
      auth: { getUserId: async () => null },
      baseUrl: "https://omr.local",
      encryptionKey: ENCRYPTION_KEY,
      integrations: { github: {
        type: "oauth2",
        clientId: "sandbox-client",
        clientSecret: "sandbox-secret",
        redirectUris: [REDIRECT_URI],
      } },
    }).use(githubProvider);
    await runtime.ready;

    const workspaceStore = new MemoryWorkspaceStore();
    const workspaces = new WorkspaceAuthority(workspaceStore);
    const { workspace } = await workspaces.provisionPersonalWorkspace({ userId: "user_owner" });
    const authority = new ConnectionAuthority(new MemoryConnectionBindingStore(workspaceStore));
    const orchestrator = new PlugFnConnectionOrchestrator(authority, runtime);
    const redirectUri = REDIRECT_URI;

    const { authUrl } = await orchestrator.startOAuth({
      actorUserId: "user_owner",
      workspaceId: workspace.id,
      provider: "github",
      ownership: "personal",
      redirectUri,
      label: "Public GitHub",
    });
    const authorization = new URL(authUrl);
    expect(authorization.origin).toBe("https://github.com");
    expect(authorization.searchParams.get("scope")).toBe("read:user");
    const state = authorization.searchParams.get("state");
    expect(state).toBeTruthy();

    const { connection } = await orchestrator.completeOAuth({
      actorUserId: "user_owner",
      workspaceId: workspace.id,
      provider: "github",
      ownership: "personal",
      code: "sandbox-code",
      state: state!,
      redirectUri,
      label: "Public GitHub",
    });
    const persisted = await runtime.connections.get(connection.providerConnectionId);
    expect(persisted.credentials.encrypted).not.toContain("sandbox-access-token");

    await runtime.action("github", "repos.list", {
      userId: "user_owner",
      connectionId: connection.providerConnectionId,
      params: {},
      actor: { userId: "user_owner", tenantId: workspace.id, organizationId: workspace.id },
      retry: { maxAttempts: 1, backoff: "exponential" },
      cache: false,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.authorization).toBe("Bearer sandbox-access-token");

    await orchestrator.disconnect("user_owner", connection.id);
    await expect(authority.resolve({ actorUserId: "user_owner", workspaceId: workspace.id, provider: "github" }))
      .rejects.toMatchObject({ code: "CONNECTION_UNAVAILABLE" });
  });

  it("creates, validates, and disconnects an encrypted API-key connection", async () => {
    const database = new MemoryAdapter();
    const runtime = plugFn({
      database,
      auth: { getUserId: async () => null },
      baseUrl: "https://omr.local",
      encryptionKey: ENCRYPTION_KEY,
      integrations: {},
    }).use(mockProvider("linear", {}));
    await runtime.ready;
    const plugfn: PlugFnConnectionPort = runtime;

    const workspaceStore = new MemoryWorkspaceStore();
    const workspaces = new WorkspaceAuthority(workspaceStore);
    const team = await workspaces.createTeam({ ownerUserId: "user_owner", name: "OMR" });
    const authority = new ConnectionAuthority(new MemoryConnectionBindingStore(workspaceStore));
    const orchestrator = new PlugFnConnectionOrchestrator(authority, plugfn);

    const binding = await orchestrator.connectApiKey({
      actorUserId: "user_owner",
      workspaceId: team.workspace.id,
      provider: "linear",
      ownership: "workspace",
      apiKey: "lin_local_secret",
      label: "Local Linear",
    });
    const stored = await runtime.connections.get(binding.providerConnectionId);
    expect(stored.credentials.algorithm).toBe("aes-256-gcm");
    expect(stored.credentials.encrypted).not.toContain("lin_local_secret");
    await expect(orchestrator.checkHealth("user_owner", binding.id)).resolves.toMatchObject({
      status: "active",
      readiness: "ready",
    });

    await expect(orchestrator.disconnect("user_owner", binding.id)).resolves.toMatchObject({
      connection: { status: "revoked" },
      provider: { localDeleted: true },
    });
    await expect(runtime.connections.get(binding.providerConnectionId)).rejects.toMatchObject({
      code: "CONNECTION_NOT_FOUND",
    });
  });
});
