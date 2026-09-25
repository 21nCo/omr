import type { Client } from "pg";

import type {
  AcceptWorkspaceInvitationInput,
  CreateWorkspaceInvitationInput,
  WorkspaceInvitationRecord,
  WorkspaceAccessRecord,
  WorkspaceMembershipRecord,
  WorkspaceProvisionInput,
  WorkspaceRole,
  WorkspaceStore,
} from "./workspaces.js";
import {
  WorkspaceAccessDeniedError,
  WorkspaceInvitationError,
} from "./workspaces.js";

interface MembershipRow {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
  updated_at: string;
}

interface InvitationRow {
  id: string;
  workspace_id: string;
  email: string;
  role: Exclude<WorkspaceRole, "owner">;
  token_hash: string;
  created_by: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkspaceAccessRow extends MembershipRow {
  workspace_kind: "personal" | "team";
  workspace_name: string;
  workspace_created_at: string;
  workspace_updated_at: string;
}

function toMembership(row: MembershipRow): WorkspaceMembershipRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toInvitation(row: InvitationRow): WorkspaceInvitationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    role: row.role,
    tokenHash: row.token_hash,
    createdBy: row.created_by,
    expiresAt: Number(row.expires_at),
    acceptedAt: row.accepted_at === null ? null : Number(row.accepted_at),
    acceptedBy: row.accepted_by,
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class PostgresWorkspaceStore implements WorkspaceStore {
  constructor(private readonly client: Client) {}

  async provisionPersonal(input: WorkspaceProvisionInput): Promise<WorkspaceProvisionInput> {
    return this.insertWorkspaceWithOwner(input, true);
  }

  async createTeam(input: WorkspaceProvisionInput): Promise<WorkspaceProvisionInput> {
    return this.insertWorkspaceWithOwner(input, false);
  }

  async findMembership(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMembershipRecord | null> {
    const result = await this.client.query<MembershipRow>(
      `SELECT id, workspace_id, user_id, role, created_at, updated_at
       FROM omr_control.workspace_memberships
       WHERE workspace_id = $1 AND user_id = $2
       LIMIT 1`,
      [workspaceId, userId],
    );
    return result.rows[0] ? toMembership(result.rows[0]) : null;
  }

  async listMemberships(userId: string): Promise<WorkspaceMembershipRecord[]> {
    const result = await this.client.query<MembershipRow>(
      `SELECT id, workspace_id, user_id, role, created_at, updated_at
       FROM omr_control.workspace_memberships
       WHERE user_id = $1
       ORDER BY workspace_id`,
      [userId],
    );
    return result.rows.map(toMembership);
  }

  async listWorkspaceAccess(userId: string): Promise<WorkspaceAccessRecord[]> {
    const result = await this.client.query<WorkspaceAccessRow>(
      `SELECT m.id, m.workspace_id, m.user_id, m.role, m.created_at, m.updated_at,
              w.kind AS workspace_kind, w.name AS workspace_name,
              w.created_at AS workspace_created_at, w.updated_at AS workspace_updated_at
       FROM omr_control.workspace_memberships m
       JOIN omr_control.workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = $1
       ORDER BY w.kind, w.name, w.id`,
      [userId],
    );
    return result.rows.map((row) => ({
      workspace: {
        id: row.workspace_id,
        kind: row.workspace_kind,
        name: row.workspace_name,
        createdAt: Number(row.workspace_created_at),
        updatedAt: Number(row.workspace_updated_at),
      },
      membership: toMembership(row),
    }));
  }

  async createInvitation(
    input: CreateWorkspaceInvitationInput,
  ): Promise<WorkspaceInvitationRecord> {
    await this.client.query("BEGIN");
    try {
      const actor = await this.client.query<{ role: WorkspaceRole }>(
        `SELECT role
         FROM omr_control.workspace_memberships
         WHERE workspace_id = $1 AND user_id = $2
         FOR SHARE`,
        [input.invitation.workspaceId, input.actorUserId],
      );
      if (actor.rows[0]?.role !== "owner" && actor.rows[0]?.role !== "admin") {
        throw new WorkspaceAccessDeniedError();
      }

      const invitation = input.invitation;
      const result = await this.client.query<InvitationRow>(
        `INSERT INTO omr_control.workspace_invitations
           (id, workspace_id, email, role, token_hash, created_by, expires_at,
            accepted_at, accepted_by, revoked_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, workspace_id, email, role, token_hash, created_by,
                   expires_at, accepted_at, accepted_by, revoked_at, created_at, updated_at`,
        [
          invitation.id,
          invitation.workspaceId,
          invitation.email,
          invitation.role,
          invitation.tokenHash,
          invitation.createdBy,
          invitation.expiresAt,
          invitation.acceptedAt,
          invitation.acceptedBy,
          invitation.revokedAt,
          invitation.createdAt,
          invitation.updatedAt,
        ],
      );
      await this.client.query("COMMIT");
      return toInvitation(result.rows[0]!);
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  async acceptInvitation(
    input: AcceptWorkspaceInvitationInput,
  ): Promise<WorkspaceMembershipRecord> {
    await this.client.query("BEGIN");
    try {
      const result = await this.client.query<InvitationRow>(
        `SELECT id, workspace_id, email, role, token_hash, created_by,
                expires_at, accepted_at, accepted_by, revoked_at, created_at, updated_at
         FROM omr_control.workspace_invitations
         WHERE token_hash = $1
         FOR UPDATE`,
        [input.tokenHash],
      );
      const invitation = result.rows[0];
      if (!invitation || invitation.revoked_at !== null || invitation.email !== input.email) {
        throw new WorkspaceInvitationError("WORKSPACE_INVITATION_INVALID");
      }
      if (invitation.accepted_at !== null) {
        throw new WorkspaceInvitationError("WORKSPACE_INVITATION_USED");
      }
      if (Number(invitation.expires_at) <= input.now) {
        throw new WorkspaceInvitationError("WORKSPACE_INVITATION_EXPIRED");
      }

      await this.client.query(
        `INSERT INTO omr_control.workspace_memberships
           (id, workspace_id, user_id, role, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [
          input.membershipId,
          invitation.workspace_id,
          input.userId,
          invitation.role,
          input.now,
          input.now,
        ],
      );
      const membershipResult = await this.client.query<MembershipRow>(
        `SELECT id, workspace_id, user_id, role, created_at, updated_at
         FROM omr_control.workspace_memberships
         WHERE workspace_id = $1 AND user_id = $2`,
        [invitation.workspace_id, input.userId],
      );
      const membership = membershipResult.rows[0];
      if (!membership) throw new Error("Invitation acceptance did not persist membership");

      await this.client.query(
        `UPDATE omr_control.workspace_invitations
         SET accepted_at = $1, accepted_by = $2, updated_at = $1
         WHERE id = $3`,
        [input.now, input.userId, invitation.id],
      );
      await this.client.query("COMMIT");
      return toMembership(membership);
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  private async insertWorkspaceWithOwner(
    input: WorkspaceProvisionInput,
    idempotent: boolean,
  ): Promise<WorkspaceProvisionInput> {
    await this.client.query("BEGIN");
    try {
      const workspaceResult = await this.client.query(
        `INSERT INTO omr_control.workspaces (id, kind, name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ${idempotent ? "ON CONFLICT (id) DO NOTHING" : ""}`,
        [
          input.workspace.id,
          input.workspace.kind,
          input.workspace.name,
          input.workspace.createdAt,
          input.workspace.updatedAt,
        ],
      );
      if (!idempotent && workspaceResult.rowCount !== 1) {
        throw new Error("Workspace already exists");
      }

      await this.client.query(
        `INSERT INTO omr_control.workspace_memberships
           (id, workspace_id, user_id, role, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ${idempotent ? "ON CONFLICT (workspace_id, user_id) DO NOTHING" : ""}`,
        [
          input.membership.id,
          input.membership.workspaceId,
          input.membership.userId,
          input.membership.role,
          input.membership.createdAt,
          input.membership.updatedAt,
        ],
      );
      await this.client.query("COMMIT");

      if (!idempotent) return input;
      const membership = await this.findMembership(
        input.workspace.id,
        input.membership.userId,
      );
      if (!membership) throw new Error("Personal workspace provisioning did not persist membership");
      return { workspace: input.workspace, membership };
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }
}
