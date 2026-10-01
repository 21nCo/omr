import { isProviderConfigured, providerStatus, type ProviderStatus } from "@oh-my-router/tools";
import { isMissingRemoteConnection } from "./remote.js";

import {
  ConnectionAuthority,
  ConnectionInputError,
  ConnectionUnavailableError,
  type ConnectionBindingRecord,
  type ConnectionOwnership,
} from "./connections.js";

type PlugFnOwner =
  | { kind: "user"; userId: string; tenantId: string }
  | {
      kind: "organization";
      organizationId: string;
      installedByUserId: string;
      tenantId: string;
    };

interface PlugFnActor {
  userId: string;
  tenantId: string;
  organizationId?: string;
  roles?: string[];
}

export interface PlugFnConnection {
  id: string;
  userId: string;
  provider: string;
  ownerKind?: "user" | "organization" | "delegated";
  ownerId?: string;
  tenantId?: string;
  organizationId?: string;
  installedByUserId?: string;
  name?: string;
  status: "active" | "expired" | "revoked" | "error";
}

export interface PlugFnDisconnectResult {
  disconnected: boolean;
  connectionId?: string;
  remoteRevokeAttempted: boolean;
  remoteRevokeSucceeded: boolean;
  localDeleted: boolean;
  connectionDeleted: boolean;
  revokeError?: { code?: string; message?: string; status?: number };
}

export interface PlugFnConnectionPort {
  config?: {
    integrations?: Record<string, unknown>;
  };
  connections: {
    getAuthUrl(input: {
      userId: string;
      provider: string;
      redirectUri: string;
      scopes?: string[];
      connectionName?: string;
      owner: PlugFnOwner;
      actor: PlugFnActor;
      returnTo?: string;
      prompt?: string;
      loginHint?: string;
    }): Promise<string>;
    handleCallback(input: {
      code: string;
      state: string;
      provider?: string;
      redirectUri?: string;
      connectionName?: string;
      expectedOwner: PlugFnOwner;
      actor: PlugFnActor;
    }): Promise<{ connection: PlugFnConnection; returnTo?: string }>;
    connect(input: {
      userId: string;
      provider: string;
      credentials: { type: "api-key"; apiKey: string };
      connectionName?: string;
      owner: PlugFnOwner;
      actor: PlugFnActor;
    }): Promise<PlugFnConnection>;
    get(id: string): Promise<PlugFnConnection>;
    isValid(id: string): Promise<boolean>;
    refresh(id: string): Promise<PlugFnConnection>;
    disconnect(input: {
      userId: string;
      provider: string;
      connectionId: string;
      owner: PlugFnOwner;
      actor: PlugFnActor;
    }): Promise<PlugFnDisconnectResult>;
  };
  providers: {
    get(name: string):
      | { name: string; displayName: string; auth: { type: string }; actions: Record<string, unknown> }
      | undefined;
  };
}

export type GithubAccess = "profile" | "public_write" | "private_repositories";

/** The private tier requests GitHub's broad repo OAuth scope; the public tier does not. */
export function githubScopes(access: GithubAccess): string[] {
  switch (access) {
    case "profile": return ["read:user"];
    case "public_write": return ["read:user", "public_repo"];
    case "private_repositories": return ["read:user", "repo"];
    default: throw new ConnectionInputError("Unknown GitHub access tier");
  }
}

export type ProviderReadiness = ProviderStatus;

export class ProviderUnavailableError extends Error {
  readonly code = "PROVIDER_UNAVAILABLE";
  constructor(readonly state: ProviderStatus["state"]) {
    super(`Provider is ${state} or does not support this connection method`);
    this.name = "ProviderUnavailableError";
  }
}

