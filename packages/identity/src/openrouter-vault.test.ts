import { describe, expect, it, vi } from "vitest";
import { decodeOpenRouterVaultKeys, OpenRouterVault, type OpenRouterKeyRow,
  type OpenRouterVaultStore, validateOpenRouterKey } from "./openrouter-vault.js";

const first = `sk-or-v1-${"a".repeat(32)}`;
const second = `sk-or-v1-${"b".repeat(32)}`;
const ring = decodeOpenRouterVaultKeys(JSON.stringify({ v1: "11".repeat(32), v2: "22".repeat(32) }), "v1");

class Store implements OpenRouterVaultStore {
  readonly users = new Set(["alice", "bob"]);
  readonly rows = new Map<string, OpenRouterKeyRow>();
  readonly revisions = new Map<string, string>();
  async get(userId: string) { return this.users.has(userId) ? this.rows.get(userId) ?? null : null; }
  async revision(userId: string) { return this.revisions.get(userId) ?? null; }
  async put(row: OpenRouterKeyRow, expectedRevision: string | null) {
    if (!this.users.has(row.userId)) throw new Error("account missing");
    if ((this.revisions.get(row.userId) ?? null) !== expectedRevision) return false;
    this.rows.set(row.userId, row);
    this.revisions.set(row.userId, row.revision);
    return true;
  }
  async markValidation(userId: string, revision: string, validation: "valid" | "invalid", checkedAt: number) {
    const row = await this.get(userId);
    if (row?.revision === revision) this.rows.set(userId, { ...row, validation, checkedAt });
  }
  async delete(userId: string) { this.rows.delete(userId); this.revisions.set(userId, crypto.randomUUID()); }
  removeAccount(userId: string) { this.users.delete(userId); this.rows.delete(userId); this.revisions.delete(userId); }
}

function fixtureResponse(status: number, data: object = { data: { is_management_key: false } }) {
  return new Response(JSON.stringify(data), { status });
}

