import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectPostgresIdentityRuntime,
  type PostgresIdentityRuntime,
} from "./postgres.js";

const connectionString = process.env.OMR_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

function cookieHeader(setCookies: string[]): string {
  return setCookies
    .map((cookie) => cookie.slice(0, cookie.indexOf(";")))
    .join("; ");
}

async function signUpActor(runtime: PostgresIdentityRuntime, email: string): Promise<string> {
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
    data: { session: { actorId: string } };
  };
  expect(response.status).toBe(200);
  return body.data.session.actorId;
}

describePostgres("OMR AuthFn/PostgreSQL integration", () => {
  let runtime: PostgresIdentityRuntime;

  beforeAll(async () => {
    runtime = await connectPostgresIdentityRuntime({
      connectionString: connectionString!,
      environment: {
        resolve: () => ({
          issuer: "https://omr.invalid",
          baseUrl: "https://omr.invalid",
        }),
      },
    });
  });

  afterAll(async () => {
    await runtime.close();
  });

  it("persists AuthFn identity and provisions one personal workspace", async () => {
    const email = `postgres-${crypto.randomUUID()}@example.com`;
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

    expect(response.status).toBe(200);
    const memberships = await runtime.workspaces.listMemberships(body.data.session.actorId);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ role: "owner" });
    await expect(runtime.workspaces.listWorkspaceAccess(body.data.session.actorId)).resolves.toEqual([
      expect.objectContaining({
        workspace: expect.objectContaining({ name: email.split("@")[0] + "'s workspace" }),
        membership: expect.objectContaining({ role: "owner" }),
      }),
    ]);

    const protectedRequest = new Request("https://omr.invalid/private", {
      headers: { cookie: cookieHeader(response.headers.getSetCookie()) },
    });
    await expect(runtime.requireSession(protectedRequest)).resolves.toMatchObject({
      actorId: body.data.session.actorId,
    });

    await runtime.auth.revokeSession(body.data.session.id, {
      userId: body.data.session.actorId,
    });
    await expect(runtime.requireSession(protectedRequest)).rejects.toMatchObject({
      code: "AUTHFN_UNAUTHENTICATED",
    });
  });

  it("keeps AuthFn tables out of the public PostgreSQL schema", async () => {
    const client = new Client({ connectionString: connectionString! });
    await client.connect();
    try {
      const result = await client.query<{ table_schema: string; table_name: string }>(
        `SELECT table_schema, table_name
         FROM information_schema.tables
         WHERE table_name IN ('users', 'sessions', 'password_credentials')
         ORDER BY table_schema, table_name`,
      );

      expect(result.rows).toHaveLength(3);
      expect(new Set(result.rows.map(({ table_schema }) => table_schema))).toEqual(
        new Set(["omr_identity"]),
      );
    } finally {
      await client.end();
    }
  });

  it("accepts a workspace invitation atomically and rejects replay", async () => {
    const ownerEmail = `owner-${crypto.randomUUID()}@example.com`;
    const inviteeEmail = `invitee-${crypto.randomUUID()}@example.com`;
    const ownerId = await signUpActor(runtime, ownerEmail);
    const inviteeId = await signUpActor(runtime, inviteeEmail);
    const team = await runtime.workspaces.createTeam({
      ownerUserId: ownerId,
      name: "Postgres Invitations",
    });
    const created = await runtime.workspaces.inviteMember({
      actorUserId: ownerId,
      workspaceId: team.workspace.id,
      email: inviteeEmail,
      role: "admin",
    });

    await expect(
      runtime.workspaces.acceptInvitation({
        token: created.token,
        userId: inviteeId,
        email: inviteeEmail,
        emailVerified: true,
      }),
    ).resolves.toMatchObject({
      workspaceId: team.workspace.id,
      userId: inviteeId,
      role: "admin",
    });
    await expect(
      runtime.workspaces.acceptInvitation({
        token: created.token,
        userId: inviteeId,
        email: inviteeEmail,
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_INVITATION_USED" });

    const client = new Client({ connectionString: connectionString! });
    await client.connect();
    try {
      const stored = await client.query<{
        accepted_by: string;
        token_hash: string;
      }>(
        `SELECT accepted_by, token_hash
         FROM omr_control.workspace_invitations
         WHERE id = $1`,
        [created.invitation.id],
      );
      expect(stored.rows[0]?.accepted_by).toBe(inviteeId);
      expect(stored.rows[0]?.token_hash).not.toBe(created.token);
    } finally {
      await client.end();
    }
  });
});