export class ConnectionProviderOperationError extends Error {
  readonly code = "CONNECTION_PROVIDER_FAILED";
  constructor(readonly operation: "oauth_start" | "oauth_callback" | "api_key" | "binding" | "health" | "refresh") {
    super({
      oauth_start: "Could not start provider authorization. Check provider setup and try again.",
      oauth_callback: "Provider authorization failed. Start a new connection.",
      api_key: "The provider rejected this API key. Check the key and its permissions.",
      binding: "Could not save this account. Check the disconnected account for provider cleanup retry.",
      health: "Could not check provider health. Try again later.",
      refresh: "Could not refresh this account. Reconnect it to restore access.",
    }[operation]);
    this.name = "ConnectionProviderOperationError";
  }
}

export class ConnectionCleanupUntrackedError extends Error {
  readonly code = "CONNECTION_CLEANUP_UNTRACKED";
  constructor() {
    super("Provider cleanup could not be confirmed or saved. Revoke this connection in the provider account.");
    this.name = "ConnectionCleanupUntrackedError";
  }
}

const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,79}$/;

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

function ownerFor(input: {
  actorUserId: string;
  workspaceId: string;
  ownership: ConnectionOwnership;
}): PlugFnOwner {
  return input.ownership === "personal"
    ? { kind: "user", userId: input.actorUserId, tenantId: input.workspaceId }
    : {
        kind: "organization",
        organizationId: input.workspaceId,
        installedByUserId: input.actorUserId,
        tenantId: input.workspaceId,
      };
}

function actorFor(input: {
  actorUserId: string;
  workspaceId: string;
  ownership: ConnectionOwnership;
}): PlugFnActor {
  return input.ownership === "workspace"
    ? {
        userId: input.actorUserId,
        tenantId: input.workspaceId,
        organizationId: input.workspaceId,
        roles: ["org:admin"],
      }
    : { userId: input.actorUserId, tenantId: input.workspaceId };
}

/** Allow failed cleanup retries, stale claims, and a returning personal owner's first claim. */
function canClaimCleanup(binding: ConnectionBindingRecord, actorUserId: string, now: number): boolean {
  if (binding.status !== "revoked") return true;
  if (binding.healthReason === "provider_cleanup_requires_owner") {
    return binding.ownership === "personal" && binding.ownerUserId === actorUserId;
  }
  if (binding.healthReason === "remote_revoke_failed" || binding.healthReason === "provider_cleanup_failed") return true;
  const pending = binding.healthReason === "provider_cleanup_pending" ||
    binding.healthReason?.startsWith("provider_cleanup_pending:");
  return Boolean(pending && now - binding.updatedAt > 60_000);
}

/** Classify remote cleanup without exposing provider error details to clients. */
function cleanupReason(provider: PlugFnDisconnectResult, oauth: boolean): string | undefined {
  const remoteFailure = provider.remoteRevokeAttempted && !provider.remoteRevokeSucceeded;
  if (provider.connectionDeleted) {
    return remoteFailure || (oauth && !provider.remoteRevokeSucceeded)
      ? "remote_revocation_unavailable" : undefined;
  }
  if (!provider.disconnected && !provider.remoteRevokeAttempted && !provider.localDeleted) {
    return "provider_connection_missing";
  }
  return remoteFailure ? "remote_revoke_failed" : "provider_cleanup_failed";
}

function assertConnectionOwner(
  connection: PlugFnConnection,
  expected: PlugFnOwner,
  provider: string,
): void {
  const expectedOwnerId = expected.kind === "user" ? expected.userId : expected.organizationId;
  if (
    connection.provider !== provider ||
    connection.ownerKind !== expected.kind ||
    connection.ownerId !== expectedOwnerId ||
    connection.tenantId !== expected.tenantId ||
    (expected.kind === "organization" && connection.organizationId !== expected.organizationId)
  ) {
    throw new ConnectionInputError("PlugFn returned a connection for an unexpected owner");
  }
}

export class PlugFnConnectionOrchestrator {
  constructor(
    private readonly authority: ConnectionAuthority,
    private readonly plugfn: PlugFnConnectionPort,
  ) {}

