import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidClientCredentialError } from "@oh-my-router/client-access";

const fixture = vi.hoisted(() => ({
  revoked: false,
  authenticate: vi.fn(async (_credential: string, _capability?: string) => {
    if (fixture.revoked) throw new InvalidClientCredentialError();
    return {
      kind: "mcp_remote" as "mcp_remote" | "cli", userId: "user_one",
      workspaceId: "workspace_one", clientId: "client_one", grantId: "grant_one",
      capabilities: ["tools:discover", "tools:read", "tools:write", "approvals:create"],
    };
  }),
  revokeGrant: vi.fn(async (_userId: string, grantId: string) => {
    if (grantId === "grant_one") fixture.revoked = true;
  }),
}));

vi.mock("@oh-my-router/client-access/postgres", () => ({
  connectPostgresClientAccess: async () => ({
    clients: { authenticate: fixture.authenticate, revokeGrant: fixture.revokeGrant },
    close: async () => undefined,
  }),
}));

import { createCloudflareRouteServices, createRemoteMcpRouteServices } from "./cloudflare-runtime.js";
import { createOMRRouter } from "./router.js";

const origin = "https://omr.example";
const bearer = "Bearer omr_" + "a".repeat(64);
function event() {
  return { request: new Request(`${origin}/api/tools`), platform: {
    env: { DATABASE_URL: "postgres://fixture" },
  } } as never;
}

function router(internal: boolean) {
  const services = internal ? createRemoteMcpRouteServices(event()) : createCloudflareRouteServices(event());
  return createOMRRouter(services.device, services.connections, services.tools,
    services.execution, services.controlPlane);
}

function request(path: string, body?: Record<string, unknown>) {
  return new Request(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: bearer, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe("remote MCP credential audience", () => {
  beforeEach(() => {
    fixture.revoked = false;
    vi.clearAllMocks();
  });

  it("rejects a remote host grant on direct public catalog, execution, approval, and grant routes", async () => {
    const publicRouter = router(false);
    const calls = [
      request("/api/tools?workspaceId=workspace_one"),
      request("/api/tools/execute", { workspaceId: "workspace_one", toolId: "fixture.read", params: {} }),
      request("/api/approvals", { workspaceId: "workspace_one", toolId: "fixture.write", params: {}, idempotencyKey: "one" }),
      request("/api/approvals/execute", { approvalId: "approval_one" }),
      request("/api/approvals/status?approvalId=approval_one"),
    ];
    for (const call of calls) {
      const response = await publicRouter.handle(call);
      expect(response.status, new URL(call.url).pathname).toBe(403);
      expect(await response.json()).toEqual({ error: "CLIENT_ACCESS_DENIED" });
    }
    const otherGrant = await publicRouter.handle(request("/api/client-grants/revoke", { clientId: "client_one" }));
    expect(otherGrant.status).toBe(403);
    expect(await otherGrant.json()).toEqual({ error: "REQUEST_ORIGIN_DENIED" });
    expect(fixture.revokeGrant).not.toHaveBeenCalled();
  });

  it("allows only bearer self-revocation for a manual remote grant and invalidates it immediately", async () => {
    const publicRouter = router(false);
    const cookie = new Request(`${origin}/api/client-grants/revoke-self`, {
      method: "POST", headers: { authorization: bearer, cookie: "session=fixture" },
    });
    expect((await publicRouter.handle(cookie)).status).toBe(403);
    expect(fixture.revokeGrant).not.toHaveBeenCalled();

    const selfRevoke = await publicRouter.handle(request("/api/client-grants/revoke-self", {}));
    expect(selfRevoke.status).toBe(200);
    expect(await selfRevoke.json()).toEqual({ revoked: true });
    expect(fixture.revokeGrant).toHaveBeenCalledWith("user_one", "grant_one");
    const retry = await publicRouter.handle(request("/api/client-grants/revoke-self", {}));
    expect(retry.status).toBe(401);
    expect(await retry.json()).toEqual({ error: "CLIENT_CREDENTIAL_INVALID" });
    expect(fixture.revokeGrant).toHaveBeenCalledTimes(1);
  });

  it("keeps the internal MCP adapter's validated grant usable and does not exclude CLI grants from public API", async () => {
    const internal = router(true);
    const internalRevoke = await internal.handle(request("/api/client-grants/revoke-self", {}));
    expect(internalRevoke.status).toBe(200);
    fixture.authenticate.mockImplementationOnce(async () => ({
      kind: "cli", userId: "user_one", workspaceId: "workspace_one",
      clientId: "client_cli", grantId: "grant_cli",
      capabilities: ["tools:discover", "tools:read", "tools:write", "approvals:create"],
    }));
    const cli = await router(false).handle(request("/api/client-grants/revoke-self", {}));
    expect(cli.status).toBe(200);
    expect(fixture.revokeGrant).toHaveBeenCalledWith("user_one", "grant_cli");
  });
});
