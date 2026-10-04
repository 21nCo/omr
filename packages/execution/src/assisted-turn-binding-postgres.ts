import pg from "pg";
import type { JsonValue } from "@oh-my-router/tools";
import { decryptJson, encryptJson } from "./postgres-crypto.js";

const { Client } = pg;

export interface AssistedTurnBinding {
  requestFingerprint: string;
  outcome: Record<string, unknown>;
  action?: { connectionId: string; params: Record<string, unknown> };
}

type BindingRow = { request_fingerprint: string; outcome: Record<string, unknown>;
  action_ciphertext: Buffer | null; action_iv: Buffer | null };

async function decodeRow(row: BindingRow, workspaceId: string, userId: string, requestId: string,
  wrappingKey: Uint8Array<ArrayBuffer>): Promise<AssistedTurnBinding> {
  const decoded = row.action_ciphertext && row.action_iv
    ? await decryptJson(row.action_ciphertext, row.action_iv, wrappingKey,
      { kind: "assisted-action", workspaceId, id: `${userId}:${requestId}` }, 1) : null;
  const action = decoded && typeof decoded === "object" && !Array.isArray(decoded)
    ? decoded as { connectionId: string; params: Record<string, unknown> } : undefined;
  return { requestFingerprint: row.request_fingerprint, outcome: row.outcome,
    ...(action ? { action } : {}) };
}

async function withClient<T>(connectionString: string,
  callback: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 3000,
    statement_timeout: 5000 });
  try {
    await client.connect();
    return await callback(client);
  } finally { await client.end().catch(() => undefined); }
}

export async function lookupPostgresAssistedTurn(input: {
  connectionString: string; userId: string; workspaceId: string; requestId: string;
  wrappingKey: Uint8Array<ArrayBuffer>;
}): Promise<AssistedTurnBinding | null> {
  return withClient(input.connectionString, async (client) => {
    const result = await client.query<BindingRow>(`
      SELECT request_fingerprint, outcome, action_ciphertext, action_iv
      FROM omr_control.assisted_turn_bindings
      WHERE workspace_id = $1 AND actor_user_id = $2 AND request_id = $3`,
    [input.workspaceId, input.userId, input.requestId]);
    const row = result.rows[0];
    return row ? decodeRow(row, input.workspaceId, input.userId, input.requestId,
      input.wrappingKey) : null;
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
    const encrypted = input.action ? await encryptJson(input.action as JsonValue,
      input.wrappingKey, { kind: "assisted-action", workspaceId: input.workspaceId,
        id: `${input.userId}:${input.requestId}` }) : null;
    const inserted = await client.query(`
      INSERT INTO omr_control.assisted_turn_bindings
        (workspace_id, actor_user_id, request_id, request_fingerprint, outcome,
          action_ciphertext, action_iv, created_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
      ON CONFLICT (workspace_id, actor_user_id, request_id) DO NOTHING`,
    [...key, input.requestFingerprint, JSON.stringify(input.outcome),
      encrypted ? Buffer.from(encrypted.ciphertext) : null,
      encrypted ? Buffer.from(encrypted.iv) : null, Date.now()]);
    const result = await client.query<BindingRow>(`
      SELECT request_fingerprint, outcome, action_ciphertext, action_iv
      FROM omr_control.assisted_turn_bindings
      WHERE workspace_id = $1 AND actor_user_id = $2 AND request_id = $3`, key);
    const row = result.rows[0];
    if (!row) throw new Error("Assisted turn binding was not visible after insert");
    return { binding: await decodeRow(row, input.workspaceId, input.userId,
      input.requestId, input.wrappingKey),
      created: inserted.rowCount === 1 };
  });
}
