import type { Client } from "pg";

import { ClientAccessDeniedError, type ClientCapability } from "./client-access.js";

export interface OAuthMcpGrant {
  omrClientId: string;
  userId: string;
  oauthClientId: string;
  redirectUri: string;
  familyKey: string;
  oauthGrantId: string;
  clientName: string;
  workspaceId: string;
  scopes: ClientCapability[];
  createdAt: number;
  revokedAt: number | null;
}

interface GrantRow {
  omr_client_id: string;
  user_id: string;
  oauth_client_id: string;
  redirect_uri: string;
  family_key: string;
  oauth_grant_id: string;
  client_name: string;
  workspace_id: string;
  scopes: ClientCapability[];
  created_at: string;
  revoked_at: string | null;
}

function toGrant(row: GrantRow): OAuthMcpGrant {
  return {
    omrClientId: row.omr_client_id,
    userId: row.user_id,
    oauthClientId: row.oauth_client_id,
    redirectUri: row.redirect_uri,
    familyKey: row.family_key,
    oauthGrantId: row.oauth_grant_id,
    clientName: row.client_name,
    workspaceId: row.workspace_id,
    scopes: row.scopes,
    createdAt: Number(row.created_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
}

/** PostgreSQL is the immediate, serialized authority for OAuth-backed OMR access. */
export class PostgresOAuthMcpGrants {
  constructor(private readonly client: Client) {}

  async activate(input: Omit<OAuthMcpGrant, "createdAt" | "revokedAt">): Promise<string[]> {
    const now = Date.now();
    await this.client.query("BEGIN");
    try {
      // Hash collisions only serialize unrelated families; equality remains the SQL predicate.
      await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        JSON.stringify([input.userId, input.familyKey]),
      ]);
      const client = await this.client.query<{ id: string }>(
        `SELECT id FROM omr_control.clients
         WHERE id = $1 AND registered_by = $2 AND workspace_id = $3
           AND kind = 'mcp_remote' AND revoked_at IS NULL
         FOR UPDATE`,
        [input.omrClientId, input.userId, input.workspaceId],
      );
      if (client.rowCount !== 1) throw new ClientAccessDeniedError();

      const prior = await this.client.query<{ omr_client_id: string; oauth_grant_id: string }>(
        `SELECT omr_client_id, oauth_grant_id FROM omr_control.oauth_mcp_grants
         WHERE user_id = $1 AND family_key = $2 AND revoked_at IS NULL
         FOR UPDATE`,
        [input.userId, input.familyKey],
      );
      for (const row of prior.rows) {
        await this.client.query(
          `UPDATE omr_control.clients
           SET revoked_at = COALESCE(revoked_at, $2), updated_at = $2 WHERE id = $1`,
          [row.omr_client_id, now],
        );
        await this.client.query(
          `UPDATE omr_control.oauth_mcp_grants
           SET revoked_at = $2 WHERE omr_client_id = $1`,
          [row.omr_client_id, now],
        );
      }
      await this.client.query(
        `INSERT INTO omr_control.oauth_mcp_grants
           (omr_client_id, user_id, oauth_client_id, redirect_uri, family_key,
            oauth_grant_id, client_name, workspace_id, scopes, created_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)`,
        [input.omrClientId, input.userId, input.oauthClientId, input.redirectUri,
          input.familyKey, input.oauthGrantId, input.clientName, input.workspaceId,
          input.scopes, now],
      );
      await this.client.query("COMMIT");
      return prior.rows.map((row) => row.oauth_grant_id);
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  async listActive(userId: string): Promise<OAuthMcpGrant[]> {
    const result = await this.client.query<GrantRow>(
      `SELECT g.* FROM omr_control.oauth_mcp_grants AS g
       INNER JOIN omr_control.clients AS c ON c.id = g.omr_client_id
       WHERE g.user_id = $1 AND g.revoked_at IS NULL AND c.revoked_at IS NULL
       ORDER BY g.created_at DESC, g.omr_client_id DESC`,
      [userId],
    );
    return result.rows.map(toGrant);
  }

  async revoke(userId: string, omrClientId: string): Promise<string> {
    const now = Date.now();
    await this.client.query("BEGIN");
    try {
      const result = await this.client.query<GrantRow>(
        `SELECT * FROM omr_control.oauth_mcp_grants
         WHERE omr_client_id = $1 AND user_id = $2 FOR UPDATE`,
        [omrClientId, userId],
      );
      const grant = result.rows[0];
      if (!grant) throw new ClientAccessDeniedError();
      const client = await this.client.query(
        `UPDATE omr_control.clients
         SET revoked_at = COALESCE(revoked_at, $2), updated_at = $2
         WHERE id = $1 AND registered_by = $3`,
        [omrClientId, now, userId],
      );
      if (client.rowCount !== 1) throw new ClientAccessDeniedError();
      await this.client.query(
        `UPDATE omr_control.oauth_mcp_grants
         SET revoked_at = COALESCE(revoked_at, $2) WHERE omr_client_id = $1`,
        [omrClientId, now],
      );
      await this.client.query("COMMIT");
      return grant.oauth_grant_id;
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }
}
