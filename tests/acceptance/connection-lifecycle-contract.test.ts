import { describe, expect, it, vi } from "vitest";
import { ConnectionAuthority, PlugFnConnectionOrchestrator, type PlugFnConnectionPort } from "@oh-my-router/connections";
import { MemoryConnectionBindingStore } from "@oh-my-router/connections/testing";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { publicConnections } from "../../apps/web/src/lib/server/connection-view.js";
import { createOMRRouter, type ConnectionRouteServices } from "../../apps/web/src/lib/server/router.js";

describe("connection-lifecycle-contract", () => {
  it("connects, selects, degrades, refreshes, reconnects, and disconnects through HTTP with role isolation", async () => {
    const workspaceStore = new MemoryWorkspaceStore();
    const workspaces = new WorkspaceAuthority(workspaceStore);
    const team = (await workspaces.createTeam({ ownerUserId: "user_owner", name: "Team" })).workspace;
    const invite = await workspaces.inviteMember({ actorUserId: "user_owner", workspaceId: team.id,
      email: "member@example.com", role: "member" });
    await workspaces.acceptInvitation({ token: invite.token, userId: "user_member",
      email: "member@example.com", emailVerified: true });
    const authority = new ConnectionAuthority(new MemoryConnectionBindingStore(workspaceStore));
    let sequence = 0;
    let valid = true;
    const remote = {
      getAuthUrl: vi.fn(async () => "https://github.example/authorize?state=fixture&scope=read%3Auser"),
      handleCallback: vi.fn(async () => { throw new Error("callback failed with secret token"); }),
      connect: vi.fn(async (input: { provider: string; owner: { kind: string; organizationId?: string; tenantId: string } }) => ({
        id: `remote_${++sequence}`, userId: "user_owner", provider: input.provider,
        ownerKind: "organization" as const, ownerId: input.owner.organizationId,
        organizationId: input.owner.organizationId, tenantId: input.owner.tenantId,
        status: "active" as const,
      })),
      get: vi.fn(async () => ({ status: "expired" as const })),
      isValid: vi.fn(async () => valid),
      refresh: vi.fn(async (id: string) => ({ id, provider: "linear", status: "active" as const })),
      disconnect: vi.fn(async () => ({ disconnected: true, remoteRevokeAttempted: true,
        remoteRevokeSucceeded: true, localDeleted: true, connectionDeleted: true })),
    };
    const port = {
      config: { integrations: { github: { type: "oauth2" } } },
      connections: remote,
      providers: { get: (name: string) => name === "linear"
        ? { name, displayName: "Linear", auth: { type: "api-key" }, actions: {} }
        : name === "github"
          ? { name, displayName: "GitHub", auth: { type: "oauth2" }, actions: {} }
          : undefined },
    } as PlugFnConnectionPort;
    const orchestrator = new PlugFnConnectionOrchestrator(authority, port);
    const actor = (request: Request) => request.headers.get("x-fixture-user") ?? "user_outsider";
    const view = async (user: string) => publicConnections(authority, user, team.id,
      await authority.listAvailable({ actorUserId: user, workspaceId: team.id }));
    const services: ConnectionRouteServices = {
      providerReadiness: async (_request, provider) => orchestrator.providerReadiness(provider),
      list: async (request) => view(actor(request)),
      select: async (request, input) => orchestrator.select({ actorUserId: actor(request), ...input }),
      startOAuth: async (request, input) => orchestrator.startOAuth({ actorUserId: actor(request), ...input }),
      completeOAuth: async (request, input) => orchestrator.completeOAuth({ actorUserId: actor(request), ...input }),
      connectApiKey: async (request, input) => orchestrator.connectApiKey({ actorUserId: actor(request), ...input }),
      checkHealth: async (request, id) => orchestrator.checkHealth(actor(request), id),
      refresh: async (request, id) => orchestrator.refresh(actor(request), id),
      disconnect: async (request, id) => orchestrator.disconnect(actor(request), id),
    };
    const router = createOMRRouter(undefined, services);
    const post = (user: string, path: string, body: object) => router.handle(new Request(
      `https://omr.example/api/connections/${path}`, { method: "POST",
        headers: { "content-type": "application/json", "x-fixture-user": user }, body: JSON.stringify(body) },
    ));
    const setup = { workspaceId: team.id, provider: "linear", ownership: "workspace" as const,
      apiKey: "fixture-secret", label: "Team Linear" };

    expect((await post("user_member", "api-key", setup)).status).toBe(403);
    expect(remote.connect).not.toHaveBeenCalled();
    const connected = await post("user_owner", "api-key", setup);
    expect(connected.status).toBe(201);
    const binding = await connected.json() as { id: string };
    const list = await post("user_member", "list", { workspaceId: team.id });
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).not.toContain("fixture-secret");
    expect((await post("user_member", "select", { workspaceId: team.id,
      provider: "linear", connectionId: binding.id })).status).toBe(200);
    expect((await view("user_member"))[0]).toMatchObject({ id: binding.id, selected: true });

    valid = false;
    expect((await post("user_member", "health", { connectionId: binding.id })).status).toBe(200);
    expect((await view("user_member"))[0]).toMatchObject({ readiness: "unavailable", selected: false });
    expect((await post("user_member", "select", { workspaceId: team.id,
      provider: "linear", connectionId: binding.id })).status).toBe(409);
    expect((await post("user_member", "refresh", { connectionId: binding.id })).status).toBe(403);
    remote.refresh.mockResolvedValueOnce({ id: "remote_1", provider: "linear", status: "expired" });
    const expiredRefresh = await post("user_owner", "refresh", { connectionId: binding.id });
    expect(expiredRefresh.status).toBe(502);
    await expect(expiredRefresh.json()).resolves.toMatchObject({ error: "CONNECTION_PROVIDER_FAILED",
      operation: "refresh", message: "Could not refresh this account. Reconnect it to restore access." });
    expect((await view("user_member"))[0]).toMatchObject({ readiness: "unavailable" });
    expect((await post("user_owner", "refresh", { connectionId: binding.id })).status).toBe(200);
    expect((await view("user_member"))[0]).toMatchObject({ readiness: "ready" });

    const reconnected = await post("user_owner", "api-key", { ...setup, apiKey: "replacement" });
    expect(reconnected.status).toBe(201);
    expect((await post("user_member", "disconnect", { connectionId: binding.id })).status).toBe(403);
    expect((await post("user_owner", "disconnect", { connectionId: binding.id })).status).toBe(200);
    expect((await view("user_member")).find(({ id }) => id === binding.id))
      .toMatchObject({ status: "revoked", readiness: "unavailable", selected: false });
    expect((await reconnected.json() as { id: string }).id).not.toBe(binding.id);
    expect((await post("user_outsider", "list", { workspaceId: team.id })).status).toBe(403);

    const callback = await post("user_owner", "oauth/callback", { workspaceId: team.id,
      provider: "github", ownership: "personal", code: "bad-code", state: "state", label: "GitHub" });
    expect(callback.status).toBe(502);
    expect(JSON.stringify(await callback.json())).not.toContain("secret token");
  });
});
