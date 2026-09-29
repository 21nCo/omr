import { describe, expect, it } from "vitest";

import { oauthRefreshMatchesGrant, oauthTokenMatchesGrant, requestedOAuthCapabilities } from "./mcp-oauth-policy.js";

const grant = {
  omrCredential: `omr_${"a".repeat(64)}`,
  workspaceId: "workspace_one",
  userId: "user_one",
  scopes: ["tools:discover", "tools:read"],
};

describe("MCP OAuth capability policy", () => {
  it("accepts only known capabilities with discovery and deduplicates them", () => {
    expect(requestedOAuthCapabilities(["tools:read", "tools:discover", "tools:read"]))
      .toEqual(["tools:read", "tools:discover"]);
    expect(requestedOAuthCapabilities(["tools:discover", "tools:read", "offline_access"]))
      .toEqual(["tools:discover", "tools:read"]);
    expect(requestedOAuthCapabilities(["tools:read"])).toBeNull();
    expect(requestedOAuthCapabilities(["tools:discover", "admin:all"])).toBeNull();
  });

  it("rejects downscoped or broadened tokens at the grant bridge", () => {
    expect(oauthTokenMatchesGrant(grant, ["tools:discover", "tools:read"])).toBe(true);
    expect(oauthTokenMatchesGrant(grant, ["tools:discover", "tools:read", "offline_access"])).toBe(true);
    expect(oauthTokenMatchesGrant(grant, ["tools:discover"])).toBe(false);
    expect(oauthTokenMatchesGrant(grant, ["tools:discover", "tools:read", "tools:write"])).toBe(false);
  });

  it("rejects malformed grant properties", () => {
    expect(oauthTokenMatchesGrant({ ...grant, omrCredential: "invalid" }, grant.scopes)).toBe(false);
    expect(oauthTokenMatchesGrant({ ...grant, workspaceId: "" }, grant.scopes)).toBe(false);
    expect(oauthTokenMatchesGrant({ ...grant, scopes: ["tools:discover", "admin:all"] }, grant.scopes)).toBe(false);
  });

  it("requires the refreshed token to retain the current user's workspace and capabilities", () => {
    const principal = {
      kind: "mcp_remote" as const, userId: "user_one", workspaceId: "workspace_one",
      clientId: "client_one", grantId: "grant_one",
      capabilities: ["tools:discover", "tools:read"] as const,
    };
    expect(oauthRefreshMatchesGrant(grant, grant.scopes, { ...principal, capabilities: [...principal.capabilities] })).toBe(true);
    expect(oauthRefreshMatchesGrant(grant, ["tools:discover"], { ...principal, capabilities: [...principal.capabilities] })).toBe(false);
    expect(oauthRefreshMatchesGrant(grant, grant.scopes, { ...principal, workspaceId: "workspace_two", capabilities: [...principal.capabilities] })).toBe(false);
    expect(oauthRefreshMatchesGrant(grant, grant.scopes, { ...principal, capabilities: ["tools:discover"] })).toBe(false);
  });
});
