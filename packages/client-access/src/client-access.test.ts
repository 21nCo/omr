import { describe, expect, it } from "vitest";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { WorkspaceAuthority } from "@oh-my-router/identity";

import {
  ClientAccessAuthority,
  ClientAccessDeniedError,
  ClientCapabilityDeniedError,
  InvalidClientCredentialError,
} from "./client-access.js";
import { MemoryClientAccessStore } from "./testing.js";

async function createFixture() {
  let now = 1_700_000_000_000;
  const workspaceStore = new MemoryWorkspaceStore();
  const workspaces = new WorkspaceAuthority(workspaceStore, () => now);
  const clientStore = new MemoryClientAccessStore(workspaceStore);
  const clients = new ClientAccessAuthority(clientStore, () => now);
  const team = await workspaces.createTeam({
    ownerUserId: "user_owner",
    name: "Client Team",
  });
  return {
    clients,
    clientStore,
    workspaceStore,
    workspaceId: team.workspace.id,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

describe("client access authority", () => {
  it("issues a scoped hashed credential and authenticates its principal", async () => {
    const { clients, clientStore, workspaceId } = await createFixture();
    const client = await clients.registerClient({
      actorUserId: "user_owner",
      workspaceId,
      kind: "cli",
      name: "  Ada's Laptop  ",
    });
    const issued = await clients.issueGrant({
      actorUserId: "user_owner",
      clientId: client.id,
      workspaceId,
      capabilities: ["tools:read", "tools:discover", "tools:read"],
    });

    expect(client.name).toBe("Ada's Laptop");
    expect(issued.credential).toMatch(/^omr_[a-f0-9]{64}$/);
    expect(issued.grant.credentialHash).not.toBe(issued.credential);
    expect(JSON.stringify([...clientStore.grants.values()])).not.toContain(issued.credential);
    await expect(
      clients.authenticate(issued.credential, "tools:discover"),
    ).resolves.toMatchObject({
      clientId: client.id,
      workspaceId,
      userId: "user_owner",
      kind: "cli",
      capabilities: ["tools:discover", "tools:read"],
    });
    await expect(
      clients.authenticate(issued.credential, "tools:write"),
    ).rejects.toBeInstanceOf(ClientCapabilityDeniedError);
  });

  it("observes grant and client revocation immediately", async () => {
    const { clients, workspaceId } = await createFixture();
    const firstClient = await clients.registerClient({
      actorUserId: "user_owner",
      workspaceId,
      kind: "mcp_remote",
      name: "Remote Agent",
    });
    const firstGrant = await clients.issueGrant({
      actorUserId: "user_owner",
      clientId: firstClient.id,
      workspaceId,
      capabilities: ["tools:read"],
    });
    await clients.revokeGrant("user_owner", firstGrant.grant.id);
    await expect(clients.authenticate(firstGrant.credential)).rejects.toBeInstanceOf(
      InvalidClientCredentialError,
    );

    const secondClient = await clients.registerClient({
      actorUserId: "user_owner",
      workspaceId,
      kind: "mcp_stdio",
      name: "Local Agent",
    });
    const secondGrant = await clients.issueGrant({
      actorUserId: "user_owner",
      clientId: secondClient.id,
      workspaceId,
      capabilities: ["tools:read"],
    });
    await clients.revokeClient("user_owner", secondClient.id);
    await expect(clients.authenticate(secondGrant.credential)).rejects.toBeInstanceOf(
      InvalidClientCredentialError,
    );
  });

  it("lists only owned, live manual grants without credential material and revokes their client", async () => {
    const { clients, clientStore, workspaceStore, workspaceId } = await createFixture();
    const client = await clients.registerClient({
      actorUserId: "user_owner", workspaceId, kind: "cli", name: "Staging CLI",
    });
    const issued = await clients.issueGrant({
      actorUserId: "user_owner", clientId: client.id, workspaceId,
      capabilities: ["tools:discover"],
    });
    const listed = await clients.listManualGrants("user_owner");
    expect(listed).toEqual({ grants: [expect.objectContaining({
      id: issued.grant.id, clientId: client.id, clientName: "Staging CLI",
    })], nextCursor: null });
    expect(JSON.stringify(listed)).not.toContain(issued.credential);
    expect(JSON.stringify(listed)).not.toContain(issued.grant.credentialHash);
    await expect(clients.listManualGrants("user_outsider")).resolves.toEqual({
      grants: [], nextCursor: null,
    });
    await expect(clients.revokeManualClient("user_outsider", client.id))
      .rejects.toBeInstanceOf(ClientAccessDeniedError);

    const membership = [...workspaceStore.memberships.values()].find(
      (record) => record.workspaceId === workspaceId && record.userId === "user_owner",
    )!;
    workspaceStore.memberships.delete(membership.id);
    await expect(clients.listManualGrants("user_owner")).resolves.toMatchObject({
      grants: [{ clientId: client.id }],
    });
    await clients.revokeManualClient("user_owner", client.id);
    await expect(clients.authenticate(issued.credential)).rejects.toBeInstanceOf(
      InvalidClientCredentialError,
    );
    await expect(clients.listManualGrants("user_owner")).resolves.toEqual({
      grants: [], nextCursor: null,
    });
    clientStore.oauthClientIds.add(client.id);
    await expect(clients.revokeManualClient("user_owner", client.id))
      .rejects.toBeInstanceOf(ClientAccessDeniedError);
  });

  it("paginates manual grants with a stable created-at and id cursor", async () => {
    const { clients, workspaceId } = await createFixture();
    const client = await clients.registerClient({
      actorUserId: "user_owner", workspaceId, kind: "mcp_stdio", name: "Many grants",
    });
    for (let index = 0; index < 51; index += 1) {
      await clients.issueGrant({
        actorUserId: "user_owner", clientId: client.id, workspaceId,
        capabilities: ["tools:read"],
      });
    }
    const first = await clients.listManualGrants("user_owner");
    expect(first.grants).toHaveLength(50);
    expect(first.nextCursor).toMatch(/^\d+:grant_/);
    const second = await clients.listManualGrants("user_owner", first.nextCursor!);
    expect(second.grants).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.grants, ...second.grants].map((grant) => grant.id)).size).toBe(51);
    await expect(clients.listManualGrants("user_owner", "bad-cursor"))
      .rejects.toMatchObject({ code: "CLIENT_ACCESS_INPUT_INVALID" });
  });

  it("rejects expired grants and grants whose member lost workspace access", async () => {
    const { clients, clientStore, workspaceStore, workspaceId, advance } = await createFixture();
    const client = await clients.registerClient({
      actorUserId: "user_owner",
      workspaceId,
      kind: "headless",
      name: "CI",
    });
    const expiring = await clients.issueGrant({
      actorUserId: "user_owner",
      clientId: client.id,
      workspaceId,
      capabilities: ["tools:read"],
      ttlMs: 60_000,
    });
    advance(60_000);
    await expect(clients.authenticate(expiring.credential)).rejects.toBeInstanceOf(
      InvalidClientCredentialError,
    );

    const active = [...clientStore.grants.values()][0]!;
    active.expiresAt += 60_001;
    const ownerMembership = [...workspaceStore.memberships.values()].find(
      (membership) => membership.workspaceId === workspaceId,
    )!;
    workspaceStore.memberships.delete(ownerMembership.id);
    await expect(clients.authenticate(expiring.credential)).rejects.toBeInstanceOf(
      InvalidClientCredentialError,
    );
  });

  it("denies registration and revocation to users outside the workspace", async () => {
    const { clients, workspaceId } = await createFixture();
    await expect(
      clients.registerClient({
        actorUserId: "user_outsider",
        workspaceId,
        kind: "cli",
        name: "Untrusted",
      }),
    ).rejects.toBeInstanceOf(ClientAccessDeniedError);

    const client = await clients.registerClient({
      actorUserId: "user_owner",
      workspaceId,
      kind: "cli",
      name: "Trusted",
    });
    await expect(
      clients.revokeClient("user_outsider", client.id),
    ).rejects.toBeInstanceOf(ClientAccessDeniedError);
  });

  it("lets a former member revoke their own client but not another user's", async () => {
    const { clients, workspaceStore, workspaceId } = await createFixture();
    const client = await clients.registerClient({
      actorUserId: "user_owner", workspaceId, kind: "mcp_remote", name: "Former member",
    });
    const membership = [...workspaceStore.memberships.values()].find(
      (record) => record.workspaceId === workspaceId && record.userId === "user_owner",
    )!;
    workspaceStore.memberships.delete(membership.id);

    await expect(clients.revokeClient("user_outsider", client.id)).rejects.toBeInstanceOf(
      ClientAccessDeniedError,
    );
    await expect(clients.revokeClient("user_owner", client.id)).resolves.toBeUndefined();
  });
});
