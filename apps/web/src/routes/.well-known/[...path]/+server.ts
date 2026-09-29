import type { RequestHandler } from "./$types";
import { handleMcpOAuth } from "$lib/server/mcp-oauth.js";
import { mcpBrowserOriginDenied, mcpCorsResponse, mcpPreflight } from "$lib/server/mcp-browser-origin.js";

export const GET: RequestHandler = async (event) => {
  if (mcpBrowserOriginDenied(event)) return new Response(null, { status: 403 });
  return mcpCorsResponse(event, await handleMcpOAuth(event));
};
export const OPTIONS: RequestHandler = mcpPreflight;
