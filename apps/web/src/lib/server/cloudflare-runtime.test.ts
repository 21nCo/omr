import { describe, expect, it, vi } from "vitest";
import { ClientAccessAuthority } from "@oh-my-router/client-access";
import { MemoryClientAccessStore } from "@oh-my-router/client-access/testing";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { ToolCatalog } from "@oh-my-router/tools";

import { assertConnectionWorkspace, checkAuthorizedConnectionHealth, createProviderIntegrationConfig, requireExecutionOrigin, revokeOwnBearerClient, scopedToolIds, selectAuthorizedConnection } from "./cloudflare-runtime.js";
import { createOMRRouter, type ConnectionRouteServices } from "./router.js";

describe("Worker provider OAuth configuration", () => {
  it("allowlists the browser callback for configured providers", () => {
    const config = createProviderIntegrationConfig({
      OMR_GITHUB_V1_ENABLED: "true",
      PLUGFN_GITHUB_CLIENT_ID: "sandbox-client",
      PLUGFN_GITHUB_CLIENT_SECRET: "sandbox-secret",
    }, "https://omr-web-staging.example");
    expect(config.github).toEqual({
      type: "oauth2",
      clientId: "sandbox-client",
      clientSecret: "sandbox-secret",
      redirectUris: ["https://omr-web-staging.example/app/oauth/callback"],
    });
    expect(config.linear).toBeUndefined();
  });

  it("does not expose a provider with only one client credential", () => {
    expect(createProviderIntegrationConfig({
      OMR_GITHUB_V1_ENABLED: "true",
      PLUGFN_GITHUB_CLIENT_ID: "sandbox-client",
    }, "https://omr-web-staging.example").github).toBeUndefined();
  });

  it("keeps GitHub unavailable by default even when OAuth credentials are configured", () => {
    expect(createProviderIntegrationConfig({
      PLUGFN_GITHUB_CLIENT_ID: "sandbox-client",
      PLUGFN_GITHUB_CLIENT_SECRET: "sandbox-secret",
    }, "https://omr-web-staging.example").github).toBeUndefined();
    expect(createProviderIntegrationConfig({
      OMR_GITHUB_V1_ENABLED: "false",
      PLUGFN_GITHUB_CLIENT_ID: "sandbox-client",
      PLUGFN_GITHUB_CLIENT_SECRET: "sandbox-secret",
    }, "https://omr-web-staging.example").github).toBeUndefined();
  });
});

describe("execution origin policy", () => {
  it("requires same-origin proof for cookie mutations and permits explicit bearer clients", () => {
    const request = (headers: Record<string, string>) => new Request("https://omr.example/api/approvals/execute",
      { method: "POST", headers });
    expect(() => requireExecutionOrigin(request({ cookie: "session=fixture" })))
      .toThrowError(/same-origin/);
    expect(() => requireExecutionOrigin(request({ cookie: "session=fixture", origin: "https://other.example" })))
      .toThrowError(/same-origin/);
    expect(() => requireExecutionOrigin(request({ cookie: "session=fixture", origin: "https://omr.example" })))
      .not.toThrow();
    expect(() => requireExecutionOrigin(request({ authorization: "Bearer client-grant" })))
      .not.toThrow();
    expect(() => requireExecutionOrigin(request({
      cookie: "session=fixture", origin: "https://other.example", authorization: "Bearer bogus-grant",
    }))).toThrowError(/same-origin/);
  });
});

