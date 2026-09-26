import { describe, expect, it } from "vitest";
import { authorizationScopes, connectionActions, connectionStatusLabel, providerRevocationGuidance } from "./connection-ui.js";

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
    expect(providerRevocationGuidance("remote_revocation_unavailable", "oauth"))
      .toContain("Revoke it in your provider account");
    expect(providerRevocationGuidance("remote_revocation_unavailable", "api_key"))
      .toContain("Delete or rotate the API key");
    expect(providerRevocationGuidance("remote_revocation_unavailable", "api_key"))
      .not.toContain("grant");
    expect(providerRevocationGuidance("provider_connection_missing", null))
      .toContain("remaining access");
    expect(providerRevocationGuidance("provider_cleanup_requires_owner", "oauth"))
      .toContain("former member to revoke the OAuth grant");
    expect(providerRevocationGuidance("provider_cleanup_requires_owner", "api_key"))
      .toContain("former member to delete or rotate the API key");
    expect(providerRevocationGuidance("remote_revoke_failed", "oauth")).toBeNull();
    expect(connectionActions(team, "user_admin", "admin", "unconfigured").canSelect).toBe(false);
  });

  it("only offers a pending cleanup retry once the server claim is stale", () => {
    const pending = { ...team, status: "revoked", healthReason: "provider_cleanup_pending:claim", updatedAt: 1_000 };
    expect(connectionActions(pending, "user_admin", "admin", "ready", 61_000).canRetryRevoke).toBe(false);
    expect(connectionActions(pending, "user_admin", "admin", "ready", 61_001).canRetryRevoke).toBe(true);
    expect(connectionActions({ ...pending, updatedAt: 61_000 }, "user_admin", "admin", "ready", 61_001)
      .canRetryRevoke).toBe(false);
    expect(connectionActions(pending, "user_member", "member", "ready", 61_001).canRetryRevoke).toBe(false);
  });

  it("limits an orphaned personal account to owner/admin cleanup actions", () => {
    const orphan = { ...team, ownership: "personal" as const, ownerUserId: "former_member",
      cleanupOnly: true };
    expect(connectionActions(orphan, "user_admin", "admin", "ready")).toMatchObject({
      canSelect: false, canCheck: false, canRefresh: false, canReconnect: false,
      canDisconnect: true,
    });
    expect(connectionActions({ ...orphan, status: "revoked", healthReason: "provider_cleanup_requires_owner" },
      "user_admin", "admin", "ready").canRetryRevoke).toBe(false);
    expect(connectionActions(orphan, "user_member", "member", "ready")).toMatchObject({
      canSelect: false, canDisconnect: false,
    });
    expect(connectionStatusLabel(orphan, "ready")).toBe("cleanup required");
    expect(connectionStatusLabel({ ...orphan, status: "revoked" }, "ready")).toBe("disconnected");
  });

  it("shows both bot and user OAuth scopes before navigation", () => {
    expect(authorizationScopes("https://slack.example/oauth?scope=chat%3Awrite%2Cusers%3Aread&user_scope=search%3Aread%2Cusers%3Aread"))
      .toEqual(["chat:write", "users:read", "search:read"]);
  });
});
