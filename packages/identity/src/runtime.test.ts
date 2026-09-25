import { memoryAdapter } from "@superfunctions/db/adapters/memory";
import { describe, expect, it } from "vitest";

import { createOMRIdentityRuntime } from "./runtime.js";
import { MemoryWorkspaceStore } from "./testing.js";
import {
  WorkspaceAccessDeniedError,
  WorkspaceAuthority,
  WorkspaceInvitationError,
} from "./workspaces.js";

function cookieHeader(setCookies: string[]): string {
  return setCookies
    .map((cookie) => cookie.slice(0, cookie.indexOf(";")))
    .join("; ");
}

async function signUp(
  runtime: ReturnType<typeof createOMRIdentityRuntime>,
  email: string,
) {
  const response = await runtime.auth.router.handle(
    new Request("https://omr.invalid/auth/sign-up/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "Correct-Horse-Battery-Staple-42!",
      }),
    }),
  );
  const body = (await response.json()) as {
    ok: true;
    data: { session: { id: string; actorId: string } };
  };
  return { response, body };
}

function createTestRuntime(now: () => number = () => 1_700_000_000_000) {
  const store = new MemoryWorkspaceStore();
  const workspaces = new WorkspaceAuthority(store, now);
  const runtime = createOMRIdentityRuntime({
    database: memoryAdapter(),
    workspaces,
    environment: {
      resolve: () => ({
        issuer: "https://omr.invalid",
        baseUrl: "https://omr.invalid",
      }),
    },
  });
  return { runtime, store, workspaces };
}

describe("OMR identity and workspace authority", () => {
  it("provisions exactly one personal workspace during sign-up and session issue", async () => {
    const { runtime, store, workspaces } = createTestRuntime();
    const { response, body } = await signUp(runtime, "ada@example.com");

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    const memberships = await workspaces.listMemberships(body.data.session.actorId);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("owner");
    expect(store.workspaces.get(memberships[0]!.workspaceId)).toMatchObject({
      kind: "personal",
      name: "ada's workspace",
    });
    await expect(workspaces.listWorkspaceAccess(body.data.session.actorId)).resolves.toEqual([
      expect.objectContaining({
        workspace: expect.objectContaining({ name: "ada's workspace" }),
        membership: expect.objectContaining({ role: "owner" }),
      }),
    ]);
  });

  it("protects requests with AuthFn sessions and observes immediate revocation", async () => {
    const { runtime } = createTestRuntime();
    const { response, body } = await signUp(runtime, "grace@example.com");
    const request = new Request("https://omr.invalid/private", {
      headers: { cookie: cookieHeader(response.headers.getSetCookie()) },
    });

    await expect(runtime.requireSession(request)).resolves.toMatchObject({
      actorId: body.data.session.actorId,
      actorType: "user",
    });

    await runtime.auth.revokeSession(body.data.session.id, {
      userId: body.data.session.actorId,
    });
    await expect(runtime.requireSession(request)).rejects.toMatchObject({
      code: "AUTHFN_UNAUTHENTICATED",
    });
  });

  it("creates an owner-scoped team without granting another user access", async () => {
    const { runtime, workspaces } = createTestRuntime();
    const first = await signUp(runtime, "owner@example.com");
    const second = await signUp(runtime, "other@example.com");

    const team = await workspaces.createTeam({
      ownerUserId: first.body.data.session.actorId,
      name: "  Agent Builders  ",
    });

    expect(team.workspace).toMatchObject({ kind: "team", name: "Agent Builders" });
    await expect(
      workspaces.requireMembership(team.workspace.id, first.body.data.session.actorId),
    ).resolves.toMatchObject({ role: "owner" });
    await expect(
      workspaces.requireMembership(team.workspace.id, second.body.data.session.actorId),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });

  it("rejects malformed workspace identities before store access", async () => {
    const { workspaces } = createTestRuntime();
    await expect(workspaces.requireMembership("", "user:valid")).rejects.toMatchObject({
      code: "WORKSPACE_INPUT_INVALID",
    });
  });

  it("accepts an email-bound invitation once and never stores its plaintext token", async () => {
    const { runtime, store, workspaces } = createTestRuntime();
    const owner = await signUp(runtime, "owner@example.com");
    const invitee = await signUp(runtime, "invitee@example.com");
    const team = await workspaces.createTeam({
      ownerUserId: owner.body.data.session.actorId,
      name: "Runtime Team",
    });

    const created = await workspaces.inviteMember({
      actorUserId: owner.body.data.session.actorId,
      workspaceId: team.workspace.id,
      email: " Invitee@Example.com ",
      role: "member",
    });

    expect(created.token).toMatch(/^[a-f0-9]{64}$/);
    expect(created.invitation.tokenHash).not.toBe(created.token);
    expect(JSON.stringify([...store.invitations.values()])).not.toContain(created.token);

    await expect(
      workspaces.acceptInvitation({
        token: created.token,
        userId: invitee.body.data.session.actorId,
        email: "INVITEE@example.com",
        emailVerified: true,
      }),
    ).resolves.toMatchObject({
      workspaceId: team.workspace.id,
      userId: invitee.body.data.session.actorId,
      role: "member",
    });

    await expect(
      workspaces.acceptInvitation({
        token: created.token,
        userId: invitee.body.data.session.actorId,
        email: "invitee@example.com",
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_INVITATION_USED" });
  });

  it("requires workspace authority and a verified matching email", async () => {
    const { runtime, workspaces } = createTestRuntime();
    const owner = await signUp(runtime, "owner@example.com");
    const outsider = await signUp(runtime, "outsider@example.com");
    const team = await workspaces.createTeam({
      ownerUserId: owner.body.data.session.actorId,
      name: "Restricted Team",
    });

    await expect(
      workspaces.inviteMember({
        actorUserId: outsider.body.data.session.actorId,
        workspaceId: team.workspace.id,
        email: "invitee@example.com",
        role: "member",
      }),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);

    const created = await workspaces.inviteMember({
      actorUserId: owner.body.data.session.actorId,
      workspaceId: team.workspace.id,
      email: "invitee@example.com",
      role: "member",
    });
    await expect(
      workspaces.acceptInvitation({
        token: created.token,
        userId: outsider.body.data.session.actorId,
        email: "invitee@example.com",
        emailVerified: false,
      }),
    ).rejects.toBeInstanceOf(WorkspaceInvitationError);
    await expect(
      workspaces.acceptInvitation({
        token: created.token,
        userId: outsider.body.data.session.actorId,
        email: "outsider@example.com",
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_INVITATION_INVALID" });
  });

  it("rejects expired invitations without creating membership", async () => {
    let now = 1_700_000_000_000;
    const { runtime, workspaces } = createTestRuntime(() => now);
    const owner = await signUp(runtime, "owner@example.com");
    const invitee = await signUp(runtime, "invitee@example.com");
    const team = await workspaces.createTeam({
      ownerUserId: owner.body.data.session.actorId,
      name: "Expiring Team",
    });
    const created = await workspaces.inviteMember({
      actorUserId: owner.body.data.session.actorId,
      workspaceId: team.workspace.id,
      email: "invitee@example.com",
      role: "admin",
      ttlMs: 60_000,
    });

    now += 60_000;
    await expect(
      workspaces.acceptInvitation({
        token: created.token,
        userId: invitee.body.data.session.actorId,
        email: "invitee@example.com",
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_INVITATION_EXPIRED" });
    await expect(
      workspaces.requireMembership(team.workspace.id, invitee.body.data.session.actorId),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });
});