describe("CLI self-revocation", () => {
  it("rejects cookies and other principals and revokes only the bearer grant", async () => {
    const revoke = vi.fn(async () => undefined);
    const principal = { kind: "client" as const, userId: "user_1", workspaceId: "workspace_1",
      clientId: "client_1", grantId: "grant_1", capabilities: [] };
    const request = (headers: Record<string, string>) => new Request("https://omr.example/api/client-grants/revoke-self",
      { method: "POST", headers });
    await expect(revokeOwnBearerClient(request({ cookie: "session=fixture" }), async () => principal, revoke))
      .rejects.toMatchObject({ code: "CLIENT_ACCESS_DENIED" });
    await expect(revokeOwnBearerClient(request({ authorization: "Bearer fixture", cookie: "session=fixture" }),
      async () => principal, revoke)).rejects.toMatchObject({ code: "CLIENT_ACCESS_DENIED" });
    await expect(revokeOwnBearerClient(request({ authorization: "Bearer fixture" }),
      async () => ({ kind: "web", userId: "user_1", workspaceId: "workspace_1" }), revoke))
      .rejects.toMatchObject({ code: "CLIENT_ACCESS_DENIED" });
    expect(revoke).not.toHaveBeenCalled();
    await expect(revokeOwnBearerClient(request({ authorization: "Bearer fixture" }),
      async () => principal, revoke)).resolves.toEqual({ revoked: true });
    expect(revoke).toHaveBeenCalledExactlyOnceWith("user_1", "grant_1");
  });

  it("keeps a sibling grant on the same client usable after self-revocation", async () => {
    const workspaceStore = new MemoryWorkspaceStore();
    const workspaces = new WorkspaceAuthority(workspaceStore);
    const workspaceId = (await workspaces.createTeam({ ownerUserId: "user_owner", name: "CLI Team" })).workspace.id;
    const clients = new ClientAccessAuthority(new MemoryClientAccessStore(workspaceStore));
    const client = await clients.registerClient({ actorUserId: "user_owner", workspaceId, kind: "cli", name: "CLI" });
    const first = await clients.issueGrant({ actorUserId: "user_owner", clientId: client.id,
      workspaceId, capabilities: ["tools:read"] });
    const sibling = await clients.issueGrant({ actorUserId: "user_owner", clientId: client.id,
      workspaceId, capabilities: ["tools:read"] });
    const request = new Request("https://omr.example/api/client-grants/revoke-self", {
      method: "POST", headers: { authorization: `Bearer ${first.credential}` },
    });
    await revokeOwnBearerClient(request,
      async () => ({ ...await clients.authenticate(first.credential), kind: "client" }),
      (userId, grantId) => clients.revokeGrant(userId, grantId));
    await expect(clients.authenticate(first.credential)).rejects.toMatchObject({ code: "CLIENT_CREDENTIAL_INVALID" });
    await expect(clients.authenticate(sibling.credential)).resolves.toMatchObject({
      clientId: client.id, grantId: sibling.grant.id,
    });
  });
});

describe("Worker scoped provider catalog", () => {
  it.each([false, true])("omits a missing selected binding with alternate ready=%s", async (alternateReady) => {
    const definitions = new Map(["github", "linear"].map((name) => [name, {
      name, displayName: name, version: "1.0.0", description: name,
      auth: { type: "oauth2" },
      actions: { read: {
        name: "read", displayName: "Read", description: "Read resource", parameters: {}, returns: {},
        contract: { version: "1.0.0", effect: "read" as const, requiredScopes: ["read"],
          resources: [], sensitiveKeys: [], pagination: { kind: "none" as const }, retry: "never" as const },
      } },
    }]));
    const catalog = await ToolCatalog.create({ providers: { list: () => [...definitions.values()] } },
      (value) => value as Record<string, never>);
    const bindings = ["github", "linear"].map((provider) => ({
      id: `binding_${provider}`, provider, providerConnectionId: `remote_${provider}`,
      status: "active", readiness: "ready",
    }));
    if (alternateReady) bindings.push({
      id: "binding_github_alternate", provider: "github", providerConnectionId: "remote_github_alternate",
      status: "active", readiness: "ready",
    });
    const recordHealth = vi.fn().mockRejectedValue(new Error("health store unavailable"));
    const authority = {
      resolve: vi.fn(async ({ provider }: { provider: string }) => bindings.find((binding) => binding.provider === provider)!),
      recordHealth,
    };
    const plugfn = {
      providers: { get: (provider: string) => definitions.get(provider) },
      config: { integrations: { github: {}, linear: {} } },
      connections: { get: vi.fn(async (connectionId: string) => {
        if (connectionId === "remote_github") {
          throw Object.assign(new Error("deleted"), { code: "CONNECTION_NOT_FOUND" });
        }
        return { scopes: ["read"] };
      }) },
    };

    const result = await scopedToolIds(catalog, plugfn as never, authority as never,
      { kind: "web", userId: "user_1", workspaceId: "workspace_1" }, "workspace_1", bindings as never);
    expect(catalog.discover({ allowedToolIds: result.allowedToolIds }).tools.map(({ id }) => id))
      .toEqual(["linear.read"]);
    expect(result.allowedToolIds.has("github.read")).toBe(false);
    expect(result.providers.find(({ provider }) => provider === "github")?.state)
      .toBe(alternateReady ? "ready" : "expired");
    expect(result.providers.find(({ provider }) => provider === "linear")?.state).toBe("ready");
    expect(recordHealth).toHaveBeenCalledExactlyOnceWith({
      connectionId: "binding_github", status: "needs_reauth", readiness: "unavailable",
      reason: "plugfn_connection_missing",
    });
  });
});

