import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASSISTED_TURN_RETENTION_MS, abandonPostgresAssistedTurn,
  bindPostgresAssistedTurn, claimPostgresAssistedTurn, lookupPostgresAssistedTurn,
  startPostgresAssistedModel } from
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
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const [a, b] = await Promise.all([
      claimPostgresAssistedTurn({ ...common, claimId: firstId }),
      claimPostgresAssistedTurn({ ...common, claimId: secondId }),
    ]);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(a.binding.outcome).toEqual({ kind: "claimed" });
    expect(b.binding.outcome).toEqual({ kind: "claimed" });
    const winner = a.created ? firstId : secondId;
    const loser = a.created ? secondId : firstId;
    expect(await startPostgresAssistedModel({ ...common, claimId: loser })).toBe(false);
    expect(await startPostgresAssistedModel({ ...common, claimId: winner })).toBe(true);
    expect(await startPostgresAssistedModel({ ...common, claimId: winner })).toBe(false);
    const outcome = { kind: "model", response: { status: "answered",
      answer: "Review complete", usage: { totalTokens: 14, costUsd: 0.00002 } } };
    const saved = await bindPostgresAssistedTurn({ ...common, outcome });
    expect(saved.created).toBe(true);
    expect(saved.binding.outcome).toEqual(outcome);
    await abandonPostgresAssistedTurn({ ...common, claimId: winner });
    const retry = await claimPostgresAssistedTurn({ ...common, claimId: crypto.randomUUID() });
    expect(retry.created).toBe(false);
    expect(retry.binding.outcome).toEqual(outcome);
    const changed = await claimPostgresAssistedTurn({ ...common,
      requestFingerprint: "changed", claimId: crypto.randomUUID() });
    expect(changed.created).toBe(false);
    expect(changed.binding.requestFingerprint).toBe("same-request");
    expect((await claimPostgresAssistedTurn({ ...common, userId: "claim_bob",
      claimId: crypto.randomUUID() })).created)
      .toBe(true);
  });

  it("reclaims only an expired unpaid claim and fences the former owner", async () => {
    const common = { connectionString: connectionString!, workspaceId,
      requestId: crypto.randomUUID(), wrappingKey, userId: "lease_alice",
      requestFingerprint: "same-request" };
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    expect((await claimPostgresAssistedTurn({ ...common, claimId: firstId })).created).toBe(true);
    expect((await claimPostgresAssistedTurn({ ...common, claimId: secondId })).created).toBe(false);
    await client.query(`UPDATE omr_control.assisted_turn_bindings SET claim_started_at = $1
      WHERE workspace_id = $2 AND actor_user_id = $3 AND request_id = $4`,
    [Date.now() - 111_000, workspaceId, common.userId, common.requestId]);
    expect((await claimPostgresAssistedTurn({ ...common, claimId: secondId })).created).toBe(true);
    await abandonPostgresAssistedTurn({ ...common, claimId: firstId });
    expect(await startPostgresAssistedModel({ ...common, claimId: firstId })).toBe(false);
    expect(await startPostgresAssistedModel({ ...common, claimId: secondId })).toBe(true);
    await abandonPostgresAssistedTurn({ ...common, claimId: secondId });
    expect((await lookupPostgresAssistedTurn(common))?.outcome).toEqual({ kind: "pending" });
  });

  it("cleans a proven undispatched pending claim only for its owner", async () => {
    const common = { connectionString: connectionString!, workspaceId,
      requestId: crypto.randomUUID(), wrappingKey, userId: "pending_alice",
      requestFingerprint: "same-request" };
    const claimId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    expect((await claimPostgresAssistedTurn({ ...common, claimId })).created).toBe(true);
    expect(await startPostgresAssistedModel({ ...common, claimId })).toBe(true);
    await abandonPostgresAssistedTurn({ ...common, claimId: otherId, includePending: true });
    await abandonPostgresAssistedTurn({ ...common, claimId });
    expect((await lookupPostgresAssistedTurn(common))?.outcome).toEqual({ kind: "pending" });
    await abandonPostgresAssistedTurn({ ...common, claimId, includePending: true });
    expect(await lookupPostgresAssistedTurn(common)).toBeNull();
    expect((await claimPostgresAssistedTurn({ ...common, claimId: otherId })).created).toBe(true);
  });

  it("rolls back a claim when decoding its post-insert row fails", async () => {
    const requestId = `decode_failure_${crypto.randomUUID()}`;
    await client.query(`CREATE FUNCTION omr_control.corrupt_assisted_claim_fixture()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.request_id LIKE 'decode_failure_%' THEN
          NEW.outcome_ciphertext := decode('00', 'hex');
          NEW.outcome_iv := decode('000000000000000000000000', 'hex');
        END IF;
        RETURN NEW;
      END $$`);
    await client.query(`CREATE TRIGGER corrupt_assisted_claim_fixture
      BEFORE INSERT ON omr_control.assisted_turn_bindings
      FOR EACH ROW EXECUTE FUNCTION omr_control.corrupt_assisted_claim_fixture()`);
    try {
      const common = { connectionString: connectionString!, workspaceId,
        requestId, wrappingKey, userId: "decode_alice",
        requestFingerprint: "same-request", claimId: crypto.randomUUID() };
      await expect(claimPostgresAssistedTurn(common)).rejects.toThrow();
      const row = await client.query(`SELECT 1 FROM omr_control.assisted_turn_bindings
        WHERE workspace_id = $1 AND actor_user_id = $2 AND request_id = $3`,
      [workspaceId, common.userId, requestId]);
      expect(row.rowCount).toBe(0);
    } finally {
      await client.query(`DROP TRIGGER corrupt_assisted_claim_fixture
        ON omr_control.assisted_turn_bindings`);
      await client.query("DROP FUNCTION omr_control.corrupt_assisted_claim_fixture()");
    }
  });

  it("claims and finalizes with the documented binding privileges", async () => {
    const role = `omr_assisted_worker_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const password = crypto.randomUUID().replaceAll("-", "") +
      crypto.randomUUID().replaceAll("-", "");
    await client.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    try {
      await client.query(`GRANT USAGE ON SCHEMA omr_control TO ${role}`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE
        ON omr_control.assisted_turn_bindings TO ${role}`);
      const workerUrl = new URL(connectionString!);
      workerUrl.username = role;
      workerUrl.password = password;
      const common = { connectionString: workerUrl.toString(), workspaceId,
        requestId: crypto.randomUUID(), wrappingKey, userId: "worker_alice",
        requestFingerprint: "same-request", claimId: crypto.randomUUID() };
      expect((await claimPostgresAssistedTurn(common)).created).toBe(true);
      expect(await startPostgresAssistedModel(common)).toBe(true);
      const outcome = { kind: "model", response: { status: "answered",
        answer: "Review complete", usage: { totalTokens: 14, costUsd: 0.00002 } } };
      expect((await bindPostgresAssistedTurn({ ...common, outcome })).binding.outcome)
        .toEqual(outcome);
    } finally {
      await client.query(`DROP OWNED BY ${role}`);
      await client.query(`DROP ROLE ${role}`);
    }
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
        $2, CASE WHEN series = 250 THEN $3::bigint ELSE $4::bigint END
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
