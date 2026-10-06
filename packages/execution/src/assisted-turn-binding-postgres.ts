import pg from "pg";
import type { JsonValue } from "@oh-my-router/tools";
import { decryptJson, encryptJson } from "./postgres-crypto.js";

const { Client } = pg;
/** Bind retries for a day; execution receipts and approvals remain the action fence. */
export const ASSISTED_TURN_RETENTION_MS = 24 * 60 * 60 * 1000;

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
export async function claimPostgresAssistedTurn(input: TurnIdentity): Promise<{
  binding: AssistedTurnBinding; created: boolean }> {
  return withClient(input.connectionString, async (client) => {
    const key = [input.workspaceId, input.userId, input.requestId];
    await purgeExpired(client, Date.now());
    await client.query(`DELETE FROM omr_control.assisted_turn_bindings
      WHERE workspace_id = $1 AND actor_user_id = $2 AND request_id = $3
        AND expires_at <= $4`, [...key, Date.now()]);
    const inserted = await client.query(`
      INSERT INTO omr_control.assisted_turn_bindings
        (workspace_id, actor_user_id, request_id, request_fingerprint, outcome,
          created_at, expires_at)
      VALUES ($1, $2, $3, $4, '{"kind":"pending"}'::jsonb, $5, $6)
      ON CONFLICT (workspace_id, actor_user_id, request_id) DO NOTHING`,
    [...key, input.requestFingerprint, Date.now(), Date.now() + ASSISTED_TURN_RETENTION_MS]);
    const result = await client.query<BindingRow>(`
      SELECT request_fingerprint, outcome, outcome_ciphertext, outcome_iv,
        action_ciphertext, action_iv
      FROM omr_control.assisted_turn_bindings
      WHERE workspace_id = $1 AND actor_user_id = $2 AND request_id = $3`, key);
    const row = result.rows[0];
    if (!row) throw new Error("Assisted turn claim was not visible after insert");
    return { binding: await decodeRow(row, input.workspaceId, input.userId,
      input.requestId, input.wrappingKey), created: inserted.rowCount === 1 };
  });
}

/** A pre-dispatch failure may release its own pending claim, never a saved outcome. */
export async function abandonPostgresAssistedTurn(input: Omit<TurnIdentity, "wrappingKey">): Promise<void> {
  await withClient(input.connectionString, async (client) => {
    await client.query(`DELETE FROM omr_control.assisted_turn_bindings
      WHERE workspace_id = $1 AND actor_user_id = $2 AND request_id = $3
        AND request_fingerprint = $4 AND outcome->>'kind' = 'pending'`,
    [input.workspaceId, input.userId, input.requestId, input.requestFingerprint]);
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
    const encrypted = input.action ? await encryptJson(input.action as JsonValue,
      input.wrappingKey, { kind: "assisted-action", workspaceId: input.workspaceId,
        id: `${input.userId}:${input.requestId}` }) : null;
    const protectedOutcome = input.outcome.kind === "model"
      ? await encryptJson(input.outcome as JsonValue, input.wrappingKey,
        { kind: "assisted-outcome", workspaceId: input.workspaceId,
          id: `${input.userId}:${input.requestId}` }) : null;
    const updated = await client.query(`
      UPDATE omr_control.assisted_turn_bindings
      SET outcome = $5::jsonb, outcome_ciphertext = $6, outcome_iv = $7,
        action_ciphertext = $8, action_iv = $9
      WHERE workspace_id = $1 AND actor_user_id = $2 AND request_id = $3
        AND request_fingerprint = $4 AND outcome->>'kind' = 'pending'`,
    [...key, input.requestFingerprint,
      JSON.stringify(protectedOutcome ? { kind: "model" } : input.outcome),
      protectedOutcome ? Buffer.from(protectedOutcome.ciphertext) : null,
      protectedOutcome ? Buffer.from(protectedOutcome.iv) : null,
      encrypted ? Buffer.from(encrypted.ciphertext) : null,
      encrypted ? Buffer.from(encrypted.iv) : null]);
    const inserted = updated.rowCount === 1 ? { rowCount: 1 } : await client.query(`
      INSERT INTO omr_control.assisted_turn_bindings
        (workspace_id, actor_user_id, request_id, request_fingerprint, outcome,
          outcome_ciphertext, outcome_iv, action_ciphertext, action_iv, created_at, expires_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (workspace_id, actor_user_id, request_id) DO NOTHING`,
    [...key, input.requestFingerprint,
      JSON.stringify(protectedOutcome ? { kind: "model" } : input.outcome),
      protectedOutcome ? Buffer.from(protectedOutcome.ciphertext) : null,
      protectedOutcome ? Buffer.from(protectedOutcome.iv) : null,
      encrypted ? Buffer.from(encrypted.ciphertext) : null,
      encrypted ? Buffer.from(encrypted.iv) : null,
      Date.now(), Date.now() + ASSISTED_TURN_RETENTION_MS]);
    const result = await client.query<BindingRow>(`
      SELECT request_fingerprint, outcome, outcome_ciphertext, outcome_iv,
        action_ciphertext, action_iv
      FROM omr_control.assisted_turn_bindings
      WHERE workspace_id = $1 AND actor_user_id = $2 AND request_id = $3`, key);
    const row = result.rows[0];
    if (!row) throw new Error("Assisted turn binding was not visible after insert");
    return { binding: await decodeRow(row, input.workspaceId, input.userId,
      input.requestId, input.wrappingKey),
      created: inserted.rowCount === 1 };
  });
}
