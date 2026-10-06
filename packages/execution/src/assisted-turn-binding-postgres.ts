import pg from "pg";
import type { JsonValue } from "@oh-my-router/tools";
import { decryptJson, encryptJson } from "./postgres-crypto.js";

const { Client } = pg;
/** Bind retries for a day; execution receipts and approvals remain the action fence. */
export const ASSISTED_TURN_RETENTION_MS = 24 * 60 * 60 * 1000;
/** An unpaid claim can be recovered after its maximum quota lease expires. */
export const ASSISTED_UNPAID_CLAIM_MS = 110_000;

export interface AssistedTurnBinding {
  requestFingerprint: string;
  outcome: Record<string, unknown>;
  action?: { connectionId: string; params: Record<string, unknown> };
}

type BindingRow = { request_fingerprint: string; outcome: Record<string, unknown>;
  outcome_ciphertext: Buffer | null; outcome_iv: Buffer | null;
  action_ciphertext: Buffer | null; action_iv: Buffer | null };
type TurnIdentity = { connectionString: string; userId: string; workspaceId: string;
  requestId: string; requestFingerprint: string; wrappingKey: Uint8Array<ArrayBuffer> };
type ClaimIdentity = TurnIdentity & { claimId: string };
type ClaimKey = Omit<ClaimIdentity, "wrappingKey"> & { includePending?: boolean };

async function readBinding(client: pg.Client, input: TurnIdentity): Promise<AssistedTurnBinding | null> {
  const result = await client.query<BindingRow>(`
    SELECT request_fingerprint, outcome, outcome_ciphertext, outcome_iv,
      action_ciphertext, action_iv
    FROM omr_control.assisted_turn_bindings
    WHERE workspace_id = $1 AND actor_user_id = $2 AND request_id = $3`,
  [input.workspaceId, input.userId, input.requestId]);
  const row = result.rows[0];
  return row ? decodeRow(row, input.workspaceId, input.userId, input.requestId,
    input.wrappingKey) : null;
}

/** Decrypt only the selected actor's saved action and model-only response. */
async function decodeRow(row: BindingRow, workspaceId: string, userId: string, requestId: string,
  wrappingKey: Uint8Array<ArrayBuffer>): Promise<AssistedTurnBinding> {
  const decoded = row.action_ciphertext && row.action_iv
    ? await decryptJson(row.action_ciphertext, row.action_iv, wrappingKey,
      { kind: "assisted-action", workspaceId, id: `${userId}:${requestId}` }, 1) : null;
  const action = decoded && typeof decoded === "object" && !Array.isArray(decoded)
    ? decoded as { connectionId: string; params: Record<string, unknown> } : undefined;
  const protectedOutcome = row.outcome_ciphertext && row.outcome_iv
    ? await decryptJson(row.outcome_ciphertext, row.outcome_iv, wrappingKey,
      { kind: "assisted-outcome", workspaceId, id: `${userId}:${requestId}` }, 1)
    : row.outcome;
  return { requestFingerprint: row.request_fingerprint,
    outcome: protectedOutcome as Record<string, unknown>,
    ...(action ? { action } : {}) };
}

/** Bound a single binding operation to one short-lived PostgreSQL client. */
async function withClient<T>(connectionString: string,
  callback: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 3000,
    statement_timeout: 5000 });
  try {
    await client.connect();
    return await callback(client);
  } finally { await client.end().catch(() => undefined); }
}

/** Keep request cleanup bounded even when many old bindings have accumulated. */
async function purgeExpired(client: pg.Client, now: number): Promise<void> {
  await client.query(`DELETE FROM omr_control.assisted_turn_bindings
    WHERE ctid IN (SELECT ctid FROM omr_control.assisted_turn_bindings
      WHERE expires_at <= $1 ORDER BY expires_at LIMIT 100)`, [now]);
}

