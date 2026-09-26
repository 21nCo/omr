export type ConnectionOwnership = "personal" | "workspace";
export type ConnectionLifecycleStatus = "active" | "needs_reauth" | "error" | "revoked";
export type ConnectionReadiness = "ready" | "degraded" | "unavailable";

export interface ConnectionBindingRecord {
  id: string;
  workspaceId: string;
  provider: string;
  providerConnectionId: string;
  ownership: ConnectionOwnership;
  ownerUserId: string | null;
  installedBy: string;
  label: string;
  status: ConnectionLifecycleStatus;
  readiness: ConnectionReadiness;
  healthReason: string | null;
  lastCheckedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ConnectionSelectionRecord {
  workspaceId: string;
  userId: string;
  provider: string;
  connectionId: string;
  createdAt: number;
  updatedAt: number;
}

export interface AttachConnectionInput {
  actorUserId: string;
  connection: ConnectionBindingRecord;
}

export interface SelectConnectionInput {
  actorUserId: string;
  workspaceId: string;
  provider: string;
  connectionId: string;
  now: number;
}

export interface RevokeConnectionInput {
  actorUserId: string;
  connectionId: string;
  reason?: string;
  now: number;
}

export type ConditionalRevokeInput = RevokeConnectionInput & (
  | { expectedStatus: "not_revoked"; expectedReason?: never }
  | { expectedStatus: ConnectionLifecycleStatus; expectedReason: string | null }
);

export interface AuthorizeConnectionInstallInput {
  actorUserId: string;
  workspaceId: string;
  ownership: ConnectionOwnership;
}

export interface AccessConnectionInput {
  actorUserId: string;
  connectionId: string;
}

export interface ConnectionBindingStore {
  authorizeInstall(input: AuthorizeConnectionInstallInput): Promise<void>;
  attach(input: AttachConnectionInput): Promise<ConnectionBindingRecord>;
  getAccessible(input: AccessConnectionInput): Promise<ConnectionBindingRecord>;
  getManageable(input: AccessConnectionInput): Promise<ConnectionBindingRecord>;
  getRevocable(input: AccessConnectionInput): Promise<ConnectionBindingRecord>;
  listAvailable(input: {
    actorUserId: string;
    workspaceId: string;
    provider?: string;
  }): Promise<ConnectionBindingRecord[]>;
  listOrphanedForCleanup(input: {
    actorUserId: string;
    workspaceId: string;
  }): Promise<ConnectionBindingRecord[]>;
  getSelection(input: {
    actorUserId: string;
    workspaceId: string;
    provider: string;
  }): Promise<ConnectionSelectionRecord | null>;
  select(input: SelectConnectionInput): Promise<ConnectionSelectionRecord>;
  revoke(input: RevokeConnectionInput): Promise<ConnectionBindingRecord>;
  revokeIf(input: ConditionalRevokeInput): Promise<ConnectionBindingRecord | null>;
  recordHealth(input: {
    connectionId: string;
    status: ConnectionLifecycleStatus;
    readiness: ConnectionReadiness;
    reason?: string;
    now: number;
  }): Promise<ConnectionBindingRecord>;
}

export class ConnectionAccessDeniedError extends Error {
  readonly code = "CONNECTION_ACCESS_DENIED";

  constructor() {
    super("Connection access denied");
    this.name = "ConnectionAccessDeniedError";
  }
}

export class ConnectionUnavailableError extends Error {
  readonly code = "CONNECTION_UNAVAILABLE";

  constructor() {
    super("No ready connection is available");
    this.name = "ConnectionUnavailableError";
  }
}

export class ConnectionSelectionRequiredError extends Error {
  readonly code = "CONNECTION_SELECTION_REQUIRED";

