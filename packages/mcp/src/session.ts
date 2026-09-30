/** Fence local backend requests as soon as a grant is rejected, then close stdio. */
export function authenticatedSessionFetch(
  fetchImpl: typeof fetch,
  close: () => Promise<void>,
  closeFailed: () => void,
): typeof fetch {
  let unauthorized = false;
  return async (request, init) => {
    if (unauthorized) throw new Error("OMR grant is revoked or expired");
    const response = await fetchImpl(request, init);
    if (response.status === 401 && !unauthorized) {
      unauthorized = true;
      // Let the failing MCP request observe its error before closing the pipe.
      setImmediate(() => { void close().catch(closeFailed); });
    } else if (unauthorized && response.status !== 401) {
      // A request already in flight must not return a successful result after 401.
      throw new Error("OMR grant is revoked or expired");
    }
    return response;
  };
}