  /** Combine adapter support, server configuration, and binding health for one provider. */
  providerReadiness(
    providerValue: string,
    connections: readonly ConnectionBindingRecord[] = [],
  ): ProviderReadiness {
    const provider = normalizeProvider(providerValue);
    const definition = this.plugfn.providers.get(provider);
    return providerStatus({
      provider,
      definition,
      configured: isProviderConfigured(definition, provider, this.plugfn.config?.integrations),
      connections,
    });
  }

  /** Reject setup when the provider or requested authentication mode is unavailable. */
  private assertConnectable(provider: string, mode: "oauth" | "api_key"): void {
    const readiness = this.providerReadiness(provider);
    if (!readiness.available || readiness.authMode !== mode) {
      throw new ProviderUnavailableError(readiness.state);
    }
  }

  /** Apply the same provider policy used by connection setup to public selection. */
  async select(input: { actorUserId: string; workspaceId: string; provider: string; connectionId: string }) {
    const readiness = this.providerReadiness(input.provider);
    if (!readiness.available) throw new ProviderUnavailableError(readiness.state);
    return this.authority.select(input);
  }

  /** Annotate visible bindings with eligibility for public account selection. */
  async listAvailable(input: { actorUserId: string; workspaceId: string; provider?: string }) {
    const bindings = await this.authority.listAvailable(input);
    const byProvider = new Map<string, ConnectionBindingRecord[]>();
    for (const binding of bindings) {
      const group = byProvider.get(binding.provider) ?? [];
      group.push(binding);
      byProvider.set(binding.provider, group);
    }
    const providerStates = new Map([...byProvider].map(([provider, group]) => [provider,
      this.providerReadiness(provider, group).state,
    ]));
    return bindings.map((binding) => {
      const providerState = providerStates.get(binding.provider)!;
      return { ...binding, providerState, selectable: providerState === "ready" &&
        binding.status === "active" && binding.readiness === "ready" };
    });
  }

  /** Authorize setup and return the provider consent URL without storing browser secrets. */
  async startOAuth(input: {
    actorUserId: string;
    workspaceId: string;
    provider: string;
    ownership: ConnectionOwnership;
    redirectUri: string;
    label: string;
    scopes?: string[];
    githubAccess?: GithubAccess;
    returnTo?: string;
    prompt?: string;
    loginHint?: string;
  }): Promise<{ authUrl: string }> {
    const provider = normalizeProvider(input.provider);
    const label = normalizeLabel(input.label);
    if (input.githubAccess !== undefined && provider !== "github") {
      throw new ConnectionInputError("GitHub access applies only to GitHub");
    }
    const defaultScopes = provider === "github" ? githubScopes(input.githubAccess ?? "profile") : undefined;
    const scopes = input.scopes ?? defaultScopes;
    await this.authority.authorizeInstall(input);
    this.assertConnectable(provider, "oauth");
    const owner = ownerFor(input);
    // GitHub's PlugFn defaults include write-capable repository scopes. An empty
    // array would fall back to the shared OAuth descriptor's profile/email grant.
    const authUrl = await this.plugfn.connections.getAuthUrl({
      userId: input.actorUserId,
      provider,
      redirectUri: input.redirectUri,
      connectionName: label,
      owner,
      actor: actorFor(input),
      ...(scopes ? { scopes } : {}),
      ...(input.returnTo ? { returnTo: input.returnTo } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.loginHint ? { loginHint: input.loginHint } : {}),
    }).catch(() => { throw new ConnectionProviderOperationError("oauth_start"); });
    return { authUrl };
  }

