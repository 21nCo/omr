import { describe, expect, it } from "vitest";
import { ClientAccessAuthority } from "@oh-my-router/client-access";
import { MemoryClientAccessStore } from "@oh-my-router/client-access/testing";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { WorkspaceAuthority } from "@oh-my-router/identity";

import { createProviderIntegrationConfig, selectAuthorizedConnection } from "./cloudflare-runtime.js";
import { createOMRRouter, type ConnectionRouteServices } from "./router.js";

describe("Worker provider OAuth configuration", () => {
  it("allowlists the browser callback for configured providers", () => {
    const config = createProviderIntegrationConfig({
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
      PLUGFN_GITHUB_CLIENT_ID: "sandbox-client",
    }, "https://omr-web-staging.example").github).toBeUndefined();
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
