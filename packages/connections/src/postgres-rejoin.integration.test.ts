import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresWorkspaceStore } from "@oh-my-router/identity/postgres";

import { PostgresConnectionBindingStore } from "./postgres-store.js";
import { ConnectionAuthority } from "./connections.js";

const connectionString = process.env.OMR_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

/** Seed an orphaned personal binding and a valid invitation in one disposable workspace. */
async function fixture(client: Client) {
  const suffix = crypto.randomUUID();
  const workspaceId = `workspace_rejoin_${suffix}`;
  const connectionId = `connection_rejoin_${suffix}`;
  const tokenHash = `invitation_${suffix}`;
  const now = Date.now();
  await client.query(
    `INSERT INTO omr_control.workspaces (id, kind, name, created_at, updated_at)
     VALUES ($1, 'team', 'Rejoin race', $2, $2)`, [workspaceId, now],
  );
  await client.query(
    `INSERT INTO omr_control.workspace_memberships
       (id, workspace_id, user_id, role, created_at, updated_at)
     VALUES ($1, $2, 'workspace_admin', 'admin', $3, $3)`,
    [`membership_admin_${suffix}`, workspaceId, now],
  );
  await client.query(
    `INSERT INTO omr_control.workspace_invitations
       (id, workspace_id, email, role, token_hash, created_by, expires_at,
        created_at, updated_at)
     VALUES ($1, $2, 'returning@example.com', 'member', $3, 'workspace_admin', $4, $5, $5)`,
    [`invite_${suffix}`, workspaceId, tokenHash, now + 60_000, now],
  );
  await client.query(
    `INSERT INTO omr_control.connection_bindings
       (id, workspace_id, provider, provider_connection_id, ownership, owner_user_id,
        installed_by, label, status, readiness, created_at, updated_at)
     VALUES ($1, $2, 'github', $1, 'personal', 'returning_member',
       'returning_member', 'Private account', 'active', 'ready', $3, $3)`,
    [connectionId, workspaceId, now],
  );
  await client.query(
    `INSERT INTO omr_control.connection_selections
       (workspace_id, user_id, provider, connection_id, created_at, updated_at)
     VALUES ($1, 'returning_member', 'github', $2, $3, $3)`,
    [workspaceId, connectionId, now],
  );
  return { workspaceId, connectionId, tokenHash, now, suffix };
}

/** Pause after a chosen SQL statement while retaining the transaction's locks. */
function pauseAfterQuery(client: Client, matches: (sql: string, params: unknown[]) => boolean) {
  const original = client.query.bind(client);
  let reached!: () => void;
  let release!: () => void;
  const atBarrier = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  (client as unknown as { query: typeof client.query }).query = (async (sql: string, params?: unknown[]) => {
    const result = await original(sql, params);
    if (matches(sql, params ?? [])) {
      reached();
      await held;
    }
    return result;
  }) as typeof client.query;
  return { atBarrier, release };
}

