import { readFileSync } from "node:fs";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { PostgresExecutionApprovalStore } from "./postgres-approval-store.js";
import { PostgresExecutionReceiptStore } from "./postgres-store.js";
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
        id text PRIMARY KEY, workspace_id text NOT NULL, actor_user_id text NOT NULL,
        principal_key text NOT NULL, tool_id text NOT NULL, manifest_hash text NOT NULL,
        connection_id text NOT NULL, provider_connection_id text NOT NULL,
        idempotency_key text NOT NULL, request_hash text NOT NULL, status text NOT NULL,
        result_ciphertext bytea, result_iv bytea, error_code text,
        started_at bigint NOT NULL, completed_at bigint, created_at bigint NOT NULL,
        updated_at bigint NOT NULL,
        CONSTRAINT execution_receipts_status_check CHECK (status IN ('running', 'succeeded', 'failed'))
      )`);
      await client.query(`INSERT INTO ${qualified}.workspaces VALUES ('workspace_1')`);
      await client.query(`INSERT INTO ${qualified}.workspace_memberships VALUES ('workspace_1', 'user_1')`);
      await client.query(`INSERT INTO ${qualified}.connection_bindings VALUES ('connection_1')`);
      const migrate = async (name: string, withinExistingTransaction = false) => {
        let sql = readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), "utf8")
          .replaceAll("omr_control.", `${qualified}.`);
        if (withinExistingTransaction) {
          const start = /^--[^\n]*\nBEGIN;/;
          const finish = /COMMIT;\s*$/;
          if (!start.test(sql) || !finish.test(sql)) {
            throw new Error(`Migration ${name} must have explicit transaction markers`);
          }
          sql = sql.replace(start, "").replace(finish, "");
        }
        await client.query(sql);
      };
      await migrate("0008_execution_approvals");
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const wrappingKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv }, wrappingKey, new TextEncoder().encode("{}"),
      ));
      const insertLegacy = async (id: string, status: string, createdAt: number,
        idempotencyKey = "legacy-key") => {
        await client.query(`INSERT INTO ${qualified}.execution_approvals
          (id, workspace_id, actor_user_id, principal_key, tool_id, manifest_hash,
           connection_id, provider_connection_id, params_ciphertext, params_iv,
           idempotency_key, status, expires_at, created_at, updated_at)
          VALUES ($1, 'workspace_1', 'user_1', 'web:user_1', 'linear.create_issue', 'manifest_1',
                  'connection_1', 'provider_1', $2, $3, $4, $5, 9999999999999, $6, $6)`,
        [id, ciphertext, iv, idempotencyKey, status, createdAt]);
      };
      await insertLegacy("approval_old", "consumed", 1);
      await insertLegacy("approval_duplicate", "approved", 2);
      await insertLegacy("approval_inflight", "executing", 3);
      await insertLegacy("approval_later_pending", "pending", 4, "later-key");
      await insertLegacy("approval_later_consumed", "consumed", 5, "later-key");
      await insertLegacy("approval_collision", "rejected", 6,
        "legacy~duplicate~approval_later_pending~0");
      await migrate("0012_execution_uncertainty");
      await migrate("0013_keyed_execution_fingerprints");

      await client.query("BEGIN");
      await migrate("0014_approval_reconciliation", true);
      const oldWriter = new Client({ connectionString: databaseUrl! });
      await oldWriter.connect();
      try {
        await oldWriter.query("BEGIN");
        let writerSettled = false;
        const racingWrite = oldWriter.query(`UPDATE ${qualified}.execution_approvals
          SET updated_at = 100 WHERE id = 'approval_old'`)
          .then(() => { writerSettled = true; });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(writerSettled).toBe(false);
        await client.query("ROLLBACK");
        await racingWrite;
        await oldWriter.query("ROLLBACK");
      } finally {
        await oldWriter.end();
      }
      const rolledBack = await client.query<{ count: string }>(
        `SELECT count(*) FROM ${qualified}.execution_approvals
         WHERE idempotency_key = 'legacy-key' AND request_hash IS NULL`,
      );
      expect(Number(rolledBack.rows[0]?.count)).toBe(3);

      await migrate("0014_approval_reconciliation");
      await client.query("BEGIN");
      await migrate("0016_receipt_approval_identity");
      await client.query("ROLLBACK");
      const rolledBackIdentity = await client.query<{ count: string }>(
        `SELECT count(*) FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'execution_receipts' AND column_name = 'approval_id'`,
        [schema]);
      expect(Number(rolledBackIdentity.rows[0]?.count)).toBe(0);
      await migrate("0016_receipt_approval_identity");
      await migrate("0016_receipt_approval_identity");
      const rows = await client.query<{ id: string; idempotency_key: string; status: string; request_hash: string }>(
        `SELECT id, idempotency_key, status, request_hash
         FROM ${qualified}.execution_approvals ORDER BY created_at, id`,
      );
      expect(rows.rows).toEqual([
        expect.objectContaining({ id: "approval_old", idempotency_key: "legacy-key",
          status: "consumed", request_hash: "legacy-redacted-approval_old" }),
        expect.objectContaining({ id: "approval_duplicate",
          idempotency_key: "legacy~duplicate~approval_duplicate~0", status: "failed" }),
        expect.objectContaining({ id: "approval_inflight",
          idempotency_key: "legacy~duplicate~approval_inflight~0", status: "uncertain" }),
        expect.objectContaining({ id: "approval_later_pending",
          idempotency_key: "legacy~duplicate~approval_later_pending~1", status: "failed" }),
        expect.objectContaining({ id: "approval_later_consumed",
          idempotency_key: "later-key", status: "consumed" }),
        expect.objectContaining({ id: "approval_collision",
          idempotency_key: "legacy~duplicate~approval_later_pending~0", status: "rejected" }),
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
      for (const decision of ["approve", "reject"] as const) {
        const id = `approval_expiring_${decision}`;
        const expiresAt = Date.now() + 750;
        await store.create({ ...candidate, id, idempotencyKey: id,
          expiresAt, createdAt: Date.now(), updatedAt: Date.now() });
        const blocker = new Client({ connectionString: databaseUrl! });
        await blocker.connect();
        try {
          await blocker.query("BEGIN");
          await blocker.query(`UPDATE ${qualified}.workspace_memberships SET user_id = user_id
            WHERE workspace_id = 'workspace_1' AND user_id = 'user_1'`);
          let settled = false;
          const pending = store[decision]({ approvalId: id, actorUserId: "user_1", now: Date.now() })
            .finally(() => { settled = true; });
          await new Promise((resolve) => setTimeout(resolve, 40));
          expect(settled).toBe(false);
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 30)));
          await blocker.query("COMMIT");
          await expect(pending).rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
          const state = await client.query(`SELECT status FROM ${qualified}.execution_approvals WHERE id = $1`, [id]);
          expect(state.rows[0]?.status).toBe("pending");
        } finally {
          await blocker.query("ROLLBACK");
          await blocker.end();
        }
      }
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
        principalKey: "web:user_1", now: 6, deadlineAt: Date.now() + 1_000 });
      await client.query(`INSERT INTO ${qualified}.execution_receipts
        (id, workspace_id, actor_user_id, principal_key, tool_id, manifest_hash, connection_id,
         provider_connection_id, idempotency_key, status, request_hash, started_at, created_at, updated_at)
        VALUES ('execution_reconcile', 'workspace_1', 'user_1', 'web:user_1', 'linear.create_issue',
                'manifest_1', 'connection_1', 'provider_1', 'fresh-key', 'uncertain', 'opaque', 1, 1, 1)`);
      await client.query(`UPDATE ${qualified}.execution_receipts SET approval_id = 'approval_fresh'
        WHERE id = 'execution_reconcile'`);
      await expect(client.query(`INSERT INTO ${qualified}.execution_receipts
        (id, workspace_id, actor_user_id, principal_key, tool_id, manifest_hash, connection_id,
         provider_connection_id, idempotency_key, status, request_hash, approval_id,
         started_at, created_at, updated_at)
        VALUES ('execution_duplicate', 'workspace_1', 'user_1', 'web:user_1', 'linear.create_issue',
                'manifest_1', 'connection_1', 'provider_1', 'another-key', 'uncertain', 'opaque',
                'approval_fresh', 1, 1, 1)`)).rejects.toMatchObject({ code: "23505" });
      await expect(store.uncertain({ approvalId: "approval_fresh", receiptId: "execution_reconcile", now: 7 }))
        .resolves.toMatchObject({ status: "uncertain", executionReceiptId: "execution_reconcile" });
      await expect(store.claim({ approvalId: "approval_fresh", actorUserId: "user_1",
        principalKey: "web:user_1", now: 8, deadlineAt: Date.now() + 1_000 })).rejects.toMatchObject({
        code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: "execution_reconcile",
      });
      const count = await client.query<{ count: string }>(
        `SELECT count(*) FROM ${qualified}.execution_approvals WHERE idempotency_key = 'legacy-key'`,
      );
      expect(Number(count.rows[0]?.count)).toBe(1);
      const receiptStore = new PostgresExecutionReceiptStore(fixtureClient, key);
      const lookup = { workspaceId: "workspace_1", principalKey: "web:user_1",
        idempotencyKey: "fresh-key" };
      await expect(receiptStore.findByIdempotency(lookup))
        .resolves.toMatchObject({ id: "execution_reconcile", status: "uncertain" });
      await client.query(`DELETE FROM ${qualified}.workspace_memberships WHERE user_id = 'user_1'`);
      await expect(receiptStore.findByIdempotency(lookup)).resolves.toBeNull();
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${qualified} CASCADE`);
      await client.end();
    }
  });
});
