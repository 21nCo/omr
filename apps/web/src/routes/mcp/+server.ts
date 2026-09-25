import type { RequestHandler } from "./$types";

import { handleRemoteMcp } from "$lib/server/mcp-http.js";
import { handleMcpOAuth } from "$lib/server/mcp-oauth.js";

const handle: RequestHandler = (event) => {
  const env = event.platform?.env as { OAUTH_KV?: unknown; OMR_PUBLIC_ORIGIN?: unknown } | undefined;
  return /^Bearer omr_[a-f0-9]{64}$/.test(event.request.headers.get("authorization") ?? "") ||
      !env?.OAUTH_KV || typeof env.OMR_PUBLIC_ORIGIN !== "string"
    ? handleRemoteMcp(event)
    : handleMcpOAuth(event);
};

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
