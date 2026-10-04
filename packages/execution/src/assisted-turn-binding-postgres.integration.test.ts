import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindPostgresAssistedTurn, lookupPostgresAssistedTurn } from
  "./assisted-turn-binding-postgres.js";

const { Client } = pg;
const connectionString = process.env.OMR_TEST_DATABASE_URL;
const describeDatabase = connectionString ? describe : describe.skip;

describeDatabase("assisted turn PostgreSQL binding", () => {
  const workspaceId = `assisted-${crypto.randomUUID()}`;
  const requestId = crypto.randomUUID();
  const wrappingKey = new Uint8Array(new ArrayBuffer(32)).fill(11);
  let client: pg.Client;

  beforeAll(async () => {
    client = new Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(new URL("../../data/migrations/0001_data_isolation.sql",
      import.meta.url), "utf8"));
    await client.query(readFileSync(new URL("../migrations/0022_assisted_turn_bindings.sql",
      import.meta.url), "utf8"));
    await client.query(`INSERT INTO omr_control.workspaces
      (id, kind, name, created_at, updated_at) VALUES ($1, 'personal', 'assisted fixture', $2, $2)`,
    [workspaceId, Date.now()]);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("DELETE FROM omr_control.workspaces WHERE id = $1", [workspaceId]);
    await client.end();
  });

  it("keeps first action and arguments isolated by user with encrypted storage", async () => {
    const common = { connectionString: connectionString!, workspaceId, requestId, wrappingKey };
    const first = await bindPostgresAssistedTurn({ ...common, userId: "alice",
      requestFingerprint: "first", outcome: { kind: "action", effect: "read", toolId: "demo.read" },
      action: { connectionId: "account_one", params: { title: "private-first-argument" } } });
    expect(first.created).toBe(true);
    expect(first.binding.action?.params).toEqual({ title: "private-first-argument" });

    const retry = await bindPostgresAssistedTurn({ ...common, userId: "alice",
      requestFingerprint: "changed", outcome: { kind: "action", effect: "write", toolId: "demo.write" },
      action: { connectionId: "account_two", params: { title: "changed" } } });
    expect(retry.created).toBe(false);
    expect(retry.binding).toEqual(first.binding);
    expect(await lookupPostgresAssistedTurn({ ...common, userId: "bob" })).toBeNull();

    const stored = await client.query<{ outcome: string; ciphertext: string }>(`
      SELECT outcome::text, encode(action_ciphertext, 'hex') AS ciphertext
      FROM omr_control.assisted_turn_bindings
      WHERE workspace_id = $1 AND actor_user_id = 'alice' AND request_id = $2`,
    [workspaceId, requestId]);
    expect(JSON.stringify(stored.rows)).not.toContain("private-first-argument");

    await bindPostgresAssistedTurn({ ...common, userId: "bob",
      requestFingerprint: "bob", outcome: { kind: "action", effect: "write", toolId: "demo.write" },
      action: { connectionId: "account_bob", params: { title: "bob's argument" } } });
    expect((await lookupPostgresAssistedTurn({ ...common, userId: "bob" }))?.action?.params)
      .toEqual({ title: "bob's argument" });
    await client.query(`UPDATE omr_control.assisted_turn_bindings AS bob
      SET action_ciphertext = alice.action_ciphertext, action_iv = alice.action_iv
      FROM omr_control.assisted_turn_bindings AS alice
      WHERE bob.workspace_id = $1 AND bob.actor_user_id = 'bob' AND bob.request_id = $2
        AND alice.workspace_id = $1 AND alice.actor_user_id = 'alice' AND alice.request_id = $2`,
    [workspaceId, requestId]);
    await expect(lookupPostgresAssistedTurn({ ...common, userId: "bob" })).rejects.toThrow();
  });
});
