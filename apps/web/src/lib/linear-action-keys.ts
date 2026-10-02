const PREFIX = "omr-linear-action-v1:";

/** Describe the actual next step for a replayed browser approval. */
export function linearApprovalNotice(status: string): string {
  switch (status) {
    case "consumed": return "This Linear action already completed. Start a new action to repeat the same change.";
    case "uncertain": return "This Linear action has an uncertain outcome. Verify it in Linear before reconciliation.";
    case "pending": return "Linear issue change awaits your approval below. Review the account and target before approving.";
    case "approved": return "This Linear action is approved. Execute it from the approvals list below.";
    case "executing": return "This Linear action is executing. Check its status before requesting another action.";
    default: return "This Linear action is closed. Start a new action if a change is still needed.";
  }
}

/** Keep retry identities across a browser reload without storing issue text. */
export function createLinearActionKeys(makeKey: () => string,
  storage?: () => Pick<Storage, "getItem" | "setItem" | "removeItem">,
  provider = "Linear") {
  const current = new Map<string, string>();
  const fingerprint = async (toolId: string, workspaceId: string, connectionId: string,
    params: object): Promise<string> => {
    const selected = JSON.stringify([toolId, workspaceId, connectionId, params]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(selected));
    return `${PREFIX}${[...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  };
  return {
    async existingKey(toolId: string, workspaceId: string, connectionId: string,
      params: object): Promise<string | undefined> {
      const identity = await fingerprint(toolId, workspaceId, connectionId, params);
      if (current.has(identity)) return current.get(identity);
      try { return storage?.().getItem(identity) ?? undefined; }
      catch { return undefined; }
    },
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
    async resetAfterSettlement(toolId: string, workspaceId: string, connectionId: string,
      params: object, probe: (idempotencyKey: string) => Promise<{ status: string }>,
      stillSelected: () => boolean = () => true): Promise<void> {
      const idempotencyKey = await this.existingKey(toolId, workspaceId, connectionId, params);
      if (!idempotencyKey) throw new Error("Request approval for this action before starting another.");
      const approval = await probe(idempotencyKey);
      if (!["consumed", "rejected", "failed", "expired"].includes(approval.status)) {
        throw new Error(approval.status === "uncertain"
          ? `Verify this uncertain ${provider} action before starting another.`
          : `This ${provider} action is still active. Finish or reject it before starting another.`);
      }
      const identity = await fingerprint(toolId, workspaceId, connectionId, params);
      if (!stillSelected()) return;
      current.delete(identity);
      try { storage?.().removeItem(identity); } catch { /* Memory is already cleared. */ }
    },
  };
}
