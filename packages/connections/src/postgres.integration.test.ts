import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connectPostgresConnections, type PostgresConnectionRuntime } from "./postgres.js";

const connectionString = process.env.OMR_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

describePostgres("connection authority/PostgreSQL integration", () => {
  let runtime: PostgresConnectionRuntime;
  let workspaceId: string;

  beforeAll(async () => {
    const client = new Client({ connectionString: connectionString! });
    await client.connect();
    workspaceId = `workspace_team_${crypto.randomUUID()}`;
    const now = Date.now();
    await client.query(
      `INSERT INTO omr_control.workspaces (id, kind, name, created_at, updated_at)
       VALUES ($1, 'team', 'Postgres Connections', $2, $2)`,
      [workspaceId, now],
    );
    for (const [userId, role] of [
      ["connection_owner", "owner"],
      ["connection_member", "member"],
    ] as const) {
      await client.query(
        `INSERT INTO omr_control.workspace_memberships
           (id, workspace_id, user_id, role, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [`membership_${crypto.randomUUID()}`, workspaceId, userId, role, now],
      );
    }
    await client.end();
    runtime = await connectPostgresConnections({ connectionString: connectionString! });
  });

  afterAll(async () => {
    await runtime.close();
  });

  it("persists ownership-aware selection and revocation", async () => {
    const shared = await runtime.connections.attach({
      actorUserId: "connection_owner",
      workspaceId,
      provider: "github",
      providerConnectionId: `plug_${crypto.randomUUID()}`,
      ownership: "workspace",
      label: "Shared",
    });
    const personal = await runtime.connections.attach({
      actorUserId: "connection_member",
      workspaceId,
      provider: "github",
      providerConnectionId: `plug_${crypto.randomUUID()}`,
      ownership: "personal",
      label: "Personal",
    });
    await expect(
      runtime.connections.resolve({
        actorUserId: "connection_member",
        workspaceId,
        provider: "github",
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_SELECTION_REQUIRED" });
    await runtime.connections.select({
      actorUserId: "connection_member",
      workspaceId,
      provider: "github",
      connectionId: personal.id,
    });
    await expect(
      runtime.connections.resolve({
        actorUserId: "connection_member",
        workspaceId,
        provider: "github",
      }),
    ).resolves.toMatchObject({ id: personal.id });

    await runtime.connections.revoke("connection_member", personal.id);
    await expect(
      runtime.connections.resolve({
        actorUserId: "connection_member",
        workspaceId,
        provider: "github",
      }),
    ).resolves.toMatchObject({ id: shared.id });
  });

  it("rejects shared installation by a regular member", async () => {
    await expect(
      runtime.connections.attach({
        actorUserId: "connection_member",
        workspaceId,
        provider: "linear",
        providerConnectionId: `plug_${crypto.randomUUID()}`,
        ownership: "workspace",
        label: "Denied",
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
  });
});
