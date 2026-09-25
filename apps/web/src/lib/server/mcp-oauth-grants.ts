import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

export const OMR_OAUTH_GRANT_KIND = "omr-mcp-remote-v1";

export function oauthGrantFamily(request: Pick<AuthRequest, "clientId" | "redirectUri">): string {
  const cimd = /^https:\/\/[^/?#]+\//i.test(request.clientId);
  return cimd
    ? JSON.stringify([request.clientId, request.redirectUri])
    : JSON.stringify([request.clientId]);
}

/** The pinned Workers OAuth provider encodes its grant ID in an authorization code. */
export function oauthGrantIdFromRedirect(redirectTo: string, userId: string): string | null {
  const code = new URL(redirectTo).searchParams.get("code");
  if (!code?.startsWith(`${userId}:`)) return null;
  const parts = code.slice(userId.length + 1).split(":");
  return parts.length === 2 && /^[A-Za-z0-9_-]{16}$/.test(parts[0] ?? "") &&
    /^[A-Za-z0-9_-]{32}$/.test(parts[1] ?? "") ? parts[0]! : null;
}
