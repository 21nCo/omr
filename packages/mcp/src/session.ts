const PROVIDER_RECONNECT_ERRORS = new Set([
  "GITHUB_RECONNECT_REQUIRED",
  "LINEAR_RECONNECT_REQUIRED",
  "SLACK_RECONNECT_REQUIRED",
  "NOTION_RECONNECT_REQUIRED",
]);

/** A provider token can expire while the OMR client grant remains valid. */
async function providerReconnect(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    const body: unknown = await response.clone().json();
    return body !== null && typeof body === "object" && !Array.isArray(body) &&
      "error" in body && typeof body.error === "string" &&
      PROVIDER_RECONNECT_ERRORS.has(body.error);
  } catch {
    return false;
  }
}

/** Fence local backend requests as soon as a client grant is rejected, then close stdio. */
export function authenticatedSessionFetch(
  fetchImpl: typeof fetch,
  close: () => Promise<void>,
  closeFailed: () => void,
): typeof fetch {
  let unauthorized = false;
  return async (request, init) => {
    if (unauthorized) throw new Error("OMR grant is revoked or expired");
    const response = await fetchImpl(request, init);
    const reconnect = await providerReconnect(response);
    if (unauthorized) {
      // Another request may have revoked the grant while this response was read.
      throw new Error("OMR grant is revoked or expired");
    }
    if (response.status === 401 && !reconnect) {
      unauthorized = true;
      // Let the failing MCP request observe its error before closing the pipe.
      setImmediate(() => { void close().catch(closeFailed); });
    }
    return response;
  };
}
