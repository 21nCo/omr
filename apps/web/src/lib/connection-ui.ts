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
}

export function providerRevocationGuidance(reason: string | null, authMode: string | null): string | null {
  return reason === "remote_revocation_unavailable" || reason === "provider_connection_missing"
    ? authMode === "api_key"
      ? "OMR access was removed. Delete or rotate the API key in your provider account; OMR no longer has the key to retry cleanup."
      : authMode === "oauth"
        ? "OMR access was removed. The provider grant may still be active. Revoke it in your provider account; OMR no longer has the token to retry."
        : "OMR access was removed. Check your provider account for remaining access and revoke it there."
    : null;
}

export function connectionActions(
  connection: ConnectionDisplay,
  actorUserId: string,
  role: "owner" | "admin" | "member",
  providerState: string,
  now = Date.now(),
) {
  const manageable = connection.ownership === "personal"
    ? connection.ownerUserId === actorUserId
    : role === "owner" || role === "admin";
  const active = connection.status !== "revoked";
  const ready = active && connection.status === "active" &&
    connection.readiness === "ready" && providerState === "ready";
  return {
    canSelect: ready,
    canCheck: active,
    canRefresh: active && manageable,
    canReconnect: active && manageable && !ready &&
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

export function authorizationScopes(authUrl: string): string[] {
  const url = new URL(authUrl);
  const scopes = ["scope", "scopes", "user_scope"].flatMap((field) =>
    (url.searchParams.get(field) ?? "").split(/[\s,]+/).filter(Boolean),
  );
  return [...new Set(scopes)];
}
