export const CLIENT_KINDS = ["cli", "mcp_remote", "mcp_stdio", "headless"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

export const CLIENT_CAPABILITIES = [
  "connections:read",
  "tools:discover",
  "tools:read",
  "tools:write",
  "approvals:create",
] as const;

export type ClientCapability = (typeof CLIENT_CAPABILITIES)[number];

export interface ClientRecord {
  id: string;
  workspaceId: string;
  kind: ClientKind;
  name: string;
  registeredBy: string;
  revokedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ClientGrantRecord {
  id: string;
  clientId: string;
  workspaceId: string;
  userId: string;
  capabilities: ClientCapability[];
  credentialHash: string;
  expiresAt: number;
  revokedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ClientPrincipal {
  grantId: string;
  clientId: string;
  workspaceId: string;
  userId: string;
  kind: ClientKind;
  capabilities: ClientCapability[];
}

/** Safe management metadata; never includes a credential or its hash. */
export interface ManualClientGrant {
  id: string;
  clientId: string;
  workspaceId: string;
  clientName: string;
  kind: ClientKind;
  capabilities: ClientCapability[];
  expiresAt: number;
  createdAt: number;
}

export interface ListManualClientGrantsInput {
  actorUserId: string;
  now: number;
  after: { createdAt: number; id: string } | null;
  limit: number;
}

export interface RegisterClientInput {
  actorUserId: string;
  client: ClientRecord;
}

export interface IssueClientGrantInput {
  actorUserId: string;
  grant: ClientGrantRecord;
}

export interface RevokeClientAccessInput {
  actorUserId: string;
  targetId: string;
  now: number;
}

export interface ClientAccessStore {
  registerClient(input: RegisterClientInput): Promise<ClientRecord>;
  issueGrant(input: IssueClientGrantInput): Promise<ClientGrantRecord>;
  authenticate(credentialHash: string, now: number): Promise<ClientPrincipal>;
  listManualGrants(input: ListManualClientGrantsInput): Promise<ManualClientGrant[]>;
  revokeManualClient(input: RevokeClientAccessInput): Promise<void>;
  revokeGrant(input: RevokeClientAccessInput): Promise<void>;
  revokeClient(input: RevokeClientAccessInput): Promise<void>;
}

export class ClientAccessDeniedError extends Error {
  readonly code = "CLIENT_ACCESS_DENIED";

  constructor() {
    super("Client access denied");
    this.name = "ClientAccessDeniedError";
  }
}

export class InvalidClientCredentialError extends Error {
  readonly code = "CLIENT_CREDENTIAL_INVALID";

  constructor() {
    super("Client credential is not valid");
    this.name = "InvalidClientCredentialError";
  }
}

export class ClientCapabilityDeniedError extends Error {
  readonly code = "CLIENT_CAPABILITY_DENIED";

  constructor(readonly capability: ClientCapability) {
    super(`Client grant does not include ${capability}`);
    this.name = "ClientCapabilityDeniedError";
  }
}

export class ClientAccessInputError extends Error {
  readonly code = "CLIENT_ACCESS_INPUT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ClientAccessInputError";
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const CAPABILITY_SET = new Set<string>(CLIENT_CAPABILITIES);
const CLIENT_KIND_SET = new Set<string>(CLIENT_KINDS);
const MANUAL_GRANT_PAGE_SIZE = 50;

function manualGrantCursor(value: string | undefined): ListManualClientGrantsInput["after"] {
  if (value === undefined) return null;
  const match = /^(\d{1,16}):(grant_[a-f0-9-]{36})$/.exec(value);
  if (!match) throw new ClientAccessInputError("Invalid client grant cursor");
  const createdAt = Number(match[1]);
  if (!Number.isSafeInteger(createdAt)) {
    throw new ClientAccessInputError("Invalid client grant cursor");
  }
  return { createdAt, id: match[2]! };
}

export function assertClientKind(value: string): asserts value is ClientKind {
  if (!CLIENT_KIND_SET.has(value)) {
    throw new ClientAccessInputError("Unrecognized client kind");
  }
}

export function assertClientAccessId(value: string): void {
  if (!SAFE_ID.test(value)) throw new ClientAccessInputError("Invalid identity identifier");
}

export function normalizeClientName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < 1 || normalized.length > 120) {
    throw new ClientAccessInputError("Client name must contain 1 to 120 characters");
  }
  return normalized;
}

export function normalizeClientCapabilities(
  values: readonly ClientCapability[],
): ClientCapability[] {
  const normalized = [...new Set(values)].sort();
  if (normalized.length === 0 || normalized.some((value) => !CAPABILITY_SET.has(value))) {
    throw new ClientAccessInputError("At least one recognized client capability is required");
  }
  return normalized;
}

export function createClientCredential(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `omr_${value}`;
}

export async function hashClientCredential(credential: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(credential),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class ClientAccessAuthority {
  constructor(
    private readonly store: ClientAccessStore,
    private readonly now: () => number = Date.now,
  ) {}

  async registerClient(input: {
    actorUserId: string;
    workspaceId: string;
    kind: ClientKind;
    name: string;
  }): Promise<ClientRecord> {
    assertClientAccessId(input.actorUserId);
    assertClientAccessId(input.workspaceId);
    assertClientKind(input.kind);
    const timestamp = this.now();
    return this.store.registerClient({
      actorUserId: input.actorUserId,
      client: {
        id: `client_${crypto.randomUUID()}`,
        workspaceId: input.workspaceId,
        kind: input.kind,
        name: normalizeClientName(input.name),
        registeredBy: input.actorUserId,
        revokedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
  }

  async issueGrant(input: {
    actorUserId: string;
    clientId: string;
    workspaceId: string;
    capabilities: readonly ClientCapability[];
    ttlMs?: number;
  }): Promise<{ grant: ClientGrantRecord; credential: string }> {
    assertClientAccessId(input.actorUserId);
    assertClientAccessId(input.clientId);
    assertClientAccessId(input.workspaceId);
    const ttlMs = input.ttlMs ?? 1000 * 60 * 60 * 24 * 30;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 1000 * 60 * 60 * 24 * 90) {
      throw new ClientAccessInputError("Client grant lifetime must be between one minute and 90 days");
    }
    const credential = createClientCredential();
    const timestamp = this.now();
    const grant = await this.store.issueGrant({
      actorUserId: input.actorUserId,
      grant: {
        id: `grant_${crypto.randomUUID()}`,
        clientId: input.clientId,
        workspaceId: input.workspaceId,
        userId: input.actorUserId,
        capabilities: normalizeClientCapabilities(input.capabilities),
        credentialHash: await hashClientCredential(credential),
        expiresAt: timestamp + ttlMs,
        revokedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    return { grant, credential };
  }

  async authenticate(
    credential: string,
    requiredCapability?: ClientCapability,
  ): Promise<ClientPrincipal> {
    if (!credential.startsWith("omr_") || credential.length !== 68) {
      throw new InvalidClientCredentialError();
    }
    const principal = await this.store.authenticate(
      await hashClientCredential(credential),
      this.now(),
    );
    if (requiredCapability && !principal.capabilities.includes(requiredCapability)) {
      throw new ClientCapabilityDeniedError(requiredCapability);
    }
    return principal;
  }

  async listManualGrants(actorUserId: string, cursor?: string): Promise<{
    grants: ManualClientGrant[];
    nextCursor: string | null;
  }> {
    assertClientAccessId(actorUserId);
    const records = await this.store.listManualGrants({
      actorUserId,
      now: this.now(),
      after: manualGrantCursor(cursor),
      limit: MANUAL_GRANT_PAGE_SIZE + 1,
    });
    const grants = records.slice(0, MANUAL_GRANT_PAGE_SIZE);
    const last = grants.at(-1);
    return {
      grants,
      nextCursor: records.length > MANUAL_GRANT_PAGE_SIZE && last
        ? `${last.createdAt}:${last.id}`
        : null,
    };
  }

  async revokeManualClient(actorUserId: string, clientId: string): Promise<void> {
    assertClientAccessId(actorUserId);
    assertClientAccessId(clientId);
    await this.store.revokeManualClient({ actorUserId, targetId: clientId, now: this.now() });
  }

  async revokeGrant(actorUserId: string, grantId: string): Promise<void> {
    assertClientAccessId(actorUserId);
    assertClientAccessId(grantId);
    await this.store.revokeGrant({ actorUserId, targetId: grantId, now: this.now() });
  }

  async revokeClient(actorUserId: string, clientId: string): Promise<void> {
    assertClientAccessId(actorUserId);
    assertClientAccessId(clientId);
    await this.store.revokeClient({ actorUserId, targetId: clientId, now: this.now() });
  }
}