  /** Bind a validated callback result or discard an unusable provider connection. */
  async completeOAuth(input: {
    actorUserId: string;
    workspaceId: string;
    provider: string;
    ownership: ConnectionOwnership;
    code: string;
    state: string;
    label: string;
    redirectUri?: string;
  }): Promise<{ connection: ConnectionBindingRecord; returnTo?: string }> {
    const provider = normalizeProvider(input.provider);
    const label = normalizeLabel(input.label);
    await this.authority.authorizeInstall(input);
    this.assertConnectable(provider, "oauth");
    const owner = ownerFor(input);
    const actor = actorFor(input);
    const result = await this.plugfn.connections.handleCallback({
      code: input.code,
      state: input.state,
      provider,
      connectionName: label,
      expectedOwner: owner,
      actor,
      ...(input.redirectUri ? { redirectUri: input.redirectUri } : {}),
    }).catch(() => { throw new ConnectionProviderOperationError("oauth_callback"); });
    assertConnectionOwner(result.connection, owner, provider);
    if (result.connection.status !== "active") {
      await this.cleanUpUnusableResult({ ...input, provider, label,
        plugFnConnection: result.connection, owner, actor });
      throw new ConnectionProviderOperationError("oauth_callback");
    }
    const connection = await this.attachOrCleanUp({
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      provider,
      ownership: input.ownership,
      label,
      plugFnConnection: result.connection,
      owner,
      actor,
    });
    return { connection, ...(result.returnTo ? { returnTo: result.returnTo } : {}) };
  }

  /** Send a credential directly to PlugFn and persist only its remote handle. */
  async connectApiKey(input: {
    actorUserId: string;
    workspaceId: string;
    provider: string;
    ownership: ConnectionOwnership;
    apiKey: string;
    label: string;
  }): Promise<ConnectionBindingRecord> {
    const provider = normalizeProvider(input.provider);
    const label = normalizeLabel(input.label);
    if (input.apiKey.length < 1 || input.apiKey.length > 16_384) {
      throw new ConnectionInputError("API key must contain 1 to 16384 characters");
    }
    await this.authority.authorizeInstall(input);
    this.assertConnectable(provider, "api_key");
    const owner = ownerFor(input);
    const actor = actorFor(input);
    const plugFnConnection = await this.plugfn.connections.connect({
      userId: input.actorUserId,
      provider,
      credentials: { type: "api-key", apiKey: input.apiKey },
      connectionName: label,
      owner,
      actor,
    }).catch(() => { throw new ConnectionProviderOperationError("api_key"); });
    assertConnectionOwner(plugFnConnection, owner, provider);
    if (plugFnConnection.status !== "active") {
      await this.cleanUpUnusableResult({ ...input, provider, label,
        plugFnConnection, owner, actor });
      throw new ConnectionProviderOperationError("api_key");
    }
    return this.attachOrCleanUp({
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      provider,
      ownership: input.ownership,
      label,
      plugFnConnection,
      owner,
      actor,
    });
  }

  /** Probe an accessible binding and keep failed or missing accounts unavailable. */
  async checkHealth(actorUserId: string, connectionId: string): Promise<ConnectionBindingRecord> {
    const binding = await this.authority.getAccessible(actorUserId, connectionId);
    if (binding.status === "revoked") throw new ConnectionUnavailableError();
    const valid = await this.plugfn.connections.isValid(binding.providerConnectionId)
      .catch(() => { throw new ConnectionProviderOperationError("health"); });
    if (valid) {
      return this.authority.recordHealth({
        connectionId,
        status: "active",
        readiness: "ready",
      });
    }
    const remote = await this.plugfn.connections.get(binding.providerConnectionId).catch((error: unknown) => {
      if (isMissingRemoteConnection(error)) return null;
      throw new ConnectionProviderOperationError("health");
    });
    const status = remote?.status === "error" ? "error" : "needs_reauth";
    return this.authority.recordHealth({
      connectionId,
      status,
      readiness: "unavailable",
      reason: remote ? `plugfn_${remote.status}` : "plugfn_connection_missing",
    });
  }

