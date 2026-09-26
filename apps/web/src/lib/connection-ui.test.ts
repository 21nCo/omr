import { describe, expect, it } from "vitest";
import { authorizationScopes, connectionActions, providerRevocationGuidance } from "./connection-ui.js";

const team = { id: "connection_1", provider: "slack", ownership: "workspace" as const,
  ownerUserId: null, status: "active", readiness: "ready", selected: false };

describe("connection control UI policy", () => {
  it("allows members to select and probe team accounts but reserves lifecycle mutations for admins", () => {
    expect(connectionActions(team, "user_member", "member", "ready")).toMatchObject({
      canSelect: true, canCheck: true, canRefresh: false, canDisconnect: false,
    });
    expect(connectionActions(team, "user_admin", "admin", "ready")).toMatchObject({
      canRefresh: true, canDisconnect: true,
    });
    expect(connectionActions({ ...team, ownership: "personal", ownerUserId: "user_other" },
      "user_admin", "admin", "ready").manageable).toBe(false);
  });

  it("hides selection for expired, revoked, and unconfigured bindings", () => {
    expect(connectionActions({ ...team, readiness: "unavailable" }, "user_admin", "admin", "expired"))
      .toMatchObject({ canSelect: false, canReconnect: true });
    expect(connectionActions({ ...team, status: "revoked", healthReason: "remote_revoke_failed" }, "user_admin", "admin", "ready"))
      .toMatchObject({ canSelect: false, canCheck: false, canRetryRevoke: true });
    expect(connectionActions({ ...team, status: "revoked", healthReason: "remote_revocation_unavailable" },
      "user_admin", "admin", "ready").canRetryRevoke).toBe(false);
    expect(providerRevocationGuidance("remote_revocation_unavailable"))
      .toContain("Revoke it in your provider account");
    expect(providerRevocationGuidance("remote_revoke_failed")).toBeNull();
    expect(connectionActions(team, "user_admin", "admin", "unconfigured").canSelect).toBe(false);
  });

  it("shows both bot and user OAuth scopes before navigation", () => {
    expect(authorizationScopes("https://slack.example/oauth?scope=chat%3Awrite%2Cusers%3Aread&user_scope=search%3Aread%2Cusers%3Aread"))
      .toEqual(["chat:write", "users:read", "search:read"]);
  });
});
