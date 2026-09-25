export type WorkspaceKind = "personal" | "team";
export type WorkspaceRole = "owner" | "admin" | "member";

export interface WorkspaceRecord {
  id: string;
  kind: WorkspaceKind;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceMembershipRecord {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceProvisionInput {
  workspace: WorkspaceRecord;
  membership: WorkspaceMembershipRecord;
}

export interface WorkspaceAccessRecord {
  workspace: WorkspaceRecord;
  membership: WorkspaceMembershipRecord;
}

export interface WorkspaceInvitationRecord {
  id: string;
  workspaceId: string;
  email: string;
  role: Exclude<WorkspaceRole, "owner">;
  tokenHash: string;
  createdBy: string;
  expiresAt: number;
  acceptedAt: number | null;
  acceptedBy: string | null;
  revokedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateWorkspaceInvitationInput {
  actorUserId: string;
  invitation: WorkspaceInvitationRecord;
}

export interface AcceptWorkspaceInvitationInput {
  tokenHash: string;
  userId: string;
  email: string;
  membershipId: string;
  now: number;
}

export interface WorkspaceStore {
  provisionPersonal(input: WorkspaceProvisionInput): Promise<WorkspaceProvisionInput>;
  createTeam(input: WorkspaceProvisionInput): Promise<WorkspaceProvisionInput>;
  findMembership(workspaceId: string, userId: string): Promise<WorkspaceMembershipRecord | null>;
  listMemberships(userId: string): Promise<WorkspaceMembershipRecord[]>;
  listWorkspaceAccess(userId: string): Promise<WorkspaceAccessRecord[]>;
  createInvitation(input: CreateWorkspaceInvitationInput): Promise<WorkspaceInvitationRecord>;
  acceptInvitation(input: AcceptWorkspaceInvitationInput): Promise<WorkspaceMembershipRecord>;
}

export class WorkspaceAccessDeniedError extends Error {
  readonly code = "WORKSPACE_ACCESS_DENIED";

  constructor() {
    super("Workspace access denied");
    this.name = "WorkspaceAccessDeniedError";
  }
}

export class WorkspaceInputError extends Error {
  readonly code = "WORKSPACE_INPUT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceInputError";
  }
}

export class WorkspaceInvitationError extends Error {
  readonly code:
    | "WORKSPACE_INVITATION_INVALID"
    | "WORKSPACE_INVITATION_EXPIRED"
    | "WORKSPACE_INVITATION_USED";

  constructor(
    code: WorkspaceInvitationError["code"],
    message = "Workspace invitation is not valid",
  ) {
    super(message);
    this.name = "WorkspaceInvitationError";
    this.code = code;
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;

function assertId(id: string): void {
  if (!SAFE_ID.test(id)) throw new WorkspaceInputError("Invalid identity identifier");
}

async function stablePersonalWorkspaceId(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `workspace_personal_${hex}`;
}

function normalizeWorkspaceName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (normalized.length < 1 || normalized.length > 120) {
    throw new WorkspaceInputError("Workspace name must contain 1 to 120 characters");
  }
  return normalized;
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new WorkspaceInputError("A valid invitation email is required");
  }
  return normalized;
}

async function hashInvitationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function invitationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class WorkspaceAuthority {
  constructor(
    private readonly store: WorkspaceStore,
    private readonly now: () => number = Date.now,
  ) {}

  async provisionPersonalWorkspace(input: {
    userId: string;
    email?: string;
  }): Promise<WorkspaceProvisionInput> {
    assertId(input.userId);
    const workspaceId = await stablePersonalWorkspaceId(input.userId);
    const timestamp = this.now();
    const preferredName = input.email?.split("@", 1)[0]?.trim();
    const name = normalizeWorkspaceName(preferredName ? `${preferredName}'s workspace` : "My workspace");

    return this.store.provisionPersonal({
      workspace: {
        id: workspaceId,
        kind: "personal",
        name,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      membership: {
        id: `membership_owner_${workspaceId}`,
        workspaceId,
        userId: input.userId,
        role: "owner",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
  }

  async createTeam(input: { ownerUserId: string; name: string }): Promise<WorkspaceProvisionInput> {
    assertId(input.ownerUserId);
    const workspaceId = `workspace_team_${crypto.randomUUID()}`;
    const timestamp = this.now();

    return this.store.createTeam({
      workspace: {
        id: workspaceId,
        kind: "team",
        name: normalizeWorkspaceName(input.name),
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      membership: {
        id: `membership_${crypto.randomUUID()}`,
        workspaceId,
        userId: input.ownerUserId,
        role: "owner",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
  }

  async requireMembership(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMembershipRecord> {
    assertId(workspaceId);
    assertId(userId);
    const membership = await this.store.findMembership(workspaceId, userId);
    if (!membership) throw new WorkspaceAccessDeniedError();
    return membership;
  }

  async listMemberships(userId: string): Promise<WorkspaceMembershipRecord[]> {
    assertId(userId);
    return this.store.listMemberships(userId);
  }

  async listWorkspaceAccess(userId: string): Promise<WorkspaceAccessRecord[]> {
    assertId(userId);
    return this.store.listWorkspaceAccess(userId);
  }

  async inviteMember(input: {
    actorUserId: string;
    workspaceId: string;
    email: string;
    role: Exclude<WorkspaceRole, "owner">;
    ttlMs?: number;
  }): Promise<{ invitation: WorkspaceInvitationRecord; token: string }> {
    assertId(input.actorUserId);
    assertId(input.workspaceId);
    if (input.role !== "admin" && input.role !== "member") {
      throw new WorkspaceInputError("Invitations may grant only admin or member roles");
    }
    const ttlMs = input.ttlMs ?? 1000 * 60 * 60 * 24 * 7;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 1000 * 60 * 60 * 24 * 30) {
      throw new WorkspaceInputError("Invitation lifetime must be between one minute and 30 days");
    }

    const token = invitationToken();
    const timestamp = this.now();
    const invitation: WorkspaceInvitationRecord = {
      id: `invitation_${crypto.randomUUID()}`,
      workspaceId: input.workspaceId,
      email: normalizeEmail(input.email),
      role: input.role,
      tokenHash: await hashInvitationToken(token),
      createdBy: input.actorUserId,
      expiresAt: timestamp + ttlMs,
      acceptedAt: null,
      acceptedBy: null,
      revokedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    return {
      invitation: await this.store.createInvitation({
        actorUserId: input.actorUserId,
        invitation,
      }),
      token,
    };
  }

  async acceptInvitation(input: {
    token: string;
    userId: string;
    email: string;
    emailVerified: boolean;
  }): Promise<WorkspaceMembershipRecord> {
    assertId(input.userId);
    if (!input.emailVerified) {
      throw new WorkspaceInvitationError(
        "WORKSPACE_INVITATION_INVALID",
        "A verified matching email is required",
      );
    }
    const timestamp = this.now();
    return this.store.acceptInvitation({
      tokenHash: await hashInvitationToken(input.token),
      userId: input.userId,
      email: normalizeEmail(input.email),
      membershipId: `membership_${crypto.randomUUID()}`,
      now: timestamp,
    });
  }
}
