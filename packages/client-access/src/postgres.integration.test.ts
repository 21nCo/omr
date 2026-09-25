import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectPostgresClientAccess,
  type PostgresClientAccessRuntime,
} from "./postgres.js";

const connectionString = process.env.OMR_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

describePostgres("client access/PostgreSQL integration", () => {
  let runtime: PostgresClientAccessRuntime;
  let workspaceId: string;

  beforeAll(async () => {
    const setup = new Client({ connectionString: connectionString! });
    await setup.connect();
    workspaceId = `workspace_team_${crypto.randomUUID()}`;
    const now = Date.now();
    await setup.query(
      `INSERT INTO omr_control.workspaces (id, kind, name, created_at, updated_at)
       VALUES ($1, 'team', 'Client Access', $2, $2)`,
      [workspaceId, now],
    );
    await setup.query(
      `INSERT INTO omr_control.workspace_memberships
         (id, workspace_id, user_id, role, created_at, updated_at)
       VALUES ($1, $2, 'user_owner', 'owner', $3, $3)`,
      [`membership_${crypto.randomUUID()}`, workspaceId, now],
    );
    await setup.end();
    runtime = await connectPostgresClientAccess({ connectionString: connectionString! });
  });

  afterAll(async () => {
    await runtime.close();
    const cleanup = new Client({ connectionString: connectionString! });
    await cleanup.connect();
    try {
      await cleanup.query("DELETE FROM omr_control.workspaces WHERE id = $1", [workspaceId]);
    } finally {
      await cleanup.end();
    }
  });

  it("persists scoped credentials and observes grant revocation", async () => {
    const client = await runtime.clients.registerClient({
      actorUserId: "user_owner",
      workspaceId,
      kind: "cli",
      name: "Postgres CLI",
    });
    const issued = await runtime.clients.issueGrant({
      actorUserId: "user_owner",
      clientId: client.id,
      workspaceId,
      capabilities: ["tools:discover", "tools:read"],
    });

    await expect(
      runtime.clients.authenticate(issued.credential, "tools:read"),
    ).resolves.toMatchObject({
      workspaceId,
      userId: "user_owner",
      capabilities: ["tools:discover", "tools:read"],
    });
    await runtime.clients.revokeGrant("user_owner", issued.grant.id);
    await expect(runtime.clients.authenticate(issued.credential)).rejects.toMatchObject({
      code: "CLIENT_CREDENTIAL_INVALID",
    });
  });

  it("lists and revokes owned manual access without exposing credentials", async () => {
    const client = await runtime.clients.registerClient({
      actorUserId: "user_owner", workspaceId, kind: "cli", name: "Disposable CLI",
    });
    const issued = await runtime.clients.issueGrant({
      actorUserId: "user_owner", clientId: client.id, workspaceId,
      capabilities: ["tools:discover"],
    });
    const listed = await runtime.clients.listManualGrants("user_owner");
    expect(listed.grants).toContainEqual(expect.objectContaining({
      id: issued.grant.id, clientId: client.id, clientName: "Disposable CLI",
    }));
    expect(JSON.stringify(listed)).not.toContain(issued.credential);
    expect(JSON.stringify(listed)).not.toContain(issued.grant.credentialHash);
    await expect(runtime.clients.listManualGrants("user_other")).resolves.toEqual({
      grants: [], nextCursor: null,
    });
    await expect(runtime.clients.revokeManualClient("user_other", client.id))
      .rejects.toMatchObject({ code: "CLIENT_ACCESS_DENIED" });
    await runtime.clients.revokeManualClient("user_owner", client.id);
    await expect(runtime.clients.authenticate(issued.credential))
      .rejects.toMatchObject({ code: "CLIENT_CREDENTIAL_INVALID" });
  });

  it("paginates owned grants with a database cursor", async () => {
    const client = await runtime.clients.registerClient({
      actorUserId: "user_owner", workspaceId, kind: "mcp_stdio", name: "Paged client",
    });
    for (let index = 0; index < 51; index += 1) {
      await runtime.clients.issueGrant({
        actorUserId: "user_owner", clientId: client.id, workspaceId,
        capabilities: ["tools:read"],
      });
    }
    const first = await runtime.clients.listManualGrants("user_owner");
    expect(first.grants).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await runtime.clients.listManualGrants("user_owner", first.nextCursor!);
    expect(second.grants.length).toBeGreaterThanOrEqual(1);
    expect(new Set([...first.grants, ...second.grants].map((grant) => grant.id)).size)
      .toBe(first.grants.length + second.grants.length);
    await runtime.clients.revokeManualClient("user_owner", client.id);
  });

  it("serializes OAuth replacement and revokes the old OMR client without KV listing", async () => {
    const first = await runtime.clients.registerClient({
      actorUserId: "user_owner", workspaceId, kind: "mcp_remote", name: "OAuth first",
    });
    const firstCredential = await runtime.clients.issueGrant({
      actorUserId: "user_owner", clientId: first.id, workspaceId,
      capabilities: ["tools:discover"],
    });
    const base = {
      userId: "user_owner",
      oauthClientId: "staging-client",
      redirectUri: "https://example.test/callback",
      familyKey: '["staging-client"]',
      clientName: "Staging client",
      workspaceId,
      scopes: ["tools:discover"] as const,
    };
    await expect(runtime.oauthGrants.activate({
      ...base, scopes: [...base.scopes], omrClientId: first.id, oauthGrantId: "first-grant-id",
    })).resolves.toEqual([]);

    const second = await runtime.clients.registerClient({
      actorUserId: "user_owner", workspaceId, kind: "mcp_remote", name: "OAuth second",
    });
    const secondCredential = await runtime.clients.issueGrant({
      actorUserId: "user_owner", clientId: second.id, workspaceId,
      capabilities: ["tools:discover"],
    });
    await expect(runtime.oauthGrants.activate({
      ...base, scopes: [...base.scopes], omrClientId: second.id, oauthGrantId: "second-grant-id",
    })).resolves.toEqual(["first-grant-id"]);
    await expect(runtime.clients.authenticate(firstCredential.credential)).rejects.toMatchObject({
      code: "CLIENT_CREDENTIAL_INVALID",
    });
    await expect(runtime.clients.authenticate(secondCredential.credential)).resolves.toMatchObject({
      clientId: second.id,
    });
    await expect(runtime.oauthGrants.listActive("user_owner")).resolves.toMatchObject([
      { omrClientId: second.id, oauthGrantId: "second-grant-id" },
    ]);
    await expect(runtime.clients.revokeManualClient("user_owner", second.id))
      .rejects.toMatchObject({ code: "CLIENT_ACCESS_DENIED" });
    expect((await runtime.clients.listManualGrants("user_owner")).grants)
      .not.toContainEqual(expect.objectContaining({ clientId: second.id }));
    await expect(runtime.oauthGrants.revoke("user_owner", second.id)).resolves.toBe("second-grant-id");
    await expect(runtime.clients.authenticate(secondCredential.credential)).rejects.toMatchObject({
      code: "CLIENT_CREDENTIAL_INVALID",
    });
    await expect(runtime.oauthGrants.listActive("user_owner")).resolves.toEqual([]);
  });

  it("invalidates a live credential as soon as workspace membership disappears", async () => {
    const client = await runtime.clients.registerClient({
      actorUserId: "user_owner",
      workspaceId,
      kind: "headless",
      name: "Postgres Headless",
    });
    const issued = await runtime.clients.issueGrant({
      actorUserId: "user_owner",
      clientId: client.id,
      workspaceId,
      capabilities: ["tools:read"],
    });

    const control = new Client({ connectionString: connectionString! });
    await control.connect();
    try {
      await control.query(
        `DELETE FROM omr_control.workspace_memberships
         WHERE workspace_id = $1 AND user_id = 'user_owner'`,
        [workspaceId],
      );
    } finally {
      await control.end();
    }
    await expect(runtime.clients.authenticate(issued.credential)).rejects.toMatchObject({
      code: "CLIENT_CREDENTIAL_INVALID",
    });
    await expect(runtime.clients.listManualGrants("user_owner")).resolves.toMatchObject({
      grants: expect.arrayContaining([expect.objectContaining({ clientId: client.id })]),
    });
    await expect(runtime.clients.revokeManualClient("user_owner", client.id)).resolves.toBeUndefined();
  });
});
