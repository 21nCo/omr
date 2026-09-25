import {
  ConnectionAuthority,
  ConnectionInputError,
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

export interface ProviderReadiness {
  provider: string;
  available: boolean;
  authMode: "oauth" | "api_key" | "jwt" | "basic" | "none" | "unknown";
  actionCount: number;
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

function authMode(type: string): ProviderReadiness["authMode"] {
  if (type === "oauth2") return "oauth";
  if (type === "api-key") return "api_key";
  if (type === "jwt" || type === "basic" || type === "none") return type;
  return "unknown";
}

export class PlugFnConnectionOrchestrator {
  constructor(
    private readonly authority: ConnectionAuthority,
    private readonly plugfn: PlugFnConnectionPort,
  ) {}

  providerReadiness(providerValue: string): ProviderReadiness {
    const provider = normalizeProvider(providerValue);
    const definition = this.plugfn.providers.get(provider);
    return {
      provider,
      available: Boolean(
        definition &&
        (definition.auth.type !== "oauth2" || this.plugfn.config?.integrations?.[provider]),
      ),
      authMode: definition ? authMode(definition.auth.type) : "unknown",
      actionCount: definition ? Object.keys(definition.actions).length : 0,
    };
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
    });
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
    });
    assertConnectionOwner(result.connection, owner, provider);
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
    const owner = ownerFor(input);
    const actor = actorFor(input);
    const plugFnConnection = await this.plugfn.connections.connect({
      userId: input.actorUserId,
      provider,
      credentials: { type: "api-key", apiKey: input.apiKey },
      connectionName: label,
      owner,
      actor,
    });
    assertConnectionOwner(plugFnConnection, owner, provider);
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
    const valid = await this.plugfn.connections.isValid(binding.providerConnectionId);
    if (valid) {
      return this.authority.recordHealth({
        connectionId,
        status: "active",
        readiness: "ready",
      });
    }
    const remote = await this.plugfn.connections.get(binding.providerConnectionId).catch(() => null);
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
    try {
      const remote = await this.plugfn.connections.refresh(binding.providerConnectionId);
      if (remote.id !== binding.providerConnectionId || remote.provider !== binding.provider) {
        throw new ConnectionInputError("PlugFn refreshed an unexpected connection");
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
      throw error;
    }
  }

  async disconnect(
    actorUserId: string,
    connectionId: string,
  ): Promise<{ connection: ConnectionBindingRecord; provider: PlugFnDisconnectResult }> {
    const binding = await this.authority.getManageable(actorUserId, connectionId);
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
    });
    const reason = provider.remoteRevokeAttempted && !provider.remoteRevokeSucceeded
      ? "remote_revoke_failed"
      : !provider.disconnected
        ? "plugfn_connection_missing"
        : undefined;
    const connection = await this.authority.revoke(actorUserId, connectionId, reason);
    return { connection, provider };
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
