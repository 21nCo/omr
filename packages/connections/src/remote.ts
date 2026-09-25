import { ConnectionAuthority, ConnectionUnavailableError } from "./connections.js";

export function isMissingRemoteConnection(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "CONNECTION_NOT_FOUND";
}

/** A deleted remote grant makes only its local binding unavailable. */
export async function markMissingRemoteConnection(authority: ConnectionAuthority, bindingId: string): Promise<void> {
  try {
    await authority.recordHealth({
      connectionId: bindingId,
      status: "needs_reauth",
      readiness: "unavailable",
      reason: "plugfn_connection_missing",
    });
  } catch (error) {
    // Revocation is terminal, including when it races this remote lookup.
    if (!(error instanceof ConnectionUnavailableError)) throw error;
  }
}
