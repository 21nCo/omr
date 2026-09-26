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

  it("does not restore a revoked binding through a late health result", async () => {
    const binding = await runtime.connections.attach({
      actorUserId: "connection_owner", workspaceId, provider: "github",
      providerConnectionId: `plug_${crypto.randomUUID()}`, ownership: "personal", label: "Health race",
    });
    await runtime.connections.revoke("connection_owner", binding.id);
    await expect(runtime.connections.recordHealth({
      connectionId: binding.id, status: "active", readiness: "ready",
    })).rejects.toMatchObject({ code: "CONNECTION_UNAVAILABLE" });
    await expect(runtime.connections.getAccessible("connection_owner", binding.id))
      .resolves.toMatchObject({ status: "revoked", readiness: "unavailable" });
    await expect(runtime.connections.resolve({
      actorUserId: "connection_owner", workspaceId, provider: "github", connectionId: binding.id,
    })).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
  });

  it("claims revocation from the current SQL row after health changes and removes selections", async () => {
    const binding = await runtime.connections.attach({
      actorUserId: "connection_owner", workspaceId, provider: "github",
      providerConnectionId: `plug_${crypto.randomUUID()}`, ownership: "workspace", label: "Claim race",
    });
    await runtime.connections.select({ actorUserId: "connection_member", workspaceId,
      provider: "github", connectionId: binding.id });
    const stale = await runtime.connections.getManageable("connection_owner", binding.id);
    await runtime.connections.recordHealth({ connectionId: binding.id, status: "needs_reauth",
      readiness: "unavailable", reason: "refresh_failed" });
    expect(stale.healthReason).toBeNull();
    const claimed = await runtime.connections.revokeIfNotRevoked("connection_owner", binding.id,
      "provider_cleanup_pending:fixture");
    expect(claimed).toMatchObject({ status: "revoked", readiness: "unavailable",
      healthReason: "provider_cleanup_pending:fixture" });
    await expect(runtime.connections.resolve({ actorUserId: "connection_member", workspaceId,
      provider: "github", connectionId: binding.id })).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(await runtime.connections.revokeIfNotRevoked("connection_owner", binding.id,
      "provider_cleanup_pending:second")).toBeNull();
    const client = new Client({ connectionString: connectionString! });
    try {
      await client.connect();
      const selection = await client.query("SELECT 1 FROM omr_control.connection_selections WHERE connection_id = $1",
        [binding.id]);
      expect(selection.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });

  it("allows only owner/admin cleanup of an orphan without exposing it for use", async () => {
    const formerUserId = `former_${crypto.randomUUID()}`;
    const membershipId = `membership_${crypto.randomUUID()}`;
    const client = new Client({ connectionString: connectionString! });
    await client.connect();
    let bindingId: string | undefined;
    try {
      await client.query(
        `INSERT INTO omr_control.workspace_memberships
           (id, workspace_id, user_id, role, created_at, updated_at)
         VALUES ($1, $2, $3, 'member', $4, $4)`,
        [membershipId, workspaceId, formerUserId, Date.now()],
      );
      const binding = await runtime.connections.attach({ actorUserId: formerUserId, workspaceId,
        provider: "github", providerConnectionId: `plug_${crypto.randomUUID()}`,
        ownership: "personal", label: "Former member" });
      bindingId = binding.id;
      await runtime.connections.select({ actorUserId: formerUserId, workspaceId,
        provider: "github", connectionId: binding.id });
      await expect(runtime.connections.getManageable("connection_owner", binding.id))
        .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
      await client.query(`DELETE FROM omr_control.workspace_memberships WHERE id = $1`, [membershipId]);
      await expect(runtime.connections.listOrphanedForCleanup({ actorUserId: "connection_member", workspaceId }))
        .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
      expect(await runtime.connections.listOrphanedForCleanup({ actorUserId: "connection_owner", workspaceId }))
        .toEqual(expect.arrayContaining([expect.objectContaining({ id: binding.id })]));
      expect(await runtime.connections.listAvailable({ actorUserId: "connection_owner", workspaceId, provider: "github" }))
        .not.toContainEqual(binding);
      await expect(runtime.connections.getAccessible("connection_owner", binding.id))
        .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
      await expect(runtime.connections.getManageable("connection_owner", binding.id))
        .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
      await expect(runtime.connections.getRevocable("connection_owner", binding.id))
        .resolves.toMatchObject({ id: binding.id });
      await expect(runtime.connections.revokeIfNotRevoked("connection_owner", binding.id,
        "provider_cleanup_pending:test"))
        .resolves.toMatchObject({ status: "revoked", readiness: "unavailable" });
      const selections = await client.query(
        `SELECT 1 FROM omr_control.connection_selections WHERE connection_id = $1`, [binding.id],
      );
      expect(selections.rowCount).toBe(0);
      await expect(runtime.connections.recordHealth({ connectionId: binding.id,
        status: "active", readiness: "ready" })).rejects.toMatchObject({ code: "CONNECTION_UNAVAILABLE" });
      await expect(runtime.connections.revokeIf("connection_owner", binding.id, "revoked",
        "provider_cleanup_pending:test", "provider_cleanup_failed"))
        .resolves.toMatchObject({ healthReason: "provider_cleanup_failed" });
    } finally {
      if (bindingId) {
        await client.query(`DELETE FROM omr_control.connection_selections WHERE connection_id = $1`, [bindingId]);
        await client.query(`DELETE FROM omr_control.connection_bindings WHERE id = $1`, [bindingId]);
      }
      await client.query(`DELETE FROM omr_control.workspace_memberships WHERE id = $1`, [membershipId]);
      await client.end();
    }
  });
});
