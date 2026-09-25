import type { Client } from "pg";

import type {
  ClientCapability,
  ClientGrantRecord,
  ClientRecord,
} from "./client-access.js";
import {
  DeviceAuthorizationError,
  type ApproveDeviceAuthorizationInput,
  type ConsumeDeviceAuthorizationInput,
  type DeviceAuthorizationRecord,
  type DeviceAuthorizationStatus,
  type DeviceAuthorizationStore,
  type DeviceClientKind,
} from "./device-login.js";

interface DeviceAuthorizationRow {
  id: string;
  device_code_hash: string;
  user_code_hash: string;
  client_kind: DeviceClientKind;
  client_name: string;
  requested_capabilities: ClientCapability[];
  status: DeviceAuthorizationStatus;
  workspace_id: string | null;
  user_id: string | null;
  client_id: string | null;
  grant_id: string | null;
  sealed_credential: string | null;
  expires_at: string;
  poll_interval_ms: number;
  created_at: string;
  updated_at: string;
}

const DEVICE_COLUMNS = `id, device_code_hash, user_code_hash, client_kind, client_name,
  requested_capabilities, status, workspace_id, user_id, client_id, grant_id,
  sealed_credential, expires_at, poll_interval_ms, created_at, updated_at`;

function toAuthorization(row: DeviceAuthorizationRow): DeviceAuthorizationRecord {
  return {
    id: row.id,
    deviceCodeHash: row.device_code_hash,
    userCodeHash: row.user_code_hash,
    clientKind: row.client_kind,
    clientName: row.client_name,
    requestedCapabilities: row.requested_capabilities,
    status: row.status,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    clientId: row.client_id,
    grantId: row.grant_id,
    sealedCredential: row.sealed_credential,
    expiresAt: Number(row.expires_at),
    pollIntervalMs: row.poll_interval_ms,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class PostgresDeviceAuthorizationStore implements DeviceAuthorizationStore {
  constructor(private readonly client: Client) {}

  async create(record: DeviceAuthorizationRecord): Promise<DeviceAuthorizationRecord> {
    const result = await this.client.query<DeviceAuthorizationRow>(
      `INSERT INTO omr_control.device_authorizations
         (id, device_code_hash, user_code_hash, client_kind, client_name,
          requested_capabilities, status, workspace_id, user_id, client_id, grant_id,
          sealed_credential, expires_at, poll_interval_ms, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING ${DEVICE_COLUMNS}`,
      [
        record.id,
        record.deviceCodeHash,
        record.userCodeHash,
        record.clientKind,
        record.clientName,
        record.requestedCapabilities,
        record.status,
        record.workspaceId,
        record.userId,
        record.clientId,
        record.grantId,
        record.sealedCredential,
        record.expiresAt,
        record.pollIntervalMs,
        record.createdAt,
        record.updatedAt,
      ],
    );
    return toAuthorization(result.rows[0]!);
  }

  async findByUserCodeHash(userCodeHash: string): Promise<DeviceAuthorizationRecord | null> {
    return this.find("user_code_hash", userCodeHash);
  }

  async findByDeviceCodeHash(deviceCodeHash: string): Promise<DeviceAuthorizationRecord | null> {
    return this.find("device_code_hash", deviceCodeHash);
  }

  async approve(
    input: ApproveDeviceAuthorizationInput,
  ): Promise<{ client: ClientRecord; grant: ClientGrantRecord }> {
    await this.client.query("BEGIN");
    try {
      const authorizationResult = await this.client.query<DeviceAuthorizationRow>(
        `SELECT ${DEVICE_COLUMNS}
         FROM omr_control.device_authorizations
         WHERE id = $1 AND user_code_hash = $2
         FOR UPDATE`,
        [input.authorizationId, input.userCodeHash],
      );
      const authorization = authorizationResult.rows[0];
      if (
        !authorization ||
        authorization.status !== "pending" ||
        Number(authorization.expires_at) <= input.now
      ) {
        throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_INVALID");
      }

      const membership = await this.client.query(
        `SELECT 1
         FROM omr_control.workspace_memberships
         WHERE workspace_id = $1 AND user_id = $2
         FOR SHARE`,
        [input.workspaceId, input.actorUserId],
      );
      if (membership.rowCount !== 1) {
        throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_INVALID");
      }

      const client: ClientRecord = {
        id: input.clientId,
        workspaceId: input.workspaceId,
        kind: authorization.client_kind,
        name: authorization.client_name,
        registeredBy: input.actorUserId,
        revokedAt: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      const grant: ClientGrantRecord = {
        id: input.grantId,
        clientId: input.clientId,
        workspaceId: input.workspaceId,
        userId: input.actorUserId,
        capabilities: authorization.requested_capabilities,
        credentialHash: input.credentialHash,
        expiresAt: input.grantExpiresAt,
        revokedAt: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      await this.client.query(
        `INSERT INTO omr_control.clients
           (id, workspace_id, kind, name, registered_by, revoked_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NULL, $6, $6)`,
        [client.id, client.workspaceId, client.kind, client.name, client.registeredBy, input.now],
      );
      await this.client.query(
        `INSERT INTO omr_control.client_grants
           (id, client_id, workspace_id, user_id, capabilities, credential_hash,
            expires_at, revoked_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $8)`,
        [
          grant.id,
          grant.clientId,
          grant.workspaceId,
          grant.userId,
          grant.capabilities,
          grant.credentialHash,
          grant.expiresAt,
          input.now,
        ],
      );
      await this.client.query(
        `UPDATE omr_control.device_authorizations
         SET status = 'approved', workspace_id = $1, user_id = $2, client_id = $3,
             grant_id = $4, sealed_credential = $5, updated_at = $6
         WHERE id = $7`,
        [
          input.workspaceId,
          input.actorUserId,
          input.clientId,
          input.grantId,
          input.sealedCredential,
          input.now,
          input.authorizationId,
        ],
      );
      await this.client.query("COMMIT");
      return { client, grant };
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  async consume(input: ConsumeDeviceAuthorizationInput): Promise<void> {
    const result = await this.client.query(
      `UPDATE omr_control.device_authorizations
       SET status = 'consumed', sealed_credential = NULL, updated_at = $1
       WHERE id = $2 AND device_code_hash = $3 AND status = 'approved' AND expires_at > $1`,
      [input.now, input.authorizationId, input.deviceCodeHash],
    );
    if (result.rowCount !== 1) {
      throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_INVALID");
    }
  }

  private async find(
    column: "user_code_hash" | "device_code_hash",
    value: string,
  ): Promise<DeviceAuthorizationRecord | null> {
    const result = await this.client.query<DeviceAuthorizationRow>(
      `SELECT ${DEVICE_COLUMNS}
       FROM omr_control.device_authorizations
       WHERE ${column} = $1
       LIMIT 1`,
      [value],
    );
    return result.rows[0] ? toAuthorization(result.rows[0]) : null;
  }
}
