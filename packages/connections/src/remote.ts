import { ConnectionAuthority, ConnectionUnavailableError } from "./connections.js";

export function isMissingRemoteConnection(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "CONNECTION_NOT_FOUND";
}

/** A deleted remote grant makes only its local binding unavailable for this request.
 * The stored transition is retried on later requests if persistence fails. */
export async function markMissingRemoteConnection(authority: ConnectionAuthority, bindingId: string): Promise<void> {
  try {
    await authority.recordHealth({
      connectionId: bindingId,
      status: "needs_reauth",
      readiness: "unavailable",
      reason: "plugfn_connection_missing",
    });
  } catch (error) {
    // A revoked binding stays terminal. A failed health write cannot make the
    // known-missing remote usable or replace the caller's unavailable response.
    const terminal = error instanceof ConnectionUnavailableError;
    let errorType = "UnknownError";
    if (terminal) errorType = "ConnectionUnavailableError";
    else if (error instanceof TypeError) errorType = "TypeError";
    else if (error instanceof Error) errorType = "Error";
    console.warn(JSON.stringify({
      service: "omr-connections",
      level: "warn",
      event: terminal
        ? "missing_remote_health_binding_unavailable" : "missing_remote_health_write_failed",
      bindingId,
      errorType,
    }));
  }
}
