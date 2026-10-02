const PREFIX = "omr-linear-action-v1:";

/** Keep retry identities across a browser reload without storing issue text. */
export function createLinearActionKeys(makeKey: () => string,
  storage?: () => Pick<Storage, "getItem" | "setItem" | "removeItem">) {
  const current = new Map<string, string>();
  const fingerprint = async (toolId: string, workspaceId: string, connectionId: string,
    params: object): Promise<string> => {
    const selected = JSON.stringify([toolId, workspaceId, connectionId, params]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(selected));
    return `${PREFIX}${[...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  };
  return {
    async key(toolId: string, workspaceId: string, connectionId: string, params: object): Promise<string> {
      const identity = await fingerprint(toolId, workspaceId, connectionId, params);
      let key = current.get(identity);
      if (!key) {
        try { key = storage?.().getItem(identity) ?? undefined; } catch { /* Private browsing may deny storage. */ }
      }
      if (!key) {
        key = makeKey();
        try { storage?.().setItem(identity, key); } catch { /* Memory still fences this page. */ }
      }
      current.set(identity, key);
      return key;
    },
    async reset(toolId: string, workspaceId: string, connectionId: string, params: object): Promise<void> {
      const identity = await fingerprint(toolId, workspaceId, connectionId, params);
      current.delete(identity);
      try { storage?.().removeItem(identity); } catch { /* Memory is already cleared. */ }
    },
  };
}