  constructor(readonly connectionIds: string[]) {
    super("Multiple ready connections require an explicit selection");
    this.name = "ConnectionSelectionRequiredError";
  }
}

export class ConnectionInputError extends Error {
  readonly code = "CONNECTION_INPUT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ConnectionInputError";
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,79}$/;

function assertId(value: string): void {
  if (!SAFE_ID.test(value)) throw new ConnectionInputError("Invalid identity identifier");
}

function normalizeProvider(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!PROVIDER.test(normalized)) throw new ConnectionInputError("Invalid provider identifier");
  return normalized;
}

function normalizeLabel(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < 1 || normalized.length > 120) {
    throw new ConnectionInputError("Connection label must contain 1 to 120 characters");
  }
  return normalized;
}

export class ConnectionAuthority {
  constructor(
    private readonly store: ConnectionBindingStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Use one clock for cleanup leases and conditional state writes. */
  currentTime(): number {
    return this.now();
  }

  /** Check current workspace membership before creating a provider credential. */
  async authorizeInstall(input: AuthorizeConnectionInstallInput): Promise<void> {
    assertId(input.actorUserId);
    assertId(input.workspaceId);
    if (input.ownership !== "personal" && input.ownership !== "workspace") {
      throw new ConnectionInputError("Invalid connection ownership");
    }
    await this.store.authorizeInstall(input);
  }

  /** Persist a server-side binding after the provider has accepted the account. */
  async attach(input: {
    actorUserId: string;
    workspaceId: string;
    provider: string;
    providerConnectionId: string;
    ownership: ConnectionOwnership;
    label: string;
  }): Promise<ConnectionBindingRecord> {
    assertId(input.actorUserId);
    assertId(input.workspaceId);
    assertId(input.providerConnectionId);
    if (input.ownership !== "personal" && input.ownership !== "workspace") {
      throw new ConnectionInputError("Invalid connection ownership");
    }
    const timestamp = this.now();
    return this.store.attach({
      actorUserId: input.actorUserId,
      connection: {
        id: `connection_${crypto.randomUUID()}`,
        workspaceId: input.workspaceId,
        provider: normalizeProvider(input.provider),
        providerConnectionId: input.providerConnectionId,
        ownership: input.ownership,
        ownerUserId: input.ownership === "personal" ? input.actorUserId : null,
        installedBy: input.actorUserId,
        label: normalizeLabel(input.label),
        status: "active",
        readiness: "ready",
        healthReason: null,
        lastCheckedAt: timestamp,
        revokedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
  }

  /** List bindings usable by this member; other members' personal accounts stay hidden. */
  async listAvailable(input: {
    actorUserId: string;
    workspaceId: string;
    provider?: string;
  }): Promise<ConnectionBindingRecord[]> {
    assertId(input.actorUserId);
    assertId(input.workspaceId);
    return this.store.listAvailable({
      ...input,
      ...(input.provider ? { provider: normalizeProvider(input.provider) } : {}),
    });
  }

  /** Return only former members' personal bindings to a workspace owner or admin. */
  async listOrphanedForCleanup(input: { actorUserId: string; workspaceId: string }): Promise<ConnectionBindingRecord[]> {
    assertId(input.actorUserId);
    assertId(input.workspaceId);
    return this.store.listOrphanedForCleanup(input);
  }

  /** Read a binding only when the actor may use it. */
  async getAccessible(actorUserId: string, connectionId: string): Promise<ConnectionBindingRecord> {
    assertId(actorUserId);
    assertId(connectionId);
    return this.store.getAccessible({ actorUserId, connectionId });
  }

  /** Read a binding only when the actor may change its lifecycle. */
  async getManageable(actorUserId: string, connectionId: string): Promise<ConnectionBindingRecord> {
    assertId(actorUserId);
    assertId(connectionId);
    return this.store.getManageable({ actorUserId, connectionId });
  }

  /** Permit ordinary lifecycle owners and admins cleaning former members' bindings. */
  async getRevocable(actorUserId: string, connectionId: string): Promise<ConnectionBindingRecord> {
    assertId(actorUserId);
    assertId(connectionId);
    return this.store.getRevocable({ actorUserId, connectionId });
  }

  /** Store an explicit account choice for one member and provider. */
  async select(input: {
    actorUserId: string;
    workspaceId: string;
    provider: string;
    connectionId: string;
  }): Promise<ConnectionSelectionRecord> {
    assertId(input.actorUserId);
    assertId(input.workspaceId);
    assertId(input.connectionId);
    return this.store.select({
      ...input,
      provider: normalizeProvider(input.provider),
      now: this.now(),
    });
  }

  /** Read the member's current account choice. */
  async getSelection(input: {
    actorUserId: string;
    workspaceId: string;
    provider: string;
  }): Promise<ConnectionSelectionRecord | null> {
    assertId(input.actorUserId);
    assertId(input.workspaceId);
    return this.store.getSelection({ ...input, provider: normalizeProvider(input.provider) });
  }

  /** Resolve an eligible binding without exposing another member's account. */
  async resolve(input: {
    actorUserId: string;
    workspaceId: string;
    provider: string;
    connectionId?: string;
  }): Promise<ConnectionBindingRecord> {
    const provider = normalizeProvider(input.provider);
    const available = (await this.listAvailable({ ...input, provider })).filter(
      (connection) => connection.status === "active" && connection.readiness === "ready",
    );
    if (input.connectionId) {
      assertId(input.connectionId);
      const explicit = available.find((connection) => connection.id === input.connectionId);
      if (!explicit) throw new ConnectionAccessDeniedError();
      return explicit;
    }

    const selection = await this.store.getSelection({
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      provider,
    });
    const selected = selection
      ? available.find((connection) => connection.id === selection.connectionId)
      : undefined;
    if (selected) return selected;
    if (available.length === 1) return available[0]!;
    if (available.length === 0) throw new ConnectionUnavailableError();
    throw new ConnectionSelectionRequiredError(available.map(({ id }) => id).sort());
  }

  /** End local use and clear selections before any provider cleanup. */
  async revoke(
    actorUserId: string,
    connectionId: string,
    reason?: string,
  ): Promise<ConnectionBindingRecord> {
    assertId(actorUserId);
    assertId(connectionId);
    if (reason && reason.length > 240) {
      throw new ConnectionInputError("Revocation reason must not exceed 240 characters");
    }
    return this.store.revoke({ actorUserId, connectionId, reason, now: this.now() });
  }

  /** Update a cleanup result only when its expected claim still owns the row. */
  async revokeIf(
    actorUserId: string,
    connectionId: string,
    expectedStatus: ConnectionLifecycleStatus,
    expectedReason: string | null,
    reason?: string,
  ): Promise<ConnectionBindingRecord | null> {
    assertId(actorUserId);
    assertId(connectionId);
    if (reason && reason.length > 240) throw new ConnectionInputError("Revocation reason must not exceed 240 characters");
    return this.store.revokeIf({ actorUserId, connectionId, expectedStatus, expectedReason, reason, now: this.now() });
  }

  /** Claim local revocation from the current row before contacting the provider. */
  async revokeIfNotRevoked(
    actorUserId: string,
    connectionId: string,
    reason: string,
  ): Promise<ConnectionBindingRecord | null> {
    assertId(actorUserId);
    assertId(connectionId);
    if (reason.length > 240) throw new ConnectionInputError("Revocation reason must not exceed 240 characters");
    return this.store.revokeIf({ actorUserId, connectionId, expectedStatus: "not_revoked", reason, now: this.now() });
  }

  /** Update a live binding while leaving revocation terminal. */
  async recordHealth(input: {
    connectionId: string;
    status: ConnectionLifecycleStatus;
    readiness: ConnectionReadiness;
    reason?: string;
  }): Promise<ConnectionBindingRecord> {
    assertId(input.connectionId);
    if (input.reason && input.reason.length > 240) {
      throw new ConnectionInputError("Health reason must not exceed 240 characters");
    }
    return this.store.recordHealth({ ...input, now: this.now() });
  }
}