  /** Refresh a manageable binding only when PlugFn returns the same active account. */
  async refresh(actorUserId: string, connectionId: string): Promise<ConnectionBindingRecord> {
    const binding = await this.authority.getManageable(actorUserId, connectionId);
    if (binding.status === "revoked") throw new ConnectionUnavailableError();
    try {
      const remote = await this.plugfn.connections.refresh(binding.providerConnectionId);
      if (remote.id !== binding.providerConnectionId || remote.provider !== binding.provider) {
        throw new ConnectionInputError("PlugFn refreshed an unexpected connection");
      }
      if (remote.status !== "active") {
        throw new ConnectionProviderOperationError("refresh");
      }
      return await this.authority.recordHealth({
        connectionId,
        status: "active",
        readiness: "ready",
      });
    } catch (error) {
      await this.authority.recordHealth({
        connectionId,
        status: "needs_reauth",
        readiness: "unavailable",
        reason: "refresh_failed",
      });
      if (error instanceof ConnectionUnavailableError) throw error;
      throw new ConnectionProviderOperationError("refresh");
    }
  }

  /** Claim local revocation first, then reconcile provider cleanup or owner guidance. */
  async disconnect(
    actorUserId: string,
    connectionId: string,
  ): Promise<{ connection: ConnectionBindingRecord; provider: PlugFnDisconnectResult }> {
    const binding = await this.authority.getRevocable(actorUserId, connectionId);
    const pending = `provider_cleanup_pending:${crypto.randomUUID()}`;
    // The conditional transition serializes retries across Worker instances.
    // It also removes local use and selections before any provider call.
    let claimed: ConnectionBindingRecord | null = null;
    if (canClaimCleanup(binding, actorUserId, this.authority.currentTime())) {
      claimed = binding.status === "revoked"
        ? await this.authority.revokeIf(actorUserId, connectionId, "revoked", binding.healthReason, pending)
        : await this.authority.revokeIfNotRevoked(actorUserId, connectionId, pending);
    }
    if (!claimed) {
      return {
        connection: await this.authority.getRevocable(actorUserId, connectionId),
        provider: { disconnected: false, remoteRevokeAttempted: false,
          remoteRevokeSucceeded: false, localDeleted: false, connectionDeleted: false },
      };
    }
    if (binding.ownership === "personal" && binding.ownerUserId !== actorUserId) {
      // PlugFn's personal disconnect requires the owner as the actual actor.
      // Never impersonate a former member to delete their provider credential.
      const connection = await this.finalizeCleanup(
        actorUserId, connectionId, pending, "provider_cleanup_requires_owner",
      );
      return {
        connection,
        provider: { disconnected: false, remoteRevokeAttempted: false,
          remoteRevokeSucceeded: false, localDeleted: false, connectionDeleted: false },
      };
    }
    const ownershipInput = {
      actorUserId,
      workspaceId: binding.workspaceId,
      ownership: binding.ownership,
    };
    const provider = await this.plugfn.connections.disconnect({
      userId: actorUserId,
      provider: binding.provider,
      connectionId: binding.providerConnectionId,
      owner: ownerFor(ownershipInput),
      actor: actorFor(ownershipInput),
    }).catch((): PlugFnDisconnectResult => ({
      disconnected: false,
      remoteRevokeAttempted: true,
      remoteRevokeSucceeded: false,
      localDeleted: false,
      connectionDeleted: false,
    }));
    // The upstream result may contain a provider error message. Return only
    // status fields; callers can safely tell users that remote cleanup failed.
    const safeProvider = {
      disconnected: provider.disconnected,
      remoteRevokeAttempted: provider.remoteRevokeAttempted,
      remoteRevokeSucceeded: provider.remoteRevokeSucceeded,
      localDeleted: provider.localDeleted,
      connectionDeleted: provider.connectionDeleted,
    };
    const reason = cleanupReason(provider, this.plugfn.providers.get(binding.provider)?.auth.type === "oauth2");
    const connection = await this.finalizeCleanup(actorUserId, connectionId, pending, reason);
    return { connection, provider: safeProvider };
  }

