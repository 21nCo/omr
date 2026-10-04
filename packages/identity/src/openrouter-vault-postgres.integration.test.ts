import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OpenRouterVault, decodeOpenRouterVaultKeys } from "./openrouter-vault.js";
import { PostgresOpenRouterVaultStore } from "./openrouter-vault-postgres.js";

const { Client } = pg;
const connectionString = process.env.OMR_TEST_DATABASE_URL;
const describeDatabase = connectionString ? describe : describe.skip;
const keyA = `sk-or-v1-${"c".repeat(32)}`;
const keyB = `sk-or-v1-${"d".repeat(32)}`;
const valid = () => new Response(JSON.stringify({ data: { is_management_key: false } }));

describeDatabase("personal OpenRouter PostgreSQL vault", () => {
  let client: pg.Client;
  let vault: OpenRouterVault;
  let store: PostgresOpenRouterVaultStore;
  const alice = `vault-${crypto.randomUUID()}`;
  const bob = `vault-${crypto.randomUUID()}`;

  beforeAll(async () => {
    client = new Client({ connectionString: connectionString! });
    await client.connect();
    await client.query(readFileSync(new URL("../migrations/0002_identity.sql", import.meta.url), "utf8"));
    await client.query(readFileSync(new URL("../migrations/0020_openrouter_personal_vault.sql", import.meta.url), "utf8"));
    await client.query(`INSERT INTO omr_identity.users (id, created_at, updated_at) VALUES
      ($1, now(), now()), ($2, now(), now())`, [alice, bob]);
    store = new PostgresOpenRouterVaultStore(client);
    vault = new OpenRouterVault(store,
      decodeOpenRouterVaultKeys(JSON.stringify({ v1: "44".repeat(32) }), "v1"),
      (async () => valid()) as typeof fetch);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("DELETE FROM omr_identity.users WHERE id IN ($1,$2)", [alice, bob]);
    await client.end();
  });

  it("persists only ciphertext, isolates users and cascades on account deletion", async () => {
    await vault.save(alice, keyA);
    expect(await vault.status(bob)).toEqual({ configured: false });
    const raw = await client.query<{ encoded: string; last_four: string }>(
      `SELECT encode(ciphertext, 'hex') AS encoded, last_four
       FROM omr_identity.openrouter_keys WHERE user_id=$1`, [alice]);
    expect(raw.rows[0]?.encoded).not.toContain(keyA);
    expect(raw.rows[0]?.last_four).toBe("cccc");
    await expect(vault.withKey(alice, async (key) => key)).resolves.toBe(keyA);
    await client.query("DELETE FROM omr_identity.users WHERE id=$1", [alice]);
    await expect(vault.withKey(alice, async () => "used")).rejects.toMatchObject({ code: "OPENROUTER_KEY_MISSING" });
    expect((await client.query("SELECT 1 FROM omr_identity.openrouter_keys WHERE user_id=$1", [alice])).rowCount).toBe(0);
  });

  it("removal creates a ciphertext-free fence against an in-flight save", async () => {
    let finish!: (response: Response) => void;
    const pendingVault = new OpenRouterVault(store,
      decodeOpenRouterVaultKeys(JSON.stringify({ v1: "44".repeat(32) }), "v1"),
      vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch);
    const pending = pendingVault.save(bob, keyA);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await vault.delete(bob);
    finish(valid());
    await expect(pending).rejects.toMatchObject({ code: "OPENROUTER_KEY_CONFLICT" });
    const raw = await client.query<{ ciphertext: Buffer | null; deleted: boolean }>(
      "SELECT ciphertext, deleted FROM omr_identity.openrouter_keys WHERE user_id=$1", [bob]);
    expect(raw.rows[0]).toMatchObject({ ciphertext: null, deleted: true });
    await vault.save(bob, keyB);
    await expect(vault.withKey(bob, async (key) => key)).resolves.toBe(keyB);
  });
});