describe("connection selection authorization", () => {
  it("denies a read-only client before changing the shared choice, while write clients and same-origin browsers can select", async () => {
    const owner = "user_owner";
    const workspaceStore = new MemoryWorkspaceStore();
    const workspace = (await new WorkspaceAuthority(workspaceStore).createTeam({
      ownerUserId: owner, name: "Selections",
    })).workspace;
    const clients = new ClientAccessAuthority(new MemoryClientAccessStore(workspaceStore));
    const credential = async (name: string, capabilities: ["connections:read"] | ["tools:write"]) => {
      const client = await clients.registerClient({
        actorUserId: owner, workspaceId: workspace.id, kind: "cli", name,
      });
      return (await clients.issueGrant({
        actorUserId: owner, clientId: client.id, workspaceId: workspace.id, capabilities,
      })).credential;
    };
    const read = await credential("Read-only", ["connections:read"]);
    const write = await credential("Writer", ["tools:write"]);
    let selected = "original";
    const routes = {
      select: (request: Request, input: { workspaceId: string; provider: string; connectionId: string }) =>
        selectAuthorizedConnection(request, input,
          async (selectionRequest, workspaceId, capability) => {
            const token = selectionRequest.headers.get("authorization")?.slice("Bearer ".length);
            if (!token) return { userId: owner };
            const principal = await clients.authenticate(token, capability);
            if (principal.workspaceId !== workspaceId) throw new Error("Wrong workspace");
            return principal;
          },
          async ({ actorUserId, connectionId }) => {
            selected = connectionId;
            return { actorUserId, connectionId };
          }),
    } as ConnectionRouteServices;
    const router = createOMRRouter(undefined, routes);
    const call = (headers: Record<string, string>, connectionId: string) => router.handle(
      new Request("https://omr.example/api/connections/select", {
        method: "POST", headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ workspaceId: workspace.id, provider: "github", connectionId }),
      }),
    );

    const denied = await call({ authorization: `Bearer ${read}` }, "read-choice");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "CLIENT_CAPABILITY_DENIED", capability: "tools:write" });
    expect(selected).toBe("original");

    expect((await call({ authorization: `Bearer ${write}` }, "write-choice")).status).toBe(200);
    expect(selected).toBe("write-choice");
    expect((await call({ origin: "https://omr.example" }, "browser-choice")).status).toBe(200);
    expect(selected).toBe("browser-choice");
    expect((await call({ origin: "https://other.example" }, "cross-origin-choice")).status).toBe(403);
    expect(selected).toBe("browser-choice");
  });
});

