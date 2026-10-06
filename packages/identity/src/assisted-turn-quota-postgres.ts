import pg from "pg";

const { Client } = pg;
export const ASSISTED_TURN_REQUESTS_PER_HOUR = 10;
const WINDOW_MS = 60 * 60 * 1000;
// 35-second assisted response plus the shared execution service's 60-second
// invocation and five-second cleanup; leave room for delayed socket closure.
const LEASE_MS = 110_000;

export class AssistedTurnQuotaExceededError extends Error {
  readonly code = "ASSISTED_RATE_LIMITED";
  constructor() { super("Personal assisted-turn limit reached"); }
}

/** Release only the lease held by this request, even if a later request replaced it. */
function releaseClaim(connectionString: string, userId: string, activeId: string) {
  return async () => {
    const release = new Client({ connectionString, connectionTimeoutMillis: 3000,
      statement_timeout: 5000 });
    try {
      await release.connect();
      await release.query(`UPDATE omr_identity.assisted_turn_quota
        SET active_id = NULL, active_until_ms = 0
        WHERE user_id = $1 AND active_id = $2`, [userId, activeId]);
    } finally { await release.end().catch(() => undefined); }
  };
}

/** A database claim arbitrates requests across Worker isolates before either model call. */
export async function reservePostgresAssistedTurn(connectionString: string, userId: string,
  now = Date.now()): Promise<() => Promise<void>> {
  const activeId = crypto.randomUUID();
  const client = new Client({ connectionString, connectionTimeoutMillis: 3000,
    statement_timeout: 5000 });
  try {
    await client.connect();
    const claimed = await client.query<{ user_id: string }>(`
      INSERT INTO omr_identity.assisted_turn_quota AS quota
        (user_id, window_start_ms, request_count, active_id, active_until_ms)
      VALUES ($1, $2, 1, $3, $4)
      ON CONFLICT (user_id) DO UPDATE SET
        window_start_ms = CASE WHEN quota.window_start_ms <= $2 - $5
          THEN $2 ELSE quota.window_start_ms END,
        request_count = CASE WHEN quota.window_start_ms <= $2 - $5
          THEN 1 ELSE quota.request_count + 1 END,
        active_id = $3, active_until_ms = $4
      WHERE quota.active_until_ms <= $2 AND
        (quota.window_start_ms <= $2 - $5 OR quota.request_count < $6)
      RETURNING user_id`,
    [userId, now, activeId, now + LEASE_MS, WINDOW_MS, ASSISTED_TURN_REQUESTS_PER_HOUR]);
    if (claimed.rowCount !== 1) throw new AssistedTurnQuotaExceededError();
  } finally { await client.end().catch(() => undefined); }
  return releaseClaim(connectionString, userId, activeId);
}

/** Claim a saved action's slot without charging a second model turn. */
export async function reservePostgresAssistedRecovery(connectionString: string, userId: string,
  now = Date.now()): Promise<() => Promise<void>> {
  const activeId = crypto.randomUUID();
  const client = new Client({ connectionString, connectionTimeoutMillis: 3000,
    statement_timeout: 5000 });
  try {
    await client.connect();
    const claimed = await client.query(`UPDATE omr_identity.assisted_turn_quota
      SET active_id = $2, active_until_ms = $3
      WHERE user_id = $1 AND active_until_ms <= $4
      RETURNING user_id`, [userId, activeId, now + LEASE_MS, now]);
    if (claimed.rowCount !== 1) throw new AssistedTurnQuotaExceededError();
  } finally { await client.end().catch(() => undefined); }
  return releaseClaim(connectionString, userId, activeId);
}
