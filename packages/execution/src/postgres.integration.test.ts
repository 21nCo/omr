import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { EXECUTION_STALE_AFTER_MS, type ExecutionReceipt } from "./execution.js";
import type { ExecutionApproval } from "./execution.js";
import {
  connectPostgresExecutionReceipts,
  type PostgresExecutionReceiptRuntime,
} from "./postgres.js";
import { PostgresOwnedQueries } from "./postgres-owned-query.js";

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
      `INSERT INTO omr_control.workspace_memberships (id, workspace_id, user_id, role, created_at, updated_at)
       VALUES ($1, $2, 'execution_owner', 'member', $3, $3)`,
      [`membership_${crypto.randomUUID()}`, workspaceId, now],
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

  afterEach(async () => {
    const client = new Client({ connectionString: connectionString! });
    await client.connect();
    try {
      await client.query("DELETE FROM omr_control.execution_approvals WHERE workspace_id = $1", [workspaceId]);
      await client.query("DELETE FROM omr_control.execution_receipts WHERE workspace_id = $1", [workspaceId]);
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    await runtime.close();
    const client = new Client({ connectionString: connectionString! });
    await client.connect();
    try {
      await client.query("DELETE FROM omr_control.workspaces WHERE id = $1", [workspaceId]);
    } finally {
      await client.end();
    }
  });

  const approvalFixture = (now: number, overrides: Partial<ExecutionApproval> = {}): ExecutionApproval => ({
    id: `approval_${crypto.randomUUID()}`, workspaceId, actorUserId: "execution_owner",
    principalKey: "web:execution_owner", toolId: "linear.create_issue",
    manifestHash: `sha256-${"d".repeat(64)}`, connectionId,
    providerConnectionId: `plug_${crypto.randomUUID()}`, params: {},
    idempotencyKey: `approval_${crypto.randomUUID()}`, status: "pending",
    approvedBy: null, decidedAt: null, expiresAt: now + 60_000,
    executionReceiptId: null, createdAt: now, updatedAt: now,
    ...overrides,
  });

  const receiptFixture = (approval: ExecutionApproval, now: number,
    overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt => ({
    id: `execution_${crypto.randomUUID()}`, workspaceId: approval.workspaceId,
    actorUserId: approval.actorUserId, principalKey: approval.principalKey,
    toolId: approval.toolId, manifestHash: approval.manifestHash,
    connectionId: approval.connectionId, providerConnectionId: approval.providerConnectionId,
    idempotencyKey: approval.idempotencyKey, requestHash: `sha256-${"f".repeat(64)}`,
    approvalId: approval.id, status: "reserved", result: null, errorCode: null,
    startedAt: now, completedAt: null, createdAt: now, updatedAt: now,
    ...overrides,
  });

  it("fences concurrent Linear approval keys until an uncertain receipt is reconciled", async () => {
    const now = Date.now();
    const intentHash = `hmac-sha256-${"e".repeat(64)}`;
    const first = approvalFixture(now, { toolId: "linear.issues.create", intentHash,
      providerConnectionId: "remote_linear_one" });
    const second = approvalFixture(now, { toolId: first.toolId, intentHash,
      providerConnectionId: first.providerConnectionId });
    const [a, b] = await Promise.all([runtime.approvals.create(first), runtime.approvals.create(second)]);
    expect(a.id).toBe(b.id);
    await runtime.approvals.approve({ approvalId: a.id, actorUserId: a.actorUserId, now: now + 1 });
    await runtime.approvals.claim({ approvalId: a.id, actorUserId: a.actorUserId,
      principalKey: a.principalKey, now: now + 2, deadlineAt: Date.now() + 2_000 });
    const receipt = receiptFixture(a, now);
    await runtime.receipts.reserve(receipt);
    await runtime.receipts.beginDispatch(receipt.id, now + 3);
    await runtime.receipts.uncertain(receipt.id, "provider_outcome_unknown", now + 4);
    await runtime.approvals.uncertain({ approvalId: a.id, receiptId: receipt.id, now: now + 5 });
    const fresh = approvalFixture(now + 6, { toolId: a.toolId, intentHash,
      providerConnectionId: a.providerConnectionId });
    expect((await runtime.approvals.create(fresh)).id).toBe(a.id);
    await expect(runtime.approvals.reconcile({ approvalId: a.id, actorUserId: "wrong_actor",
      principalKey: a.principalKey, decision: "effect_absent", now: now + 7 }))
      .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    const reconciled = await runtime.approvals.reconcile({ approvalId: a.id,
      actorUserId: a.actorUserId, principalKey: a.principalKey,
      decision: "effect_absent", now: now + 8 });
    expect(reconciled).toMatchObject({ status: "failed", reconciledAs: "effect_absent" });
    expect((await runtime.approvals.create(fresh)).id).toBe(fresh.id);
    expect((await runtime.receipts.findByIdempotency({ workspaceId,
      principalKey: a.principalKey, idempotencyKey: a.idempotencyKey }))?.status).toBe("uncertain");
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
      status: "reserved",
      result: null,
      errorCode: null,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await expect(runtime.receipts.reserve(receipt)).resolves.toMatchObject({ created: true });
    await expect(runtime.receipts.reserve({ ...receipt, id: `execution_${crypto.randomUUID()}` }))
      .resolves.toMatchObject({ created: false, receipt: { id: receipt.id, status: "reserved" } });
    await runtime.receipts.beginDispatch(receipt.id, now);
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

  it("authenticates PostgreSQL ciphertext against its exact row and workspace", async () => {
    const now = Date.now();
    const approvals = [0, 1].map(() => approvalFixture(now, {
      manifestHash: `sha256-${"a".repeat(64)}`, params: { secret: "approval-secret" },
    }));
    await Promise.all(approvals.map((approval) => runtime.approvals.create(approval)));
    const observer = new Client({ connectionString: connectionString! });
    await observer.connect();
    const original = await observer.query<{ params_ciphertext: Buffer; params_iv: Buffer }>(
      `SELECT params_ciphertext, params_iv FROM omr_control.execution_approvals WHERE id = $1`,
      [approvals[1]!.id]);
    try {
      await observer.query(`UPDATE omr_control.execution_approvals AS target
        SET params_ciphertext = source.params_ciphertext, params_iv = source.params_iv
        FROM omr_control.execution_approvals AS source
        WHERE target.id = $1 AND source.id = $2`, [approvals[1]!.id, approvals[0]!.id]);
      await expect(runtime.approvals.getForActor(approvals[1]!.id, "execution_owner"))
        .rejects.toThrow();
      await expect(runtime.approvals.getForActor(approvals[0]!.id, "execution_owner"))
        .resolves.toMatchObject({ params: { secret: "approval-secret" } });
    } finally {
      await observer.query(`UPDATE omr_control.execution_approvals
        SET params_ciphertext = $2, params_iv = $3 WHERE id = $1`,
      [approvals[1]!.id, original.rows[0]!.params_ciphertext, original.rows[0]!.params_iv]);
      await observer.end();
    }
  });

  it("atomically commits approved result and consumption after a lock timeout retry", async () => {
    const now = Date.now();
    const approval = approvalFixture(now, { manifestHash: `sha256-${"b".repeat(64)}` });
    await runtime.approvals.create(approval);
    await runtime.approvals.approve({ approvalId: approval.id,
      actorUserId: "execution_owner", now: now + 1 });
    await runtime.approvals.claim({ approvalId: approval.id,
      actorUserId: "execution_owner", principalKey: approval.principalKey,
      now: now + 2, deadlineAt: Date.now() + 1_000 });
    const receipt = receiptFixture(approval, now, { requestHash: `sha256-${"c".repeat(64)}` });
    await runtime.receipts.reserve(receipt);
    await runtime.receipts.beginDispatch(receipt.id, now + 3);
    const observer = new Client({ connectionString: connectionString! });
    await observer.connect();
    try {
      await observer.query("BEGIN");
      await observer.query(`SELECT id FROM omr_control.execution_approvals
        WHERE id = $1 FOR UPDATE`, [approval.id]);
      await expect(runtime.approvals.succeedWithReceipt({ approvalId: approval.id,
        receipt, result: { id: "confirmed" }, now: now + 4, deadlineAt: Date.now() + 80 }))
        .rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
      await observer.query("ROLLBACK");
      const before = await observer.query<{ receipt_status: string; approval_status: string }>(
        `SELECT receipt.status AS receipt_status, approval.status AS approval_status
         FROM omr_control.execution_receipts AS receipt
         JOIN omr_control.execution_approvals AS approval ON approval.id = receipt.approval_id
         WHERE receipt.id = $1`, [receipt.id]);
      expect(before.rows[0]).toEqual({ receipt_status: "running", approval_status: "executing" });
      await expect(runtime.approvals.succeedWithReceipt({ approvalId: approval.id,
        receipt, result: { id: "confirmed" }, now: now + 5, deadlineAt: Date.now() + 2_000 }))
        .resolves.toMatchObject({ status: "succeeded", result: { id: "confirmed" } });
      const after = await observer.query<{ receipt_status: string; approval_status: string }>(
        `SELECT receipt.status AS receipt_status, approval.status AS approval_status
         FROM omr_control.execution_receipts AS receipt
         JOIN omr_control.execution_approvals AS approval ON approval.id = receipt.approval_id
         WHERE receipt.id = $1`, [receipt.id]);
      expect(after.rows[0]).toEqual({ receipt_status: "succeeded", approval_status: "consumed" });
      await expect(runtime.receipts.findByIdempotency({ workspaceId,
        principalKey: approval.principalKey, idempotencyKey: approval.idempotencyKey }))
        .resolves.toMatchObject({ id: receipt.id, result: { id: "confirmed" } });
    } finally {
      await observer.query("ROLLBACK").catch(() => undefined);
      await observer.end();
    }
  }, 15_000);

  it("does not restart an expired invocation while completing an approved receipt", async () => {
    const now = Date.now();
    const approval = approvalFixture(now);
    await runtime.approvals.create(approval);
    await runtime.approvals.approve({ approvalId: approval.id,
      actorUserId: "execution_owner", now: now + 1 });
    await runtime.approvals.claim({ approvalId: approval.id,
      actorUserId: "execution_owner", principalKey: approval.principalKey,
      now: now + 2, deadlineAt: Date.now() + 1_000 });
    const receipt = receiptFixture(approval, now);
    await runtime.receipts.reserve(receipt);
    await runtime.receipts.beginDispatch(receipt.id, now + 3);
    const started = Date.now();
    await expect(runtime.approvals.succeedWithReceipt({ approvalId: approval.id,
      receipt, result: { id: "late" }, now: now + 4, deadlineAt: started - 1 }))
      .rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(1_000);
    const observer = new Client({ connectionString: connectionString! });
    await observer.connect();
    try {
      const state = await observer.query<{ receipt_status: string; approval_status: string }>(
        `SELECT receipt.status AS receipt_status, approval.status AS approval_status
         FROM omr_control.execution_receipts AS receipt
         JOIN omr_control.execution_approvals AS approval ON approval.id = receipt.approval_id
         WHERE receipt.id = $1`, [receipt.id]);
      expect(state.rows[0]).toEqual({ receipt_status: "running", approval_status: "executing" });
    } finally {
      await observer.end();
    }
  });

  it("atomically binds encrypted approval parameters to one actor and principal", async () => {
    const now = Date.now();
    const approval = approvalFixture(now, { manifestHash: `sha256-${"c".repeat(64)}`,
      params: { title: "Sensitive approval title" } });
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
      deadlineAt: Date.now() + 1_000,
    })).resolves.toMatchObject({ status: "executing" });
    await expect(runtime.approvals.claim({
      approvalId: approval.id,
      actorUserId: "execution_owner",
      principalKey: "web:execution_owner",
      now: now + 3,
      deadlineAt: Date.now() + 1_000,
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

  it("times out an approved claim behind a membership lock and permits a safe retry", async () => {
    const now = Date.now();
    const approval = approvalFixture(now);
    await runtime.approvals.create(approval);
    await runtime.approvals.approve({ approvalId: approval.id,
      actorUserId: "execution_owner", now: now + 1 });
    const revoker = new Client({ connectionString: connectionString! });
    await revoker.connect();
    try {
      await revoker.query("BEGIN");
      await revoker.query(`SELECT id FROM omr_control.workspace_memberships
        WHERE workspace_id = $1 AND user_id = 'execution_owner' FOR UPDATE`, [workspaceId]);
      await expect(runtime.approvals.claim({ approvalId: approval.id,
        actorUserId: "execution_owner", principalKey: "web:execution_owner",
        now: now + 2, deadlineAt: Date.now() + 80 }))
        .rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
      await revoker.query("ROLLBACK");
      await expect(runtime.approvals.claim({ approvalId: approval.id,
        actorUserId: "execution_owner", principalKey: "web:execution_owner",
        now: now + 3, deadlineAt: Date.now() + 1_000 }))
        .resolves.toMatchObject({ status: "executing" });
      const observer = new Client({ connectionString: connectionString! });
      await observer.connect();
      try {
        await observer.query(`UPDATE omr_control.execution_approvals SET updated_at = $2
          WHERE id = $1`, [approval.id, Date.now() - EXECUTION_STALE_AFTER_MS - 5_000]);
        await expect(runtime.approvals.claim({ approvalId: approval.id,
          actorUserId: "execution_owner", principalKey: "web:execution_owner",
          now: Date.now(), deadlineAt: Date.now() + 1_000 }))
          .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
        const state = await observer.query<{ status: string }>(
          `SELECT status FROM omr_control.execution_approvals WHERE id = $1`, [approval.id]);
        expect(state.rows[0]?.status).toBe("failed");
      } finally {
        await observer.end();
      }
    } finally {
      await revoker.query("ROLLBACK").catch(() => undefined);
      await revoker.end();
    }
  });

  it("keeps a stale claimed approval uncertain when its receipt may have dispatched", async () => {
    const now = Date.now();
    const approval = approvalFixture(now, { manifestHash: `sha256-${"e".repeat(64)}` });
    await runtime.approvals.create(approval);
    await runtime.approvals.approve({ approvalId: approval.id,
      actorUserId: "execution_owner", now: now + 1 });
    await runtime.approvals.claim({ approvalId: approval.id,
      actorUserId: "execution_owner", principalKey: "web:execution_owner",
      now: now + 2, deadlineAt: Date.now() + 1_000 });
    const receipt = receiptFixture(approval, now);
    await runtime.receipts.reserve(receipt);
    await runtime.receipts.beginDispatch(receipt.id, now + 3);

    const observer = new Client({ connectionString: connectionString! });
    await observer.connect();
    try {
      await observer.query(`UPDATE omr_control.execution_approvals SET updated_at = $2
        WHERE id = $1`, [approval.id, Date.now() - EXECUTION_STALE_AFTER_MS - 5_000]);
      await expect(runtime.approvals.claim({ approvalId: approval.id,
        actorUserId: "execution_owner", principalKey: "web:execution_owner",
        now: Date.now(), deadlineAt: Date.now() + 1_000 }))
        .rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: receipt.id });
      const state = await observer.query<{ status: string; execution_receipt_id: string }>(
        `SELECT status, execution_receipt_id FROM omr_control.execution_approvals WHERE id = $1`,
        [approval.id]);
      expect(state.rows[0]).toMatchObject({ status: "uncertain", execution_receipt_id: receipt.id });
      const effect = await observer.query<{ status: string; error_code: string }>(
        `SELECT status, error_code FROM omr_control.execution_receipts WHERE id = $1`, [receipt.id]);
      expect(effect.rows[0]).toMatchObject({ status: "uncertain", error_code: "stale_approval" });
    } finally {
      await observer.end();
    }
  });

  it("gives concurrent stale claimers the same settled receipt after an approval-lock race", async () => {
    const now = Date.now();
    const approval = approvalFixture(now);
    await runtime.approvals.create(approval);
    await runtime.approvals.approve({ approvalId: approval.id,
      actorUserId: approval.actorUserId, now: now + 1 });
    await runtime.approvals.claim({ approvalId: approval.id, actorUserId: approval.actorUserId,
      principalKey: approval.principalKey, now: now + 2, deadlineAt: Date.now() + 1_000 });
    const receipt = receiptFixture(approval, now);
    await runtime.receipts.reserve(receipt);
    await runtime.receipts.beginDispatch(receipt.id, now + 3);
    const blocker = new Client({ connectionString: connectionString! });
    const observer = new Client({ connectionString: connectionString! });
    await blocker.connect();
    await observer.connect();
    try {
      await observer.query(`UPDATE omr_control.execution_approvals SET updated_at = $2
        WHERE id = $1`, [approval.id, Date.now() - EXECUTION_STALE_AFTER_MS - 5_000]);
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM omr_control.execution_receipts WHERE id = $1 FOR UPDATE", [receipt.id]);
      const claim = () => runtime.approvals.claim({ approvalId: approval.id,
        actorUserId: approval.actorUserId, principalKey: approval.principalKey,
        now: Date.now(), deadlineAt: Date.now() + 5_000 });
      const first = claim();
      const second = claim();
      await vi.waitFor(async () => {
        const waiting = await observer.query<{ count: string }>(
          `SELECT count(*) FROM pg_stat_activity
           WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
             AND (query LIKE 'SELECT receipt.id, receipt.status%'
               OR query LIKE 'SELECT approval.id%')`);
        expect(Number(waiting.rows[0]?.count)).toBeGreaterThanOrEqual(2);
      }, { timeout: 3_000, interval: 20 });
      await blocker.query("ROLLBACK");
      const results = await Promise.allSettled([first, second]);
      for (const result of results) {
        expect(result).toMatchObject({ status: "rejected", reason: {
          code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: receipt.id,
        } });
      }
      const state = await observer.query<{ approval_status: string; execution_receipt_id: string;
        receipt_status: string }>(
        `SELECT approval.status AS approval_status, approval.execution_receipt_id,
           receipt.status AS receipt_status
         FROM omr_control.execution_approvals AS approval
         JOIN omr_control.execution_receipts AS receipt ON receipt.approval_id = approval.id
         WHERE approval.id = $1`, [approval.id]);
      expect(state.rows[0]).toEqual({ approval_status: "uncertain",
        execution_receipt_id: receipt.id, receipt_status: "uncertain" });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
      await observer.end();
    }
  });

  it("exposes a committed completion to a second replay client after its earlier running read", async () => {
    const now = Date.now();
    const approval = approvalFixture(now);
    await runtime.approvals.create(approval);
    await runtime.approvals.approve({ approvalId: approval.id,
      actorUserId: approval.actorUserId, now: now + 1 });
    await runtime.approvals.claim({ approvalId: approval.id, actorUserId: approval.actorUserId,
      principalKey: approval.principalKey, now: now + 2, deadlineAt: Date.now() + 2_000 });
    const receipt = receiptFixture(approval, now);
    await runtime.receipts.reserve(receipt);
    await runtime.receipts.beginDispatch(receipt.id, now + 3);
    const prior = await runtime.receipts.findByIdempotency({ workspaceId: approval.workspaceId,
      principalKey: approval.principalKey, idempotencyKey: approval.idempotencyKey });
    expect(prior).toMatchObject({ id: receipt.id, status: "running" });

    const producer = await connectPostgresExecutionReceipts({
      connectionString: connectionString!, resultWrappingKey: new Uint8Array(WRAPPING_KEY),
    });
    try {
      await producer.approvals.succeedWithReceipt({ approvalId: approval.id, receipt: prior!,
        result: { id: "committed_issue" }, now: Date.now(), deadlineAt: Date.now() + 3_000 });
      await expect(runtime.approvals.claim({ approvalId: approval.id,
        actorUserId: approval.actorUserId, principalKey: approval.principalKey,
        now: Date.now(), deadlineAt: Date.now() + 2_000 }))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      const settled = await runtime.approvals.getForActor(approval.id, approval.actorUserId);
      const current = await runtime.receipts.findByIdempotency({ workspaceId: approval.workspaceId,
        principalKey: approval.principalKey, idempotencyKey: approval.idempotencyKey });
      expect(settled).toMatchObject({ status: "consumed", executionReceiptId: receipt.id });
      expect(current).toMatchObject({ id: receipt.id, status: "succeeded",
        result: { id: "committed_issue" } });
    } finally {
      await producer.close();
    }
  });

  it("does not claim an approval that expires behind a membership lock", async () => {
    const now = Date.now();
    const approval = approvalFixture(now, { expiresAt: now + 300 });
    await runtime.approvals.create(approval);
    await runtime.approvals.approve({ approvalId: approval.id,
      actorUserId: "execution_owner", now: now + 1 });
    const revoker = new Client({ connectionString: connectionString! });
    await revoker.connect();
    try {
      await revoker.query("BEGIN");
      await revoker.query(`SELECT id FROM omr_control.workspace_memberships
        WHERE workspace_id = $1 AND user_id = 'execution_owner' FOR UPDATE`, [workspaceId]);
      const claim = runtime.approvals.claim({ approvalId: approval.id,
        actorUserId: "execution_owner", principalKey: "web:execution_owner",
        now: now + 2, deadlineAt: Date.now() + 2_000 });
      await new Promise((resolve) => setTimeout(resolve, 350));
      await revoker.query("ROLLBACK");
      await expect(claim).rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    } finally {
      await revoker.query("ROLLBACK").catch(() => undefined);
      await revoker.end();
    }
  });

  it("does not claim an approval that expires while opening its connection", async () => {
    const now = Date.now();
    const approval = approvalFixture(now, { expiresAt: now + 300 });
    await runtime.approvals.create(approval);
    await runtime.approvals.approve({ approvalId: approval.id,
      actorUserId: "execution_owner", now: now + 1 });
    const originalConnect = Client.prototype.connect;
    vi.spyOn(Client.prototype, "connect").mockImplementation(async function (this: Client) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return originalConnect.call(this);
    });
    try {
      await expect(runtime.approvals.claim({ approvalId: approval.id,
        actorUserId: "execution_owner", principalKey: "web:execution_owner",
        now: now + 2, deadlineAt: Date.now() + 2_000 }))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("reconciles only an exact approval receipt and its effect-bearing status", async () => {
    const observer = new Client({ connectionString: connectionString! });
    await observer.connect();
    try {
      const scenarios = ["reserved", "failed", "running", "succeeded", "uncertain"] as const;
      for (const association of ["exact", "legacy", "foreign", "wrong-operation"] as const) {
        for (const status of scenarios) {
          const now = Date.now();
          const approval = approvalFixture(now);
          await runtime.approvals.create(approval);
          await runtime.approvals.approve({ approvalId: approval.id,
            actorUserId: "execution_owner", now: now + 1 });
          await runtime.approvals.claim({ approvalId: approval.id,
            actorUserId: "execution_owner", principalKey: "web:execution_owner",
            now: now + 2, deadlineAt: Date.now() + 2_000 });
          let associatedApprovalId: string | null = approval.id;
          if (association === "legacy") associatedApprovalId = null;
          if (association === "foreign") associatedApprovalId = `approval_foreign_${crypto.randomUUID()}`;
          const receipt = receiptFixture(approval, now, {
            toolId: association === "wrong-operation" ? "linear.other" : approval.toolId,
            approvalId: associatedApprovalId,
          });
          await runtime.receipts.reserve(receipt);
          if (["running", "succeeded", "uncertain"].includes(status)) {
            await runtime.receipts.beginDispatch(receipt.id, now + 3);
          }
          if (status === "failed") await runtime.receipts.fail(receipt.id, "predispatch", now + 3);
          if (status === "succeeded") await runtime.receipts.succeed(receipt.id, {}, now + 4);
          if (status === "uncertain") await runtime.receipts.uncertain(receipt.id, "provider_outcome_unknown", now + 4);
          if (association !== "exact") {
            await expect(runtime.approvals.consume({ approvalId: approval.id,
              receiptId: receipt.id, now: now + 5 })).rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
            await expect(runtime.approvals.uncertain({ approvalId: approval.id,
              receiptId: receipt.id, now: now + 5 })).rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
          } else if (status === "succeeded") {
            await expect(runtime.approvals.consume({ approvalId: approval.id,
              receiptId: receipt.id, now: now + 5 })).resolves.toMatchObject({
                status: "consumed", executionReceiptId: receipt.id });
            await observer.query(`UPDATE omr_control.execution_approvals
              SET status = 'executing', execution_receipt_id = NULL WHERE id = $1`, [approval.id]);
          } else if (status === "running") {
            await expect(runtime.approvals.uncertain({ approvalId: approval.id,
              receiptId: receipt.id, now: now + 5 })).resolves.toMatchObject({
                status: "uncertain", executionReceiptId: receipt.id });
            await observer.query(`UPDATE omr_control.execution_approvals
              SET status = 'executing', execution_receipt_id = NULL WHERE id = $1`, [approval.id]);
          }
          await observer.query(`UPDATE omr_control.execution_approvals
            SET status = 'uncertain', execution_receipt_id = $2 WHERE id = $1`, [approval.id, receipt.id]);
          const exactEffect = association === "exact" &&
            ["running", "succeeded", "uncertain"].includes(status);
          await expect(runtime.approvals.claim({ approvalId: approval.id,
            actorUserId: "execution_owner", principalKey: "web:execution_owner",
            now: Date.now(), deadlineAt: Date.now() + 2_000 })).rejects.toMatchObject(exactEffect
            ? { code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: receipt.id }
            : { code: "APPROVAL_UNAVAILABLE" });
          await observer.query(`UPDATE omr_control.execution_approvals
            SET status = 'executing', execution_receipt_id = NULL WHERE id = $1`, [approval.id]);
          await expect(runtime.approvals.claim({ approvalId: approval.id,
            actorUserId: "execution_owner", principalKey: "web:execution_owner",
            now: Date.now(), deadlineAt: Date.now() + 2_000 }))
            .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
          const fresh = await observer.query<{ status: string; execution_receipt_id: string | null }>(
            `SELECT status, execution_receipt_id FROM omr_control.execution_approvals WHERE id = $1`,
            [approval.id]);
          expect(fresh.rows[0]).toEqual({ status: "executing", execution_receipt_id: null });
          await observer.query(`UPDATE omr_control.execution_approvals SET updated_at = $2
            WHERE id = $1`, [approval.id, Date.now() - EXECUTION_STALE_AFTER_MS - 5_000]);
          const expected = exactEffect
            ? { code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: receipt.id }
            : { code: "APPROVAL_UNAVAILABLE" };
          await expect(runtime.approvals.claim({ approvalId: approval.id,
            actorUserId: "execution_owner", principalKey: "web:execution_owner",
            now: Date.now(), deadlineAt: Date.now() + 2_000 })).rejects.toMatchObject(expected);
          const state = await observer.query<{ status: string; execution_receipt_id: string | null }>(
            `SELECT status, execution_receipt_id FROM omr_control.execution_approvals WHERE id = $1`,
            [approval.id]);
          expect(state.rows[0]).toMatchObject(exactEffect
            ? { status: "uncertain", execution_receipt_id: receipt.id }
            : { status: "failed", execution_receipt_id: null });
          const receiptState = await observer.query<{ status: string; error_code: string | null;
            completed_at: string | null }>(
            `SELECT status, error_code, completed_at FROM omr_control.execution_receipts WHERE id = $1`,
            [receipt.id]);
          expect(receiptState.rows[0]).toMatchObject(association === "exact" && status === "reserved"
            ? { status: "failed", error_code: "reservation_expired",
              completed_at: expect.anything() }
            : association === "exact" && status === "running"
              ? { status: "uncertain", error_code: "stale_approval",
                completed_at: expect.anything() }
            : { status, error_code: status === "failed" ? "predispatch" :
              status === "uncertain" ? "provider_outcome_unknown" : null });
        }
      }
    } finally {
      await observer.end();
    }
  });

  it("rolls back a locked stale reservation and settles both rows on retry", async () => {
    const now = Date.now();
    const approval = approvalFixture(now);
    await runtime.approvals.create(approval);
    await runtime.approvals.approve({ approvalId: approval.id,
      actorUserId: "execution_owner", now: now + 1 });
    await runtime.approvals.claim({ approvalId: approval.id,
      actorUserId: "execution_owner", principalKey: approval.principalKey,
      now: now + 2, deadlineAt: Date.now() + 2_000 });
    const receipt = receiptFixture(approval, now);
    await runtime.receipts.reserve(receipt);
    const observer = new Client({ connectionString: connectionString! });
    await observer.connect();
    const monitor = new Client({ connectionString: connectionString! });
    await monitor.connect();
    const appName = `omr_stale_${crypto.randomUUID().replaceAll("-", "")}`;
    const url = new URL(connectionString!);
    url.searchParams.set("application_name", appName);
    const isolated = await connectPostgresExecutionReceipts({
      connectionString: url.toString(), resultWrappingKey: new Uint8Array(WRAPPING_KEY),
    });
    try {
      await observer.query(`UPDATE omr_control.execution_approvals SET updated_at = $2 WHERE id = $1`,
        [approval.id, now - EXECUTION_STALE_AFTER_MS - 5_000]);
      await observer.query("BEGIN");
      await observer.query("SELECT id FROM omr_control.execution_receipts WHERE id = $1 FOR UPDATE",
        [receipt.id]);
      const pending = isolated.approvals.claim({ approvalId: approval.id,
        actorUserId: "execution_owner", principalKey: approval.principalKey,
        now: Date.now(), deadlineAt: Date.now() + 1_000 }).catch((error: unknown) => error);
      await vi.waitFor(async () => {
        const state = await monitor.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_stat_activity
           WHERE left(application_name, length($1) + 1) = $1 || ':' AND wait_event_type = 'Lock'
             AND query LIKE '%FROM omr_control.execution_receipts AS receipt%'`, [appName]);
        expect(Number(state.rows[0]?.count)).toBeGreaterThan(0);
      }, { timeout: 2_000 });
      expect(await pending).toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
      await observer.query("ROLLBACK");
      const before = await observer.query<{ approval_status: string; receipt_status: string }>(
        `SELECT approval.status AS approval_status, receipt.status AS receipt_status
         FROM omr_control.execution_approvals AS approval
         JOIN omr_control.execution_receipts AS receipt ON receipt.approval_id = approval.id
         WHERE approval.id = $1`, [approval.id]);
      expect(before.rows[0]).toEqual({ approval_status: "executing", receipt_status: "reserved" });
      await observer.query("BEGIN");
      await observer.query("SELECT id FROM omr_control.execution_receipts WHERE id = $1 FOR UPDATE",
        [receipt.id]);
      const closingClaim = isolated.approvals.claim({ approvalId: approval.id,
        actorUserId: "execution_owner", principalKey: approval.principalKey,
        now: Date.now(), deadlineAt: Date.now() + 5_000 }).catch((error: unknown) => error);
      await vi.waitFor(async () => {
        const state = await monitor.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_stat_activity
           WHERE left(application_name, length($1) + 1) = $1 || ':' AND wait_event_type = 'Lock'
             AND query LIKE '%FROM omr_control.execution_receipts AS receipt%'`, [appName]);
        expect(Number(state.rows[0]?.count)).toBeGreaterThan(0);
      }, { timeout: 2_000 });
      await isolated.close();
      expect(await closingClaim).toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
      await vi.waitFor(async () => {
        const state = await monitor.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_stat_activity
           WHERE left(application_name, length($1) + 1) = $1 || ':'`,
          [appName]);
        expect(Number(state.rows[0]?.count)).toBe(0);
      }, { timeout: 2_000 });
      await observer.query("ROLLBACK");
      await expect(runtime.approvals.claim({ approvalId: approval.id,
        actorUserId: "execution_owner", principalKey: approval.principalKey,
        now: Date.now(), deadlineAt: Date.now() + 2_000 }))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      const after = await observer.query<{ approval_status: string; receipt_status: string;
        error_code: string }>(
        `SELECT approval.status AS approval_status, receipt.status AS receipt_status,
           receipt.error_code FROM omr_control.execution_approvals AS approval
         JOIN omr_control.execution_receipts AS receipt ON receipt.approval_id = approval.id
         WHERE approval.id = $1`, [approval.id]);
      expect(after.rows[0]).toEqual({ approval_status: "failed", receipt_status: "failed",
        error_code: "reservation_expired" });
    } finally {
      await observer.query("ROLLBACK").catch(() => undefined);
      await isolated.close();
      await monitor.end();
      await observer.end();
    }
  }, 15_000);

  it("closes a guard waiting on a real membership lock and leaves no backend", async () => {
    const appName = `omr_guard_${crypto.randomUUID().replaceAll("-", "")}`;
    const url = new URL(connectionString!);
    url.searchParams.set("application_name", appName);
    const isolated = await connectPostgresExecutionReceipts({
      connectionString: url.toString(), resultWrappingKey: new Uint8Array(WRAPPING_KEY),
    });
    const observer = new Client({ connectionString: connectionString! });
    await observer.connect();
    const monitor = new Client({ connectionString: connectionString! });
    await monitor.connect();
    const invoke = vi.fn(async () => "effect");
    try {
      await observer.query("BEGIN");
      await observer.query(`UPDATE omr_control.workspace_memberships SET role = role
        WHERE workspace_id = $1 AND user_id = 'execution_owner'`, [workspaceId]);
      const pending = isolated.invocationGuard.runIdentity!({
        principal: { kind: "web", userId: "execution_owner", workspaceId,
          sessionId: "unused_session" }, capability: "tools:write",
        deadlineAt: Date.now() + 5_000,
      }, invoke).catch((error: unknown) => error);
      await vi.waitFor(async () => {
        const state = await monitor.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_stat_activity
           WHERE left(application_name, length($1) + 1) = $1 || ':'
             AND wait_event_type = 'Lock'`, [appName]);
        expect(Number(state.rows[0]?.count)).toBeGreaterThan(0);
      }, { timeout: 2_000 });
      await isolated.close();
      expect(await pending).toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
      await expect(isolated.invocationGuard.runIdentity!({
        principal: { kind: "web", userId: "execution_owner", workspaceId },
        capability: "tools:write", deadlineAt: Date.now() + 2_000,
      }, invoke)).rejects.toThrow(/closed/);
      await vi.waitFor(async () => {
        const state = await monitor.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_stat_activity
           WHERE left(application_name, length($1) + 1) = $1 || ':'`,
          [appName]);
        expect(Number(state.rows[0]?.count)).toBe(0);
      }, { timeout: 2_000 });
      expect(invoke).not.toHaveBeenCalled();
      const healthy = await connectPostgresExecutionReceipts({
        connectionString: connectionString!, resultWrappingKey: new Uint8Array(WRAPPING_KEY),
      });
      try {
        await expect(healthy.receipts.findByIdempotency({ workspaceId,
          principalKey: "web:execution_owner", idempotencyKey: "after-guard-close" }))
          .resolves.toBeNull();
      } finally {
        await healthy.close();
      }
    } finally {
      await observer.query("ROLLBACK").catch(() => undefined);
      await isolated.close();
      await monitor.end();
      await observer.end();
    }
  }, 15_000);

  it("releases dedicated PostgreSQL sockets after concurrent failed claims", async () => {
    const applicationName = `omr_claim_${crypto.randomUUID().replaceAll("-", "")}`;
    const url = new URL(connectionString!);
    url.searchParams.set("application_name", applicationName);
    const isolated = await connectPostgresExecutionReceipts({
      connectionString: url.toString(), resultWrappingKey: new Uint8Array(WRAPPING_KEY),
    });
    const observer = new Client({ connectionString: connectionString! });
    await observer.connect();
    try {
      const count = async () => Number((await observer.query<{ count: string }>(
        `SELECT count(*) FROM pg_stat_activity
         WHERE left(application_name, length($1) + 1) = $1 || ':'`, [applicationName])).rows[0]?.count);
      expect(await count()).toBe(0);
      const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) =>
        isolated.approvals.claim({ approvalId: `missing_${index}`, actorUserId: "execution_owner",
          principalKey: "web:execution_owner", now: Date.now(), deadlineAt: Date.now() + 3_000 })));
      expect(results.every((result) => result.status === "rejected" &&
        (result.reason as { code?: string }).code === "APPROVAL_UNAVAILABLE")).toBe(true);
      expect(await count()).toBe(0);
    } finally {
      await isolated.close();
      await observer.end();
    }
  });

  it("bounds live owned-query sockets under concurrent PostgreSQL load", async () => {
    const applicationName = `omr_store_${crypto.randomUUID().replaceAll("-", "")}`;
    const url = new URL(connectionString!);
    url.searchParams.set("application_name", applicationName);
    const owned = new PostgresOwnedQueries(url.toString());
    const observer = new Client({ connectionString: connectionString! });
    await observer.connect();
    const count = async () => Number((await observer.query<{ count: string }>(
      "SELECT count(*) FROM pg_stat_activity WHERE application_name = $1",
      [applicationName])).rows[0]?.count);
    try {
      expect(await count()).toBe(0);
      let settled = false;
      const pending = Promise.all(Array.from({ length: 24 }, () =>
        owned.query("SELECT pg_sleep(0.1)", [], Date.now() + 5_000))).finally(() => { settled = true; });
      let peak = 0;
      while (!settled) {
        peak = Math.max(peak, await count());
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await pending;
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(8);
      await owned.close();
      expect(await count()).toBe(0);
    } finally {
      await owned.close();
      await observer.end();
    }
  });

  it("cancels a lock-stalled receipt write without poisoning the runtime's next store call", async () => {
    const now = Date.now();
    const approval = approvalFixture(now);
    await runtime.approvals.create(approval);
    const receipt = receiptFixture(approval, now);
    await runtime.receipts.reserve(receipt);
    await runtime.receipts.beginDispatch(receipt.id, now + 1);
    const blocker = new Client({ connectionString: connectionString! });
    const observer = new Client({ connectionString: connectionString! });
    await blocker.connect();
    await observer.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM omr_control.execution_receipts WHERE id = $1 FOR UPDATE", [receipt.id]);
      const pending = runtime.receipts.uncertain(receipt.id, "unknown", now + 2, Date.now() + 2_000);
      await vi.waitFor(async () => {
        const waiting = await observer.query<{ count: string }>(
          `SELECT count(*) FROM pg_stat_activity
           WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
             AND query LIKE 'UPDATE omr_control.execution_receipts%'`);
        expect(Number(waiting.rows[0]?.count)).toBeGreaterThan(0);
      }, { timeout: 1_500, interval: 20 });
      await expect(pending)
        .rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
      await expect(runtime.receipts.findByIdempotency({ workspaceId,
        principalKey: receipt.principalKey, idempotencyKey: receipt.idempotencyKey,
        deadlineAt: Date.now() + 2_000 })).resolves.toMatchObject({ id: receipt.id, status: "running" });
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
      await observer.end();
    }
    await expect(runtime.receipts.uncertain(receipt.id, "unknown", Date.now(), Date.now() + 1_000))
      .resolves.toMatchObject({ id: receipt.id, status: "uncertain" });
  });

  it("cancels a lock-stalled approval cleanup and preserves the associated receipt", async () => {
    const now = Date.now();
    const approval = approvalFixture(now);
    await runtime.approvals.create(approval);
    await runtime.approvals.approve({ approvalId: approval.id,
      actorUserId: approval.actorUserId, now: now + 1 });
    await runtime.approvals.claim({ approvalId: approval.id, actorUserId: approval.actorUserId,
      principalKey: approval.principalKey, now: now + 2, deadlineAt: Date.now() + 1_000 });
    const receipt = receiptFixture(approval, now);
    await runtime.receipts.reserve(receipt);
    await runtime.receipts.beginDispatch(receipt.id, now + 3);
    await runtime.receipts.uncertain(receipt.id, "unknown", now + 4);
    const blocker = new Client({ connectionString: connectionString! });
    const observer = new Client({ connectionString: connectionString! });
    await blocker.connect();
    await observer.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM omr_control.execution_approvals WHERE id = $1 FOR UPDATE", [approval.id]);
      const pending = runtime.approvals.uncertain({ approvalId: approval.id, receiptId: receipt.id,
        now: now + 5, deadlineAt: Date.now() + 2_000 });
      await vi.waitFor(async () => {
        const waiting = await observer.query<{ count: string }>(
          `SELECT count(*) FROM pg_stat_activity
           WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
             AND query LIKE 'UPDATE omr_control.execution_approvals%'`);
        expect(Number(waiting.rows[0]?.count)).toBeGreaterThan(0);
      }, { timeout: 1_500, interval: 20 });
      await expect(pending)
        .rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
      await expect(runtime.approvals.getForActor(approval.id, approval.actorUserId, Date.now() + 500))
        .resolves.toMatchObject({ status: "executing", executionReceiptId: null });
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
      await observer.end();
    }
    await expect(runtime.approvals.uncertain({ approvalId: approval.id, receiptId: receipt.id,
      now: Date.now(), deadlineAt: Date.now() + 1_000 }))
      .resolves.toMatchObject({ status: "uncertain", executionReceiptId: receipt.id });
  });
});
