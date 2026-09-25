import type { RequestHandler } from "./$types";
import { handleMcpOAuth } from "$lib/server/mcp-oauth.js";

export const GET: RequestHandler = handleMcpOAuth;
