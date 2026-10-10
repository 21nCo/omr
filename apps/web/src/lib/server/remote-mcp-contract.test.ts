import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryExecutionApprovalStore, MemoryExecutionReceiptStore } from "@oh-my-router/execution/testing";
import { ExecutionService, type ExecutionApproval } from "@oh-my-router/execution";


const fixture = vi.hoisted(() => ({
  revoked: false,
  expired: false,
  kind: "mcp_remote" as "mcp_remote" | "mcp_stdio",
  capabilities: ["tools:discover", "tools:read", "tools:write", "approvals:create"] as string[],
  catalogTools: ["fixture.read", "fixture.write"] as string[],
  apiRequests: [] as Array<{ path: string; workspaceId: string | null; credential: string | null; toolId: unknown }>,
}));

const credential = `omr_${"a".repeat(64)}`;
const origin = "https://omr.example";
const omrClientId = "client_11111111-1111-4111-8111-111111111111";
const receipts = new MemoryExecutionReceiptStore(() => true);
const approvals = new MemoryExecutionApprovalStore(() => true, receipts);
const approvalService = new ExecutionService({} as never, {} as never, {} as never,
  receipts, async () => [], Date.now, approvals, undefined, new Uint8Array(32));
function seedApproval(id: string, workspaceId: string, grantId = "grant_one") {
  approvals.approvals.set(id, {
    id, workspaceId, actorUserId: "user_one", principalKey: `client:client_one:grant:${grantId}`,
    status: "approved", expiresAt: Date.now() + 60_000, updatedAt: Date.now(),
  } as ExecutionApproval);
}

