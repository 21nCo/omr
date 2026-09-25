import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ExecutionReceipt } from "./execution.js";
import type { ExecutionApproval } from "./execution.js";
import {
  connectPostgresExecutionReceipts,
  type PostgresExecutionReceiptRuntime,
} from "./postgres.js";

const connectionString = process.env.OMR_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const WRAPPING_KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1)).buffer;

describePostgres("execution receipts/PostgreSQL integration", () => {
  let runtime: PostgresExecutionReceiptRuntime;
  let workspaceId: string;
  let connectionId: string;

  beforeAll(async () => {
    const client = new Client({ connectionString: connectionString! });
    await client.connect();
    const now = Date.now();
    workspaceId = `workspace_team_${crypto.randomUUID()}`;
    connectionId = `connection_${crypto.randomUUID()}`;
    await client.query(
      `INSERT INTO omr_control.workspaces (id, kind, name, created_at, updated_at)
       VALUES ($1, 'team', 'Execution', $2, $2)`,
      [workspaceId, now],
    );
    await client.query(
      `INSERT INTO omr_control.connection_bindings
         (id, workspace_id, provider, provider_connection_id, ownership, owner_user_id,
          installed_by, label, status, readiness, last_checked_at, created_at, updated_at)
       VALUES ($1, $2, 'linear', $3, 'workspace', NULL,
               'execution_owner', 'Linear', 'active', 'ready', $4, $4, $4)`,
      [connectionId, workspaceId, `plug_${crypto.randomUUID()}`, now],
    );
    await client.end();
    runtime = await connectPostgresExecutionReceipts({
      connectionString: connectionString!,
      resultWrappingKey: new Uint8Array(WRAPPING_KEY),
    });
  });

  afterAll(async () => {
    await runtime.close();
  });

  it("reserves idempotently and encrypts successful results at rest", async () => {
    const now = Date.now();
    const receipt: ExecutionReceipt = {
      id: `execution_${crypto.randomUUID()}`,
      workspaceId,
      actorUserId: "execution_owner",
      principalKey: "web:execution_owner",
      toolId: "linear.get_issue",
      manifestHash: `sha256-${"a".repeat(64)}`,
      connectionId,
      providerConnectionId: `plug_${crypto.randomUUID()}`,
      idempotencyKey: `request_${crypto.randomUUID()}`,
      requestHash: `sha256-${"b".repeat(64)}`,
      status: "running",
      result: null,
      errorCode: null,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await expect(runtime.receipts.reserve(receipt)).resolves.toMatchObject({ created: true });
    await expect(runtime.receipts.reserve({ ...receipt, id: `execution_${crypto.randomUUID()}` }))
      .resolves.toMatchObject({ created: false, receipt: { id: receipt.id } });
    await expect(runtime.receipts.succeed(receipt.id, {
      id: "issue_secret",
      title: "Sensitive provider result",
    }, now + 1)).resolves.toMatchObject({
      status: "succeeded",
      result: { id: "issue_secret", title: "Sensitive provider result" },
    });
    await expect(runtime.receipts.listForActor({
      workspaceId,
      actorUserId: "execution_owner",
      limit: 20,
    })).resolves.toEqual([
      expect.objectContaining({
        id: receipt.id,
        result: { id: "issue_secret", title: "Sensitive provider result" },
      }),
    ]);
    await expect(runtime.receipts.listForActor({
      workspaceId,
      actorUserId: "other_user",
      limit: 20,
    })).resolves.toEqual([]);

    const client = new Client({ connectionString: connectionString! });
    await client.connect();
    try {
      const raw = await client.query<{ encoded: string }>(
        `SELECT encode(result_ciphertext, 'hex') AS encoded
         FROM omr_control.execution_receipts WHERE id = $1`,
        [receipt.id],
      );
      expect(raw.rows[0]?.encoded).not.toContain("issue_secret");
      expect(raw.rows[0]?.encoded.length).toBeGreaterThan(32);
    } finally {
      await client.end();
    }
  });

  it("atomically binds encrypted approval parameters to one actor and principal", async () => {
    const now = Date.now();
    const approval: ExecutionApproval = {
      id: `approval_${crypto.randomUUID()}`,
      workspaceId,
      actorUserId: "execution_owner",
      principalKey: "web:execution_owner",
      toolId: "linear.create_issue",
      manifestHash: `sha256-${"c".repeat(64)}`,
      connectionId,
      providerConnectionId: `plug_${crypto.randomUUID()}`,
      params: { title: "Sensitive approval title" },
      idempotencyKey: `approval_${crypto.randomUUID()}`,
      status: "pending",
      approvedBy: null,
      decidedAt: null,
      expiresAt: now + 60_000,
      executionReceiptId: null,
      createdAt: now,
      updatedAt: now,
    };
    await expect(runtime.approvals.create(approval)).resolves.toMatchObject({
      params: { title: "Sensitive approval title" },
      status: "pending",
    });
    await expect(runtime.approvals.listForActor({
      workspaceId,
      actorUserId: "execution_owner",
      limit: 20,
    })).resolves.toEqual([
      expect.objectContaining({
        id: approval.id,
        params: { title: "Sensitive approval title" },
      }),
    ]);
    await expect(runtime.approvals.approve({
      approvalId: approval.id,
      actorUserId: "other_user",
      now: now + 1,
    })).rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    await runtime.approvals.approve({
      approvalId: approval.id,
      actorUserId: "execution_owner",
      now: now + 1,
    });
    await expect(runtime.approvals.claim({
      approvalId: approval.id,
      actorUserId: "execution_owner",
      principalKey: "web:execution_owner",
      now: now + 2,
    })).resolves.toMatchObject({ status: "executing" });
    await expect(runtime.approvals.claim({
      approvalId: approval.id,
      actorUserId: "execution_owner",
      principalKey: "web:execution_owner",
      now: now + 3,
    })).rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });

    const client = new Client({ connectionString: connectionString! });
    await client.connect();
    try {
      const raw = await client.query<{ encoded: string }>(
        `SELECT encode(params_ciphertext, 'hex') AS encoded
         FROM omr_control.execution_approvals WHERE id = $1`,
        [approval.id],
      );
      expect(raw.rows[0]?.encoded).not.toContain("Sensitive approval title");
    } finally {
      await client.end();
    }
  });
});
