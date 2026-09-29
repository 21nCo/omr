import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";


const fixture = vi.hoisted(() => ({
  revoked: false,
  kind: "mcp_remote" as "mcp_remote" | "mcp_stdio",
  apiRequests: [] as Array<{ path: string; workspaceId: string | null; credential: string | null }>,
}));

const credential = `omr_${"a".repeat(64)}`;
const origin = "https://omr.example";
const omrClientId = "client_11111111-1111-4111-8111-111111111111";

vi.mock("@oh-my-router/client-access/postgres", () => ({
  connectPostgresClientAccess: async () => ({
    clients: {
      authenticate: async (value: string) => {
        if (value !== credential || fixture.revoked) {
          const { InvalidClientCredentialError } = await import("@oh-my-router/client-access");
          throw new InvalidClientCredentialError();
        }
        return {
          kind: fixture.kind, userId: "user_one", workspaceId: "workspace_one",
          clientId: "client_one", grantId: "grant_one",
          capabilities: ["tools:discover", "tools:read", "tools:write", "approvals:create"],
        };
      },
      registerClient: async () => ({ id: omrClientId }),
      issueGrant: async () => ({ credential }),
      revokeClient: async () => { fixture.revoked = true; },
    },
    oauthGrants: {
      activate: async () => [],
      listActive: async () => [{
        omrClientId, clientName: "Fixture host", workspaceId: "workspace_one",
        oauthClientId: "fixture-oauth-client", scopes: ["tools:discover"], createdAt: 1,
      }],
      revoke: async (_userId: string, clientId: string) => {
        if (clientId !== omrClientId) {
          const { ClientAccessDeniedError } = await import("@oh-my-router/client-access");
          throw new ClientAccessDeniedError();
        }
        fixture.revoked = true;
        return "grant_one";
      },
    },
    close: async () => undefined,
  }),
}));

vi.mock("@oh-my-router/identity/postgres", () => ({
  connectPostgresIdentityRuntime: async () => ({
    requireSession: async () => ({ actorId: "user_one" }),
    workspaces: { listWorkspaceAccess: async () => [{
      workspace: { id: "workspace_one", name: "Personal", kind: "personal" },
    }] },
    close: async () => undefined,
  }),
}));

vi.mock("./cloudflare-runtime.js", () => ({
  databaseConnectionString: () => "postgres://fixture",
  createCloudflareRouteServices: () => ({
    device: {}, connections: {}, tools: {}, execution: {}, controlPlane: {},
  }),
}));

vi.mock("./router.js", () => ({
  createOMRRouter: () => ({
    handle: async (request: Request) => {
      const url = new URL(request.url);
      const workspaceId = url.searchParams.get("workspaceId") ??
        (request.method === "POST" ? (await request.clone().json()).workspaceId : null);
      fixture.apiRequests.push({
        path: url.pathname, workspaceId,
        credential: request.headers.get("authorization"),
      });
      if (workspaceId !== "workspace_one") return Response.json({ error: "WORKSPACE_ACCESS_DENIED" }, { status: 403 });
      if (url.pathname === "/api/tools") return Response.json({
        catalogSchemaVersion: "1.0.0", revision: "one", tools: [{
          catalogSchemaVersion: "1.0.0", id: "fixture.read", provider: "fixture",
          providerVersion: "1.0.0", action: "read", displayName: "Fixture read",
          description: "Read a fixture", hash: "fixture-hash",
          contract: { version: "1.0.0", effect: "read", requiredScopes: [], resources: [],
            sensitiveKeys: [], pagination: { kind: "none" }, retry: "safe" },
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          outputSchema: { type: "object" },
        }],
      });
      if (url.pathname === "/api/tools/execute") return Response.json({
        status: "succeeded", output: { workspaceId },
      });
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    },
  }),
}));

import { handleRemoteMcp } from "./mcp-http.js";
import { handleMcpOAuth } from "./mcp-oauth.js";
import { GET as wellKnownGet, OPTIONS as wellKnownOptions } from "../../routes/.well-known/[...path]/+server.js";

function kvFixture() {
  const values = new Map<string, string>();
  return {
    values,
    async get(key: string, options?: { type?: string }) {
      const value = values.get(key);
      return value === undefined ? null : options?.type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) { values.set(key, value); },
    async delete(key: string) { values.delete(key); },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return { keys: [...values.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true, cursor: "" };
    },
  };
}

function event(request: Request, kv = kvFixture()) {
  return {
    request,
    platform: {
      env: { OAUTH_KV: kv, OMR_PUBLIC_ORIGIN: origin },
      ctx: { waitUntil() {}, passThroughOnException() {} },
    },
  } as never;
}

