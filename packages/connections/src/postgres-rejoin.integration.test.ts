import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresWorkspaceStore } from "@oh-my-router/identity/postgres";

import { PostgresConnectionBindingStore } from "./postgres-store.js";

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

/** Distinguish a blocked transaction from one that completed before lock release. */
async function remainsPending(operation: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    operation.then(() => false, () => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 100)),
  ]);
}

describePostgres("orphan cleanup and membership rejoin serialization", () => {
  it("keeps the revocation preflight advisory while the mutation waits for the workspace lock", async () => {
    const seed = new Client({ connectionString: connectionString! });
    const lockClient = new Client({ connectionString: connectionString! });
    const cleanupClient = new Client({ connectionString: connectionString! });
    await Promise.all([seed.connect(), lockClient.connect(), cleanupClient.connect()]);
    const state = await fixture(seed);
    const connections = new PostgresConnectionBindingStore(cleanupClient);
    await lockClient.query("BEGIN");
    await lockClient.query(`SELECT id FROM omr_control.workspaces WHERE id = $1 FOR UPDATE`, [state.workspaceId]);
    const preflight = connections.getRevocable({ actorUserId: "workspace_admin", connectionId: state.connectionId });
    let cleanup: Promise<unknown> | undefined;
    try {
      expect(await remainsPending(preflight)).toBe(false);
      await expect(preflight).resolves.toMatchObject({ status: "active" });
      cleanup = connections.revoke({ actorUserId: "workspace_admin", connectionId: state.connectionId, now: state.now });
      expect(await remainsPending(cleanup)).toBe(true);
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
          expect(await remainsPending(rejoin)).toBe(true);
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
          expect(await remainsPending(cleanup)).toBe(true);
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