describe("connection health workspace scope", () => {
  it("rejects cross-origin web probes before authentication and lets same-origin web and scoped bearer probes run", async () => {
    const owner = "user_owner";
    const workspaceStore = new MemoryWorkspaceStore();
    const workspaces = new WorkspaceAuthority(workspaceStore);
    const a = (await workspaces.createTeam({ ownerUserId: owner, name: "A" })).workspace;
    const b = (await workspaces.createTeam({ ownerUserId: owner, name: "B" })).workspace;
    const clients = new ClientAccessAuthority(new MemoryClientAccessStore(workspaceStore));
    const client = await clients.registerClient({ actorUserId: owner, workspaceId: a.id, kind: "cli", name: "Reader" });
    const credential = (await clients.issueGrant({ actorUserId: owner, clientId: client.id,
      workspaceId: a.id, capabilities: ["connections:read"] })).credential;
    const authenticateHealth = vi.fn(async (request: Request) => {
      const token = request.headers.get("authorization")?.slice("Bearer ".length);
      if (!token) return { kind: "web" as const, userId: owner, workspaceId: "" };
      const principal = await clients.authenticate(token, "connections:read");
      return { kind: "client" as const, userId: principal.userId, workspaceId: principal.workspaceId,
        clientId: principal.clientId, grantId: principal.grantId, capabilities: principal.capabilities };
    });
    const getAccessible = vi.fn(async (id: string) => ({ workspaceId: id === "connection_a" ? a.id : b.id }));
    const providerProbe = vi.fn(async () => ({ status: "active" }));
    const routes = {
      checkHealth: (request: Request, connectionId: string) => checkAuthorizedConnectionHealth(
        request, connectionId, authenticateHealth,
        async (principal, id) => {
          const binding = await getAccessible(id);
          assertConnectionWorkspace(principal, binding.workspaceId);
          return providerProbe();
        }),
    } as ConnectionRouteServices;
    const router = createOMRRouter(undefined, routes);
    const call = (connectionId: string, headers: Record<string, string>) => router.handle(
      new Request("https://omr.example/api/connections/health", {
        method: "POST", headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ connectionId }),
      }),
    );

    expect((await call("connection_b", { cookie: "session=test", origin: "https://other.example" })).status).toBe(403);
    expect(authenticateHealth).not.toHaveBeenCalled();
    expect(getAccessible).not.toHaveBeenCalled();
    expect(providerProbe).not.toHaveBeenCalled();

    expect((await call("connection_b", { cookie: "session=test", origin: "https://omr.example" })).status).toBe(200);
    expect((await call("connection_a", { authorization: `Bearer ${credential}`, origin: "https://other.example" })).status).toBe(200);
    expect((await call("connection_b", { authorization: `Bearer ${credential}`, origin: "https://other.example" })).status).toBe(403);
    expect(providerProbe).toHaveBeenCalledTimes(2);
  });

  it("rejects a client grant for workspace A probing a binding in B even when its user belongs to both", async () => {
    const owner = "user_owner";
    const workspaceStore = new MemoryWorkspaceStore();
    const workspaces = new WorkspaceAuthority(workspaceStore);
    const a = (await workspaces.createTeam({ ownerUserId: owner, name: "A" })).workspace;
    const b = (await workspaces.createTeam({ ownerUserId: owner, name: "B" })).workspace;
    const clients = new ClientAccessAuthority(new MemoryClientAccessStore(workspaceStore));
    const client = await clients.registerClient({ actorUserId: owner, workspaceId: a.id, kind: "cli", name: "Reader" });
    const credential = (await clients.issueGrant({ actorUserId: owner, clientId: client.id,
      workspaceId: a.id, capabilities: ["connections:read"] })).credential;
    const principal = await clients.authenticate(credential, "connections:read");
    expect(() => assertConnectionWorkspace({ kind: "client", userId: principal.userId,
      workspaceId: principal.workspaceId, clientId: principal.clientId, grantId: principal.grantId,
      capabilities: principal.capabilities }, b.id)).toThrowError(/access denied/i);
    expect(() => assertConnectionWorkspace({ kind: "client", userId: principal.userId,
      workspaceId: principal.workspaceId, clientId: principal.clientId, grantId: principal.grantId,
      capabilities: principal.capabilities }, a.id)).not.toThrow();
  });
});
