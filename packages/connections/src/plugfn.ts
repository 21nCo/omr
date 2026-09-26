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
  constructor(readonly operation: "oauth_start" | "oauth_callback" | "api_key" | "health" | "refresh") {
    super({
      oauth_start: "Could not start provider authorization. Check provider setup and try again.",
      oauth_callback: "Provider authorization failed. Start a new connection.",
      api_key: "The provider rejected this API key. Check the key and its permissions.",
      health: "Could not check provider health. Try again later.",
      refresh: "Could not refresh this account. Reconnect it to restore access.",
    }[operation]);
    this.name = "ConnectionProviderOperationError";
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

  async startOAuth(input: {
    actorUserId: string;
    workspaceId: string;
    provider: string;
    ownership: ConnectionOwnership;
    redirectUri: string;
    label: string;
    scopes?: string[];
    returnTo?: string;
    prompt?: string;
    loginHint?: string;
  }): Promise<{ authUrl: string }> {
    const provider = normalizeProvider(input.provider);
    const label = normalizeLabel(input.label);
    await this.authority.authorizeInstall(input);
    this.assertConnectable(provider, "oauth");
    const owner = ownerFor(input);
    // GitHub's PlugFn defaults include write-capable repository scopes. An empty
    // array would fall back to the shared OAuth descriptor's profile/email grant.
    const scopes = input.scopes ?? (provider === "github" ? ["read:user"] : undefined);
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
      await this.plugfn.connections.disconnect({ userId: input.actorUserId, provider,
        connectionId: result.connection.id, owner, actor }).catch(() => undefined);
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
      await this.plugfn.connections.disconnect({ userId: input.actorUserId, provider,
        connectionId: plugFnConnection.id, owner, actor }).catch(() => undefined);
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

  async disconnect(
    actorUserId: string,
    connectionId: string,
  ): Promise<{ connection: ConnectionBindingRecord; provider: PlugFnDisconnectResult }> {
    const binding = await this.authority.getManageable(actorUserId, connectionId);
    const pending = `provider_cleanup_pending:${crypto.randomUUID()}`;
    const retryable = binding.healthReason === "remote_revoke_failed" || binding.healthReason === "provider_cleanup_failed";
    const stalePending = binding.status === "revoked" &&
      (binding.healthReason === "provider_cleanup_pending" ||
        binding.healthReason?.startsWith("provider_cleanup_pending:")) &&
      this.authority.currentTime() - binding.updatedAt > 60_000;
    const claimable = binding.status !== "revoked" || retryable || stalePending;
    // The conditional transition serializes retries across Worker instances.
    // It also removes local use and selections before any provider call.
    const claimed = !claimable ? null : binding.status === "revoked"
      ? await this.authority.revokeIf(actorUserId, connectionId, "revoked", binding.healthReason, pending)
      : await this.authority.revokeIfNotRevoked(actorUserId, connectionId, pending);
    if (!claimed) {
      return {
        connection: await this.authority.getManageable(actorUserId, connectionId),
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
    const remoteFailure = provider.remoteRevokeAttempted && !provider.remoteRevokeSucceeded;
    const oauthGrantMayRemain = this.plugfn.providers.get(binding.provider)?.auth.type === "oauth2" &&
      !provider.remoteRevokeSucceeded;
    const reason = provider.connectionDeleted
      ? remoteFailure || oauthGrantMayRemain ? "remote_revocation_unavailable" : undefined
      : !provider.disconnected && !provider.remoteRevokeAttempted && !provider.localDeleted
        ? "provider_connection_missing"
        : remoteFailure ? "remote_revoke_failed" : "provider_cleanup_failed";
    const connection = await this.authority.revokeIf(
      actorUserId, connectionId, "revoked", pending, reason,
    ).catch(() => null);
    return { connection: connection ?? await this.authority.getManageable(actorUserId, connectionId), provider: safeProvider };
  }

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
    } catch (error) {
      await this.plugfn.connections.disconnect({
        userId: input.actorUserId,
        provider: input.provider,
        connectionId: input.plugFnConnection.id,
        owner: input.owner,
        actor: input.actor,
      }).catch(() => undefined);
      throw error;
    }
  }
}