  /** Retry a failed outcome write under the same claim, then recheck response access. */
  private async finalizeCleanup(
    actorUserId: string,
    connectionId: string,
    pending: string,
    reason?: string,
  ): Promise<ConnectionBindingRecord> {
    try {
      await this.authority.finalizeCleanupClaim(connectionId, pending, reason);
    } catch {
      // The first write may have failed before commit, or after commit with a
      // lost acknowledgement. The same conditional claim is safe in both cases.
      await this.authority.finalizeCleanupClaim(connectionId, pending, reason);
    }
    // Membership may have changed during provider I/O. The claim may finish,
    // but its former actor must not receive a now-inaccessible binding.
    return this.authority.getRevocable(actorUserId, connectionId);
  }

  /** Reuse duplicate results or retain a failed attach as revoked cleanup state. */
  private async attachOrCleanUp(input: {
    actorUserId: string;
    workspaceId: string;
    provider: string;
    ownership: ConnectionOwnership;
    label: string;
    plugFnConnection: PlugFnConnection;
    owner: PlugFnOwner;
    actor: PlugFnActor;
  }): Promise<ConnectionBindingRecord> {
    try {
      return await this.authority.attach({
        actorUserId: input.actorUserId,
        workspaceId: input.workspaceId,
        provider: input.provider,
        providerConnectionId: input.plugFnConnection.id,
        ownership: input.ownership,
        label: input.label,
      });
    } catch {
      const existing = await this.findVisibleRemoteBinding(input);
      if (existing && existing.status !== "revoked") {
        const reconciled = await this.authority.reconcileActiveDuplicate({
          actorUserId: input.actorUserId, connectionId: existing.id, workspaceId: input.workspaceId,
          provider: input.provider, providerConnectionId: input.plugFnConnection.id,
          ownership: input.ownership,
        }).catch(() => null);
        if (reconciled) return reconciled;
        throw new ConnectionProviderOperationError("binding");
      }
      await this.cleanUpUnusableResult(input);
      throw new ConnectionProviderOperationError("binding");
    }
  }

  /** Find a same-owner binding visible to the current callback or credential actor. */
  private async findVisibleRemoteBinding(input: {
    actorUserId: string;
    workspaceId: string;
    provider: string;
    ownership: ConnectionOwnership;
    plugFnConnection: PlugFnConnection;
  }): Promise<ConnectionBindingRecord | undefined> {
    const visible = await this.authority.listAvailable({ actorUserId: input.actorUserId,
      workspaceId: input.workspaceId, provider: input.provider }).catch(() => []);
    return visible.find((binding) => binding.providerConnectionId === input.plugFnConnection.id &&
      binding.ownership === input.ownership &&
      (binding.ownership === "workspace" || binding.ownerUserId === input.actorUserId));
  }

  /** Reserve the remote handle before deleting it; a competing live binding wins unchanged. */
  private async cleanUpUnusableResult(input: {
    actorUserId: string;
    workspaceId: string;
    provider: string;
    ownership: ConnectionOwnership;
    label: string;
    plugFnConnection: PlugFnConnection;
    owner: PlugFnOwner;
    actor: PlugFnActor;
  }): Promise<void> {
    let record: ConnectionBindingRecord;
    try {
      record = await this.authority.attachForCleanup({
        actorUserId: input.actorUserId,
        workspaceId: input.workspaceId,
        provider: input.provider,
        providerConnectionId: input.plugFnConnection.id,
        ownership: input.ownership,
        label: input.label,
      });
    } catch {
      // The uniqueness constraint arbitrates with a concurrent successful attach.
      // A separate read may classify the error, but must never authorize deletion.
      const bound = await this.authority.hasRemoteBinding({ workspaceId: input.workspaceId,
        providerConnectionId: input.plugFnConnection.id }).catch(() => null);
      if (bound) throw new ConnectionProviderOperationError("binding");
      throw new ConnectionCleanupUntrackedError();
    }
    // A membership can disappear after PlugFn returns. The committed record is
    // still available for an authorized owner or orphan cleanup retry.
    await this.disconnect(input.actorUserId, record.id).catch(() => undefined);
  }
}