describe("personal OpenRouter key vault", () => {
  it("encrypts for one owner, keeps responses masked, rotates and immediately denies deleted keys", async () => {
    const store = new Store();
    const fetcher = vi.fn(async () => fixtureResponse(200));
    const vault = new OpenRouterVault(store, ring, fetcher as typeof fetch);
    expect(await vault.save("alice", first)).toEqual(expect.objectContaining({
      configured: true, maskedKey: "••••aaaa", validation: "valid",
    }));
    expect(await vault.status("bob")).toEqual({ configured: false });
    await expect(vault.withKey("bob", async () => "used")).rejects.toMatchObject({ code: "OPENROUTER_KEY_MISSING" });
    const stored = store.rows.get("alice")!;
    expect(JSON.stringify(stored)).not.toContain(first);
    expect(Array.from(stored.ciphertext)).not.toEqual(Array.from(new TextEncoder().encode(first)));
    expect(Buffer.from(stored.ciphertext).toString("hex"))
      .not.toContain(Buffer.from(first).toString("hex"));
    expect(stored).toMatchObject({ keyId: "v1", lastFour: "aaaa" });
    expect(await vault.withKey("alice", async (key) => key)).toBe(first);
    await vault.save("alice", second);
    expect(await vault.withKey("alice", async (key) => key)).toBe(second);
    expect(JSON.stringify(await vault.status("alice"))).not.toContain(second);
    expect(await vault.delete("alice")).toEqual({ configured: false });
    await expect(vault.withKey("alice", async () => "used")).rejects.toMatchObject({ code: "OPENROUTER_KEY_MISSING" });
    expect(fetcher).toHaveBeenCalledWith("https://openrouter.ai/api/v1/key",
      expect.objectContaining({ redirect: "error", cache: "no-store" }));
  });

  it("rejects invalid replacement without losing the current key and masks provider failures", async () => {
    const store = new Store();
    let providerStatus = 200;
    const fetcher = vi.fn(async () => fixtureResponse(providerStatus, { error: `provider echoed ${second}` }));
    const vault = new OpenRouterVault(store, ring, fetcher as typeof fetch);
    // A successful fixture must contain the current-key record.
    fetcher.mockImplementationOnce(async () => fixtureResponse(200));
    await vault.save("alice", first);
    providerStatus = 401;
    await expect(vault.save("alice", second)).rejects.toMatchObject({ code: "OPENROUTER_KEY_INVALID" });
    expect(await vault.withKey("alice", async (key) => key)).toBe(first);
    providerStatus = 429;
    await expect(vault.check("alice")).rejects.toMatchObject({ code: "OPENROUTER_VALIDATION_UNAVAILABLE" });
    expect((await vault.status("alice")).validation).toBe("valid");
    expect(JSON.stringify(await vault.status("alice"))).not.toContain(second);
  });

  it("marks a revoked key invalid, refuses its use, and never resurrects an interleaved replacement", async () => {
    const store = new Store();
    const fetcher = vi.fn(async () => fixtureResponse(200));
    const vault = new OpenRouterVault(store, ring, fetcher as typeof fetch);
    await vault.save("alice", first);
    fetcher.mockResolvedValueOnce(fixtureResponse(401));
    expect((await vault.check("alice")).validation).toBe("invalid");
    await expect(vault.withKey("alice", async () => "used")).rejects.toMatchObject({ code: "OPENROUTER_KEY_MISSING" });
    let releaseOldCheck!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseOldCheck = resolve; }));
    const staleCheck = vault.check("alice");
    await vi.waitFor(() => expect(releaseOldCheck).toBeTypeOf("function"));
    await vault.save("alice", second);
    releaseOldCheck(fixtureResponse(401));
    expect((await staleCheck).validation).toBe("valid");
    expect(await vault.withKey("alice", async (key) => key)).toBe(second);
    store.removeAccount("alice");
    await expect(vault.withKey("alice", async () => "used")).rejects.toMatchObject({ code: "OPENROUTER_KEY_MISSING" });
  });

  it("fences a save whose provider validation completes after removal", async () => {
    const store = new Store();
    let finishValidation!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finishValidation = resolve; }));
    const vault = new OpenRouterVault(store, ring, fetcher as typeof fetch);
    const pending = vault.save("alice", first);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await vault.delete("alice");
    finishValidation(fixtureResponse(200));
    await expect(pending).rejects.toMatchObject({ code: "OPENROUTER_KEY_CONFLICT" });
    expect(await vault.status("alice")).toEqual({ configured: false });
    fetcher.mockResolvedValueOnce(fixtureResponse(200));
    await expect(vault.save("alice", second)).resolves.toMatchObject({ configured: true });
  });

  it("binds ciphertext to its owner and supports staged wrapping-key rotation", async () => {
    const store = new Store();
    const vault = new OpenRouterVault(store, ring, vi.fn(async () => fixtureResponse(200)) as typeof fetch);
    await vault.save("alice", first);
    const old = store.rows.get("alice")!;
    store.rows.set("bob", { ...old, userId: "bob" });
    await expect(vault.withKey("bob", async () => "used")).rejects.toMatchObject({ code: "OPENROUTER_VAULT_UNAVAILABLE" });
    const rotating = new OpenRouterVault(store, { ...ring, activeKeyId: "v2" },
      vi.fn(async () => fixtureResponse(200)) as typeof fetch);
    expect(await rotating.withKey("alice", async (key) => key)).toBe(first);
    await rotating.save("alice", second);
    expect(store.rows.get("alice")?.keyId).toBe("v2");
    await expect(vault.withKey("alice", async (key) => key)).resolves.toBe(second);
  });
});

describe("OpenRouter validation", () => {
  it("rejects malformed and management keys without sending malformed values or exposing provider text", async () => {
    const fetcher = vi.fn(async () => fixtureResponse(200, { data: { is_management_key: true } }));
    await expect(validateOpenRouterKey("bad key", fetcher as typeof fetch)).rejects
      .toMatchObject({ code: "OPENROUTER_KEY_INVALID" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(validateOpenRouterKey(first, fetcher as typeof fetch)).rejects
      .toMatchObject({ code: "OPENROUTER_KEY_INVALID" });
    fetcher.mockRejectedValueOnce(new Error(`provider echoed ${first}`));
    await expect(validateOpenRouterKey(first, fetcher as typeof fetch)).rejects
      .toMatchObject({ code: "OPENROUTER_VALIDATION_UNAVAILABLE" });
    expect(() => decodeOpenRouterVaultKeys('{"v1":"short"}', "v1"))
      .toThrowError("OPENROUTER_VAULT_UNAVAILABLE");
  });
});