vi.mock("@oh-my-router/client-access/postgres", () => ({
  connectPostgresClientAccess: async () => ({
    clients: {
      authenticate: async (value: string, requiredCapability?: string) => {
        if (value !== credential || fixture.revoked || fixture.expired) {
          const { InvalidClientCredentialError } = await import("@oh-my-router/client-access");
          throw new InvalidClientCredentialError();
        }
        if (requiredCapability && !fixture.capabilities.includes(requiredCapability)) {
          const { ClientCapabilityDeniedError } = await import("@oh-my-router/client-access");
          throw new ClientCapabilityDeniedError(requiredCapability as never);
        }
        return {
          kind: fixture.kind, userId: "user_one", workspaceId: "workspace_one",
          clientId: "client_one", grantId: "grant_one",
          capabilities: [...fixture.capabilities],
        };
      },
      registerClient: async () => ({ id: omrClientId }),
      issueGrant: async (input: { capabilities: string[] }) => {
        fixture.capabilities = [...input.capabilities];
        return { credential };
      },
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
  createRemoteMcpRouteServices: () => ({
    device: {}, connections: {}, tools: {}, execution: {}, controlPlane: {},
  }),
}));

vi.mock("./router.js", () => ({
  createOMRRouter: () => ({
    handle: async (request: Request) => {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.clone().json() as Record<string, unknown> : null;
      const workspaceId = url.searchParams.get("workspaceId") ??
        (typeof body?.workspaceId === "string" ? body.workspaceId : null);
      fixture.apiRequests.push({
        path: url.pathname, workspaceId,
        credential: request.headers.get("authorization"),
        toolId: body?.toolId,
      });
      if (request.headers.get("authorization") !== `Bearer ${credential}`)
        return Response.json({ error: "CLIENT_CREDENTIAL_INVALID" }, { status: 401 });
      if (workspaceId && workspaceId !== "workspace_one")
        return Response.json({ error: "WORKSPACE_ACCESS_DENIED" }, { status: 403 });
      const required = url.pathname === "/api/tools" ? "tools:discover" :
        url.pathname === "/api/tools/execute" ? "tools:read" :
        url.pathname === "/api/approvals" || url.pathname === "/api/approvals/execute" ? "approvals:create" :
        url.pathname === "/api/connections/list" ? "connections:read" : null;
      if (required && !fixture.capabilities.includes(required))
        return Response.json({ error: "CLIENT_CAPABILITY_DENIED", capability: required }, { status: 403 });
      if (url.pathname === "/api/tools") return Response.json({
        catalogSchemaVersion: "1.0.0", revision: "one", tools: [{
          catalogSchemaVersion: "1.0.0", id: "fixture.read", provider: "fixture",
          providerVersion: "1.0.0", action: "read", displayName: "Fixture read",
          description: "Read a fixture", hash: "fixture-hash",
          contract: { version: "1.0.0", effect: "read", requiredScopes: [], resources: [],
            sensitiveKeys: [], pagination: { kind: "none" }, retry: "safe" },
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          outputSchema: { type: "object" },
        }, {
          catalogSchemaVersion: "1.0.0", id: "fixture.write", provider: "fixture",
          providerVersion: "1.0.0", action: "write", displayName: "Fixture write",
          description: "Write a fixture", hash: "fixture-write-hash",
          contract: { version: "1.0.0", effect: "write", requiredScopes: [], resources: [],
            sensitiveKeys: [], pagination: { kind: "none" }, retry: "provider-key" },
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          outputSchema: { type: "object" },
        }].filter(({ id }) => fixture.catalogTools.includes(id)),
      });
      if (url.pathname === "/api/tools/execute") return Response.json({
        status: "succeeded", output: { workspaceId },
      });
      if (url.pathname === "/api/approvals") return Response.json({
        id: "approval_one", status: "pending", workspaceId: "workspace_one",
        toolId: body?.toolId, expiresAt: Date.now() + 60_000,
      }, { status: 201 });
      if (url.pathname === "/api/approvals/execute") {
        try {
          await approvalService.approvalStatus({ kind: "client", userId: "user_one",
            workspaceId: "workspace_one", clientId: "client_one", grantId: "grant_one",
            capabilities: fixture.capabilities as never }, String(body?.approvalId));
          await approvals.claim({ approvalId: String(body?.approvalId), actorUserId: "user_one",
            principalKey: "client:client_one:grant:grant_one", now: Date.now(),
            clock: Date.now,
            deadlineAt: Date.now() + 60_000 });
        } catch (error) {
          return Response.json({ error: (error as { code: string }).code }, { status: 409 });
        }
        return Response.json({ id: "receipt_one", status: "succeeded", workspaceId: "workspace_one",
          toolId: "fixture.write", result: { ok: true } });
      }
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    },
  }),
}));

import { handleRemoteMcp } from "./mcp-http.js";
import { handleMcpOAuth } from "./mcp-oauth.js";
import { mcpCorsResponse } from "./mcp-browser-origin.js";
import { GET as wellKnownGet, OPTIONS as wellKnownOptions } from "../../routes/.well-known/[...path]/+server.js";
import { GET as mcpGet, POST as mcpPost, OPTIONS as mcpOptions } from "../../routes/mcp/+server.js";
import { POST as oauthPost, OPTIONS as oauthOptions } from "../../routes/oauth/[...path]/+server.js";

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
      env: { OAUTH_KV: kv, OMR_PUBLIC_ORIGIN: origin, OMR_MCP_BROWSER_ORIGINS: "https://host.example" },
      ctx: { waitUntil() {}, passThroughOnException() {} },
    },
  } as never;
}

