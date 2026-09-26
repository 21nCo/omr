import { describe, expect, it } from "vitest";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { WorkspaceAuthority } from "@oh-my-router/identity";

import {
  ConnectionAccessDeniedError,
  ConnectionAuthority,
  ConnectionSelectionRequiredError,
  ConnectionUnavailableError,
} from "./connections.js";
import { MemoryConnectionBindingStore } from "./testing.js";

async function createFixture() {
  let now = 1_700_000_000_000;
  const workspaceStore = new MemoryWorkspaceStore();
  const workspaces = new WorkspaceAuthority(workspaceStore, () => now);
  const team = await workspaces.createTeam({ ownerUserId: "user_owner", name: "Connections" });
  const adminInvite = await workspaces.inviteMember({
    actorUserId: "user_owner",
    workspaceId: team.workspace.id,
    email: "admin@example.com",
    role: "admin",
  });
  await workspaces.acceptInvitation({
    token: adminInvite.token,
    userId: "user_admin",
    email: "admin@example.com",
    emailVerified: true,
  });
  const memberInvite = await workspaces.inviteMember({
    actorUserId: "user_owner",
    workspaceId: team.workspace.id,
    email: "member@example.com",
    role: "member",
  });
  await workspaces.acceptInvitation({
    token: memberInvite.token,
    userId: "user_member",
    email: "member@example.com",
    emailVerified: true,
  });
  const store = new MemoryConnectionBindingStore(workspaceStore);
  const connections = new ConnectionAuthority(store, () => now);
  return {
    connections,
    store,
    workspaceStore,
    workspaceId: team.workspace.id,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

describe("connection authority", () => {
  it("keeps personal accounts private while exposing workspace accounts", async () => {
    const { connections, workspaceId } = await createFixture();
    const shared = await connections.attach({
      actorUserId: "user_owner",
      workspaceId,
      provider: "GitHub",
      providerConnectionId: "plug_shared",
      ownership: "workspace",
      label: "  Engineering Org  ",
    });
    const personal = await connections.attach({
      actorUserId: "user_member",
      workspaceId,
      provider: "github",
      providerConnectionId: "plug_personal",
      ownership: "personal",
      label: "Member Account",
    });

    await expect(
      connections.listAvailable({ actorUserId: "user_member", workspaceId, provider: "github" }),
    ).resolves.toEqual([shared, personal]);
    await expect(
      connections.listAvailable({ actorUserId: "user_admin", workspaceId, provider: "github" }),
    ).resolves.toEqual([shared]);
    expect(shared.label).toBe("Engineering Org");
  });

  it("allows only owner/admin installation of shared workspace accounts", async () => {
    const { connections, workspaceId } = await createFixture();
    await expect(
      connections.attach({
        actorUserId: "user_member",
        workspaceId,
        provider: "linear",
        providerConnectionId: "plug_denied",
        ownership: "workspace",
        label: "Denied",
      }),
    ).rejects.toBeInstanceOf(ConnectionAccessDeniedError);
    await expect(
      connections.attach({
        actorUserId: "user_admin",
        workspaceId,
        provider: "linear",
        providerConnectionId: "plug_allowed",
        ownership: "workspace",
        label: "Allowed",
      }),
    ).resolves.toMatchObject({ ownership: "workspace", installedBy: "user_admin" });
  });

  it("requires explicit account selection and ignores stale unhealthy selections", async () => {
    const { connections, workspaceId, advance } = await createFixture();
    const first = await connections.attach({
      actorUserId: "user_owner",
      workspaceId,
      provider: "github",
      providerConnectionId: "plug_one",
      ownership: "workspace",
      label: "One",
    });
    const second = await connections.attach({
      actorUserId: "user_owner",
      workspaceId,
      provider: "github",
      providerConnectionId: "plug_two",
      ownership: "workspace",
      label: "Two",
    });

    await expect(
      connections.resolve({ actorUserId: "user_member", workspaceId, provider: "github" }),
    ).rejects.toBeInstanceOf(ConnectionSelectionRequiredError);
    await connections.select({
      actorUserId: "user_member",
      workspaceId,
      provider: "github",
      connectionId: second.id,
    });
    await expect(
      connections.resolve({ actorUserId: "user_member", workspaceId, provider: "github" }),
    ).resolves.toEqual(second);

    advance(1_000);
    await connections.recordHealth({
      connectionId: second.id,
      status: "needs_reauth",
      readiness: "unavailable",
      reason: "token_expired",
    });
    await expect(
      connections.resolve({ actorUserId: "user_member", workspaceId, provider: "github" }),
    ).resolves.toEqual(first);
  });

  it("revokes authorized bindings immediately and clears saved selection", async () => {
    const { connections, store, workspaceId } = await createFixture();
    const personal = await connections.attach({
      actorUserId: "user_member",
      workspaceId,
      provider: "notion",
      providerConnectionId: "plug_personal",
      ownership: "personal",
      label: "Private Notion",
    });
    await connections.select({
      actorUserId: "user_member",
      workspaceId,
      provider: "notion",
      connectionId: personal.id,
    });

    await expect(
      connections.revoke("user_admin", personal.id),
    ).rejects.toBeInstanceOf(ConnectionAccessDeniedError);
    await expect(connections.revoke("user_member", personal.id)).resolves.toMatchObject({
      status: "revoked",
      readiness: "unavailable",
    });
    expect(store.selections.size).toBe(0);
    await expect(
      connections.resolve({ actorUserId: "user_member", workspaceId, provider: "notion" }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
  });

  it("rejects a former member's personal disconnect after workspace access is removed", async () => {
    const { connections, workspaceStore, workspaceId } = await createFixture();
    const personal = await connections.attach({ actorUserId: "user_member", workspaceId,
      provider: "notion", providerConnectionId: "plug_private", ownership: "personal", label: "Private" });
    for (const [id, membership] of workspaceStore.memberships) {
      if (membership.userId === "user_member" && membership.workspaceId === workspaceId) {
        workspaceStore.memberships.delete(id);
      }
    }
    await expect(connections.revoke("user_member", personal.id))
      .rejects.toBeInstanceOf(ConnectionAccessDeniedError);
  });
});
