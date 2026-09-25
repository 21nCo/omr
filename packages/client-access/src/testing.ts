import type { WorkspaceStore } from "@oh-my-router/identity";

import {
  ClientAccessDeniedError,
  InvalidClientCredentialError,
  type ClientAccessStore,
  type ClientGrantRecord,
  type ClientPrincipal,
  type ClientRecord,
  type IssueClientGrantInput,
  type ListManualClientGrantsInput,
  type ManualClientGrant,
  type RegisterClientInput,
  type RevokeClientAccessInput,
} from "./client-access.js";
import {
  DeviceAuthorizationError,
  type ApproveDeviceAuthorizationInput,
  type ConsumeDeviceAuthorizationInput,
  type DeviceAuthorizationRecord,
  type DeviceAuthorizationStore,
} from "./device-login.js";

export class MemoryClientAccessStore implements ClientAccessStore {
  readonly clients = new Map<string, ClientRecord>();
  readonly grants = new Map<string, ClientGrantRecord>();
  readonly oauthClientIds = new Set<string>();

  constructor(private readonly workspaces: WorkspaceStore) {}

  async registerClient(input: RegisterClientInput): Promise<ClientRecord> {
    await this.requireMembership(input.client.workspaceId, input.actorUserId);
    const client = structuredClone(input.client);
    this.clients.set(client.id, client);
    return structuredClone(client);
  }

  async issueGrant(input: IssueClientGrantInput): Promise<ClientGrantRecord> {
    const client = this.clients.get(input.grant.clientId);
    if (
      !client ||
      client.revokedAt !== null ||
      client.workspaceId !== input.grant.workspaceId ||
      client.registeredBy !== input.actorUserId
    ) {
      throw new ClientAccessDeniedError();
    }
    await this.requireMembership(client.workspaceId, input.actorUserId);
    const grant = structuredClone(input.grant);
    this.grants.set(grant.id, grant);
    return structuredClone(grant);
  }

  async authenticate(credentialHash: string, now: number): Promise<ClientPrincipal> {
    const grant = [...this.grants.values()].find(
      (candidate) => candidate.credentialHash === credentialHash,
    );
    const client = grant ? this.clients.get(grant.clientId) : undefined;
    if (
      !grant ||
      !client ||
      grant.revokedAt !== null ||
      client.revokedAt !== null ||
      grant.expiresAt <= now ||
      !(await this.workspaces.findMembership(grant.workspaceId, grant.userId))
    ) {
      throw new InvalidClientCredentialError();
    }
    return {
      grantId: grant.id,
      clientId: client.id,
      workspaceId: grant.workspaceId,
      userId: grant.userId,
      kind: client.kind,
      capabilities: [...grant.capabilities],
    };
  }

  async listManualGrants(input: ListManualClientGrantsInput): Promise<ManualClientGrant[]> {
    return [...this.grants.values()].flatMap((grant) => {
      const client = this.clients.get(grant.clientId);
      if (!client || client.registeredBy !== input.actorUserId ||
        grant.userId !== input.actorUserId || client.revokedAt !== null ||
        grant.revokedAt !== null || grant.expiresAt <= input.now ||
        this.oauthClientIds.has(client.id)) return [];
      if (input.after && (grant.createdAt > input.after.createdAt ||
        (grant.createdAt === input.after.createdAt && grant.id >= input.after.id))) return [];
      return [{
        id: grant.id,
        clientId: client.id,
        workspaceId: grant.workspaceId,
        clientName: client.name,
        kind: client.kind,
        capabilities: [...grant.capabilities],
        expiresAt: grant.expiresAt,
        createdAt: grant.createdAt,
      }];
    }).sort((left, right) => right.createdAt - left.createdAt ||
      right.id.localeCompare(left.id)).slice(0, input.limit);
  }

  async revokeManualClient(input: RevokeClientAccessInput): Promise<void> {
    const client = this.clients.get(input.targetId);
    if (!client || client.registeredBy !== input.actorUserId ||
      this.oauthClientIds.has(client.id)) throw new ClientAccessDeniedError();
    client.revokedAt ??= input.now;
    client.updatedAt = input.now;
  }

