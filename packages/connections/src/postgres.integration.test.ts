import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ConnectionAuthority } from "./connections.js";
import { PlugFnConnectionOrchestrator, type PlugFnConnection, type PlugFnConnectionPort } from "./plugfn.js";
import { PostgresConnectionBindingStore } from "./postgres-store.js";
import { connectPostgresConnections, type PostgresConnectionRuntime } from "./postgres.js";
import { finishRaceTest, raceStep, settleRaceRequest, waitForRaceBarrier } from "../test-support/race-test-barrier.js";

const connectionString = process.env.OMR_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

/** Close both race clients if either setup connection fails. */
async function connectRaceClients(first: Client, second: Client): Promise<void> {
  try {
    await first.connect();
    await second.connect();
  } catch (error) {
    await finishRaceTest(error, [async () => { await first.end(); }, async () => { await second.end(); }]);
    throw error;
  }
}

/** Keep the shared member usable even when lookup or the race body fails. */
async function withConnectionMember<T>(
  client: Client, workspaceId: string, run: (memberId: string) => Promise<T>,
): Promise<T> {
  let memberId: string | undefined;
  let primaryError: unknown;
  try {
    await client.connect();
    const member = await client.query<{ id: string }>(
      `SELECT id FROM omr_control.workspace_memberships WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, "connection_member"],
    );
    memberId = member.rows[0]?.id;
    if (!memberId) throw new Error("PostgreSQL race fixture is missing connection_member");
    return await run(memberId);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await finishRaceTest(primaryError, [
      async () => { await client.query(`INSERT INTO omr_control.workspace_memberships
        (id, workspace_id, user_id, role, created_at, updated_at)
        VALUES ($1, $2, 'connection_member', 'member', $3, $3)
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'member'`,
      [memberId ?? `membership_${crypto.randomUUID()}`, workspaceId, Date.now()]); },
      async () => { await client.end(); },
    ]);
  }
}

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
      await connectRaceClients(firstClient, secondClient);
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
      let secondRequest: ReturnType<typeof connect> | undefined;
      let primaryError: unknown;
      try {
        await waitForRaceBarrier(waiting, first, `${mode} ${firstStatus} PostgreSQL cleanup claim`);
        secondRequest = connect(active);
        const second = await raceStep(secondRequest, `${mode} active PostgreSQL competing connect`);
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
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        release();
        await finishRaceTest(primaryError, [async () => {
          const outcomes = await Promise.allSettled([
            settleRaceRequest(first, `${mode} ${firstStatus} PostgreSQL cleanup`),
            ...(secondRequest ? [settleRaceRequest(secondRequest, `${mode} active PostgreSQL connect`)] : []),
          ]);
          const failure = outcomes.find((outcome) => outcome.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }, async () => {
          await secondClient.query(`DELETE FROM omr_control.connection_selections
              WHERE workspace_id = $1 AND provider = $2`, [workspaceId, provider]);
        }, async () => {
          await secondClient.query(`DELETE FROM omr_control.connection_bindings
              WHERE workspace_id = $1 AND provider_connection_id = $2`, [workspaceId, providerConnectionId]);
        }, async () => { await firstClient.end(); }, async () => { await secondClient.end(); }]);
      }
    }, 20_000);
  }

  it("keeps a cleanup reservation terminal when it claims the PostgreSQL handle first", async () => {
    const providerConnectionId = `plug_${crypto.randomUUID()}`;
    const cleanup = await runtime.connections.attachForCleanup({ actorUserId: "connection_owner",
      workspaceId, provider: "linear", providerConnectionId,
      ownership: "personal", label: "Pending cleanup" });
    const contender = await connectPostgresConnections({ connectionString: connectionString! });
    const inspector = new Client({ connectionString: connectionString! });
    let primaryError: unknown;
    try {
      await inspector.connect();
      await expect(contender.connections.attach({ actorUserId: "connection_owner",
        workspaceId, provider: "linear", providerConnectionId,
        ownership: "personal", label: "Late active result" }))
        .rejects.toMatchObject({ code: "23505",
          constraint: "connection_bindings_workspace_id_provider_connection_id_key" });
      const rows = await inspector.query(
        `SELECT id, status, readiness FROM omr_control.connection_bindings
         WHERE workspace_id = $1 AND provider_connection_id = $2`,
        [workspaceId, providerConnectionId],
      );
      expect(rows.rows).toEqual([{ id: cleanup.id, status: "revoked", readiness: "unavailable" }]);
      await expect(contender.connections.resolve({ actorUserId: "connection_owner",
        workspaceId, provider: "linear", connectionId: cleanup.id }))
        .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await finishRaceTest(primaryError, [
        async () => { await inspector.query(`DELETE FROM omr_control.connection_bindings WHERE id = $1`, [cleanup.id]); },
        async () => { await inspector.end(); },
        async () => { await contender.close(); },
      ]);
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

  for (const [change, remoteSucceeded, expectedReason] of [
    ["demote", true, null], ["remove", false, "remote_revoke_failed"],
  ] as const) {
    it(`persists PostgreSQL provider ${remoteSucceeded ? "success" : "failure"} after member ${change}`, async () => {
      const client = new Client({ connectionString: connectionString! });
      await withConnectionMember(client, workspaceId, async (memberId) => {
        let bindingId: string | undefined;
        let release!: () => void;
        let request: ReturnType<PlugFnConnectionOrchestrator["disconnect"]> | undefined;
        let primaryError: unknown;
        try {
          await client.query(`UPDATE omr_control.workspace_memberships SET role = 'admin'
            WHERE id = $1`, [memberId]);
          const binding = await runtime.connections.attach({ actorUserId: "connection_member", workspaceId,
            provider: "linear", providerConnectionId: `plug_${crypto.randomUUID()}`,
            ownership: "workspace", label: "Claim-scoped cleanup" });
          bindingId = binding.id;
          await runtime.connections.select({ actorUserId: "connection_member", workspaceId,
            provider: "linear", connectionId: binding.id });
          const remote: PlugFnConnection = { id: binding.providerConnectionId, userId: "connection_member",
            provider: "linear", status: "active" };
          let entered!: () => void;
          const started = new Promise<void>((resolve) => { entered = resolve; });
          const paused = new Promise<void>((resolve) => { release = resolve; });
          const port: PlugFnConnectionPort = {
            config: { integrations: { linear: { type: "api-key" } } },
            providers: { get: () => ({ name: "linear", displayName: "Linear",
              auth: { type: "api-key" }, actions: {} }) },
            connections: {
              getAuthUrl: async () => "", handleCallback: async () => ({ connection: remote }),
              connect: async () => remote, get: async () => remote, isValid: async () => true,
              refresh: async () => remote,
              disconnect: async () => {
                entered();
                await paused;
                return { disconnected: remoteSucceeded, remoteRevokeAttempted: true,
                  remoteRevokeSucceeded: remoteSucceeded, localDeleted: remoteSucceeded,
                  connectionDeleted: remoteSucceeded,
                  revokeError: { message: "provider secret" } };
              },
            },
          };
          const orchestrator = new PlugFnConnectionOrchestrator(runtime.connections, port);
          request = orchestrator.disconnect("connection_member", binding.id);
          await waitForRaceBarrier(started, request, "PostgreSQL claim provider call");
          const pending = await client.query<{ health_reason: string }>(
            `SELECT health_reason FROM omr_control.connection_bindings WHERE id = $1`, [binding.id]);
          const claim = pending.rows[0]!.health_reason;
          expect(claim).toMatch(/^provider_cleanup_pending:/);
          if (change === "remove") {
            await client.query(`DELETE FROM omr_control.workspace_memberships WHERE id = $1`, [memberId]);
          } else {
            await client.query(`UPDATE omr_control.workspace_memberships SET role = 'member'
              WHERE id = $1`, [memberId]);
          }
          await expect(runtime.connections.revokeIf("connection_member", binding.id, "revoked", claim, "stale"))
            .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
          release();
          await expect(request).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
          const rows = await client.query<{ status: string; readiness: string; health_reason: string | null }>(
            `SELECT status, readiness, health_reason FROM omr_control.connection_bindings WHERE id = $1`,
            [binding.id]);
          expect(rows.rows).toEqual([{ status: "revoked", readiness: "unavailable",
            health_reason: expectedReason }]);
          await expect(runtime.connections.finalizeCleanupClaim(binding.id, claim)).resolves.toBeNull();
          const selections = await client.query(`SELECT 1 FROM omr_control.connection_selections
            WHERE connection_id = $1`, [binding.id]);
          expect(selections.rowCount).toBe(0);
          await expect(runtime.connections.resolve({ actorUserId: "connection_owner", workspaceId,
            provider: "linear", connectionId: binding.id }))
            .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
          expect(JSON.stringify(rows.rows)).not.toContain("provider secret");
        } catch (error) {
          primaryError = error;
          throw error;
        } finally {
          release?.();
          await finishRaceTest(primaryError, [
            async () => { if (request) await settleRaceRequest(request, "PostgreSQL cleanup result"); },
            async () => { if (bindingId) await client.query(`DELETE FROM omr_control.connection_selections
              WHERE connection_id = $1`, [bindingId]); },
            async () => { if (bindingId) await client.query(`DELETE FROM omr_control.connection_bindings
              WHERE id = $1`, [bindingId]); },
          ]);
        }
      });
    }, 15_000);
  }

  it("restores and closes the shared member fixture after lookup and race failures", async () => {
    let primaryError: unknown;
    try {
      const verifyUsable = async () => {
        const binding = await runtime.connections.attach({ actorUserId: "connection_member", workspaceId,
          provider: "linear", providerConnectionId: `plug_${crypto.randomUUID()}`,
          ownership: "personal", label: "Restored member" });
        try {
          await runtime.connections.select({ actorUserId: "connection_member", workspaceId,
            provider: "linear", connectionId: binding.id });
          await expect(runtime.connections.resolve({ actorUserId: "connection_member", workspaceId,
            provider: "linear" })).resolves.toMatchObject({ id: binding.id });
        } finally {
          const cleanup = new Client({ connectionString: connectionString! });
          try {
            await cleanup.connect();
            await cleanup.query(`DELETE FROM omr_control.connection_selections WHERE connection_id = $1`, [binding.id]);
            await cleanup.query(`DELETE FROM omr_control.connection_bindings WHERE id = $1`, [binding.id]);
          } finally {
            await cleanup.end();
          }
        }
      };

      const lookupClient = new Client({ connectionString: connectionString! });
      const lookupClosed = vi.spyOn(lookupClient, "end");
      vi.spyOn(lookupClient, "query").mockRejectedValueOnce(new Error("member lookup sentinel"));
      await expect(withConnectionMember(lookupClient, workspaceId, async () => {
        throw new Error("body must not run after lookup failure");
      })).rejects.toThrow("member lookup sentinel");
      expect(lookupClosed).toHaveBeenCalledOnce();
      await verifyUsable();

      const remover = new Client({ connectionString: connectionString! });
      try {
        await remover.connect();
        await remover.query(`DELETE FROM omr_control.workspace_memberships
          WHERE workspace_id = $1 AND user_id = 'connection_member'`, [workspaceId]);
      } finally {
        await remover.end();
      }
      const missingClient = new Client({ connectionString: connectionString! });
      const missingClosed = vi.spyOn(missingClient, "end");
      await expect(withConnectionMember(missingClient, workspaceId, async () => {
        throw new Error("body must not run with missing member");
      })).rejects.toThrow("PostgreSQL race fixture is missing connection_member");
      expect(missingClosed).toHaveBeenCalledOnce();
      await verifyUsable();

      const raceClient = new Client({ connectionString: connectionString! });
      const raceClosed = vi.spyOn(raceClient, "end");
      const primary = new Error("post-removal assertion sentinel");
      await expect(withConnectionMember(raceClient, workspaceId, async (memberId) => {
        await raceClient.query(`DELETE FROM omr_control.workspace_memberships WHERE id = $1`, [memberId]);
        try {
          throw primary;
        } catch (error) {
          await finishRaceTest(error, [() => raceStep(new Promise<void>(() => {}), "forced teardown timeout")]);
          throw error;
        }
      })).rejects.toBe(primary);
      expect(primary.cause).toBeInstanceOf(AggregateError);
      expect(String(primary.cause)).toContain("Race test teardown failed");
      expect((primary.cause as AggregateError).errors[0]).toHaveProperty("message",
        "forced teardown timeout did not complete within 3000 ms");
      expect(raceClosed).toHaveBeenCalledOnce();
      await verifyUsable();
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await finishRaceTest(primaryError, [async () => {
        const rescue = new Client({ connectionString: connectionString! });
        try {
          await rescue.connect();
          await rescue.query(`INSERT INTO omr_control.workspace_memberships
            (id, workspace_id, user_id, role, created_at, updated_at)
            VALUES ($1, $2, 'connection_member', 'member', $3, $3)
            ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'member'`,
          [`membership_${crypto.randomUUID()}`, workspaceId, Date.now()]);
        } finally {
          await rescue.end();
        }
      }]);
    }
  }, 10_000);

  it("rejects a stale PostgreSQL cleanup claim after an authorized retry takes ownership", async () => {
    const binding = await runtime.connections.attach({ actorUserId: "connection_owner", workspaceId,
      provider: "linear", providerConnectionId: `plug_${crypto.randomUUID()}`,
      ownership: "workspace", label: "Claim retry" });
    const client = new Client({ connectionString: connectionString! });
    await client.connect();
    try {
      const first = `provider_cleanup_pending:${crypto.randomUUID()}`;
      const second = `provider_cleanup_pending:${crypto.randomUUID()}`;
      await runtime.connections.revokeIfNotRevoked("connection_owner", binding.id, first);
      await runtime.connections.revokeIf("connection_owner", binding.id, "revoked", first, second);
      await expect(runtime.connections.finalizeCleanupClaim(binding.id, first, "remote_revoke_failed"))
        .resolves.toBeNull();
      await expect(runtime.connections.finalizeCleanupClaim(binding.id, second, "provider_cleanup_failed"))
        .resolves.toMatchObject({ healthReason: "provider_cleanup_failed" });
      const row = await client.query<{ health_reason: string }>(
        `SELECT health_reason FROM omr_control.connection_bindings WHERE id = $1`, [binding.id]);
      expect(row.rows[0]?.health_reason).toBe("provider_cleanup_failed");
    } finally {
      await client.query(`DELETE FROM omr_control.connection_bindings WHERE id = $1`, [binding.id]);
      await client.end();
    }
  });
});
