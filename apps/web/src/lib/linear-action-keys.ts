const PREFIX = "omr-linear-action-v1:";

/** Describe the actual next step for a replayed browser approval. */
export function linearApprovalNotice(status: string): string {
  switch (status) {
    case "consumed": return "This Linear action already completed. Start a new action to repeat the same change.";
    case "uncertain": return "This Linear action has an uncertain outcome. Verify it in Linear, then reconcile its receipt before starting another action.";
    case "pending": return "Linear issue change awaits your approval below. Review the account and target before approving.";
    case "approved": return "This Linear action is approved. Execute it from the approvals list below.";
    case "executing": return "This Linear action is executing. Check its status before requesting another action.";
    default: return "This Linear action is closed. Start a new action if a change is still needed.";
  }
}

/** Keep retry identities across a browser reload without storing issue text. */
export function createLinearActionKeys(makeKey: () => string,
  storage?: () => Pick<Storage, "getItem" | "setItem" | "removeItem"> &
    Partial<Pick<Storage, "key" | "length">>,
  provider = "Linear") {
  const current = new Map<string, string>();
  const approvalIdentities = new Map<string, string>();
  /** Name one approval's storage record without persisting its arguments. */
  const approvalStorageKey = (approvalId: string) => `${PREFIX}approval:${approvalId}`;
  /** Derive a stable action identity from the selected account and arguments. */
  const fingerprint = async (toolId: string, workspaceId: string, connectionId: string,
    params: object): Promise<string> => {
    const selected = JSON.stringify([toolId, workspaceId, connectionId, params]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(selected));
    return `${PREFIX}${[...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  };
  /** Match a server-confirmed approval to an exact retained key without storing arguments. */
  const identityForKeyDigest = async (digest: string): Promise<string | undefined> => {
    if (!/^[0-9a-f]{64}$/.test(digest)) return undefined;
    const candidates = new Map(current);
    try {
      const saved = storage?.();
      if (saved?.key && typeof saved.length === "number") {
        for (let index = 0; index < saved.length; index++) {
          const identity = saved.key(index);
          if (identity && new RegExp(`^${PREFIX}[0-9a-f]{64}$`).test(identity)) {
            const key = saved.getItem(identity);
            if (key) candidates.set(identity, key);
          }
        }
      }
    } catch { /* Memory still covers this page if browser storage is denied. */ }
    for (const [identity, key] of candidates) {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
      const actual = [...new Uint8Array(bytes)]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (actual === digest) return identity;
    }
    return undefined;
  };
  return {
    /** Associate a server approval with its secret-free fingerprint for reload recovery. */
    async bindApproval(approvalId: string, toolId: string, workspaceId: string,
      connectionId: string, params: object): Promise<void> {
      const identity = await fingerprint(toolId, workspaceId, connectionId, params);
      approvalIdentities.set(approvalId, identity);
      try { storage?.().setItem(approvalStorageKey(approvalId), identity); }
      catch { /* The current page still remembers the approval. */ }
    },
    /** Clear a write fingerprint only after a server-confirmed terminal status. */
    async resetApprovalAfterSettlement(approvalId: string,
      probe: () => Promise<{ id: string; status: string; actionKeyDigest?: string }>,
      stillSelected: () => boolean = () => true): Promise<boolean> {
      const approval = await probe();
      if (approval.id !== approvalId) throw new Error("Approval changed. Check its status before another action.");
      if (!["consumed", "rejected", "failed", "expired"].includes(approval.status)) {
        throw new Error(approval.status === "uncertain"
          ? `Verify this uncertain ${provider} action and reconcile its receipt before starting another.`
          : `This ${provider} action is still active. Finish or reject it before starting another.`);
      }
      let identity = approvalIdentities.get(approvalId);
      if (!identity) {
        try { identity = storage?.().getItem(approvalStorageKey(approvalId)) ?? undefined; }
        catch { /* Recovery without browser storage is still safe. */ }
      }
      if (!identity && approval.actionKeyDigest) {
        identity = await identityForKeyDigest(approval.actionKeyDigest);
      }
      if (!stillSelected()) return false;
      if (!identity || !new RegExp(`^${PREFIX}[0-9a-f]{64}$`).test(identity)) return false;
      current.delete(identity);
      approvalIdentities.delete(approvalId);
      try {
        storage?.().removeItem(identity);
        storage?.().removeItem(approvalStorageKey(approvalId));
      } catch { /* The current page is already cleared. */ }
      return true;
    },
    /** Recover the idempotency key for the exact action fingerprint. */
    async existingKey(toolId: string, workspaceId: string, connectionId: string,
      params: object): Promise<string | undefined> {
      const identity = await fingerprint(toolId, workspaceId, connectionId, params);
      if (current.has(identity)) return current.get(identity);
      try { return storage?.().getItem(identity) ?? undefined; }
      catch { return undefined; }
    },
    /** Reuse a pending action key across reloads and allocate one for a fresh intent. */
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
    /** Remove one exact fingerprint after the caller confirms it can be discarded. */
    async reset(toolId: string, workspaceId: string, connectionId: string, params: object): Promise<void> {
      const identity = await fingerprint(toolId, workspaceId, connectionId, params);
      current.delete(identity);
      try { storage?.().removeItem(identity); } catch { /* Memory is already cleared. */ }
    },
    /** Probe settlement before releasing an action key when approval ID is unavailable. */
    async resetAfterSettlement(toolId: string, workspaceId: string, connectionId: string,
      params: object, probe: (idempotencyKey: string) => Promise<{ status: string }>,
      stillSelected: () => boolean = () => true): Promise<void> {
      const idempotencyKey = await this.existingKey(toolId, workspaceId, connectionId, params);
      if (!idempotencyKey) throw new Error("Request approval for this action before starting another.");
      const approval = await probe(idempotencyKey);
      if (!["consumed", "rejected", "failed", "expired"].includes(approval.status)) {
        throw new Error(approval.status === "uncertain"
          ? `Verify this uncertain ${provider} action and reconcile its receipt before starting another.`
          : `This ${provider} action is still active. Finish or reject it before starting another.`);
      }
      const identity = await fingerprint(toolId, workspaceId, connectionId, params);
      if (!stillSelected()) return;
      current.delete(identity);
      try { storage?.().removeItem(identity); } catch { /* Memory is already cleared. */ }
    },
  };
}
