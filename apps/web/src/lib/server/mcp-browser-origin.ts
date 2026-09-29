import type { RequestEvent } from "@sveltejs/kit";

/** Browser access is opt-in by exact HTTPS origin in the staging Worker. */
export function allowedMcpBrowserOrigin(event: RequestEvent): string | null {
  const requestOrigin = event.request.headers.get("origin");
  if (!requestOrigin) return null;
  const publicOrigin = new URL(event.request.url).origin;
  if (requestOrigin === publicOrigin) return requestOrigin;
  const configured = (event.platform?.env as { OMR_MCP_BROWSER_ORIGINS?: unknown } | undefined)
    ?.OMR_MCP_BROWSER_ORIGINS;
  if (typeof configured !== "string") return null;
  const origins = configured.split(",").map((origin) => origin.trim());
  try {
    const parsed = new URL(requestOrigin);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password &&
      parsed.origin === requestOrigin && origins.includes(requestOrigin) ? requestOrigin : null;
  } catch {
    return null;
  }
}

export function mcpBrowserOriginDenied(event: RequestEvent): boolean {
  return event.request.headers.has("origin") && !allowedMcpBrowserOrigin(event);
}

export function mcpCorsResponse(event: RequestEvent, response: Response): Response {
  const headers = new Headers(response.headers);
  // The OAuth library reflects any Origin. Publish CORS only for configured hosts.
  for (const name of ["access-control-allow-origin", "access-control-allow-methods",
    "access-control-allow-headers", "access-control-expose-headers", "access-control-max-age"]) {
    headers.delete(name);
  }
  const origin = allowedMcpBrowserOrigin(event);
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", headers.has("vary") ? `${headers.get("vary")}, Origin` : "Origin");
    headers.set("access-control-allow-methods", new URL(event.request.url).pathname === "/mcp"
      ? "GET, POST, DELETE, OPTIONS" : "POST, OPTIONS");
    headers.set("access-control-allow-headers", "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID");
    headers.set("access-control-expose-headers", "WWW-Authenticate, Mcp-Session-Id");
    headers.set("access-control-max-age", "600");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function mcpPreflight(event: RequestEvent): Response {
  if (mcpBrowserOriginDenied(event)) return new Response(null, { status: 403 });
  const method = event.request.headers.get("access-control-request-method");
  const path = new URL(event.request.url).pathname;
  const methods = path === "/mcp" ? ["GET", "POST", "DELETE"] :
    path === "/oauth/token" || path === "/oauth/register" ? ["POST"] : [];
  if (!method || !methods.includes(method)) return new Response(null, { status: 405 });
  const requested = event.request.headers.get("access-control-request-headers");
  if (requested && requested.split(",").some((header) => ![
    "authorization", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id",
  ].includes(header.trim().toLowerCase()))) return new Response(null, { status: 403 });
  return mcpCorsResponse(event, new Response(null, { status: 204 }));
}
