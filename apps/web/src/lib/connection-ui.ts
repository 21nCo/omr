export interface ConnectionDisplay {
  id: string;
  provider: string;
  ownership: "personal" | "workspace";
  ownerUserId: string | null;
  status: string;
  readiness: string;
  selected: boolean;
  healthReason?: string | null;
  updatedAt?: number;
  cleanupOnly?: boolean;
}

/** Explain terminal provider cleanup using the provider's authentication mode. */
export function providerRevocationGuidance(reason: string | null, authMode: string | null): string | null {
  if (reason === "provider_cleanup_requires_owner") {
    if (authMode === "api_key") return "OMR access was removed. Ask the former member to delete or rotate the API key in their provider account; an admin cannot revoke their personal key through OMR.";
    if (authMode === "oauth") return "OMR access was removed. Ask the former member to revoke the OAuth grant in their provider account; an admin cannot revoke their personal grant through OMR.";
    return "OMR access was removed. Ask the former member to remove this connection in their provider account.";
  }
  if (reason !== "remote_revocation_unavailable" && reason !== "provider_connection_missing") return null;
  if (authMode === "api_key") {
    return "OMR access was removed. Delete or rotate the API key in your provider account; OMR no longer has the key to retry cleanup.";
  }
  if (authMode === "oauth") {
    return "OMR access was removed. The provider grant may still be active. Revoke it in your provider account; OMR no longer has the token to retry.";
  }
  return "OMR access was removed. Check your provider account for remaining access and revoke it there.";
}

/** Derive visible actions from server state, ownership, role, and provider readiness. */
export function connectionActions(
  connection: ConnectionDisplay,
  actorUserId: string,
  role: "owner" | "admin" | "member",
  providerState: string,
  now = Date.now(),
) {
  const cleanupOnly = connection.cleanupOnly === true;
  const manageable = connection.ownership === "personal"
    ? connection.ownerUserId === actorUserId || (cleanupOnly && (role === "owner" || role === "admin"))
    : role === "owner" || role === "admin";
  const active = connection.status !== "revoked";
  const ready = !cleanupOnly && active && connection.status === "active" &&
    connection.readiness === "ready" && providerState === "ready";
  return {
    canSelect: ready,
    canCheck: active && !cleanupOnly,
    canRefresh: active && manageable && !cleanupOnly,
    canReconnect: active && manageable && !cleanupOnly && !ready &&
      providerState !== "unsupported" && providerState !== "unconfigured" && providerState !== "unknown",
    canDisconnect: active && manageable,
    canRetryRevoke: !active && manageable && connection.status === "revoked" &&
      (connection.healthReason === "remote_revoke_failed" ||
        connection.healthReason === "provider_cleanup_failed" ||
        ((connection.healthReason === "provider_cleanup_pending" ||
          connection.healthReason?.startsWith("provider_cleanup_pending:") === true) &&
          connection.updatedAt !== undefined && now - connection.updatedAt > 60_000)),
    manageable,
  };
}

/** Never present an orphaned or revoked binding as ready in the control plane. */
export function connectionStatusLabel(connection: ConnectionDisplay, providerState: string): string {
  if (connection.status === "revoked") return "disconnected";
  if (connection.cleanupOnly) return "cleanup required";
  return providerState === "ready" ? connection.readiness : providerState;
}

/** Extract the requested scopes from an OAuth consent URL for review. */
export function authorizationScopes(authUrl: string): string[] {
  const url = new URL(authUrl);
  const scopes = ["scope", "scopes", "user_scope"].flatMap((field) =>
    (url.searchParams.get(field) ?? "").split(/[\s,]+/).filter(Boolean),
  );
  return [...new Set(scopes)];
}
