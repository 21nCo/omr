import type { WorkspaceStore } from "@oh-my-router/identity";

import {
  ConnectionAccessDeniedError,
  ConnectionUnavailableError,
  type AccessConnectionInput,
  type AttachConnectionInput,
  type AuthorizeConnectionInstallInput,
  type ConnectionBindingRecord,
  type ConnectionBindingStore,
  type ConnectionSelectionRecord,
  type RevokeConnectionInput,
  type SelectConnectionInput,
} from "./connections.js";

function selectionKey(workspaceId: string, userId: string, provider: string): string {
  return `${workspaceId}\u0000${userId}\u0000${provider}`;
}

export class MemoryConnectionBindingStore implements ConnectionBindingStore {
  readonly connections = new Map<string, ConnectionBindingRecord>();
  readonly selections = new Map<string, ConnectionSelectionRecord>();

  constructor(private readonly workspaces: WorkspaceStore) {}

  async authorizeInstall(input: AuthorizeConnectionInstallInput): Promise<void> {
    const membership = await this.workspaces.findMembership(input.workspaceId, input.actorUserId);
    if (
      !membership ||
      (input.ownership === "workspace" && membership.role !== "owner" && membership.role !== "admin")
    ) {
      throw new ConnectionAccessDeniedError();
    }
  }

  async attach(input: AttachConnectionInput): Promise<ConnectionBindingRecord> {
    const membership = await this.workspaces.findMembership(
      input.connection.workspaceId,
      input.actorUserId,
    );
    if (
      !membership ||
      (input.connection.ownership === "workspace" &&
        membership.role !== "owner" &&
        membership.role !== "admin")
    ) {
      throw new ConnectionAccessDeniedError();
    }
    const duplicate = [...this.connections.values()].some(
      (connection) =>
        connection.workspaceId === input.connection.workspaceId &&
        connection.providerConnectionId === input.connection.providerConnectionId,
    );
    if (duplicate) throw new ConnectionAccessDeniedError();
    const connection = structuredClone(input.connection);
    this.connections.set(connection.id, connection);
    return structuredClone(connection);
  }

  async getAccessible(input: AccessConnectionInput): Promise<ConnectionBindingRecord> {
    const connection = this.connections.get(input.connectionId);
    if (!connection) throw new ConnectionAccessDeniedError();
    const membership = await this.workspaces.findMembership(
      connection.workspaceId,
      input.actorUserId,
    );
    const authorized = Boolean(membership) &&
      (connection.ownership === "workspace" || connection.ownerUserId === input.actorUserId);
    if (!authorized) throw new ConnectionAccessDeniedError();
    return structuredClone(connection);
  }

  async getManageable(input: AccessConnectionInput): Promise<ConnectionBindingRecord> {
    const connection = this.connections.get(input.connectionId);
    if (!connection) throw new ConnectionAccessDeniedError();
    const membership = await this.workspaces.findMembership(
      connection.workspaceId,
      input.actorUserId,
    );
    const authorized = connection.ownership === "personal"
      ? Boolean(membership) && connection.ownerUserId === input.actorUserId
      : membership?.role === "owner" || membership?.role === "admin";
    if (!authorized) throw new ConnectionAccessDeniedError();
    return structuredClone(connection);
  }

  async listAvailable(input: {
    actorUserId: string;
    workspaceId: string;
    provider?: string;
  }): Promise<ConnectionBindingRecord[]> {
    if (!(await this.workspaces.findMembership(input.workspaceId, input.actorUserId))) {
      throw new ConnectionAccessDeniedError();
    }
    return [...this.connections.values()]
      .filter(
        (connection) =>
          connection.workspaceId === input.workspaceId &&
          (!input.provider || connection.provider === input.provider) &&
          (connection.ownership === "workspace" || connection.ownerUserId === input.actorUserId),
      )
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((connection) => structuredClone(connection));
  }

  async getSelection(input: {
    actorUserId: string;
    workspaceId: string;
    provider: string;
  }): Promise<ConnectionSelectionRecord | null> {
    if (!(await this.workspaces.findMembership(input.workspaceId, input.actorUserId))) {
      throw new ConnectionAccessDeniedError();
    }
    const selection = this.selections.get(
      selectionKey(input.workspaceId, input.actorUserId, input.provider),
    );
    return selection ? structuredClone(selection) : null;
  }

  async select(input: SelectConnectionInput): Promise<ConnectionSelectionRecord> {
    const available = await this.listAvailable({
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      provider: input.provider,
    });
    const connection = available.find(
      (candidate) =>
        candidate.id === input.connectionId &&
        candidate.status === "active" &&
        candidate.readiness === "ready",
    );
    if (!connection) throw new ConnectionUnavailableError();
    const key = selectionKey(input.workspaceId, input.actorUserId, input.provider);
    const existing = this.selections.get(key);
    const selection: ConnectionSelectionRecord = {
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
      provider: input.provider,
      connectionId: input.connectionId,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    this.selections.set(key, selection);
    return structuredClone(selection);
  }

  async revoke(input: RevokeConnectionInput): Promise<ConnectionBindingRecord> {
    const connection = this.connections.get(input.connectionId);
    if (!connection) throw new ConnectionAccessDeniedError();
    const membership = await this.workspaces.findMembership(
      connection.workspaceId,
      input.actorUserId,
    );
    const authorized =
      connection.ownership === "personal"
        ? Boolean(membership) && connection.ownerUserId === input.actorUserId
        : membership?.role === "owner" || membership?.role === "admin";
    if (!authorized) throw new ConnectionAccessDeniedError();
    connection.status = "revoked";
    connection.readiness = "unavailable";
    connection.healthReason = input.reason ?? null;
    connection.revokedAt ??= input.now;
    connection.updatedAt = input.now;
    for (const [key, selection] of this.selections) {
      if (selection.connectionId === connection.id) this.selections.delete(key);
    }
    return structuredClone(connection);
  }

  async recordHealth(input: {
    connectionId: string;
    status: ConnectionBindingRecord["status"];
    readiness: ConnectionBindingRecord["readiness"];
    reason?: string;
    now: number;
  }): Promise<ConnectionBindingRecord> {
    const connection = this.connections.get(input.connectionId);
    if (!connection || connection.status === "revoked") throw new ConnectionUnavailableError();
    connection.status = input.status;
    connection.readiness = input.readiness;
    connection.healthReason = input.reason ?? null;
    connection.lastCheckedAt = input.now;
    connection.updatedAt = input.now;
    return structuredClone(connection);
  }
}
