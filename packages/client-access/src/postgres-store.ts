import type { Client } from "pg";

import {
  ClientAccessDeniedError,
  InvalidClientCredentialError,
  type ClientAccessStore,
  type ClientCapability,
  type ClientGrantRecord,
  type ClientKind,
  type ClientPrincipal,
  type ClientRecord,
  type IssueClientGrantInput,
  type ListManualClientGrantsInput,
  type ManualClientGrant,
  type RegisterClientInput,
  type RevokeClientAccessInput,
} from "./client-access.js";

interface ClientRow {
  id: string;
  workspace_id: string;
  kind: ClientKind;
  name: string;
  registered_by: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface GrantRow {
  id: string;
  client_id: string;
  workspace_id: string;
  user_id: string;
  capabilities: ClientCapability[];
  credential_hash: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PrincipalRow {
  grant_id: string;
  client_id: string;
  workspace_id: string;
  user_id: string;
  kind: ClientKind;
  capabilities: ClientCapability[];
}

interface ManualGrantRow {
  id: string;
  client_id: string;
  workspace_id: string;
  name: string;
  kind: ClientKind;
  capabilities: ClientCapability[];
  expires_at: string;
  created_at: string;
}

function toClient(row: ClientRow): ClientRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    name: row.name,
    registeredBy: row.registered_by,
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toGrant(row: GrantRow): ClientGrantRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    capabilities: row.capabilities,
    credentialHash: row.credential_hash,
    expiresAt: Number(row.expires_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class PostgresClientAccessStore implements ClientAccessStore {
  constructor(private readonly client: Client) {}

  async registerClient(input: RegisterClientInput): Promise<ClientRecord> {
    await this.client.query("BEGIN");
    try {
      await this.requireMembership(
        input.client.workspaceId,
        input.actorUserId,
      );
      const client = input.client;
      const result = await this.client.query<ClientRow>(
        `INSERT INTO omr_control.clients
           (id, workspace_id, kind, name, registered_by, revoked_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, workspace_id, kind, name, registered_by, revoked_at, created_at, updated_at`,
        [
          client.id,
          client.workspaceId,
          client.kind,
          client.name,
          client.registeredBy,
          client.revokedAt,
          client.createdAt,
          client.updatedAt,
        ],
      );
      await this.client.query("COMMIT");
      return toClient(result.rows[0]!);
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  async issueGrant(input: IssueClientGrantInput): Promise<ClientGrantRecord> {
    await this.client.query("BEGIN");
    try {
      const clientResult = await this.client.query<ClientRow>(
        `SELECT id, workspace_id, kind, name, registered_by, revoked_at, created_at, updated_at
         FROM omr_control.clients
         WHERE id = $1
         FOR UPDATE`,
        [input.grant.clientId],
      );
      const client = clientResult.rows[0];
      if (
        !client ||
        client.revoked_at !== null ||
        client.workspace_id !== input.grant.workspaceId ||
        client.registered_by !== input.actorUserId
      ) {
        throw new ClientAccessDeniedError();
      }
      await this.requireMembership(client.workspace_id, input.actorUserId);

      const grant = input.grant;
      const result = await this.client.query<GrantRow>(
        `INSERT INTO omr_control.client_grants
           (id, client_id, workspace_id, user_id, capabilities, credential_hash,
            expires_at, revoked_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, client_id, workspace_id, user_id, capabilities, credential_hash,
                   expires_at, revoked_at, created_at, updated_at`,
        [
          grant.id,
          grant.clientId,
          grant.workspaceId,
          grant.userId,
          grant.capabilities,
          grant.credentialHash,
          grant.expiresAt,
          grant.revokedAt,
          grant.createdAt,
          grant.updatedAt,
        ],
      );
      await this.client.query("COMMIT");
      return toGrant(result.rows[0]!);
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  async authenticate(credentialHash: string, now: number): Promise<ClientPrincipal> {
    const result = await this.client.query<PrincipalRow>(
      `SELECT g.id AS grant_id, client.id AS client_id,
              g.workspace_id, g.user_id, client.kind, g.capabilities
       FROM omr_control.client_grants AS g
       INNER JOIN omr_control.clients AS client ON client.id = g.client_id
       INNER JOIN omr_control.workspace_memberships AS membership
         ON membership.workspace_id = g.workspace_id
        AND membership.user_id = g.user_id
       WHERE g.credential_hash = $1
         AND g.revoked_at IS NULL
         AND client.revoked_at IS NULL
         AND g.expires_at > $2
       LIMIT 1`,
      [credentialHash, now],
    );
    const principal = result.rows[0];
    if (!principal) throw new InvalidClientCredentialError();
    return {
      grantId: principal.grant_id,
      clientId: principal.client_id,
      workspaceId: principal.workspace_id,
      userId: principal.user_id,
      kind: principal.kind,
      capabilities: principal.capabilities,
    };
  }

  async listManualGrants(input: ListManualClientGrantsInput): Promise<ManualClientGrant[]> {
    const result = await this.client.query<ManualGrantRow>(
      `SELECT g.id, g.client_id, g.workspace_id, c.name, c.kind,
              g.capabilities, g.expires_at, g.created_at
       FROM omr_control.client_grants AS g
       INNER JOIN omr_control.clients AS c ON c.id = g.client_id
       WHERE c.registered_by = $1 AND g.user_id = $1
         AND c.revoked_at IS NULL AND g.revoked_at IS NULL AND g.expires_at > $2
         AND NOT EXISTS (
           SELECT 1 FROM omr_control.oauth_mcp_grants AS oauth
           WHERE oauth.omr_client_id = c.id
         )
         AND ($3::bigint IS NULL OR (g.created_at, g.id) < ($3, $4))
       ORDER BY g.created_at DESC, g.id DESC
       LIMIT $5`,
      [input.actorUserId, input.now, input.after?.createdAt ?? null,
        input.after?.id ?? null, input.limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      workspaceId: row.workspace_id,
      clientName: row.name,
      kind: row.kind,
      capabilities: row.capabilities,
      expiresAt: Number(row.expires_at),
      createdAt: Number(row.created_at),
    }));
  }

  async revokeManualClient(input: RevokeClientAccessInput): Promise<void> {
    await this.client.query("BEGIN");
    try {
      const result = await this.client.query<{ id: string; registered_by: string }>(
        `SELECT id, registered_by FROM omr_control.clients
         WHERE id = $1 FOR UPDATE`,
        [input.targetId],
      );
      if (result.rows[0]?.registered_by !== input.actorUserId) {
        throw new ClientAccessDeniedError();
      }
      // OAuth activation locks the same client row, so these paths cannot race.
      const oauth = await this.client.query(
        `SELECT 1 FROM omr_control.oauth_mcp_grants
         WHERE omr_client_id = $1 LIMIT 1`,
        [input.targetId],
      );
      if (oauth.rowCount) throw new ClientAccessDeniedError();
      await this.client.query(
        `UPDATE omr_control.clients
         SET revoked_at = COALESCE(revoked_at, $1), updated_at = $1
         WHERE id = $2`,
        [input.now, input.targetId],
      );
      await this.client.query("COMMIT");
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  async revokeGrant(input: RevokeClientAccessInput): Promise<void> {
    await this.revoke(input, "grant");
  }

  async revokeClient(input: RevokeClientAccessInput): Promise<void> {
    await this.revoke(input, "client");
  }

  private async revoke(
    input: RevokeClientAccessInput,
    target: "client" | "grant",
  ): Promise<void> {
    await this.client.query("BEGIN");
    try {
      const result = await this.client.query<ClientRow>(
        target === "client"
          ? `SELECT id, workspace_id, kind, name, registered_by, revoked_at, created_at, updated_at
             FROM omr_control.clients WHERE id = $1 FOR UPDATE`
          : `SELECT client.id, client.workspace_id, client.kind, client.name,
                    client.registered_by, client.revoked_at, client.created_at, client.updated_at
             FROM omr_control.client_grants AS g
             INNER JOIN omr_control.clients AS client ON client.id = g.client_id
             WHERE g.id = $1 FOR UPDATE OF g, client`,
        [input.targetId],
      );
      const client = result.rows[0];
      if (!client) throw new ClientAccessDeniedError();
      // A former member must still be able to cancel a credential they issued.
      // Managing another user's client continues to require active admin access.
      if (client.registered_by !== input.actorUserId) {
        const role = await this.requireMembership(client.workspace_id, input.actorUserId);
        if (role !== "owner" && role !== "admin") {
          throw new ClientAccessDeniedError();
        }
      }

      if (target === "client") {
        await this.client.query(
          `UPDATE omr_control.clients
           SET revoked_at = COALESCE(revoked_at, $1), updated_at = $1
           WHERE id = $2`,
          [input.now, input.targetId],
        );
      } else {
        await this.client.query(
          `UPDATE omr_control.client_grants
           SET revoked_at = COALESCE(revoked_at, $1), updated_at = $1
           WHERE id = $2`,
          [input.now, input.targetId],
        );
      }
      await this.client.query("COMMIT");
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  private async requireMembership(
    workspaceId: string,
    userId: string,
  ): Promise<"owner" | "admin" | "member"> {
    const result = await this.client.query<{ role: "owner" | "admin" | "member" }>(
      `SELECT role
       FROM omr_control.workspace_memberships
       WHERE workspace_id = $1 AND user_id = $2
       FOR SHARE`,
      [workspaceId, userId],
    );
    const role = result.rows[0]?.role;
    if (!role) throw new ClientAccessDeniedError();
    return role;
  }
}
