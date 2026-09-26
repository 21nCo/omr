export interface PendingOAuthConnection {
  provider: string;
  workspaceId: string;
  ownership: "personal" | "workspace";
  label: string;
  redirectUri: string;
  createdAt: number;
}

const PREFIX = "omr.provider-oauth.";
const MAX_AGE_MS = 10 * 60 * 1000;

export function oauthCallbackUri(origin: string): string {
  return new URL("/app/oauth/callback", origin).toString();
}

export function savePendingOAuthConnection(
  storage: Pick<Storage, "setItem">,
  authUrl: string,
  pending: PendingOAuthConnection,
): string {
  const url = new URL(authUrl);
  const state = url.searchParams.get("state");
  if (url.protocol !== "https:" || !state || state.length > 512 ||
    !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(state)) {
    throw new Error("Provider authorization URL is invalid");
  }
  storage.setItem(`${PREFIX}${state}`, JSON.stringify(pending));
  return url.toString();
}

/** Consume one callback intent, rejecting malformed, foreign-origin, or expired state. */
export function readPendingOAuthConnection(
  storage: Pick<Storage, "getItem" | "removeItem">,
  state: string,
  origin: string,
  now = Date.now(),
): PendingOAuthConnection | null {
  if (!state || state.length > 512) return null;
  const key = `${PREFIX}${state}`;
  const value = storage.getItem(key);
  if (!value) return null;
  try {
    const pending: unknown = JSON.parse(value);
    if (!pending || typeof pending !== "object" || Array.isArray(pending)) return null;
    const record = pending as Record<string, unknown>;
    if (typeof record.provider !== "string" || !/^[a-z0-9_-]{1,80}$/.test(record.provider) ||
      typeof record.workspaceId !== "string" || !/^workspace_[A-Za-z0-9_-]+$/.test(record.workspaceId) ||
      (record.ownership !== "personal" && record.ownership !== "workspace") ||
      typeof record.label !== "string" || record.label.length < 1 || record.label.length > 120 ||
      record.redirectUri !== oauthCallbackUri(origin) ||
      typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt) ||
      record.createdAt > now || now - record.createdAt > MAX_AGE_MS) return null;
    return pending as PendingOAuthConnection;
  } catch {
    return null;
  } finally {
    // Callback intent is single use even when the provider or server fails.
    storage.removeItem(key);
  }
}

export function clearPendingOAuthConnection(
  storage: Pick<Storage, "removeItem">,
  state: string,
): void {
  if (state && state.length <= 512) storage.removeItem(`${PREFIX}${state}`);
}
