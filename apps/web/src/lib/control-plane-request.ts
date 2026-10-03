const PROVIDER_RECONNECT_ERRORS = new Set([
  "GITHUB_RECONNECT_REQUIRED", "LINEAR_RECONNECT_REQUIRED", "SLACK_RECONNECT_REQUIRED",
  "NOTION_RECONNECT_REQUIRED",
]);

/** Keep a provider error code available to the reconnect UI. */
export class OMRResponseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OMRResponseError";
  }
}

/** Keep provider revocation in the control plane so the account can be reconnected. */
export function createControlPlaneRequest(
  fetchImpl: typeof fetch,
  redirectToLogin: () => void,
) {
  return async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchImpl(path, { credentials: "same-origin", ...init });
    const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
    if (response.status === 401 && !PROVIDER_RECONNECT_ERRORS.has(body.error ?? "")) {
      redirectToLogin();
      throw new Error("Authentication required");
    }
    if (!response.ok) throw new OMRResponseError(body.error ?? "HTTP_ERROR",
      body.message ?? body.error ?? `Request failed (${response.status})`);
    return body as T;
  };
}