  async revokeGrant(input: RevokeClientAccessInput): Promise<void> {
    const grant = this.grants.get(input.targetId);
    const client = grant ? this.clients.get(grant.clientId) : undefined;
    if (!grant || !client || !(await this.canManage(client, input.actorUserId))) {
      throw new ClientAccessDeniedError();
    }
    grant.revokedAt ??= input.now;
    grant.updatedAt = input.now;
  }

  async revokeClient(input: RevokeClientAccessInput): Promise<void> {
    const client = this.clients.get(input.targetId);
    if (!client || !(await this.canManage(client, input.actorUserId))) {
      throw new ClientAccessDeniedError();
    }
    client.revokedAt ??= input.now;
    client.updatedAt = input.now;
  }

  private async requireMembership(workspaceId: string, userId: string): Promise<void> {
    if (!(await this.workspaces.findMembership(workspaceId, userId))) {
      throw new ClientAccessDeniedError();
    }
  }

  private async canManage(client: ClientRecord, actorUserId: string): Promise<boolean> {
    if (client.registeredBy === actorUserId) return true;
    const membership = await this.workspaces.findMembership(client.workspaceId, actorUserId);
    return Boolean(
      membership &&
        (membership.role === "owner" || membership.role === "admin"),
    );
  }
}

export class MemoryDeviceAuthorizationStore implements DeviceAuthorizationStore {
  readonly authorizations = new Map<string, DeviceAuthorizationRecord>();

  constructor(
    private readonly workspaces: WorkspaceStore,
    private readonly clients: MemoryClientAccessStore,
  ) {}

  async create(record: DeviceAuthorizationRecord): Promise<DeviceAuthorizationRecord> {
    const stored = structuredClone(record);
    this.authorizations.set(stored.id, stored);
    return structuredClone(stored);
  }

  async findByUserCodeHash(userCodeHash: string): Promise<DeviceAuthorizationRecord | null> {
    const record = [...this.authorizations.values()].find(
      (candidate) => candidate.userCodeHash === userCodeHash,
    );
    return record ? structuredClone(record) : null;
  }

  async findByDeviceCodeHash(deviceCodeHash: string): Promise<DeviceAuthorizationRecord | null> {
    const record = [...this.authorizations.values()].find(
      (candidate) => candidate.deviceCodeHash === deviceCodeHash,
    );
    return record ? structuredClone(record) : null;
  }

  async approve(
    input: ApproveDeviceAuthorizationInput,
  ): Promise<{ client: ClientRecord; grant: ClientGrantRecord }> {
    const authorization = this.authorizations.get(input.authorizationId);
    const membership = await this.workspaces.findMembership(
      input.workspaceId,
      input.actorUserId,
    );
    if (
      !authorization ||
      authorization.userCodeHash !== input.userCodeHash ||
      authorization.status !== "pending" ||
      authorization.expiresAt <= input.now ||
      !membership
    ) {
      throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_INVALID");
    }

    const client: ClientRecord = {
      id: input.clientId,
      workspaceId: input.workspaceId,
      kind: authorization.clientKind,
      name: authorization.clientName,
      registeredBy: input.actorUserId,
      revokedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    const grant: ClientGrantRecord = {
      id: input.grantId,
      clientId: client.id,
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
      capabilities: [...authorization.requestedCapabilities],
      credentialHash: input.credentialHash,
      expiresAt: input.grantExpiresAt,
      revokedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.clients.clients.set(client.id, structuredClone(client));
    this.clients.grants.set(grant.id, structuredClone(grant));
    Object.assign(authorization, {
      status: "approved" as const,
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
      clientId: client.id,
      grantId: grant.id,
      sealedCredential: input.sealedCredential,
      updatedAt: input.now,
    });
    return { client: structuredClone(client), grant: structuredClone(grant) };
  }

  async consume(input: ConsumeDeviceAuthorizationInput): Promise<void> {
    const authorization = this.authorizations.get(input.authorizationId);
    if (
      !authorization ||
      authorization.deviceCodeHash !== input.deviceCodeHash ||
      authorization.status !== "approved" ||
      authorization.expiresAt <= input.now
    ) {
      throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_INVALID");
    }
    authorization.status = "consumed";
    authorization.sealedCredential = null;
    authorization.updatedAt = input.now;
  }
}
