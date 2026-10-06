import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASSISTED_TURN_RETENTION_MS, abandonPostgresAssistedTurn,
  bindPostgresAssistedTurn, claimPostgresAssistedTurn, lookupPostgresAssistedTurn } from
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

  it("atomically claims one paid identity, finalizes it and isolates users", async () => {
    const common = { connectionString: connectionString!, workspaceId,
      requestId: crypto.randomUUID(), wrappingKey, userId: "claim_alice",
      requestFingerprint: "same-request" };
    const [a, b] = await Promise.all([
      claimPostgresAssistedTurn(common), claimPostgresAssistedTurn(common),
    ]);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(a.binding.outcome).toEqual({ kind: "pending" });
    expect(b.binding.outcome).toEqual({ kind: "pending" });
    const outcome = { kind: "model", response: { status: "answered",
      answer: "Review complete", usage: { totalTokens: 14, costUsd: 0.00002 } } };
    const saved = await bindPostgresAssistedTurn({ ...common, outcome });
    expect(saved.created).toBe(true);
    expect(saved.binding.outcome).toEqual(outcome);
    await abandonPostgresAssistedTurn(common);
    const retry = await claimPostgresAssistedTurn(common);
    expect(retry.created).toBe(false);
    expect(retry.binding.outcome).toEqual(outcome);
    const changed = await claimPostgresAssistedTurn({ ...common,
      requestFingerprint: "changed" });
    expect(changed.created).toBe(false);
    expect(changed.binding.requestFingerprint).toBe("same-request");
    expect((await claimPostgresAssistedTurn({ ...common, userId: "claim_bob" })).created)
      .toBe(true);
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

  it("encrypts model-only answers and purges expired request bindings", async () => {
    const requestId = crypto.randomUUID();
    const common = { connectionString: connectionString!, workspaceId, requestId, wrappingKey,
      userId: "alice" };
    const answer = "private model answer";
    const outcome = { kind: "model", response: { status: "answered", answer,
      model: "fixture/model", servedModels: ["fixture/served"],
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, costUsd: 0.01 } } };
    const first = await bindPostgresAssistedTurn({ ...common,
      requestFingerprint: "model-only", outcome });
    expect(first.binding.outcome).toEqual(outcome);
    const row = await client.query<{ outcome: string; ciphertext: string;
      expires_at: string }>(`
      SELECT outcome::text, encode(outcome_ciphertext, 'hex') AS ciphertext, expires_at
      FROM omr_control.assisted_turn_bindings
      WHERE workspace_id = $1 AND actor_user_id = $2 AND request_id = $3`,
    [workspaceId, "alice", requestId]);
    expect(JSON.stringify(row.rows)).not.toContain(answer);
    expect(Number(row.rows[0]!.expires_at)).toBeGreaterThan(Date.now());
    expect(Number(row.rows[0]!.expires_at)).toBeLessThanOrEqual(
      Date.now() + ASSISTED_TURN_RETENTION_MS);
    expect((await lookupPostgresAssistedTurn(common))?.outcome).toEqual(outcome);
    await client.query(`UPDATE omr_control.assisted_turn_bindings SET expires_at = $1
      WHERE workspace_id = $2 AND actor_user_id = $3 AND request_id = $4`,
    [Date.now() - 1, workspaceId, "alice", requestId]);
    expect(await lookupPostgresAssistedTurn(common)).toBeNull();
    const gone = await client.query(`SELECT 1 FROM omr_control.assisted_turn_bindings
      WHERE workspace_id = $1 AND actor_user_id = $2 AND request_id = $3`,
    [workspaceId, "alice", requestId]);
    expect(gone.rowCount).toBe(0);
  });

  it("serves a request while purging a large expired backlog in bounded batches", async () => {
    const now = Date.now();
    await client.query(`INSERT INTO omr_control.assisted_turn_bindings
      (workspace_id, actor_user_id, request_id, request_fingerprint, outcome,
        created_at, expires_at)
      SELECT $1, 'backlog', 'expired_' || series::text, 'old', '{"kind":"model"}'::jsonb,
        $2, CASE WHEN series = 250 THEN $3 ELSE $4 END
      FROM generate_series(1, 250) AS series`,
    [workspaceId, now - 2000, now - 1, now - 1000]);
    const common = { connectionString: connectionString!, workspaceId, userId: "backlog",
      wrappingKey };
    expect(await lookupPostgresAssistedTurn({ ...common, requestId: "absent" })).toBeNull();
    const afterLookup = await client.query<{ count: string }>(`
      SELECT count(*) FROM omr_control.assisted_turn_bindings
      WHERE workspace_id = $1 AND actor_user_id = 'backlog'`, [workspaceId]);
    expect(Number(afterLookup.rows[0]!.count)).toBe(150);

    const rebound = await bindPostgresAssistedTurn({ ...common,
      requestId: "expired_250", requestFingerprint: "new",
      outcome: { kind: "model", response: { answer: "new" } } });
    expect(rebound.created).toBe(true);
    expect(rebound.binding.requestFingerprint).toBe("new");
    const remaining = await client.query<{ count: string }>(`
      SELECT count(*) FROM omr_control.assisted_turn_bindings
      WHERE workspace_id = $1 AND actor_user_id = 'backlog' AND expires_at <= $2`,
    [workspaceId, Date.now()]);
    expect(Number(remaining.rows[0]!.count)).toBe(49);
  });
});
