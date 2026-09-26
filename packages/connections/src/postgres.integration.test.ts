import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ConnectionAuthority } from "./connections.js";
import { PlugFnConnectionOrchestrator, type PlugFnConnection, type PlugFnConnectionPort } from "./plugfn.js";
import { PostgresConnectionBindingStore } from "./postgres-store.js";
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

  it("preserves a stored cleanup outcome when a later revoke has no reason", async () => {
    const binding = await runtime.connections.attach({ actorUserId: "connection_owner", workspaceId,
      provider: "linear", providerConnectionId: `plug_${crypto.randomUUID()}`,
      ownership: "workspace", label: "Cleanup outcome" });
    await runtime.connections.select({ actorUserId: "connection_member", workspaceId,
      provider: "linear", connectionId: binding.id });
    await runtime.connections.revoke("connection_owner", binding.id, "remote_revoke_failed");
    await expect(runtime.connections.revoke("connection_owner", binding.id)).resolves.toMatchObject({
      status: "revoked", readiness: "unavailable", healthReason: "remote_revoke_failed",
    });
    const client = new Client({ connectionString: connectionString! });
    await client.connect();
    try {
      const row = await client.query(
        `SELECT health_reason FROM omr_control.connection_bindings WHERE id = $1`, [binding.id],
      );
      expect(row.rows[0]?.health_reason).toBe("remote_revoke_failed");
      const selection = await client.query(
        `SELECT 1 FROM omr_control.connection_selections WHERE connection_id = $1`, [binding.id],
      );
      expect(selection.rowCount).toBe(0);
    } finally {
      await client.query(`DELETE FROM omr_control.connection_selections WHERE connection_id = $1`, [binding.id]);
      await client.query(`DELETE FROM omr_control.connection_bindings WHERE id = $1`, [binding.id]);
      await client.end();
    }
  });

  it("reconciles only a current owner's live duplicate and leaves revoked rows unavailable", async () => {
    const providerConnectionId = `plug_${crypto.randomUUID()}`;
    const binding = await runtime.connections.attach({ actorUserId: "connection_member", workspaceId,
      provider: "linear", providerConnectionId, ownership: "personal", label: "Reconnect" });
    const client = new Client({ connectionString: connectionString! });
    await client.connect();
    try {
      await expect(runtime.connections.hasRemoteBinding({ workspaceId, providerConnectionId })).resolves.toBe(true);
      await runtime.connections.recordHealth({ connectionId: binding.id, status: "needs_reauth",
        readiness: "unavailable", reason: "expired" });
      await expect(runtime.connections.resolve({ actorUserId: "connection_member", workspaceId,
        provider: "linear", connectionId: binding.id })).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
      const input = { actorUserId: "connection_member", connectionId: binding.id, workspaceId,
        provider: "linear", providerConnectionId, ownership: "personal" as const };
      await expect(runtime.connections.reconcileActiveDuplicate({ ...input, connectionId: "bad/id" }))
        .rejects.toMatchObject({ code: "CONNECTION_INPUT_INVALID" });
      await expect(runtime.connections.reconcileActiveDuplicate({ ...input, ownership: "invalid" as "personal" }))
        .rejects.toMatchObject({ code: "CONNECTION_INPUT_INVALID" });
      await expect(runtime.connections.reconcileActiveDuplicate({ ...input, actorUserId: "connection_owner" }))
        .resolves.toBeNull();
      await expect(runtime.connections.reconcileActiveDuplicate({ ...input, provider: " Linear " }))
        .resolves.toMatchObject({
          id: binding.id, status: "active", readiness: "ready", healthReason: null,
        });
      await expect(runtime.connections.resolve({ actorUserId: "connection_member", workspaceId,
        provider: "linear", connectionId: binding.id })).resolves.toMatchObject({ id: binding.id });
      const ready = await runtime.connections.reconcileActiveDuplicate(input);
      expect(ready?.id).toBe(binding.id);
      await runtime.connections.revoke("connection_member", binding.id);
      await expect(runtime.connections.reconcileActiveDuplicate(input)).resolves.toBeNull();
      await expect(runtime.connections.resolve({ actorUserId: "connection_member", workspaceId,
        provider: "linear", connectionId: binding.id })).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    } finally {
      await client.query(`DELETE FROM omr_control.connection_selections WHERE connection_id = $1`, [binding.id]);
      await client.query(`DELETE FROM omr_control.connection_bindings WHERE id = $1`, [binding.id]);
      await client.end();
    }
    await expect(runtime.connections.hasRemoteBinding({ workspaceId, providerConnectionId })).resolves.toBe(false);
  });

  for (const [mode, firstStatus] of [
    ["oauth", "expired"], ["oauth", "active"],
    ["api_key", "expired"], ["api_key", "active"],
  ] as const) {
    it(`keeps a successful ${mode} binding when ${firstStatus} cleanup loses in PostgreSQL`, async () => {
      const provider = mode === "oauth" ? "github" : "linear";
      const providerConnectionId = `plug_${crypto.randomUUID()}`;
      const firstClient = new Client({ connectionString: connectionString! });
      const secondClient = new Client({ connectionString: connectionString! });
      await firstClient.connect();
      await secondClient.connect();
      const firstStore = new PostgresConnectionBindingStore(firstClient);
      const firstAuthority = new ConnectionAuthority(firstStore);
      const secondAuthority = new ConnectionAuthority(new PostgresConnectionBindingStore(secondClient));
      const remote = (status: PlugFnConnection["status"]): PlugFnConnection => ({
        id: providerConnectionId, userId: "connection_owner", provider,
        ownerKind: "user", ownerId: "connection_owner", tenantId: workspaceId, status,
      });
      const port = (result: PlugFnConnection) => {
        const disconnect = vi.fn(async () => ({ disconnected: true, remoteRevokeAttempted: true,
          remoteRevokeSucceeded: true, localDeleted: true, connectionDeleted: true }));
        const connections: PlugFnConnectionPort["connections"] = {
          getAuthUrl: async () => "https://provider.example",
          handleCallback: async () => ({ connection: result }),
          connect: async () => result,
          get: async () => result,
          isValid: async () => true,
          refresh: async () => result,
          disconnect,
        };
        const value: PlugFnConnectionPort = {
          config: { integrations: { github: { type: "oauth2" } } },
          connections,
          providers: { get: (name) => name === provider ? {
            name, displayName: name, auth: { type: mode === "oauth" ? "oauth2" : "api-key" },
            actions: {},
          } : undefined },
        };
        return { value, disconnect };
      };
      const inactivePort = port(remote(firstStatus));
      const activePort = port(remote("active"));
      const inactive = new PlugFnConnectionOrchestrator(firstAuthority, inactivePort.value);
      const active = new PlugFnConnectionOrchestrator(secondAuthority, activePort.value);
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const attachForCleanup = firstStore.attachForCleanup.bind(firstStore);
      if (firstStatus === "active") {
        vi.spyOn(firstStore, "attach").mockRejectedValueOnce(new Error("first attach unavailable"));
      }
      vi.spyOn(firstStore, "attachForCleanup").mockImplementationOnce(async (input) => {
        entered();
        await barrier;
        return attachForCleanup(input);
      });
      const connect = (orchestrator: PlugFnConnectionOrchestrator) => mode === "oauth"
        ? orchestrator.completeOAuth({ actorUserId: "connection_owner", workspaceId,
          provider, ownership: "personal", code: "code", state: "state", label: "Account" })
        : orchestrator.connectApiKey({ actorUserId: "connection_owner", workspaceId,
          provider, ownership: "personal", apiKey: "key-secret", label: "Account" });
      const first = connect(inactive);
      try {
        await waiting;
        const second = await connect(active);
        const binding = "connection" in second ? second.connection : second;
        await secondAuthority.select({ actorUserId: "connection_owner", workspaceId,
          provider, connectionId: binding.id });
        release();
        await expect(first).rejects.toMatchObject({ code: "CONNECTION_PROVIDER_FAILED" });
        await expect(secondAuthority.resolve({ actorUserId: "connection_owner", workspaceId, provider }))
          .resolves.toMatchObject({ id: binding.id, providerConnectionId });
        const rows = await secondClient.query(
          `SELECT status, readiness FROM omr_control.connection_bindings
           WHERE workspace_id = $1 AND provider_connection_id = $2`,
          [workspaceId, providerConnectionId],
        );
        expect(rows.rows).toEqual([{ status: "active", readiness: "ready" }]);
        expect(inactivePort.disconnect).not.toHaveBeenCalled();
        expect(activePort.disconnect).not.toHaveBeenCalled();
      } finally {
        release();
        await first.catch(() => undefined);
        await secondClient.query(`DELETE FROM omr_control.connection_selections
          WHERE workspace_id = $1 AND provider = $2`, [workspaceId, provider]);
        await secondClient.query(`DELETE FROM omr_control.connection_bindings
          WHERE workspace_id = $1 AND provider_connection_id = $2`, [workspaceId, providerConnectionId]);
        await firstClient.end();
        await secondClient.end();
      }
    });
  }

  it("keeps a cleanup reservation terminal when it claims the PostgreSQL handle first", async () => {
    const providerConnectionId = `plug_${crypto.randomUUID()}`;
    const cleanup = await runtime.connections.attachForCleanup({ actorUserId: "connection_owner",
      workspaceId, provider: "linear", providerConnectionId,
      ownership: "personal", label: "Pending cleanup" });
    const contender = await connectPostgresConnections({ connectionString: connectionString! });
    const inspector = new Client({ connectionString: connectionString! });
    await inspector.connect();
    try {
      await expect(contender.connections.attach({ actorUserId: "connection_owner",
        workspaceId, provider: "linear", providerConnectionId,
        ownership: "personal", label: "Late active result" }))
        .rejects.toThrow();
      const rows = await inspector.query(
        `SELECT id, status, readiness FROM omr_control.connection_bindings
         WHERE workspace_id = $1 AND provider_connection_id = $2`,
        [workspaceId, providerConnectionId],
      );
      expect(rows.rows).toEqual([{ id: cleanup.id, status: "revoked", readiness: "unavailable" }]);
      await expect(contender.connections.resolve({ actorUserId: "connection_owner",
        workspaceId, provider: "linear", connectionId: cleanup.id }))
        .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    } finally {
      await inspector.query(`DELETE FROM omr_control.connection_bindings WHERE id = $1`, [cleanup.id]);
      await inspector.end();
      await contender.close();
    }
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
