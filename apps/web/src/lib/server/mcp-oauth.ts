import type { RequestEvent } from "@sveltejs/kit";
import type { ExecutionContext, KVNamespace } from "@cloudflare/workers-types";
import type {
  AuthorizationError,
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { CLIENT_CAPABILITIES } from "@oh-my-router/client-access";
import { connectPostgresClientAccess } from "@oh-my-router/client-access/postgres";
import { connectPostgresIdentityRuntime } from "@oh-my-router/identity/postgres";

import { databaseConnectionString } from "./cloudflare-runtime.js";
import { handleRemoteMcp } from "./mcp-http.js";
import {
  oauthTokenMatchesGrant,
  requestedOAuthCapabilities,
  type OAuthGrantProps,
} from "./mcp-oauth-policy.js";
import { createOAuthCsrfToken, oauthCsrfCookie, validOAuthCsrf } from "./mcp-oauth-csrf.js";
import { oauthGrantFamily, oauthGrantIdFromRedirect, OMR_OAUTH_GRANT_KIND } from "./mcp-oauth-grants.js";

type OAuthBindings = Cloudflare.Env & {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  OMR_PUBLIC_ORIGIN?: string;
};

const CONSENT_CSRF_COOKIE = "__Host-omr-oauth-consent";
const MANAGE_CSRF_COOKIE = "__Host-omr-oauth-manage";

function html(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function page(content: string, status = 200, cookie?: string): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
  });
  if (cookie) headers.set("set-cookie", cookie);
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize OMR MCP</title><style>body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem;line-height:1.5}button,select{font:inherit;padding:.5rem}fieldset{margin:1rem 0}button{cursor:pointer}</style><main>${content}</main></html>`, {
    status,
    headers,
  });
}

function redirectWithCookie(url: string, name: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: url,
      "cache-control": "no-store",
      "set-cookie": oauthCsrfCookie(name, "", 0),
    },
  });
}

function oauthError(error: AuthorizationError): Response {
  if (!error.redirectUri) return page(`<h1>Authorization unavailable</h1><p>${html(error.description)}</p>`, 400);
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect, 302);
}

function deny(request: AuthRequest): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", "access_denied");
  if (request.state) redirect.searchParams.set("state", request.state);
  if (request.issuer) redirect.searchParams.set("iss", request.issuer);
  return Response.redirect(redirect, 302);
}

async function authorize(request: Request, env: OAuthBindings, event: RequestEvent): Promise<Response> {
  const { AuthorizationError } = await import("@cloudflare/workers-oauth-provider");
  if (request.method !== "GET" && request.method !== "POST") return new Response(null, { status: 405 });
  if (request.method === "POST" && request.headers.get("origin") !== env.OMR_PUBLIC_ORIGIN) {
    return page("<h1>Request origin denied</h1>", 403);
  }
  let authRequest: AuthRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(new Request(request.url));
  } catch (error) {
    if (error instanceof AuthorizationError) return oauthError(error);
    throw error;
  }
  if (!authRequest.codeChallenge || authRequest.codeChallengeMethod !== "S256") {
    return page("<h1>PKCE is required</h1>", 400);
  }
  if (authRequest.responseType !== "code") return page("<h1>Authorization code flow is required</h1>", 400);
  const requestedScopes = requestedOAuthCapabilities(authRequest.scope);
  if (!requestedScopes) {
    return page("<h1>Unsupported capabilities</h1><p>Request tools:discover and only OMR capabilities.</p>", 400);
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (!client) return page("<h1>Unknown OAuth client</h1>", 400);

  const identity = await connectPostgresIdentityRuntime({
    connectionString: databaseConnectionString(event),
    environment: { resolve: () => ({ issuer: env.OMR_PUBLIC_ORIGIN!, baseUrl: env.OMR_PUBLIC_ORIGIN! }) },
  });
  let userId: string;
  let workspaces: Awaited<ReturnType<typeof identity.workspaces.listWorkspaceAccess>>;
  try {
    try {
      userId = (await identity.requireSession(request)).actorId;
    } catch (error) {
      if (error instanceof Error && error.name === "AuthFnUnauthenticatedError") {
        const returnTo = new URL(request.url);
        return Response.redirect(`${env.OMR_PUBLIC_ORIGIN}/login?returnTo=${encodeURIComponent(returnTo.pathname + returnTo.search)}`, 302);
      }
      throw error;
    }
    workspaces = await identity.workspaces.listWorkspaceAccess(userId);
  } finally {
    await identity.close();
  }

  if (request.method === "GET") {
    const csrf = createOAuthCsrfToken();
    const options = workspaces.map(({ workspace }) =>
      `<option value="${html(workspace.id)}">${html(workspace.name)} (${html(workspace.kind)})</option>`,
    ).join("");
    return page(`<h1>Connect ${html(client.clientName ?? "an MCP client")} to OMR?</h1><p>The client supplies this name; OMR has not verified it. After approval, you will return to <code>${html(authRequest.redirectUri)}</code>.</p><p>Choose the workspace this client may access. It requests:</p><ul>${requestedScopes.map((scope) => `<li>${html(scope)}</li>`).join("")}</ul><form method="post"><input type="hidden" name="csrf" value="${csrf}"><fieldset><legend>Workspace</legend><select name="workspaceId" required><option value="" selected disabled>Choose a workspace</option>${options}</select></fieldset><button name="decision" value="allow">Allow access</button> <button name="decision" value="deny" formnovalidate>Deny</button></form>`, 200, oauthCsrfCookie(CONSENT_CSRF_COOKIE, csrf));
  }

  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return page("<h1>Invalid form</h1>", 400);
  }
  const body = await request.text();
  if (body.length > 8192) return page("<h1>Form too large</h1>", 413);
  const form = new URLSearchParams(body);
  if (!validOAuthCsrf(request, CONSENT_CSRF_COOKIE, form.get("csrf"))) {
    return page("<h1>Consent form expired</h1><p>Return to the client and try again.</p>", 403);
  }
  if (form.get("decision") === "deny") {
    return redirectWithCookie(deny(authRequest).headers.get("location")!, CONSENT_CSRF_COOKIE);
  }
  if (form.get("decision") !== "allow") return page("<h1>Invalid decision</h1>", 400);
  const workspaceId = form.get("workspaceId");
  if (!workspaceId || !workspaces.some(({ workspace }) => workspace.id === workspaceId)) {
    return page("<h1>Workspace access denied</h1>", 403);
  }

  const access = await connectPostgresClientAccess({ connectionString: databaseConnectionString(event) });
  let clientId: string | undefined;
  let pendingOAuthGrantId: string | undefined;
  try {
    const omrClient = await access.clients.registerClient({
      actorUserId: userId,
      workspaceId,
      kind: "mcp_remote",
      name: `OAuth: ${(client.clientName ?? "MCP client").slice(0, 110)}`,
    });
    clientId = omrClient.id;
    const { credential } = await access.clients.issueGrant({
      actorUserId: userId,
      clientId,
      workspaceId,
      capabilities: requestedScopes,
      ttlMs: 30 * 24 * 60 * 60 * 1000,
    });
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: authRequest,
      userId,
      scope: requestedScopes,
      revokeExistingGrants: false,
      metadata: {
        kind: OMR_OAUTH_GRANT_KIND,
        omrClientId: clientId,
        clientName: client.clientName ?? "MCP client",
        workspaceId,
      },
      props: { omrCredential: credential, workspaceId, userId, scopes: requestedScopes } satisfies OAuthGrantProps,
    });
    const oauthGrantId = oauthGrantIdFromRedirect(redirectTo, userId);
    if (!oauthGrantId) throw new Error("OAuth provider grant ID unavailable");
    pendingOAuthGrantId = oauthGrantId;
    const replacedGrants = await access.oauthGrants.activate({
      omrClientId: clientId,
      userId,
      oauthClientId: authRequest.clientId,
      redirectUri: authRequest.redirectUri,
      familyKey: oauthGrantFamily(authRequest),
      oauthGrantId,
      clientName: client.clientName ?? "MCP client",
      workspaceId,
      scopes: requestedScopes,
    });
    pendingOAuthGrantId = undefined;
    const results = await Promise.allSettled(
      replacedGrants.map((id) => env.OAUTH_PROVIDER.revokeGrant(id, userId)),
    );
    const failures = results.filter((result) => result.status === "rejected").length;
    if (failures > 0) {
      console.error(JSON.stringify({ service: "omr-mcp-oauth", event: "old_provider_grant_revoke_failed", count: failures }));
    }
    return redirectWithCookie(redirectTo, CONSENT_CSRF_COOKIE);
  } catch (error) {
    if (pendingOAuthGrantId) {
      await env.OAUTH_PROVIDER.revokeGrant(pendingOAuthGrantId, userId).catch(() => undefined);
    }
    if (clientId) await access.clients.revokeClient(userId, clientId).catch(() => undefined);
    throw error;
  } finally {
    await access.close();
  }
}

async function manage(request: Request, env: OAuthBindings, event: RequestEvent): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return new Response(null, { status: 405 });
  if (request.method === "POST" && request.headers.get("origin") !== env.OMR_PUBLIC_ORIGIN) {
    return page("<h1>Request origin denied</h1>", 403);
  }
  const identity = await connectPostgresIdentityRuntime({
    connectionString: databaseConnectionString(event),
    environment: { resolve: () => ({ issuer: env.OMR_PUBLIC_ORIGIN!, baseUrl: env.OMR_PUBLIC_ORIGIN! }) },
  });
  let userId: string;
  try {
    try {
      userId = (await identity.requireSession(request)).actorId;
    } catch (error) {
      if (error instanceof Error && error.name === "AuthFnUnauthenticatedError") {
        return request.method === "GET"
          ? Response.redirect(`${env.OMR_PUBLIC_ORIGIN}/login?returnTo=%2Foauth%2Fmanage`, 302)
          : page("<h1>Sign in required</h1>", 401);
      }
      throw error;
    }
  } finally {
    await identity.close();
  }

  if (request.method === "GET") {
    const access = await connectPostgresClientAccess({ connectionString: databaseConnectionString(event) });
    let grants: Awaited<ReturnType<typeof access.oauthGrants.listActive>>;
    try {
      grants = await access.oauthGrants.listActive(userId);
    } finally {
      await access.close();
    }
    const csrf = createOAuthCsrfToken();
    const rows = grants.map((grant) => `<article><h2>${html(grant.clientName)}</h2><p>Workspace: <code>${html(grant.workspaceId)}</code><br>Client: <code>${html(grant.oauthClientId)}</code><br>Capabilities: ${grant.scopes.map(html).join(", ")}<br>Authorized: ${html(new Date(grant.createdAt).toISOString())}</p><form method="post"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="grantId" value="${html(grant.omrClientId)}"><button name="decision" value="revoke">Revoke access</button></form></article>`).join("");
    return page(`<p><a href="/app">← Control plane</a></p><h1>My remote MCP access</h1><p>Revoking a connection stops its MCP requests immediately, including refreshed tokens.</p>${rows || "<p>No active OAuth MCP grants.</p>"}`, 200, oauthCsrfCookie(MANAGE_CSRF_COOKIE, csrf));
  }

  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return page("<h1>Invalid form</h1>", 400);
  }
  const body = await request.text();
  if (body.length > 8192) return page("<h1>Form too large</h1>", 413);
  const form = new URLSearchParams(body);
  if (!validOAuthCsrf(request, MANAGE_CSRF_COOKIE, form.get("csrf"))) {
    return page("<h1>Management form expired</h1>", 403);
  }
  if (form.get("decision") !== "revoke") return page("<h1>Invalid decision</h1>", 400);
  const omrClientId = form.get("grantId");
  if (!omrClientId || !/^client_[a-f0-9-]{36}$/.test(omrClientId)) return page("<h1>Grant not found</h1>", 404);

  const access = await connectPostgresClientAccess({ connectionString: databaseConnectionString(event) });
  let oauthGrantId: string;
  try {
    oauthGrantId = await access.oauthGrants.revoke(userId, omrClientId);
  } finally {
    await access.close();
  }
  try {
    await env.OAUTH_PROVIDER.revokeGrant(oauthGrantId, userId);
  } catch (error) {
    console.error(JSON.stringify({ service: "omr-mcp-oauth", event: "provider_grant_revoke_failed", error: error instanceof Error ? error.name : "UnknownError" }));
  }
  return redirectWithCookie(`${env.OMR_PUBLIC_ORIGIN}/oauth/manage`, MANAGE_CSRF_COOKIE);
}

export async function handleMcpOAuth(event: RequestEvent): Promise<Response> {
  const env = event.platform?.env as OAuthBindings | undefined;
  const origin = env?.OMR_PUBLIC_ORIGIN;
  if (!origin || !env?.OAUTH_KV || !event.platform?.ctx || new URL(event.request.url).origin !== origin) {
    return new Response("OAuth is unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  }
  const { OAuthProvider } = await import("@cloudflare/workers-oauth-provider");
  const provider = new OAuthProvider<OAuthBindings>({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request: Request, providerEnv: OAuthBindings, ctx: ExecutionContext<unknown>) {
        const props = ctx.props;
        const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
        const token = bearer ? await providerEnv.OAUTH_PROVIDER.unwrapToken(bearer) : null;
        if (!token || !oauthTokenMatchesGrant(props, token.scope)) {
          return new Response("Forbidden", { status: 403, headers: { "cache-control": "no-store" } });
        }
        const headers = new Headers(request.headers);
        headers.set("authorization", `Bearer ${props.omrCredential}`);
        return handleRemoteMcp({ ...event, request: new Request(request, { headers }) });
      },
    },
    defaultHandler: {
      fetch(request: Request, providerEnv: OAuthBindings) {
        if (new URL(request.url).pathname === "/oauth/authorize") return authorize(request, providerEnv, event);
        if (new URL(request.url).pathname === "/oauth/manage") return manage(request, providerEnv, event);
        return new Response("Not found", { status: 404 });
      },
    },
    authorizeEndpoint: "/oauth/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [...CLIENT_CAPABILITIES],
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: ["tools:discover"],
    },
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 3600,
    clientRegistrationTTL: 30 * 24 * 3600,
  });
  try {
    const response = await provider.fetch(event.request, env, event.platform.ctx);
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    console.error(JSON.stringify({ service: "omr-mcp-oauth", event: "request_failed", error: error instanceof Error ? error.name : "UnknownError" }));
    return new Response("OAuth unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  }
}