describe("remote-mcp-contract", () => {
  afterEach(() => {
    fixture.revoked = false;
    fixture.expired = false;
    fixture.kind = "mcp_remote";
    fixture.capabilities = ["tools:discover", "tools:read", "tools:write", "approvals:create"];
    fixture.catalogTools = ["fixture.read", "fixture.write"];
    fixture.apiRequests.length = 0;
    approvals.approvals.clear();
  });

  it("serves public OAuth discovery from routed well-known URLs without exposing private data", async () => {
    const kv = kvFixture();
    const resource = await wellKnownGet(event(new Request(`${origin}/.well-known/oauth-protected-resource/mcp`), kv));
    const authorization = await wellKnownGet(event(new Request(`${origin}/.well-known/oauth-authorization-server`), kv));
    const preflight = await wellKnownOptions(event(new Request(`${origin}/.well-known/oauth-protected-resource/mcp`, {
      method: "OPTIONS", headers: { origin: "https://host.example", "access-control-request-method": "GET" },
    }), kv));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://host.example");
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    const browserMetadata = await wellKnownGet(event(new Request(`${origin}/.well-known/oauth-authorization-server`, {
      headers: { origin: "https://host.example" },
    }), kv));
    expect(browserMetadata.status).toBe(200);
    expect(browserMetadata.headers.get("access-control-allow-origin")).toBe("https://host.example");
    const deniedMetadata = await wellKnownGet(event(new Request(`${origin}/.well-known/oauth-authorization-server`, {
      headers: { origin: "https://other.example" },
    }), kv));
    const deniedPreflight = await wellKnownOptions(event(new Request(`${origin}/.well-known/oauth-protected-resource/mcp`, {
      method: "OPTIONS", headers: { origin: "https://other.example", "access-control-request-method": "GET" },
    }), kv));
    expect(deniedMetadata.status).toBe(403);
    expect(deniedMetadata.headers.has("access-control-allow-origin")).toBe(false);
    expect(deniedPreflight.status).toBe(403);
    expect(deniedPreflight.headers.has("access-control-allow-origin")).toBe(false);
    const unsupportedPreflight = await wellKnownOptions(event(new Request(`${origin}/.well-known/oauth-authorization-server`, {
      method: "OPTIONS", headers: { origin: "https://host.example", "access-control-request-method": "POST" },
    }), kv));
    expect(unsupportedPreflight.status).toBe(405);
    expect(resource.status).toBe(200);
    expect(resource.headers.has("access-control-allow-origin")).toBe(false);
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
      scope: "tools:discover tools:read tools:write approvals:create offline_access", state: "host-state", resource: `${origin}/mcp`,
      code_challenge: challenge, code_challenge_method: "S256",
    })) authorizeUrl.searchParams.set(key, value);
    const consent = await send(authorizeUrl.pathname + authorizeUrl.search);
    expect(consent.status).toBe(200);
    const consentBody = await consent.text();
    expect(consentBody).toContain("<li>offline_access</li>");
    expect(consentBody).toContain("refresh its access");
    expect(consentBody).toContain("up to 30 days");
    const noRefreshUrl = new URL(authorizeUrl);
    noRefreshUrl.searchParams.set("scope", "tools:discover tools:read");
    const noRefreshConsent = await send(noRefreshUrl.pathname + noRefreshUrl.search);
    expect(noRefreshConsent.status).toBe(200);
    const noRefreshBody = await noRefreshConsent.text();
    expect(noRefreshBody).toContain("<li>tools:read</li>");
    expect(noRefreshBody).not.toContain("offline_access");
    expect(noRefreshBody).not.toContain("refresh its access");
    const noRefreshCsrf = noRefreshBody.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1];
    const noRefreshAllow = await send(noRefreshUrl.pathname + noRefreshUrl.search, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin,
        cookie: noRefreshConsent.headers.get("set-cookie")!.split(";")[0]! },
      body: new URLSearchParams({ csrf: noRefreshCsrf!, workspaceId: "workspace_one", decision: "allow" }),
    });
    expect(noRefreshAllow.status).toBe(302);
    const noRefreshCode = new URL(noRefreshAllow.headers.get("location")!).searchParams.get("code");
    const noRefreshToken = await send("/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId,
        code: noRefreshCode!, redirect_uri: "https://host.example/callback", code_verifier: verifier,
        resource: `${origin}/mcp` }),
    });
    expect(noRefreshToken.status).toBe(200);
    const shortLived = await noRefreshToken.json() as { access_token: string; refresh_token?: string };
    expect(shortLived.refresh_token).toBeUndefined();
    expect((await send("/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId,
        refresh_token: "absent", resource: `${origin}/mcp` }),
    })).status).toBe(400);
    const shortRequest = new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${shortLived.access_token}` } });
    expect((await handleMcpOAuth(event(shortRequest, kv))).status).toBe(406);
    const shortTokenKey = [...kv.values.keys()].find((key) => key.startsWith("token:"));
    expect(shortTokenKey).toBeTruthy();
    const shortTokenRecord = kv.values.get(shortTokenKey!)!;
    kv.values.set(shortTokenKey!, JSON.stringify({ ...JSON.parse(shortTokenRecord), expiresAt: 0 }));
    expect((await handleMcpOAuth(event(shortRequest, kv))).status).toBe(401);
    kv.values.set(shortTokenKey!, shortTokenRecord);
    fixture.revoked = true;
    expect((await handleMcpOAuth(event(shortRequest, kv))).status).toBe(401);
    fixture.revoked = false;
    const csrf = consentBody.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1];
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
    const challengeResponse = await mcpGet(event(new Request(`${origin}/mcp`), kv));
    expect(challengeResponse.status).toBe(401);
    expect(challengeResponse.headers.get("www-authenticate")).toContain('scope="tools:discover"');
    expect(challengeResponse.headers.get("www-authenticate")).not.toContain("tools:write");
    expect(challengeResponse.headers.get("www-authenticate")).not.toContain("approvals:create");
    const routedMcp = async (request: Request) => {
      const response = await mcpPost(event(request, kv));
      expect(response.headers.get("access-control-allow-origin")).toBe("https://host.example");
      return response;
    };
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${issued.access_token}`, origin: "https://host.example" } },
      fetch: async (request, init) => routedMcp(new Request(request, init)),
    });
    const client = new Client({ name: "oauth-host", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("fixture.read");
      await expect(client.callTool({ name: "fixture.read", arguments: {} })).resolves.toMatchObject({
        structuredContent: { status: "succeeded", output: { workspaceId: "workspace_one" } },
      });
      const requestedApproval = await client.callTool({ name: "fixture.write",
        arguments: { _omrIdempotencyKey: "same-intent" } });
      expect(requestedApproval.structuredContent).toMatchObject({
        status: "approval_required", approvalId: "approval_one", executed: false,
      });
      expect(fixture.apiRequests.some((call) => call.path === "/api/approvals")).toBe(true);
      seedApproval("approval_one", "workspace_one");
      const receipt = await client.callTool({ name: "omr.approvals.execute",
        arguments: { approvalId: "approval_one" } });
      expect(receipt.structuredContent).toMatchObject({ id: "receipt_one", status: "succeeded" });
      fixture.capabilities = ["tools:discover", "tools:read"];
      const deniedApproval = await client.callTool({ name: "fixture.write",
        arguments: { _omrIdempotencyKey: "new-intent" } });
      expect(deniedApproval.isError).toBe(true);
      fixture.capabilities = ["tools:discover", "tools:read", "tools:write", "approvals:create"];
      expect(fixture.apiRequests.some((call) => call.path === "/api/tools/execute" &&
        call.workspaceId !== "workspace_one")).toBe(false);
      expect(fixture.apiRequests.some((call) => call.path === "/api/tools/execute" &&
        call.toolId === "fixture.write")).toBe(false);
    } finally {
      await client.close().catch(() => undefined);
    }
    const oauthRequest = new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${issued.access_token}` } });
    const oauthAccess = await handleMcpOAuth(event(oauthRequest, kv));
    expect(oauthAccess.status).not.toBe(401);
    const tokenKey = [...kv.values.keys()].filter((key) => key.startsWith("token:")).at(-1);
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
    const legacyGrantKey = `grant:${issued.refresh_token.split(":").slice(0, 2).join(":")}`;
    const currentGrant = kv.values.get(legacyGrantKey);
    expect(currentGrant).toBeTruthy();
    const legacyGrant = JSON.parse(currentGrant!) as { scope: string[] };
    const legacyRecord = JSON.stringify({ ...legacyGrant,
      scope: legacyGrant.scope.filter((scope) => scope !== "offline_access") });
    kv.values.set(legacyGrantKey, legacyRecord);
    const legacyRefresh = await refresh(issued.refresh_token);
    expect(legacyRefresh.status).toBe(400);
    await expect(legacyRefresh.json()).resolves.toMatchObject({ error: "invalid_grant" });
    expect(kv.values.get(legacyGrantKey)).toBe(legacyRecord);
    kv.values.set(legacyGrantKey, currentGrant!);
    const narrow = await refresh(issued.refresh_token, "tools:discover");
    expect(narrow.status).toBe(400);
    await expect(narrow.json()).resolves.toMatchObject({ error: "invalid_scope" });
    const renewed = await refresh(issued.refresh_token);
    expect(renewed.status).toBe(200);
    const renewedToken = await renewed.json() as { refresh_token: string };
    fixture.capabilities = ["tools:read", "tools:write", "approvals:create"];
    const lostDiscovery = await refresh(renewedToken.refresh_token);
    expect(lostDiscovery.status).toBe(400);
    await expect(lostDiscovery.json()).resolves.toMatchObject({ error: "invalid_grant" });
    fixture.capabilities = ["tools:discover", "tools:write", "approvals:create"];
    const lostRead = await refresh(renewedToken.refresh_token);
    expect(lostRead.status).toBe(400);
    await expect(lostRead.json()).resolves.toMatchObject({ error: "invalid_grant" });
    fixture.capabilities = ["tools:discover", "tools:read", "tools:write", "approvals:create"];
    fixture.expired = true;
    const expired = await refresh(renewedToken.refresh_token);
    expect(expired.status).toBe(400);
    await expect(expired.json()).resolves.toMatchObject({ error: "invalid_grant" });
    fixture.expired = false;
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

  it("invalidates a remote host's cached tool list across routed HTTP requests", async () => {
    fixture.catalogTools = ["fixture.read"];
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${credential}` } },
      fetch: async (request, init) => handleRemoteMcp(event(new Request(request, init))),
    });
    const client = new Client({ name: "caching-host", version: "1.0.0" }, { capabilities: {} });
    const notifications: string[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notifications.push("changed"); });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(({ name }) => name)).toContain("fixture.read");
      fixture.catalogTools = ["fixture.read", "fixture.write"];
      const added = await client.callTool({ name: "omr.catalog.refresh", arguments: {} });
      expect(added.structuredContent).toMatchObject({ relistRequired: true, tools: 2 });
      expect(notifications).toEqual(["changed"]);
      expect((await client.listTools()).tools.map(({ name }) => name)).toContain("fixture.write");
      fixture.catalogTools = ["fixture.write"];
      await client.callTool({ name: "omr.catalog.refresh", arguments: {} });
      expect(notifications).toEqual(["changed", "changed"]);
      expect((await client.listTools()).tools.map(({ name }) => name)).not.toContain("fixture.read");
      await expect(client.callTool({ name: "fixture.read", arguments: {} })).rejects.toThrow(/not found/);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("routes browser preflight and authenticated MCP POST only for configured origins", async () => {
    const kv = kvFixture();
    const browser = "https://host.example";
    const preflight = (url: string, method: string, headers: string) => new Request(url, {
      method: "OPTIONS", headers: { origin: browser, "access-control-request-method": method,
        "access-control-request-headers": headers },
    });
    const mcp = await mcpOptions(event(preflight(`${origin}/mcp`, "POST", "authorization, content-type"), kv));
    const token = await oauthOptions(event(preflight(`${origin}/oauth/token`, "POST", "content-type"), kv));
    expect(mcp.status).toBe(204);
    expect(token.status).toBe(204);
    expect(mcp.headers.get("access-control-allow-origin")).toBe(browser);
    expect(token.headers.get("access-control-allow-origin")).toBe(browser);
    const registration = await oauthPost(event(new Request(`${origin}/oauth/register`, {
      method: "POST", headers: { origin: browser, "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Browser fixture", redirect_uris: [`${browser}/callback`],
        grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    }), kv));
    expect(registration.status).toBe(201);
    expect(registration.headers.get("access-control-allow-origin")).toBe(browser);
    const post = await mcpPost(event(new Request(`${origin}/mcp`, {
      method: "POST", headers: { origin: browser, authorization: `Bearer ${credential}`,
        "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }), kv));
    expect(post.status).toBe(200);
    expect(post.headers.get("access-control-allow-origin")).toBe(browser);
    expect(fixture.apiRequests.some((call) => call.path === "/api/tools")).toBe(true);
    const denied = await mcpOptions(event(new Request(`${origin}/mcp`, {
      method: "OPTIONS", headers: { origin: "https://other.example", "access-control-request-method": "POST" },
    }), kv));
    expect(denied.status).toBe(403);
    expect(denied.headers.has("access-control-allow-origin")).toBe(false);
    const unsafeHeader = await mcpOptions(event(preflight(`${origin}/mcp`, "POST", "x-unsafe"), kv));
    expect(unsafeHeader.status).toBe(403);
    const forged = await oauthPost(event(new Request(`${origin}/oauth/token`, {
      method: "POST", headers: { origin: "https://other.example", "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token",
    }), kv));
    expect(forged.status).toBe(403);
  });

  it("exposes OAuth retry timing to allowed browser hosts without exposing it to other origins", async () => {
    const retry = () => new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
      status: 429, headers: { "Retry-After": "30",
        "Access-Control-Expose-Headers": "Retry-After, X-OAuth-Provider" },
    });
    const allowed = mcpCorsResponse(event(new Request(`${origin}/oauth/token`, {
      headers: { origin: "https://host.example" },
    })), retry());
    expect(allowed.status).toBe(429);
    expect(allowed.headers.get("retry-after")).toBe("30");
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://host.example");
    expect(allowed.headers.get("access-control-expose-headers")?.split(/,\s*/))
      .toEqual(expect.arrayContaining(["Retry-After", "X-OAuth-Provider", "WWW-Authenticate"]));
    const denied = mcpCorsResponse(event(new Request(`${origin}/oauth/token`, {
      headers: { origin: "https://other.example" },
    })), retry());
    expect(denied.headers.has("access-control-allow-origin")).toBe(false);
    expect(denied.headers.has("access-control-expose-headers")).toBe(false);
  });

  it("keeps MCP grants workspace-bound and checks capabilities and expiry on later calls", async () => {
    seedApproval("approval_workspace_two", "workspace_two");
    seedApproval("approval_same_workspace", "workspace_one");
    const handler = async (request: Request) => handleRemoteMcp(event(request));
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${credential}` } },
      fetch: async (request, init) => handler(new Request(request, init)),
    });
    const client = new Client({ name: "scoped-host", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const sameWorkspace = await client.callTool({ name: "omr.approvals.execute",
        arguments: { approvalId: "approval_same_workspace" } });
      expect(sameWorkspace.structuredContent).toMatchObject({ id: "receipt_one", status: "succeeded" });
      const foreign = await client.callTool({ name: "omr.approvals.execute",
        arguments: { approvalId: "approval_workspace_two" } });
      expect(foreign).toMatchObject({ isError: true, structuredContent: {
        error: { details: { error: "APPROVAL_UNAVAILABLE" } },
      } });
      expect(approvals.approvals.get("approval_workspace_two")?.status).toBe("approved");
      expect(fixture.apiRequests.at(-1)?.path).toBe("/api/approvals/execute");
      fixture.capabilities = ["tools:discover", "tools:read"];
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("fixture.read");
      const selectedRead = await client.callTool({ name: "fixture.read", arguments: {} });
      expect(selectedRead.structuredContent).toMatchObject({ status: "succeeded" });
      const selectedWrite = await client.callTool({ name: "fixture.write",
        arguments: { _omrIdempotencyKey: "read-only" } });
      expect(selectedWrite.isError).toBe(true);
      seedApproval("approval_read_only", "workspace_one");
      const selectedReceipt = await client.callTool({ name: "omr.approvals.execute",
        arguments: { approvalId: "approval_read_only" } });
      expect(selectedReceipt.isError).toBe(true);
      expect(approvals.approvals.get("approval_read_only")?.status).toBe("approved");
      fixture.capabilities = ["tools:discover"];
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("fixture.read");
      const deniedRead = await client.callTool({ name: "fixture.read", arguments: {} });
      expect(deniedRead.isError).toBe(true);
      expect(fixture.apiRequests.at(-1)?.path).toBe("/api/tools/execute");
      const deniedApproval = await client.callTool({ name: "fixture.write",
        arguments: { _omrIdempotencyKey: "narrowed" } });
      expect(deniedApproval.isError).toBe(true);
      seedApproval("approval_narrowed", "workspace_one");
      const deniedReceipt = await client.callTool({ name: "omr.approvals.execute",
        arguments: { approvalId: "approval_narrowed" } });
      expect(deniedReceipt.isError).toBe(true);
      expect(approvals.approvals.get("approval_narrowed")?.status).toBe("approved");
      fixture.capabilities = ["tools:read"];
      await expect(client.listTools()).rejects.toThrow();
      fixture.capabilities = ["tools:discover", "tools:read", "tools:write", "approvals:create"];
      const calls = [
        { method: "tools/list", params: {} },
        { method: "tools/call", params: { name: "fixture.read", arguments: {} } },
        { method: "tools/call", params: { name: "fixture.write", arguments: { _omrIdempotencyKey: "late" } } },
        { method: "tools/call", params: { name: "omr.approvals.execute", arguments: { approvalId: "approval_narrowed" } } },
      ];
      for (const state of ["expired", "revoked"] as const) {
        fixture[state] = true;
        const count = fixture.apiRequests.length;
        for (const [index, call] of calls.entries()) {
          const denied = await handler(new Request(`${origin}/mcp`, {
            method: "POST", headers: { authorization: `Bearer ${credential}`,
              "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...call }),
          }));
          expect(denied.status, `${state}: ${JSON.stringify(call)}`).toBe(401);
        }
        expect(fixture.apiRequests).toHaveLength(count);
        fixture[state] = false;
      }
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

  it("wraps long OAuth identifiers so consent and management pages fit a 375px screen", async () => {
    const manage = await handleMcpOAuth(event(new Request(`${origin}/oauth/manage`), kvFixture()));
    expect(manage.status).toBe(200);
    const body = await manage.text();
    expect(body).toMatch(/Workspace: <code>workspace_[^<]+<\/code>/);
    expect(body).toMatch(/<style>[^<]*code\{overflow-wrap:anywhere\}/);
    // A fieldset defaults to min-content width, which would let the workspace select overflow.
    expect(body).toMatch(/<style>[^<]*select\{max-width:100%\}/);
    expect(body).toMatch(/<style>[^<]*fieldset\{[^}]*min-width:0/);
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
      env: { staging: { vars: { OMR_PUBLIC_ORIGIN: string; OMR_MCP_BROWSER_ORIGINS: string }; kv_namespaces: Array<{ binding: string }>;
        hyperdrive: Array<{ binding: string }> } };
      kv_namespaces?: unknown;
    };
    expect(config.kv_namespaces).toBeUndefined();
    expect(config.env.staging.vars.OMR_PUBLIC_ORIGIN).toBe("https://omr-staging.21n.dev");
    expect(config.env.staging.vars.OMR_MCP_BROWSER_ORIGINS.split(",")).toContain("https://chatgpt.com");
    expect(config.env.staging.kv_namespaces.map((binding) => binding.binding)).toContain("OAUTH_KV");
    expect(config.env.staging.hyperdrive.map((binding) => binding.binding)).toContain("HYPERDRIVE");
  });

  it("disables OAuth discovery and token routes when the documented staging rollback removes its bindings", async () => {
    const config = JSON.parse(readFileSync(new URL("../../../wrangler.jsonc", import.meta.url), "utf8")) as {
      env: { staging: { vars: Record<string, string>; kv_namespaces: Array<{ binding: string }> } };
    };
    const vars = { ...config.env.staging.vars, OMR_PUBLIC_ORIGIN: origin };
    const bindings = config.env.staging.kv_namespaces.filter(({ binding }) => binding !== "OAUTH_KV");
    expect(bindings.some(({ binding }) => binding === "OAUTH_KV")).toBe(false);
    const enabled = await wellKnownGet(event(new Request(`${origin}/.well-known/oauth-protected-resource/mcp`)));
    expect(enabled.status).toBe(200);
    const rolledBack = (request: Request) => ({
      request, platform: { env: { ...vars, ...(bindings.some(({ binding }) => binding === "OAUTH_KV")
        ? { OAUTH_KV: kvFixture() } : {}) }, ctx: { waitUntil() {}, passThroughOnException() {} } },
    }) as never;
    const metadata = await wellKnownGet(rolledBack(new Request(`${origin}/.well-known/oauth-protected-resource/mcp`)));
    const token = await oauthPost(rolledBack(new Request(`${origin}/oauth/token`, { method: "POST" })));
    const mcp = await mcpGet(rolledBack(new Request(`${origin}/mcp`)));
    expect(metadata.status).toBe(503);
    expect(token.status).toBe(503);
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toBe('Bearer realm="OMR MCP"');
  });
});
