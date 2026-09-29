import type { RequestHandler } from "./$types";

import { handleRemoteMcp } from "$lib/server/mcp-http.js";
import { handleMcpOAuth } from "$lib/server/mcp-oauth.js";
import { mcpBrowserOriginDenied, mcpCorsResponse, mcpPreflight } from "$lib/server/mcp-browser-origin.js";

const handle: RequestHandler = async (event) => {
  if (mcpBrowserOriginDenied(event)) return new Response(null, { status: 403 });
  const env = event.platform?.env as { OAUTH_KV?: unknown; OMR_PUBLIC_ORIGIN?: unknown } | undefined;
  const response = await (/^Bearer omr_[a-f0-9]{64}$/.test(event.request.headers.get("authorization") ?? "") ||
      !env?.OAUTH_KV || typeof env.OMR_PUBLIC_ORIGIN !== "string"
    ? handleRemoteMcp(event)
    : handleMcpOAuth(event));
  return mcpCorsResponse(event, response);
};

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS: RequestHandler = mcpPreflight;