/** Return the unexpired binding for one user, workspace and request identity. */
export async function lookupPostgresAssistedTurn(input: {
  connectionString: string; userId: string; workspaceId: string; requestId: string;
  wrappingKey: Uint8Array<ArrayBuffer>;
}): Promise<AssistedTurnBinding | null> {
  return withClient(input.connectionString, async (client) => {
    await purgeExpired(client, Date.now());
    const result = await client.query<BindingRow>(`
      SELECT request_fingerprint, outcome, outcome_ciphertext, outcome_iv,
        action_ciphertext, action_iv
      FROM omr_control.assisted_turn_bindings
      WHERE workspace_id = $1 AND actor_user_id = $2 AND request_id = $3
        AND expires_at > $4`,
    [input.workspaceId, input.userId, input.requestId, Date.now()]);
    const row = result.rows[0];
    return row ? decodeRow(row, input.workspaceId, input.userId, input.requestId,
      input.wrappingKey) : null;
  });
}

/** First writer reserves an identity before OpenRouter can charge for a choice. */
export async function claimPostgresAssistedTurn(input: ClaimIdentity): Promise<{
  binding: AssistedTurnBinding; created: boolean }> {
  return withClient(input.connectionString, async (client) => {
    const key = [input.workspaceId, input.userId, input.requestId];
    await purgeExpired(client, Date.now());
    await client.query("BEGIN");
    try {
      await client.query(`DELETE FROM omr_control.assisted_turn_bindings
        WHERE workspace_id = $1 AND actor_user_id = $2 AND request_id = $3
          AND expires_at <= $4`, [...key, Date.now()]);
      const now = Date.now();
      const inserted = await client.query(`
        INSERT INTO omr_control.assisted_turn_bindings
          (workspace_id, actor_user_id, request_id, request_fingerprint, claim_id,
            claim_started_at, outcome, created_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, '{"kind":"claimed"}'::jsonb, $6, $7)
        ON CONFLICT (workspace_id, actor_user_id, request_id) DO NOTHING`,
      [...key, input.requestFingerprint, input.claimId, now,
        now + ASSISTED_TURN_RETENTION_MS]);
      const reclaimed = inserted.rowCount === 1 ? false : await reclaimExpiredClaim(client,
        input, now);
      const binding = await readBinding(client, input);
      if (!binding) throw new Error("Assisted turn claim was not visible after insert");
      await client.query("COMMIT");
      return { binding, created: inserted.rowCount === 1 || reclaimed };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

/** Reclaim only an unpaid claim whose entire quota lease has elapsed. */
async function reclaimExpiredClaim(client: pg.Client, input: ClaimIdentity,
  now: number): Promise<boolean> {
  const result = await client.query(`UPDATE omr_control.assisted_turn_bindings
    SET claim_id = $5, claim_started_at = $6
    WHERE workspace_id = $1 AND actor_user_id = $2 AND request_id = $3
      AND request_fingerprint = $4 AND outcome->>'kind' = 'claimed'
      AND claim_started_at <= $7`,
  [input.workspaceId, input.userId, input.requestId, input.requestFingerprint,
    input.claimId, now, now - ASSISTED_UNPAID_CLAIM_MS]);
  return result.rowCount === 1;
}

/** Fence payment to the owner of the unpaid claim before calling OpenRouter. */
export async function startPostgresAssistedModel(input: ClaimKey): Promise<boolean> {
  return withClient(input.connectionString, async (client) => {
    const result = await client.query(`UPDATE omr_control.assisted_turn_bindings
      SET outcome = '{"kind":"pending"}'::jsonb
      WHERE workspace_id = $1 AND actor_user_id = $2 AND request_id = $3
        AND request_fingerprint = $4 AND claim_id = $5
        AND outcome->>'kind' = 'claimed'`,
    [input.workspaceId, input.userId, input.requestId,
      input.requestFingerprint, input.claimId]);
    return result.rowCount === 1;
  });
}

/** A proven pre-dispatch failure may release its own claimed or started row. */
export async function abandonPostgresAssistedTurn(input: ClaimKey): Promise<void> {
  await withClient(input.connectionString, async (client) => {
    await client.query(`DELETE FROM omr_control.assisted_turn_bindings
      WHERE workspace_id = $1 AND actor_user_id = $2 AND request_id = $3
        AND request_fingerprint = $4 AND claim_id = $5
        AND outcome->>'kind' = ANY($6::text[])`,
    [input.workspaceId, input.userId, input.requestId, input.requestFingerprint,
      input.claimId, input.includePending ? ["claimed", "pending"] : ["claimed"]]);
  });
}

/** The first committed outcome wins, even if a timed-out caller resumes later. */
export async function bindPostgresAssistedTurn(input: {
  connectionString: string; userId: string; workspaceId: string; requestId: string;
  requestFingerprint: string; outcome: Record<string, unknown>;
  action?: { connectionId: string; params: Record<string, unknown> };
  wrappingKey: Uint8Array<ArrayBuffer>;
}): Promise<{ binding: AssistedTurnBinding; created: boolean }> {
  return withClient(input.connectionString, async (client) => {
    const key = [input.workspaceId, input.userId, input.requestId];
    await purgeExpired(client, Date.now());
    await client.query(`DELETE FROM omr_control.assisted_turn_bindings
      WHERE workspace_id = $1 AND actor_user_id = $2 AND request_id = $3
        AND expires_at <= $4`, [...key, Date.now()]);
    const stored = await encodeBinding(input);
    const updated = await client.query(`
      UPDATE omr_control.assisted_turn_bindings
      SET outcome = $5::jsonb, outcome_ciphertext = $6, outcome_iv = $7,
        action_ciphertext = $8, action_iv = $9, claim_id = NULL, claim_started_at = NULL
      WHERE workspace_id = $1 AND actor_user_id = $2 AND request_id = $3
        AND request_fingerprint = $4 AND outcome->>'kind' = 'pending'`,
    [...key, input.requestFingerprint, ...stored]);
    const inserted = updated.rowCount === 1 ? { rowCount: 1 } : await client.query(`
      INSERT INTO omr_control.assisted_turn_bindings
        (workspace_id, actor_user_id, request_id, request_fingerprint, outcome,
          outcome_ciphertext, outcome_iv, action_ciphertext, action_iv, created_at, expires_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (workspace_id, actor_user_id, request_id) DO NOTHING`,
    [...key, input.requestFingerprint, ...stored,
      Date.now(), Date.now() + ASSISTED_TURN_RETENTION_MS]);
    const binding = await readBinding(client, input);
    if (!binding) throw new Error("Assisted turn binding was not visible after insert");
    return { binding, created: inserted.rowCount === 1 };
  });
}

/** Encrypt model answers and action arguments before either finalization path. */
async function encodeBinding(input: {
  workspaceId: string; userId: string; requestId: string; wrappingKey: Uint8Array<ArrayBuffer>;
  outcome: Record<string, unknown>; action?: { connectionId: string; params: Record<string, unknown> };
}): Promise<[string, Buffer | null, Buffer | null, Buffer | null, Buffer | null]> {
  const context = { workspaceId: input.workspaceId, id: `${input.userId}:${input.requestId}` };
  const encrypted = input.action ? await encryptJson(input.action as JsonValue,
    input.wrappingKey, { kind: "assisted-action", ...context }) : null;
  const protectedOutcome = input.outcome.kind === "model"
    ? await encryptJson(input.outcome as JsonValue, input.wrappingKey,
      { kind: "assisted-outcome", ...context }) : null;
  return [JSON.stringify(protectedOutcome ? { kind: "model" } : input.outcome),
    protectedOutcome ? Buffer.from(protectedOutcome.ciphertext) : null,
    protectedOutcome ? Buffer.from(protectedOutcome.iv) : null,
    encrypted ? Buffer.from(encrypted.ciphertext) : null,
    encrypted ? Buffer.from(encrypted.iv) : null];
}
