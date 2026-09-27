import { readFileSync } from "node:fs";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { PostgresExecutionApprovalStore } from "./postgres-approval-store.js";
import type { ExecutionApproval } from "./execution.js";

const databaseUrl = process.env.OMR_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("approval migration from origin/dev schema", () => {
  it("rolls back atomically, reconciles duplicate legacy keys, and reserves NULL fingerprints", async () => {
    const client = new Client({ connectionString: databaseUrl! });
    const schema = `omr_approval_${crypto.randomUUID().replaceAll("-", "")}`;
    const qualified = `"${schema}"`;
    const key = new Uint8Array(32).fill(9);
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${qualified}`);
      await client.query(`CREATE TABLE ${qualified}.workspaces (id text PRIMARY KEY)`);
      await client.query(`CREATE TABLE ${qualified}.workspace_memberships (
        workspace_id text NOT NULL, user_id text NOT NULL, PRIMARY KEY (workspace_id, user_id))`);
      await client.query(`CREATE TABLE ${qualified}.connection_bindings (id text PRIMARY KEY)`);
      await client.query(`CREATE TABLE ${qualified}.execution_receipts (
        id text PRIMARY KEY, status text NOT NULL, request_hash text NOT NULL,
        CONSTRAINT execution_receipts_status_check CHECK (status IN ('running', 'succeeded', 'failed'))
      )`);
      await client.query(`INSERT INTO ${qualified}.workspaces VALUES ('workspace_1')`);
      await client.query(`INSERT INTO ${qualified}.workspace_memberships VALUES ('workspace_1', 'user_1')`);
      await client.query(`INSERT INTO ${qualified}.connection_bindings VALUES ('connection_1')`);
      const migrate = async (name: string) => {
        const sql = readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), "utf8")
          .replaceAll("omr_control.", `${qualified}.`);
        await client.query(sql);
      };
      await migrate("0008_execution_approvals");
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const wrappingKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv }, wrappingKey, new TextEncoder().encode("{}"),
      ));
      const insertLegacy = async (id: string, status: string, createdAt: number) => {
        await client.query(`INSERT INTO ${qualified}.execution_approvals
          (id, workspace_id, actor_user_id, principal_key, tool_id, manifest_hash,
           connection_id, provider_connection_id, params_ciphertext, params_iv,
           idempotency_key, status, expires_at, created_at, updated_at)
          VALUES ($1, 'workspace_1', 'user_1', 'web:user_1', 'linear.create_issue', 'manifest_1',
                  'connection_1', 'provider_1', $2, $3, 'legacy-key', $4, 9999999999999, $5, $5)`,
        [id, ciphertext, iv, status, createdAt]);
      };
      await insertLegacy("approval_old", "consumed", 1);
      await insertLegacy("approval_duplicate", "approved", 2);
      await insertLegacy("approval_inflight", "executing", 3);
      await migrate("0012_execution_uncertainty");
      await migrate("0013_keyed_execution_fingerprints");

      await client.query("BEGIN");
      await migrate("0014_approval_reconciliation");
      await client.query("ROLLBACK");
      const rolledBack = await client.query<{ count: string }>(
        `SELECT count(*) FROM ${qualified}.execution_approvals
         WHERE idempotency_key = 'legacy-key' AND request_hash IS NULL`,
      );
      expect(Number(rolledBack.rows[0]?.count)).toBe(3);

      await migrate("0014_approval_reconciliation");
      const rows = await client.query<{ id: string; idempotency_key: string; status: string; request_hash: string }>(
        `SELECT id, idempotency_key, status, request_hash
         FROM ${qualified}.execution_approvals ORDER BY created_at, id`,
      );
      expect(rows.rows).toEqual([
        expect.objectContaining({ id: "approval_old", idempotency_key: "legacy-key",
          status: "consumed", request_hash: "legacy-redacted-approval_old" }),
        expect.objectContaining({ id: "approval_duplicate",
          idempotency_key: "legacy~duplicate~approval_duplicate", status: "failed" }),
        expect.objectContaining({ id: "approval_inflight",
          idempotency_key: "legacy~duplicate~approval_inflight", status: "uncertain" }),
      ]);

      // Point the store at this isolated schema; its SQL otherwise matches production.
      const originalQuery = client.query.bind(client);
      const fixtureClient = { query: (sql: string, values?: unknown[]) =>
        originalQuery(sql.replaceAll("omr_control.", `${qualified}.`), values) } as unknown as Client;
      const store = new PostgresExecutionApprovalStore(fixtureClient, key);
      const candidate: ExecutionApproval = {
        id: "approval_new", workspaceId: "workspace_1", actorUserId: "user_1",
        principalKey: "web:user_1", toolId: "linear.create_issue", manifestHash: "manifest_1",
        connectionId: "connection_1", providerConnectionId: "provider_1", params: {},
        idempotencyKey: "legacy-key", requestHash: "hmac-sha256-new-request", status: "pending",
        approvedBy: null, decidedAt: null, expiresAt: 9999999999999,
        executionReceiptId: null, createdAt: 4, updatedAt: 4,
      };
      await expect(store.create(candidate)).rejects.toMatchObject({
        code: "EXECUTION_IDEMPOTENCY_CONFLICT",
      });
      await expect(store.create({ ...candidate, id: "approval_fresh", idempotencyKey: "fresh-key" }))
        .resolves.toMatchObject({ id: "approval_fresh", status: "pending" });
      await expect(store.getForActor("approval_fresh", "user_1"))
        .resolves.toMatchObject({ id: "approval_fresh", params: {} });
      await expect(store.getForActor("approval_fresh", "another_user"))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      const revoker = new Client({ connectionString: databaseUrl! });
      await revoker.connect();
      try {
        await revoker.query("BEGIN");
        await revoker.query(`DELETE FROM ${qualified}.workspace_memberships WHERE user_id = 'user_1'`);
        let decisionSettled = false;
        const racingDecision = store.approve({ approvalId: "approval_fresh", actorUserId: "user_1", now: 5 })
          .then(() => { decisionSettled = true; return null; }, (error: unknown) => {
            decisionSettled = true;
            return error;
          });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(decisionSettled).toBe(false);
        await revoker.query("COMMIT");
        await expect(racingDecision).resolves.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      } finally {
        await revoker.query("ROLLBACK");
        await revoker.end();
      }
      await expect(store.getForActor("approval_fresh", "user_1"))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      await expect(store.approve({ approvalId: "approval_fresh", actorUserId: "user_1", now: 5 }))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      await expect(store.reject({ approvalId: "approval_fresh", actorUserId: "user_1", now: 5 }))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      await client.query(`INSERT INTO ${qualified}.workspace_memberships VALUES ('workspace_1', 'user_1')`);
      await store.approve({ approvalId: "approval_fresh", actorUserId: "user_1", now: 5 });
      await store.claim({ approvalId: "approval_fresh", actorUserId: "user_1",
        principalKey: "web:user_1", now: 6 });
      await client.query(`INSERT INTO ${qualified}.execution_receipts
        (id, status, request_hash) VALUES ('execution_reconcile', 'uncertain', 'opaque')`);
      await expect(store.uncertain({ approvalId: "approval_fresh", receiptId: "execution_reconcile", now: 7 }))
        .resolves.toMatchObject({ status: "uncertain", executionReceiptId: "execution_reconcile" });
      await expect(store.claim({ approvalId: "approval_fresh", actorUserId: "user_1",
        principalKey: "web:user_1", now: 8 })).rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      const count = await client.query<{ count: string }>(
        `SELECT count(*) FROM ${qualified}.execution_approvals WHERE idempotency_key = 'legacy-key'`,
      );
      expect(Number(count.rows[0]?.count)).toBe(1);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${qualified} CASCADE`);
      await client.end();
    }
  });
});
