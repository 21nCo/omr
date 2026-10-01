import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAdapter, mockProvider, plugFn } from "plugfn";
import { omrGithubProvider, verifiedGithubScopes } from "@oh-my-router/plugfn-runtime";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { createPlugFnToolCatalog, usableToolIds } from "@oh-my-router/tools";
import { ExecutionService } from "@oh-my-router/execution";
import { MemoryExecutionApprovalStore, MemoryExecutionReceiptStore } from "@oh-my-router/execution/testing";

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
  it("uses observed GitHub grants after an omitted callback scope and later downgrade", async () => {
    const database = new MemoryAdapter();
    let effectiveScopes: string | null = "read:user";
    const post = vi.fn(async () => Response.json({ id: 9,
      html_url: "https://github.com/org/repo/issues/1#issuecomment-9" }));
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "sandbox-access-token", token_type: "bearer" });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({ id: 7, login: "alice", html_url: "https://github.com/alice" },
          { headers: effectiveScopes === null ? {} : { "X-OAuth-Scopes": effectiveScopes } });
      }
      if (url === "https://api.github.com/repos/org/repo") {
        return Response.json({ private: false });
      }
      if (url === "https://api.github.com/repos/org/repo/issues/1/comments") return post();
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof fetch;

    const runtime = plugFn({ database, auth: { getUserId: async () => null },
      baseUrl: "https://omr.local", encryptionKey: ENCRYPTION_KEY,
      integrations: { github: { type: "oauth2", clientId: "sandbox-client",
        clientSecret: "sandbox-secret", redirectUris: [REDIRECT_URI] } },
    }).use(omrGithubProvider);
    await runtime.ready;
    const workspaceStore = new MemoryWorkspaceStore();
    const workspaces = new WorkspaceAuthority(workspaceStore);
    const { workspace } = await workspaces.provisionPersonalWorkspace({ userId: "user_owner" });
    const other = await workspaces.createTeam({ ownerUserId: "user_owner", name: "Other" });
    const authority = new ConnectionAuthority(new MemoryConnectionBindingStore(workspaceStore));
    const orchestrator = new PlugFnConnectionOrchestrator(authority, runtime);
    const { authUrl } = await orchestrator.startOAuth({ actorUserId: "user_owner",
      workspaceId: workspace.id, provider: "github", ownership: "personal",
      redirectUri: REDIRECT_URI, label: "Write request", githubAccess: "public_write" });
    const { connection } = await orchestrator.completeOAuth({ actorUserId: "user_owner",
      workspaceId: workspace.id, provider: "github", ownership: "personal",
      redirectUri: REDIRECT_URI, label: "Write request", code: "sandbox-code",
      state: new URL(authUrl).searchParams.get("state")! });
    expect((await runtime.connections.get(connection.providerConnectionId)).scopes)
      .toContain("public_repo"); // Pinned PlugFn currently records the requested fallback.

    const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrGithubProvider] } });
    const scopeProof = () => verifiedGithubScopes(runtime, { userId: "user_owner",
      workspaceId: workspace.id, connectionId: connection.providerConnectionId });
    const visible = () => usableToolIds(catalog, [{ provider: "github", state: "ready" }], scopeProof);
    expect([...await visible()]).not.toContain("github.issues.commentPublic");
    expect([...await visible()]).not.toContain("github.repos.listPrivate");
    const receipts = new MemoryExecutionReceiptStore(() => true);
    const approvals = new MemoryExecutionApprovalStore(() => true, receipts);
    const service = new ExecutionService(catalog, authority, runtime, receipts,
      scopeProof, Date.now, approvals, undefined, new Uint8Array(32).fill(7));
    const principal = { kind: "web" as const, userId: "user_owner", workspaceId: workspace.id };
    const params = { owner: "org", repo: "repo", issueNumber: 1, body: "Hello" };
    await expect(service.execute({ principal, toolId: "github.repos.listPrivate", params: {} }))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    await expect(service.requestApproval({ principal, toolId: "github.issues.commentPublic",
      params, idempotencyKey: "omitted-grant" }))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    const requestsBeforeOtherWorkspace = requests.length;
    await expect(service.requestApproval({ principal: { ...principal, workspaceId: other.workspace.id },
      toolId: "github.issues.commentPublic", connectionId: connection.id,
      params, idempotencyKey: "cross-workspace" }))
      .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(requests).toHaveLength(requestsBeforeOtherWorkspace);
    expect(post).not.toHaveBeenCalled();
    expect(receipts.receipts.size).toBe(0);

    effectiveScopes = null;
    expect([...await visible()]).toEqual([]);
    await expect(service.requestApproval({ principal, toolId: "github.issues.commentPublic",
      params, idempotencyKey: "unverifiable-grant" }))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });

    effectiveScopes = "read:user, public_repo";
    expect([...await visible()]).toContain("github.issues.commentPublic");
    const approval = await service.requestApproval({ principal, toolId: "github.issues.commentPublic",
      params, idempotencyKey: "verified-grant" });
    await service.approve(approval.id, principal.userId);
    effectiveScopes = "read:user"; // A refresh or provider-side reduction must revoke write use.
    await expect(service.executeApproved(principal, approval.id))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    expect(post).not.toHaveBeenCalled();
    expect(requests).not.toContain("https://api.github.com/repos/org/repo");
    expect(receipts.receipts.size).toBe(0);
  });

  it("completes a read-only GitHub OAuth connection, reads, and disconnects", async () => {
    const database = new MemoryAdapter();
    const requests: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        // PlugFn currently substitutes requested scopes when GitHub omits scope.
        return Response.json({ access_token: "sandbox-access-token", token_type: "bearer" });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({ id: 7, login: "alice", html_url: "https://github.com/alice" },
          { headers: { "X-OAuth-Scopes": "read:user" } });
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
    }).use(omrGithubProvider);
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
    expect(await verifiedGithubScopes(runtime, { userId: "user_owner", workspaceId: workspace.id,
      connectionId: connection.providerConnectionId })).toEqual(["read:user"]);

    await runtime.action("github", "repos.listPublic", {
      userId: "user_owner",
      connectionId: connection.providerConnectionId,
      params: {},
      actor: { userId: "user_owner", tenantId: workspace.id, organizationId: workspace.id },
      retry: { maxAttempts: 1, backoff: "exponential" },
      cache: false,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.authorization).toBe("Bearer sandbox-access-token");
    expect(new URL(requests[0]!.url).searchParams.get("visibility")).toBe("public");

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