/** Observe PostgreSQL's lock wait instead of assuming a fixed runner speed. */
async function expectLockWait(observer: Client, blockedPid: number): Promise<void> {
  await vi.waitFor(async () => {
    const result = await observer.query<{ wait_event_type: string | null }>(
      `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [blockedPid],
    );
    expect(result.rows[0]?.wait_event_type).toBe("Lock");
  }, { timeout: 5_000, interval: 20 });
}

describePostgres("orphan cleanup and membership rejoin serialization", () => {
  it("durably records an inactive remote handle after the initiating member departs", async () => {
    const seed = new Client({ connectionString: connectionString! });
    const cleanupClient = new Client({ connectionString: connectionString! });
    await Promise.all([seed.connect(), cleanupClient.connect()]);
    const state = await fixture(seed);
    const authority = new ConnectionAuthority(new PostgresConnectionBindingStore(cleanupClient), () => state.now);
    try {
      const record = await authority.attachForCleanup({ actorUserId: "returning_member",
        workspaceId: state.workspaceId, provider: "linear", ownership: "personal",
        providerConnectionId: `inactive_${state.suffix}`, label: "Inactive" });
      expect(record).toMatchObject({ status: "revoked", readiness: "unavailable",
        healthReason: "provider_cleanup_failed" });
      const persisted = await seed.query(
        `SELECT provider_connection_id, status, readiness, health_reason FROM omr_control.connection_bindings WHERE id = $1`,
        [record.id],
      );
      expect(persisted.rows[0]).toMatchObject({ provider_connection_id: `inactive_${state.suffix}`,
        status: "revoked", readiness: "unavailable", health_reason: "provider_cleanup_failed" });
    } finally {
      await seed.query(`DELETE FROM omr_control.workspaces WHERE id = $1`, [state.workspaceId]);
      await Promise.all([seed.end(), cleanupClient.end()]);
    }
  }, 15_000);

  it("lets a rejoined owner claim cleanup while keeping admins and selections out", async () => {
    const seed = new Client({ connectionString: connectionString! });
    const cleanupClient = new Client({ connectionString: connectionString! });
    const invitationClient = new Client({ connectionString: connectionString! });
    await Promise.all([seed.connect(), cleanupClient.connect(), invitationClient.connect()]);
    const state = await fixture(seed);
    const connections = new PostgresConnectionBindingStore(cleanupClient);
    const workspaces = new PostgresWorkspaceStore(invitationClient);
    try {
      await expect(connections.revokeIf({ actorUserId: "workspace_admin", connectionId: state.connectionId,
        expectedStatus: "not_revoked", reason: "provider_cleanup_requires_owner", now: state.now }))
        .resolves.toMatchObject({ status: "revoked", readiness: "unavailable" });
      await workspaces.acceptInvitation({ tokenHash: state.tokenHash,
        userId: "returning_member", email: "returning@example.com",
        membershipId: `membership_returning_${state.suffix}`, now: state.now });
      await expect(connections.revokeIf({ actorUserId: "workspace_admin", connectionId: state.connectionId,
        expectedStatus: "revoked", expectedReason: "provider_cleanup_requires_owner",
        reason: "provider_cleanup_pending:admin", now: state.now }))
        .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
      await expect(connections.revokeIf({ actorUserId: "returning_member", connectionId: state.connectionId,
        expectedStatus: "revoked", expectedReason: "provider_cleanup_requires_owner",
        reason: "provider_cleanup_pending:owner", now: state.now }))
        .resolves.toMatchObject({ status: "revoked", readiness: "unavailable",
          healthReason: "provider_cleanup_pending:owner" });
      await expect(connections.revokeIf({ actorUserId: "returning_member", connectionId: state.connectionId,
        expectedStatus: "revoked", expectedReason: "provider_cleanup_requires_owner",
        reason: "provider_cleanup_pending:second", now: state.now }))
        .resolves.toBeNull();
      const stateAfter = await seed.query(
        `SELECT status, readiness,
           (SELECT count(*) FROM omr_control.connection_selections WHERE connection_id = $1) AS selections
         FROM omr_control.connection_bindings WHERE id = $1`, [state.connectionId],
      );
      expect(stateAfter.rows[0]).toMatchObject({ status: "revoked", readiness: "unavailable", selections: "0" });
    } finally {
      await seed.query(`DELETE FROM omr_control.workspaces WHERE id = $1`, [state.workspaceId]);
      await Promise.all([seed.end(), cleanupClient.end(), invitationClient.end()]);
    }
  }, 15_000);

  it("keeps the revocation preflight advisory while the mutation waits for the workspace lock", async () => {
    const seed = new Client({ connectionString: connectionString! });
    const lockClient = new Client({ connectionString: connectionString! });
    const cleanupClient = new Client({ connectionString: connectionString! });
    await Promise.all([seed.connect(), lockClient.connect(), cleanupClient.connect()]);
    const state = await fixture(seed);
    const cleanupPid = (await cleanupClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const connections = new PostgresConnectionBindingStore(cleanupClient);
    await lockClient.query("BEGIN");
    await lockClient.query(`SELECT id FROM omr_control.workspaces WHERE id = $1 FOR UPDATE`, [state.workspaceId]);
    const preflight = connections.getRevocable({ actorUserId: "workspace_admin", connectionId: state.connectionId });
    let cleanup: Promise<unknown> | undefined;
    try {
      await expect(preflight).resolves.toMatchObject({ status: "active" });
      cleanup = connections.revoke({ actorUserId: "workspace_admin", connectionId: state.connectionId, now: state.now });
      await expectLockWait(seed, cleanupPid);
      await lockClient.query("COMMIT");
      await expect(cleanup).resolves.toMatchObject({ status: "revoked", readiness: "unavailable" });
    } finally {
      await lockClient.query("ROLLBACK");
      await Promise.allSettled([preflight, ...(cleanup ? [cleanup] : [])]);
      await cleanupClient.query("ROLLBACK");
      await seed.query(`DELETE FROM omr_control.workspaces WHERE id = $1`, [state.workspaceId]);
      await Promise.all([seed.end(), lockClient.end(), cleanupClient.end()]);
    }
  }, 15_000);

  for (const mode of ["revoke", "revokeIf"] as const) {
    it(`${mode}: cleanup commits before rejoin without a stale authorization decision`, async () => {
      const seed = new Client({ connectionString: connectionString! });
      const cleanupClient = new Client({ connectionString: connectionString! });
      const invitationClient = new Client({ connectionString: connectionString! });
      await Promise.all([seed.connect(), cleanupClient.connect(), invitationClient.connect()]);
      const state = await fixture(seed);
      const invitationPid = (await invitationClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const barrier = pauseAfterQuery(cleanupClient, (sql, params) =>
        sql.includes("FROM omr_control.workspace_memberships") && params[1] === "returning_member");
      const connections = new PostgresConnectionBindingStore(cleanupClient);
      const workspaces = new PostgresWorkspaceStore(invitationClient);
      const cleanup = mode === "revoke"
        ? connections.revoke({ actorUserId: "workspace_admin", connectionId: state.connectionId, now: state.now })
        : connections.revokeIf({ actorUserId: "workspace_admin", connectionId: state.connectionId,
          expectedStatus: "not_revoked", reason: "provider_cleanup_pending:test", now: state.now });
      let rejoin: Promise<unknown> | undefined;
      try {
        await barrier.atBarrier;
        rejoin = workspaces.acceptInvitation({ tokenHash: state.tokenHash,
          userId: "returning_member", email: "returning@example.com",
          membershipId: `membership_returning_${state.suffix}`, now: state.now });
        try {
          await expectLockWait(seed, invitationPid);
        } finally {
          barrier.release();
        }
        await expect(cleanup).resolves.toMatchObject({ status: "revoked", readiness: "unavailable" });
        await expect(rejoin).resolves.toMatchObject({ userId: "returning_member" });
        const result = await seed.query(
          `SELECT binding.status,
             (SELECT count(*) FROM omr_control.connection_selections WHERE connection_id = $1) AS selections
           FROM omr_control.connection_bindings AS binding WHERE binding.id = $1`,
          [state.connectionId],
        );
        expect(result.rows[0]).toMatchObject({ status: "revoked", selections: "0" });
      } finally {
        barrier.release();
        await Promise.allSettled([cleanup, ...(rejoin ? [rejoin] : [])]);
        await Promise.allSettled([cleanupClient.query("ROLLBACK"), invitationClient.query("ROLLBACK")]);
        await seed.query(`DELETE FROM omr_control.workspaces WHERE id = $1`, [state.workspaceId]);
        await Promise.all([seed.end(), cleanupClient.end(), invitationClient.end()]);
      }
    }, 15_000);

    it(`${mode}: rejoin commits first and preserves the personal binding and selection`, async () => {
      const seed = new Client({ connectionString: connectionString! });
      const cleanupClient = new Client({ connectionString: connectionString! });
      const invitationClient = new Client({ connectionString: connectionString! });
      await Promise.all([seed.connect(), cleanupClient.connect(), invitationClient.connect()]);
      const state = await fixture(seed);
      const cleanupPid = (await cleanupClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const barrier = pauseAfterQuery(invitationClient, (sql) =>
        sql.includes("INSERT INTO omr_control.workspace_memberships"));
      const connections = new PostgresConnectionBindingStore(cleanupClient);
      const workspaces = new PostgresWorkspaceStore(invitationClient);
      const rejoin = workspaces.acceptInvitation({ tokenHash: state.tokenHash,
        userId: "returning_member", email: "returning@example.com",
        membershipId: `membership_returning_${state.suffix}`, now: state.now });
      let cleanup: Promise<unknown> | undefined;
      try {
        await barrier.atBarrier;
        cleanup = mode === "revoke"
          ? connections.revoke({ actorUserId: "workspace_admin", connectionId: state.connectionId, now: state.now })
          : connections.revokeIf({ actorUserId: "workspace_admin", connectionId: state.connectionId,
            expectedStatus: "not_revoked", reason: "provider_cleanup_pending:test", now: state.now });
        try {
          await expectLockWait(seed, cleanupPid);
        } finally {
          barrier.release();
        }
        await expect(rejoin).resolves.toMatchObject({ userId: "returning_member" });
        await expect(cleanup).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
        const result = await seed.query(
          `SELECT binding.status,
             (SELECT count(*) FROM omr_control.connection_selections WHERE connection_id = $1) AS selections
           FROM omr_control.connection_bindings AS binding WHERE binding.id = $1`,
          [state.connectionId],
        );
        expect(result.rows[0]).toMatchObject({ status: "active", selections: "1" });
      } finally {
        barrier.release();
        await Promise.allSettled([rejoin, ...(cleanup ? [cleanup] : [])]);
        await Promise.allSettled([cleanupClient.query("ROLLBACK"), invitationClient.query("ROLLBACK")]);
        await seed.query(`DELETE FROM omr_control.workspaces WHERE id = $1`, [state.workspaceId]);
        await Promise.all([seed.end(), cleanupClient.end(), invitationClient.end()]);
      }
    }, 15_000);
  }
});
