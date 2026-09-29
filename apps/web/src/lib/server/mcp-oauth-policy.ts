import {
  CLIENT_CAPABILITIES,
  type ClientCapability,
  type ClientPrincipal,
} from "@oh-my-router/client-access";

export type OAuthGrantProps = {
  omrCredential: string;
  workspaceId: string;
  userId: string;
  scopes: ClientCapability[];
};

const CAPABILITIES = new Set<string>(CLIENT_CAPABILITIES);

export function requestedOAuthCapabilities(scopes: readonly string[]): ClientCapability[] | null {
  const requested = [...new Set(scopes)];
  const capabilities = requested.filter((scope) => scope !== "offline_access");
  return capabilities.includes("tools:discover") && requested.every((scope) =>
    CAPABILITIES.has(scope) || scope === "offline_access")
    ? capabilities as ClientCapability[]
    : null;
}

export function oauthTokenMatchesGrant(
  props: unknown,
  tokenScopes: readonly string[],
): props is OAuthGrantProps {
  if (!props || typeof props !== "object") return false;
  const grant = props as Partial<OAuthGrantProps>;
  return typeof grant.omrCredential === "string" && /^omr_[a-f0-9]{64}$/.test(grant.omrCredential) &&
    typeof grant.workspaceId === "string" && grant.workspaceId.length > 0 &&
    typeof grant.userId === "string" && grant.userId.length > 0 &&
    Array.isArray(grant.scopes) && grant.scopes.includes("tools:discover") &&
    grant.scopes.every((scope) => CAPABILITIES.has(scope)) &&
    grant.scopes.every((scope) => tokenScopes.includes(scope)) &&
    tokenScopes.every((scope) => scope === "offline_access" || grant.scopes?.includes(scope as ClientCapability));
}

/** Refresh must not mint another token after the OMR grant has lost authority. */
export function oauthRefreshMatchesGrant(
  props: unknown,
  requestedScopes: readonly string[],
  principal: ClientPrincipal,
): boolean {
  return oauthTokenMatchesGrant(props, requestedScopes) &&
    principal.kind === "mcp_remote" &&
    principal.userId === props.userId &&
    principal.workspaceId === props.workspaceId &&
    props.scopes.every((scope) => principal.capabilities.includes(scope));
}
