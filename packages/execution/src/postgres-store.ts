import type { Client } from "pg";
import type { JsonValue } from "@oh-my-router/tools";

import type { ExecutionReceipt, ExecutionReceiptStore, ExecutionStatus } from "./execution.js";

interface ReceiptRow {
  id: string;
  workspace_id: string;
  actor_user_id: string;
  principal_key: string;
  tool_id: string;
  manifest_hash: string;
  connection_id: string;
  provider_connection_id: string;
  idempotency_key: string;
  request_hash: string;
  status: ExecutionStatus;
  result_ciphertext: Buffer | null;
  result_iv: Buffer | null;
  error_code: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, workspace_id, actor_user_id, principal_key, tool_id, manifest_hash,
  connection_id, provider_connection_id, idempotency_key, request_hash, status,
  result_ciphertext, result_iv, error_code, started_at, completed_at, created_at, updated_at`;

export class PostgresExecutionReceiptStore implements ExecutionReceiptStore {
  constructor(
    private readonly client: Client,
    private readonly wrappingKey: Uint8Array<ArrayBuffer>,
  ) {
    if (wrappingKey.byteLength !== 32) throw new Error("Execution receipt wrapping key must be 32 bytes");
  }

  async reserve(receipt: ExecutionReceipt): Promise<{ receipt: ExecutionReceipt; created: boolean }> {
    const result = await this.client.query<ReceiptRow>(
      `INSERT INTO omr_control.execution_receipts
         (id, workspace_id, actor_user_id, principal_key, tool_id, manifest_hash,
          connection_id, provider_connection_id, idempotency_key, request_hash, status,
          error_code, started_at, completed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (workspace_id, principal_key, idempotency_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        receipt.id,
        receipt.workspaceId,
        receipt.actorUserId,
        receipt.principalKey,
        receipt.toolId,
        receipt.manifestHash,
        receipt.connectionId,
        receipt.providerConnectionId,
        receipt.idempotencyKey,
        receipt.requestHash,
        receipt.status,
        receipt.errorCode,
        receipt.startedAt,
        receipt.completedAt,
        receipt.createdAt,
        receipt.updatedAt,
      ],
    );
    if (result.rows[0]) return { receipt: await this.toReceipt(result.rows[0]), created: true };
    const existing = await this.client.query<ReceiptRow>(
      `SELECT ${COLUMNS}
       FROM omr_control.execution_receipts
       WHERE workspace_id = $1 AND principal_key = $2 AND idempotency_key = $3`,
      [receipt.workspaceId, receipt.principalKey, receipt.idempotencyKey],
    );
    if (!existing.rows[0]) throw new Error("Idempotency reservation disappeared");
    return { receipt: await this.toReceipt(existing.rows[0]), created: false };
  }

  async succeed(receiptId: string, result: JsonValue, now: number): Promise<ExecutionReceipt> {
    const encrypted = await this.encrypt(result);
    const updated = await this.client.query<ReceiptRow>(
      `UPDATE omr_control.execution_receipts
       SET status = 'succeeded', result_ciphertext = $1, result_iv = $2,
           completed_at = $3, updated_at = $3
       WHERE id = $4 AND status = 'running'
       RETURNING ${COLUMNS}`,
      [encrypted.ciphertext, encrypted.iv, now, receiptId],
    );
    if (!updated.rows[0]) throw new Error("Execution receipt is not running");
    return this.toReceipt(updated.rows[0]);
  }

  async fail(receiptId: string, errorCode: string, now: number): Promise<ExecutionReceipt> {
    const updated = await this.client.query<ReceiptRow>(
      `UPDATE omr_control.execution_receipts
       SET status = 'failed', error_code = $1, completed_at = $2, updated_at = $2
       WHERE id = $3 AND status = 'running'
       RETURNING ${COLUMNS}`,
      [errorCode, now, receiptId],
    );
    if (!updated.rows[0]) throw new Error("Execution receipt is not running");
    return this.toReceipt(updated.rows[0]);
  }

  async listForActor(input: {
    workspaceId: string;
    actorUserId: string;
    limit: number;
  }): Promise<ExecutionReceipt[]> {
    const result = await this.client.query<ReceiptRow>(
      `SELECT ${COLUMNS}
       FROM omr_control.execution_receipts
       WHERE workspace_id = $1 AND actor_user_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [input.workspaceId, input.actorUserId, input.limit],
    );
    return Promise.all(result.rows.map((row) => this.toReceipt(row)));
  }

  private async toReceipt(row: ReceiptRow): Promise<ExecutionReceipt> {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      actorUserId: row.actor_user_id,
      principalKey: row.principal_key,
      toolId: row.tool_id,
      manifestHash: row.manifest_hash,
      connectionId: row.connection_id,
      providerConnectionId: row.provider_connection_id,
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      status: row.status,
      result: row.result_ciphertext && row.result_iv
        ? await this.decrypt(row.result_ciphertext, row.result_iv)
        : null,
      errorCode: row.error_code,
      startedAt: Number(row.started_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private async encrypt(value: JsonValue): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", this.wrappingKey, "AES-GCM", false, ["encrypt"]);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(value)),
    );
    return { ciphertext: new Uint8Array(ciphertext), iv };
  }

  private async decrypt(ciphertext: Buffer, iv: Buffer): Promise<JsonValue> {
    const key = await crypto.subtle.importKey("raw", this.wrappingKey, "AES-GCM", false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(iv) },
      key,
      new Uint8Array(ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as JsonValue;
  }
}
