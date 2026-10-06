import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reservePostgresAssistedRecovery, reservePostgresAssistedTurn,
  AssistedTurnQuotaExceededError,
  ASSISTED_TURN_REQUESTS_PER_HOUR } from "./assisted-turn-quota-postgres.js";

const { Client } = pg;
const connectionString = process.env.OMR_TEST_DATABASE_URL;
const describeDatabase = connectionString ? describe : describe.skip;

describeDatabase("assisted PostgreSQL quota", () => {
  const alice = `assisted-${crypto.randomUUID()}`;
  const bob = `assisted-${crypto.randomUUID()}`;
  let client: pg.Client;

  beforeAll(async () => {
    client = new Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(new URL("../migrations/0002_identity.sql", import.meta.url), "utf8"));
    await client.query(readFileSync(new URL("../migrations/0021_assisted_turn_quota.sql", import.meta.url), "utf8"));
    await client.query(`INSERT INTO omr_identity.users (id, created_at, updated_at) VALUES
      ($1, now(), now()), ($2, now(), now())`, [alice, bob]);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("DELETE FROM omr_identity.users WHERE id IN ($1, $2)", [alice, bob]);
    await client.end();
  });

  it("enforces a cross-connection active claim and ten starts per user hour", async () => {
    const now = Date.now();
    const releaseAlice = await reservePostgresAssistedTurn(connectionString!, alice, now);
    await expect(reservePostgresAssistedTurn(connectionString!, alice, now + 1))
      .rejects.toBeInstanceOf(AssistedTurnQuotaExceededError);
    const releaseBob = await reservePostgresAssistedTurn(connectionString!, bob, now + 1);
    await releaseBob();
    await releaseAlice();
    for (let index = 1; index < ASSISTED_TURN_REQUESTS_PER_HOUR; index += 1) {
      const release = await reservePostgresAssistedTurn(connectionString!, alice, now + index * 10);
      await release();
    }
    await expect(reservePostgresAssistedTurn(connectionString!, alice, now + 200))
      .rejects.toBeInstanceOf(AssistedTurnQuotaExceededError);
    const nextHour = await reservePostgresAssistedTurn(connectionString!, alice, now + 3_600_001);
    await nextHour();
  });

  it("recovery claims the same user slot without increasing hourly starts", async () => {
    const user = `assisted-recovery-${crypto.randomUUID()}`;
    await client.query(`INSERT INTO omr_identity.users (id, created_at, updated_at)
      VALUES ($1, now(), now())`, [user]);
    try {
      const now = Date.now();
      const first = await reservePostgresAssistedTurn(connectionString!, user, now);
      await expect(reservePostgresAssistedRecovery(connectionString!, user, now + 1))
        .rejects.toBeInstanceOf(AssistedTurnQuotaExceededError);
      await first();
      const recovery = await reservePostgresAssistedRecovery(connectionString!, user, now + 2);
      await expect(reservePostgresAssistedTurn(connectionString!, user, now + 3))
        .rejects.toBeInstanceOf(AssistedTurnQuotaExceededError);
      await recovery();
      const count = await client.query<{ request_count: number }>(
        `SELECT request_count FROM omr_identity.assisted_turn_quota WHERE user_id = $1`, [user]);
      expect(count.rows[0]?.request_count).toBe(1);
    } finally {
      await client.query("DELETE FROM omr_identity.users WHERE id = $1", [user]);
    }
  });
});