describe("remote-mcp-contract", () => {
  afterEach(() => {
    fixture.revoked = false;
    fixture.kind = "mcp_remote";
    fixture.apiRequests.length = 0;
  });

  it("serves public OAuth discovery from routed well-known URLs without exposing private data", async () => {
    const kv = kvFixture();
    const resource = await wellKnownGet(event(new Request(`${origin}/.well-known/oauth-protected-resource/mcp`), kv));
    const authorization = await wellKnownGet(event(new Request(`${origin}/.well-known/oauth-authorization-server`), kv));
    const preflight = await wellKnownOptions(event(new Request(`${origin}/.well-known/oauth-protected-resource/mcp`, {
      method: "OPTIONS", headers: { origin: "https://host.example", "access-control-request-method": "GET" },
    }), kv));
    expect(preflight.status).toBe(204);
    expect(resource.status).toBe(200);
    await expect(resource.json()).resolves.toMatchObject({
      resource: `${origin}/mcp`, authorization_servers: [origin],
      scopes_supported: expect.arrayContaining(["tools:discover", "tools:read", "tools:write", "approvals:create"]),
    });
    expect(authorization.status).toBe(200);
    await expect(authorization.json()).resolves.toMatchObject({
      authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`, code_challenge_methods_supported: ["S256"],
      scopes_supported: expect.arrayContaining(["tools:discover", "offline_access"]),
    });
    expect(JSON.stringify([...kv.values.values()])).not.toContain("workspace_one");
    expect(fixture.apiRequests).toHaveLength(0);
  });

  it("exchanges an S256 consent code, refreshes only the live full grant, and denies narrowed or revoked refresh", async () => {
    const kv = kvFixture();
    const send = (path: string, init?: RequestInit) => handleMcpOAuth(event(new Request(`${origin}${path}`, init), kv));
    const registration = await send("/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Fixture host", redirect_uris: ["https://host.example/callback"],
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registration.status).toBe(201);
    const { client_id: clientId } = await registration.json() as { client_id: string };
    const verifier = "v".repeat(64);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = Buffer.from(digest).toString("base64url");
    const authorizeUrl = new URL(`${origin}/oauth/authorize`);
    for (const [key, value] of Object.entries({
      response_type: "code", client_id: clientId, redirect_uri: "https://host.example/callback",
      scope: "tools:discover tools:read offline_access", state: "host-state", resource: `${origin}/mcp`,
      code_challenge: challenge, code_challenge_method: "S256",
    })) authorizeUrl.searchParams.set(key, value);
    const consent = await send(authorizeUrl.pathname + authorizeUrl.search);
    expect(consent.status).toBe(200);
    const csrf = (await consent.text()).match(/name="csrf" value="([a-f0-9]{64})"/)?.[1];
    expect(csrf).toBeTruthy();
    const noPkce = await send("/oauth/authorize?client_id=" + encodeURIComponent(clientId) +
      "&redirect_uri=https%3A%2F%2Fhost.example%2Fcallback&response_type=code&scope=tools%3Adiscover", {
      method: "GET",
    });
    expect(noPkce.status).toBe(302);
    expect(new URL(noPkce.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const wrongResource = new URL(authorizeUrl);
    wrongResource.searchParams.set("resource", "https://other.example/mcp");
    const wrongResourceResponse = await send(wrongResource.pathname + wrongResource.search);
    expect(wrongResourceResponse.status).toBe(302);
    expect(new URL(wrongResourceResponse.headers.get("location")!).searchParams.get("error"))
      .toBe("invalid_target");
    const allow = await send(authorizeUrl.pathname + authorizeUrl.search, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin,
        cookie: consent.headers.get("set-cookie")!.split(";")[0]! },
      body: new URLSearchParams({ csrf: csrf!, workspaceId: "workspace_one", decision: "allow" }),
    });
    expect(allow.status).toBe(302);
    const code = new URL(allow.headers.get("location")!).searchParams.get("code");
    expect(code).toBeTruthy();
    const token = await send("/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId,
        code: code!, redirect_uri: "https://host.example/callback", code_verifier: verifier,
        resource: `${origin}/mcp` }),
    });
    expect(token.status).toBe(200);
    const issued = await token.json() as { access_token: string; refresh_token: string; resource: string };
    expect(issued.resource).toBe(`${origin}/mcp`);
    const oauthRequest = new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${issued.access_token}` } });
    const oauthAccess = await handleMcpOAuth(event(oauthRequest, kv));
    expect(oauthAccess.status).not.toBe(401);
    const tokenKey = [...kv.values.keys()].find((key) => key.startsWith("token:"));
    expect(tokenKey).toBeTruthy();
    const tokenRecord = JSON.parse(kv.values.get(tokenKey!)!) as { expiresAt: number };
    kv.values.set(tokenKey!, JSON.stringify({ ...tokenRecord, expiresAt: 0 }));
    expect((await handleMcpOAuth(event(oauthRequest, kv))).status).toBe(401);
    kv.values.set(tokenKey!, JSON.stringify(tokenRecord));
    const refresh = (refreshToken: string, scope?: string) => send("/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId,
        refresh_token: refreshToken, resource: `${origin}/mcp`, ...(scope ? { scope } : {}) }),
    });
    const narrow = await refresh(issued.refresh_token, "tools:discover");
    expect(narrow.status).toBe(400);
    await expect(narrow.json()).resolves.toMatchObject({ error: "invalid_scope" });
    const renewed = await refresh(issued.refresh_token);
    expect(renewed.status).toBe(200);
    const renewedToken = await renewed.json() as { refresh_token: string };
    fixture.revoked = true;
    expect((await handleMcpOAuth(event(oauthRequest, kv))).status).toBe(401);
    const denied = await refresh(renewedToken.refresh_token);
    expect(denied.status).toBe(400);
    await expect(denied.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });

  it("uses a separate manual bearer grant for Streamable HTTP and stops after revocation", async () => {
    const handler = async (request: Request) => handleRemoteMcp(event(request));
    const missing = await handler(new Request(`${origin}/mcp`));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${credential}` } },
      fetch: async (request, init) => handler(new Request(request, init)),
    });
    const client = new Client({ name: "fixture-host", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("fixture.read");
      await expect(client.callTool({ name: "fixture.read", arguments: {} })).resolves.toMatchObject({
        structuredContent: { status: "succeeded", output: { workspaceId: "workspace_one" } },
      });
      expect(fixture.apiRequests.every((call) => call.workspaceId === "workspace_one" &&
        call.credential === `Bearer ${credential}`)).toBe(true);
      fixture.revoked = true;
      const after = fixture.apiRequests.length;
      await expect(client.listTools()).rejects.toThrow();
      expect(fixture.apiRequests).toHaveLength(after);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("rejects malformed, cross-origin, and disabled-configuration requests truthfully", async () => {
    const malformed = await handleRemoteMcp(event(new Request(`${origin}/mcp`, {
      headers: { authorization: "Bearer malformed" },
    })));
    expect(malformed.status).toBe(401);
    expect(await malformed.json()).toEqual({ error: "MCP_CREDENTIAL_INVALID" });
    const originDenied = await handleRemoteMcp(event(new Request(`${origin}/mcp`, {
      headers: { origin: "https://other.example", authorization: `Bearer ${credential}` },
    })));
    expect(originDenied.status).toBe(403);
    expect(await originDenied.json()).toEqual({ error: "MCP_ORIGIN_DENIED" });
    fixture.kind = "mcp_stdio";
    const wrongKind = await handleRemoteMcp(event(new Request(`${origin}/mcp`, {
      headers: { authorization: `Bearer ${credential}` },
    })));
    expect(wrongKind.status).toBe(403);
    expect(await wrongKind.json()).toEqual({ error: "MCP_CLIENT_KIND_DENIED" });
    const disabled = await handleMcpOAuth({ request: new Request(`${origin}/oauth/token`) } as never);
    expect(disabled.status).toBe(503);
    expect(fixture.apiRequests).toHaveLength(0);
  });

  it("requires a same-origin CSRF form to revoke an OAuth client", async () => {
    const kv = kvFixture();
    const manage = await handleMcpOAuth(event(new Request(`${origin}/oauth/manage`), kv));
    expect(manage.status).toBe(200);
    const csrf = (await manage.text()).match(/name="csrf" value="([a-f0-9]{64})"/)?.[1];
    expect(csrf).toBeTruthy();
    const form = new URLSearchParams({ csrf: csrf!, decision: "revoke", grantId: omrClientId });
    const headers = { "content-type": "application/x-www-form-urlencoded", origin,
      cookie: manage.headers.get("set-cookie")!.split(";")[0]! };
    const forged = await handleMcpOAuth(event(new Request(`${origin}/oauth/manage`, {
      method: "POST", headers: { ...headers, origin: "https://other.example" }, body: form,
    }), kv));
    expect(forged.status).toBe(403);
    expect(fixture.revoked).toBe(false);
    const missing = await handleMcpOAuth(event(new Request(`${origin}/oauth/manage`, {
      method: "POST", headers,
      body: new URLSearchParams({ csrf: csrf!, decision: "revoke",
        grantId: "client_22222222-2222-4222-8222-222222222222" }),
    }), kv));
    expect(missing.status).toBe(404);
    expect(fixture.revoked).toBe(false);
    const revoke = await handleMcpOAuth(event(new Request(`${origin}/oauth/manage`, {
      method: "POST", headers, body: form,
    }), kv));
    expect(revoke.status).toBe(302);
    expect(fixture.revoked).toBe(true);
  });

  it("keeps OAuth wiring behind staging configuration with a canonical resource origin", () => {
    const config = JSON.parse(readFileSync(new URL("../../../wrangler.jsonc", import.meta.url), "utf8")) as {
      env: { staging: { vars: { OMR_PUBLIC_ORIGIN: string }; kv_namespaces: Array<{ binding: string }>;
        hyperdrive: Array<{ binding: string }> } };
      kv_namespaces?: unknown;
    };
    expect(config.kv_namespaces).toBeUndefined();
    expect(config.env.staging.vars.OMR_PUBLIC_ORIGIN).toBe("https://omr-web-staging.21n.workers.dev");
    expect(config.env.staging.kv_namespaces.map((binding) => binding.binding)).toContain("OAUTH_KV");
    expect(config.env.staging.hyperdrive.map((binding) => binding.binding)).toContain("HYPERDRIVE");
  });
});
