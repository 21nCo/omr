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
export function providerRevocationGuidance(reason: string | null, authMode: string | null, ownerCanRetry = false): string | null {
  if (reason === "provider_cleanup_requires_owner") {
    if (ownerCanRetry) return "OMR access was removed. You can retry provider cleanup now; this account will remain unavailable.";
    if (authMode === "api_key") return "OMR access was removed. Ask the former member to delete or rotate the API key in their provider account; an admin cannot revoke their personal key through OMR.";
    if (authMode === "oauth") return "OMR access was removed. Ask the former member to revoke the OAuth grant in their provider account; an admin cannot revoke their personal grant through OMR.";
    return "OMR access was removed. Ask the former member to remove this connection in their provider account.";
  }
  if (reason !== "remote_revocation_unavailable" && reason !== "provider_connection_missing" &&
      reason !== "plugfn_connection_missing") return null;
  if (authMode === "api_key") {
    return "OMR access was removed. Delete or rotate the API key in your provider account; OMR no longer has the key to retry cleanup.";
  }
  if (authMode === "oauth") {
    return "OMR access was removed. The provider grant may still be active. Revoke it in your provider account; OMR no longer has the token to retry.";
  }
  return "OMR access was removed. Check your provider account for remaining access and revoke it there.";
}

/** Surface a permanent Notion proof denial from either fresh catalog proof or persisted health. */
export function notionAccessGuidance(proofIssue?: string | null, healthReason?: string | null): string | null {
  return proofIssue === "notion_access_restricted" || healthReason === "notion_access_restricted"
    ? "Notion restricted this integration's API access. Contact Notion support to restore access."
    : null;
}

/** Project a just-failed proof before the separate overview request can see persisted health. */
export function connectionAfterNotionProof<Connection extends ConnectionDisplay>(connection: Connection,
  proofBindingId?: string): Connection {
  if (connection.provider !== "notion" || connection.id !== proofBindingId) return connection;
  return { ...connection, status: "needs_reauth", readiness: "unavailable",
    healthReason: "notion_access_restricted", selected: false };
}

/** Scope a proof denial to its binding; another ready integration can be selected. */
export function notionJourneyGuidance(
  connections: readonly (Pick<ConnectionDisplay, "id" | "provider" | "status" | "readiness" | "selected" | "healthReason"> &
    { workspaceId: string })[], workspaceId: string, proofIssue?: string | null,
  proofBindingId?: string,
): string | null {
  const scoped = connections.filter((connection) => connection.provider === "notion" &&
    connection.workspaceId === workspaceId);
  if (scoped.some((connection) => connection.id !== proofBindingId &&
      connection.status === "active" && connection.readiness === "ready")) return null;
  const deniedProof = proofBindingId && scoped.some((connection) => connection.id === proofBindingId)
    ? proofIssue : null;
  return notionAccessGuidance(deniedProof,
    scoped.find((connection) => connection.healthReason === "notion_access_restricted")?.healthReason);
}

/** A failed proof for one binding must not disable selection of another ready one. */
export function notionConnectionProviderState(connection: ConnectionDisplay,
  providerState: string, proofBindingId?: string): string {
  return connection.provider === "notion" && providerState === "expired" &&
    connection.id !== proofBindingId && connection.status === "active" &&
    connection.readiness === "ready" ? "ready" : providerState;
}

/** Keep the chooser visible when a ready Notion binding can replace a denied one. */
export function notionJourneyAvailable(connections: readonly (ConnectionDisplay & { workspaceId: string })[],
  workspaceId: string, providerState: string, proofBindingId?: string): boolean {
  if (providerState === "ready") return true;
  return providerState === "expired" && connections.some((connection) =>
    connection.provider === "notion" && connection.workspaceId === workspaceId &&
    connection.id !== proofBindingId && connection.status === "active" &&
    connection.readiness === "ready");
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
      connection.healthReason !== "notion_access_restricted" &&
      providerState !== "unsupported" && providerState !== "unconfigured" && providerState !== "unknown",
    canDisconnect: active && manageable,
    canRetryRevoke: !active && manageable && connection.status === "revoked" &&
      (connection.healthReason === "remote_revoke_failed" ||
        connection.healthReason === "provider_cleanup_failed" ||
        (connection.healthReason === "provider_cleanup_requires_owner" &&
          connection.ownership === "personal" && connection.ownerUserId === actorUserId) ||
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
