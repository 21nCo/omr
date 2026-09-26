import type { Client } from "pg";

import {
  ConnectionAccessDeniedError,
  ConnectionUnavailableError,
  type AccessConnectionInput,
  type AttachConnectionInput,
  type AuthorizeConnectionInstallInput,
  type ConnectionBindingRecord,
  type ConnectionBindingStore,
  type ConnectionLifecycleStatus,
  type ConnectionOwnership,
  type ConnectionReadiness,
  type ConnectionSelectionRecord,
  type ConditionalRevokeInput,
  type RevokeConnectionInput,
  type SelectConnectionInput,
} from "./connections.js";

interface ConnectionRow {
  id: string;
  workspace_id: string;
  provider: string;
  provider_connection_id: string;
  ownership: ConnectionOwnership;
  owner_user_id: string | null;
  installed_by: string;
  label: string;
  status: ConnectionLifecycleStatus;
  readiness: ConnectionReadiness;
  health_reason: string | null;
  last_checked_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SelectionRow {
  workspace_id: string;
  user_id: string;
  provider: string;
  connection_id: string;
  created_at: string;
  updated_at: string;
}

const CONNECTION_COLUMNS = `id, workspace_id, provider, provider_connection_id,
  ownership, owner_user_id, installed_by, label, status, readiness, health_reason,
  last_checked_at, revoked_at, created_at, updated_at`;

/** Normalize database binding fields and timestamps for the authority layer. */
function toConnection(row: ConnectionRow): ConnectionBindingRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    providerConnectionId: row.provider_connection_id,
    ownership: row.ownership,
    ownerUserId: row.owner_user_id,
    installedBy: row.installed_by,
    label: row.label,
    status: row.status,
    readiness: row.readiness,
    healthReason: row.health_reason,
    lastCheckedAt: row.last_checked_at === null ? null : Number(row.last_checked_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Normalize database timestamp fields in a saved account selection. */
function toSelection(row: SelectionRow): ConnectionSelectionRecord {
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    provider: row.provider,
    connectionId: row.connection_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class PostgresConnectionBindingStore implements ConnectionBindingStore {
  constructor(private readonly client: Client) {}

  /** Apply workspace role rules before provider setup. */
  async authorizeInstall(input: AuthorizeConnectionInstallInput): Promise<void> {
    const role = await this.membershipRole(input.workspaceId, input.actorUserId);
    if (!role || (input.ownership === "workspace" && role !== "owner" && role !== "admin")) {
      throw new ConnectionAccessDeniedError();
    }
  }

  /** Persist a binding after checking install authority in the same transaction. */
  async attach(input: AttachConnectionInput): Promise<ConnectionBindingRecord> {
    await this.client.query("BEGIN");
    try {
      const role = await this.membershipRole(
        input.connection.workspaceId,
        input.actorUserId,
      );
      if (
        !role ||
        (input.connection.ownership === "workspace" && role !== "owner" && role !== "admin")
      ) {
        throw new ConnectionAccessDeniedError();
      }
      const c = input.connection;
      const result = await this.client.query<ConnectionRow>(
        `INSERT INTO omr_control.connection_bindings
           (id, workspace_id, provider, provider_connection_id, ownership, owner_user_id,
            installed_by, label, status, readiness, health_reason, last_checked_at,
            revoked_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING ${CONNECTION_COLUMNS}`,
        [
          c.id,
          c.workspaceId,
          c.provider,
          c.providerConnectionId,
          c.ownership,
          c.ownerUserId,
          c.installedBy,
          c.label,
          c.status,
          c.readiness,
          c.healthReason,
          c.lastCheckedAt,
          c.revokedAt,
          c.createdAt,
          c.updatedAt,
        ],
      );
      await this.client.query("COMMIT");
      return toConnection(result.rows[0]!);
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  /** Return a binding only to an actor permitted to use it. */
  async getAccessible(input: AccessConnectionInput): Promise<ConnectionBindingRecord> {
    const connection = await this.readConnection(input.connectionId);
    if (!connection) throw new ConnectionAccessDeniedError();
    const role = await this.membershipRole(connection.workspace_id, input.actorUserId);
    const authorized = Boolean(role) &&
      (connection.ownership === "workspace" || connection.owner_user_id === input.actorUserId);
    if (!authorized) throw new ConnectionAccessDeniedError();
    return toConnection(connection);
  }

  /** Read lifecycle state under current ownership and role rules. */
  async getManageable(input: AccessConnectionInput): Promise<ConnectionBindingRecord> {
    const connection = await this.readConnection(input.connectionId);
    if (!connection) throw new ConnectionAccessDeniedError();
    if (!await this.canManage(connection, input.actorUserId)) throw new ConnectionAccessDeniedError();
    return toConnection(connection);
  }

  /** Include orphan cleanup authority without granting account use. */
  async getRevocable(input: AccessConnectionInput): Promise<ConnectionBindingRecord> {
    const connection = await this.readConnection(input.connectionId);
    // This read is advisory: revoke and revokeIf repeat authorization while
    // holding the workspace lock in their mutation transactions.
    if (!connection || !await this.canManage(connection, input.actorUserId, true)) {
      throw new ConnectionAccessDeniedError();
    }
    return toConnection(connection);
  }

  /** List only bindings visible to this workspace member. */
  async listAvailable(input: {
    actorUserId: string;
    workspaceId: string;
    provider?: string;
  }): Promise<ConnectionBindingRecord[]> {
    if (!(await this.membershipRole(input.workspaceId, input.actorUserId))) {
      throw new ConnectionAccessDeniedError();
    }
    const result = await this.client.query<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS}
       FROM omr_control.connection_bindings
       WHERE workspace_id = $1
         AND ($2::text IS NULL OR provider = $2)
         AND (ownership = 'workspace' OR owner_user_id = $3)
       ORDER BY created_at, id`,
      [input.workspaceId, input.provider ?? null, input.actorUserId],
    );
    return result.rows.map(toConnection);
  }

  /** Discover former members' personal bindings after checking the caller's current role. */
  async listOrphanedForCleanup(input: { actorUserId: string; workspaceId: string }): Promise<ConnectionBindingRecord[]> {
    const role = await this.membershipRole(input.workspaceId, input.actorUserId);
    if (role !== "owner" && role !== "admin") throw new ConnectionAccessDeniedError();
    const result = await this.client.query<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS}
       FROM omr_control.connection_bindings AS binding
       WHERE binding.workspace_id = $1 AND binding.ownership = 'personal'
         AND NOT EXISTS (
           SELECT 1 FROM omr_control.workspace_memberships AS member
           WHERE member.workspace_id = binding.workspace_id AND member.user_id = binding.owner_user_id
         )
       ORDER BY binding.created_at, binding.id`,
      [input.workspaceId],
    );
    return result.rows.map(toConnection);
  }

  /** Read a member's provider choice only while membership is current. */
  async getSelection(input: {
    actorUserId: string;
    workspaceId: string;
    provider: string;
  }): Promise<ConnectionSelectionRecord | null> {
    if (!(await this.membershipRole(input.workspaceId, input.actorUserId))) {
      throw new ConnectionAccessDeniedError();
    }
    const result = await this.client.query<SelectionRow>(
      `SELECT workspace_id, user_id, provider, connection_id, created_at, updated_at
       FROM omr_control.connection_selections
       WHERE workspace_id = $1 AND user_id = $2 AND provider = $3`,
      [input.workspaceId, input.actorUserId, input.provider],
    );
    return result.rows[0] ? toSelection(result.rows[0]) : null;
  }

  /** Persist an eligible account choice under current access rules. */
  async select(input: SelectConnectionInput): Promise<ConnectionSelectionRecord> {
    await this.client.query("BEGIN");
    try {
      if (!(await this.membershipRole(input.workspaceId, input.actorUserId))) {
        throw new ConnectionAccessDeniedError();
      }
      const available = await this.client.query(
        `SELECT 1
         FROM omr_control.connection_bindings
         WHERE id = $1 AND workspace_id = $2 AND provider = $3
           AND status = 'active' AND readiness = 'ready'
           AND (ownership = 'workspace' OR owner_user_id = $4)
         FOR SHARE`,
        [input.connectionId, input.workspaceId, input.provider, input.actorUserId],
      );
      if (available.rowCount !== 1) throw new ConnectionUnavailableError();
      const result = await this.client.query<SelectionRow>(
        `INSERT INTO omr_control.connection_selections
           (workspace_id, user_id, provider, connection_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (workspace_id, user_id, provider) DO UPDATE
         SET connection_id = EXCLUDED.connection_id, updated_at = EXCLUDED.updated_at
         RETURNING workspace_id, user_id, provider, connection_id, created_at, updated_at`,
        [input.workspaceId, input.actorUserId, input.provider, input.connectionId, input.now],
      );
      await this.client.query("COMMIT");
      return toSelection(result.rows[0]!);
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  /** Revoke and clear selections atomically, preserving an omitted cleanup reason. */
  async revoke(input: RevokeConnectionInput): Promise<ConnectionBindingRecord> {
    await this.client.query("BEGIN");
    try {
      const result = await this.client.query<ConnectionRow>(
        `SELECT ${CONNECTION_COLUMNS}
         FROM omr_control.connection_bindings
         WHERE id = $1
         FOR UPDATE`,
        [input.connectionId],
      );
      const connection = result.rows[0];
      if (!connection) throw new ConnectionAccessDeniedError();
      await this.lockWorkspaceForOrphanCleanup(connection);
      if (!await this.canManage(connection, input.actorUserId, true)) throw new ConnectionAccessDeniedError();

      const updated = await this.client.query<ConnectionRow>(
        `UPDATE omr_control.connection_bindings
         SET status = 'revoked', readiness = 'unavailable',
             health_reason = COALESCE($2, health_reason),
             revoked_at = COALESCE(revoked_at, $1), updated_at = $1
         WHERE id = $3
         RETURNING ${CONNECTION_COLUMNS}`,
        [input.now, input.reason ?? null, input.connectionId],
      );
      await this.client.query(
        `DELETE FROM omr_control.connection_selections WHERE connection_id = $1`,
        [input.connectionId],
      );
      await this.client.query("COMMIT");
      return toConnection(updated.rows[0]!);
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  /** Atomically fence a cleanup state change and remove selections. */
  async revokeIf(input: ConditionalRevokeInput): Promise<ConnectionBindingRecord | null> {
    await this.client.query("BEGIN");
    try {
      const result = await this.client.query<ConnectionRow>(
        `SELECT ${CONNECTION_COLUMNS}
         FROM omr_control.connection_bindings WHERE id = $1 FOR UPDATE`,
        [input.connectionId],
      );
      const connection = result.rows[0];
      if (!connection) throw new ConnectionAccessDeniedError();
      await this.lockWorkspaceForOrphanCleanup(connection);
      if (!await this.canManage(connection, input.actorUserId, true)) throw new ConnectionAccessDeniedError();
      const matches = input.expectedStatus === "not_revoked"
        ? connection.status !== "revoked"
        : connection.status === input.expectedStatus && connection.health_reason === input.expectedReason;
      if (!matches) {
        await this.client.query("COMMIT");
        return null;
      }
      const updated = await this.client.query<ConnectionRow>(
        `UPDATE omr_control.connection_bindings
         SET status = 'revoked', readiness = 'unavailable', health_reason = $2,
             revoked_at = COALESCE(revoked_at, $1), updated_at = $1
         WHERE id = $3 RETURNING ${CONNECTION_COLUMNS}`,
        [input.now, input.reason ?? null, input.connectionId],
      );
      await this.client.query(`DELETE FROM omr_control.connection_selections WHERE connection_id = $1`, [input.connectionId]);
      await this.client.query("COMMIT");
      return toConnection(updated.rows[0]!);
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  /** Reject late health updates after a binding has been revoked. */
  async recordHealth(input: {
    connectionId: string;
    status: ConnectionLifecycleStatus;
    readiness: ConnectionReadiness;
    reason?: string;
    now: number;
  }): Promise<ConnectionBindingRecord> {
    const result = await this.client.query<ConnectionRow>(
      `UPDATE omr_control.connection_bindings
       SET status = $1, readiness = $2, health_reason = $3,
           last_checked_at = $4, updated_at = $4
       WHERE id = $5 AND status <> 'revoked'
       RETURNING ${CONNECTION_COLUMNS}`,
      [input.status, input.readiness, input.reason ?? null, input.now, input.connectionId],
    );
    if (!result.rows[0]) throw new ConnectionUnavailableError();
    return toConnection(result.rows[0]);
  }

  /** Read the current workspace role, locking an existing membership row. */
  private async membershipRole(
    workspaceId: string,
    userId: string,
  ): Promise<"owner" | "admin" | "member" | null> {
    const result = await this.client.query<{ role: "owner" | "admin" | "member" }>(
      `SELECT role
       FROM omr_control.workspace_memberships
       WHERE workspace_id = $1 AND user_id = $2
       FOR SHARE`,
      [workspaceId, userId],
    );
    return result.rows[0]?.role ?? null;
  }

  /** Serialize orphan cleanup against membership insertion until the mutation commits. */
  private async lockWorkspaceForOrphanCleanup(connection: ConnectionRow): Promise<void> {
    if (connection.ownership !== "personal") return;
    await this.client.query(
      `SELECT id FROM omr_control.workspaces WHERE id = $1 FOR UPDATE`,
      [connection.workspace_id],
    );
  }

  /** Check current role and personal ownership, including orphan cleanup authority. */
  private async canManage(connection: ConnectionRow, actorUserId: string, allowOrphanCleanup = false): Promise<boolean> {
    const role = await this.membershipRole(connection.workspace_id, actorUserId);
    if (connection.ownership === "workspace") return role === "owner" || role === "admin";
    if (role && connection.owner_user_id === actorUserId) return true;
    if (!allowOrphanCleanup || (role !== "owner" && role !== "admin")) return false;
    return !await this.membershipRole(connection.workspace_id, connection.owner_user_id!);
  }

  /** Read a binding for advisory access checks outside mutation transactions. */
  private async readConnection(connectionId: string): Promise<ConnectionRow | null> {
    const result = await this.client.query<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS}
       FROM omr_control.connection_bindings
       WHERE id = $1`,
      [connectionId],
    );
    return result.rows[0] ?? null;
  }
}
