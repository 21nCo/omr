import type {
  AcceptWorkspaceInvitationInput,
  CreateWorkspaceInvitationInput,
  WorkspaceInvitationRecord,
  WorkspaceAccessRecord,
  WorkspaceMembershipRecord,
  WorkspaceProvisionInput,
  WorkspaceStore,
} from "./workspaces.js";
import {
  WorkspaceAccessDeniedError,
  WorkspaceInvitationError,
} from "./workspaces.js";

export class MemoryWorkspaceStore implements WorkspaceStore {
  readonly workspaces = new Map<string, WorkspaceProvisionInput["workspace"]>();
  readonly memberships = new Map<string, WorkspaceMembershipRecord>();
  readonly invitations = new Map<string, WorkspaceInvitationRecord>();

  async provisionPersonal(input: WorkspaceProvisionInput): Promise<WorkspaceProvisionInput> {
    const existingMembership = await this.findMembership(
      input.workspace.id,
      input.membership.userId,
    );
    if (existingMembership) {
      return {
        workspace: this.workspaces.get(input.workspace.id)!,
        membership: existingMembership,
      };
    }
    return this.insert(input);
  }

  async createTeam(input: WorkspaceProvisionInput): Promise<WorkspaceProvisionInput> {
    if (this.workspaces.has(input.workspace.id)) {
      throw new Error("Workspace already exists");
    }
    return this.insert(input);
  }

  async findMembership(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMembershipRecord | null> {
    return (
      [...this.memberships.values()].find(
        (membership) =>
          membership.workspaceId === workspaceId && membership.userId === userId,
      ) ?? null
    );
  }

  async listMemberships(userId: string): Promise<WorkspaceMembershipRecord[]> {
    return [...this.memberships.values()]
      .filter((membership) => membership.userId === userId)
      .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
  }

  async listWorkspaceAccess(userId: string): Promise<WorkspaceAccessRecord[]> {
    return (await this.listMemberships(userId)).map((membership) => ({
      workspace: structuredClone(this.workspaces.get(membership.workspaceId)!),
      membership,
    }));
  }

  async createInvitation(
    input: CreateWorkspaceInvitationInput,
  ): Promise<WorkspaceInvitationRecord> {
    const actor = [...this.memberships.values()].find(
      (membership) =>
        membership.workspaceId === input.invitation.workspaceId &&
        membership.userId === input.actorUserId,
    );
    if (!actor || (actor.role !== "owner" && actor.role !== "admin")) {
      throw new WorkspaceAccessDeniedError();
    }

    const invitation = structuredClone(input.invitation);
    this.invitations.set(invitation.id, invitation);
    return structuredClone(invitation);
  }

  async acceptInvitation(
    input: AcceptWorkspaceInvitationInput,
  ): Promise<WorkspaceMembershipRecord> {
    const invitation = [...this.invitations.values()].find(
      (candidate) => candidate.tokenHash === input.tokenHash,
    );
    if (!invitation || invitation.revokedAt !== null || invitation.email !== input.email) {
      throw new WorkspaceInvitationError("WORKSPACE_INVITATION_INVALID");
    }
    if (invitation.acceptedAt !== null) {
      throw new WorkspaceInvitationError("WORKSPACE_INVITATION_USED");
    }
    if (invitation.expiresAt <= input.now) {
      throw new WorkspaceInvitationError("WORKSPACE_INVITATION_EXPIRED");
    }

    const existing = [...this.memberships.values()].find(
      (membership) =>
        membership.workspaceId === invitation.workspaceId &&
        membership.userId === input.userId,
    );
    const membership: WorkspaceMembershipRecord = existing ?? {
      id: input.membershipId,
      workspaceId: invitation.workspaceId,
      userId: input.userId,
      role: invitation.role,
      createdAt: input.now,
      updatedAt: input.now,
    };
    if (!existing) this.memberships.set(membership.id, membership);

    invitation.acceptedAt = input.now;
    invitation.acceptedBy = input.userId;
    invitation.updatedAt = input.now;
    return structuredClone(membership);
  }

  private insert(input: WorkspaceProvisionInput): WorkspaceProvisionInput {
    this.workspaces.set(input.workspace.id, structuredClone(input.workspace));
    this.memberships.set(input.membership.id, structuredClone(input.membership));
    return structuredClone(input);
  }
}
