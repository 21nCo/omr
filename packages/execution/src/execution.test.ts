import { describe, expect, it, vi } from "vitest";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { ConnectionAccessDeniedError, ConnectionAuthority, ConnectionSelectionRequiredError,
  ConnectionUnavailableError } from "@oh-my-router/connections";
import { MemoryConnectionBindingStore } from "@oh-my-router/connections/testing";
import { ToolCatalog, usableToolIds, type ToolEffect } from "@oh-my-router/tools";

import {
  ApprovalUnavailableError,
  ExecutionApprovalRequiredError,
  ExecutionCapabilityDeniedError,
  ExecutionIdempotencyConflictError,
  ExecutionInputError,
  ExecutionService,
  type ExecutionApproval,
  type ExecutionInvocationGuard,
  type ExecutionReceipt,
} from "./execution.js";
import { MemoryExecutionApprovalStore, MemoryExecutionReceiptStore } from "./testing.js";
import { approvalPreviewReady, publicApproval, publicReceipt } from "./projection.js";
import { deriveExecutionFingerprintKey } from "./fingerprint-key.js";
import { PostgresExecutionInvocationGuard } from "./postgres-invocation-guard.js";

async function fixture(allowedProviders?: ReadonlySet<string>, initialScopes: string[] | undefined = ["issues:read", "repo"], scopeFree = false, guard?: ExecutionInvocationGuard) {
  let now = 1_700_000_000_000;
  let grantedScopes: string[] | undefined = initialScopes;
  let remoteError: Error | null = null;
  const workspaceStore = new MemoryWorkspaceStore();
  const workspaces = new WorkspaceAuthority(workspaceStore, () => now);
  const { workspace } = await workspaces.provisionPersonalWorkspace({ userId: "user_1" });
  const connectionStore = new MemoryConnectionBindingStore(workspaceStore);
  const connections = new ConnectionAuthority(connectionStore, () => now);
  const firstBinding = await connections.attach({
    actorUserId: "user_1",
    workspaceId: workspace.id,
    provider: "linear",
    providerConnectionId: "plug_linear",
    ownership: "personal",
    label: "Linear",
  });
  const otherBinding = await connections.attach({
    actorUserId: "user_1", workspaceId: workspace.id, provider: "github",
    providerConnectionId: "plug_github", ownership: "personal", label: "GitHub",
  });
  const catalog = await ToolCatalog.create({
    providers: { list: () => [{
      name: "linear",
      displayName: "Linear",
      version: "1.0.0",
      description: "Linear",
      actions: {
        get_issue: action("get_issue", "read"),
        create_issue: action("create_issue", "write"),
        mystery: action("mystery", "unknown"),
        uncontracted: { ...action("uncontracted", "unknown"), contract: undefined },
        targeted: { ...action("targeted", "write"), contract: {
          ...action("targeted", "write").contract, resources: [{ kind: "issue", parameter: "target" }],
        } },
        secret_target: { ...action("secret_target", "write"), contract: {
          ...action("secret_target", "write").contract, resources: [{ kind: "credential", parameter: "passphrase" }],
        } },
        ...(scopeFree ? {
          no_scope_read: { ...action("no_scope_read", "read"), contract: {
            ...action("no_scope_read", "read").contract, requiredScopes: [],
          } },
          no_scope_write: { ...action("no_scope_write", "write"), contract: {
            ...action("no_scope_write", "write").contract, requiredScopes: [],
          } },
        } : {}),
      },
    }, {
      name: "github", displayName: "GitHub", version: "1.0.0", description: "GitHub",
      actions: { get_issue: action("get_issue", "read") },
    }] },
  }, (value) => value as never, allowedProviders);
  const actionCall = vi.fn(async () => ({ id: "issue_1", title: "Fixed" }));
  const receipts = new MemoryExecutionReceiptStore((workspaceId, actorUserId) =>
    [...workspaceStore.memberships.values()].some((member) =>
      member.workspaceId === workspaceId && member.userId === actorUserId));
  const approvals = new MemoryExecutionApprovalStore((workspaceId, actorUserId) =>
    [...workspaceStore.memberships.values()].some((member) =>
      member.workspaceId === workspaceId && member.userId === actorUserId), receipts);
  return {
    actionCall,
    approvals,
    catalog,
    connections,
    firstBinding,
    otherBinding,
    receipts,
    workspace,
    workspaceStore,
    setScopes(scopes: string[] | undefined) { grantedScopes = scopes; },
    setRemoteError(error: Error | null) { remoteError = error; },
    service: new ExecutionService(
      catalog,
      connections,
      { action: actionCall },
      receipts,
      async (connectionId) => {
        if (connectionId === "plug_linear" && remoteError) throw remoteError;
        return grantedScopes;
      },
      () => now,
      approvals,
      guard,
      new Uint8Array(32).fill(7),
    ),
    advance(ms: number) { now += ms; },
  };
}

let nextApprovalKey = 0;
function requestApproval(service: ExecutionService, input: Omit<Parameters<ExecutionService["requestApproval"]>[0], "idempotencyKey"> & { idempotencyKey?: string }) {
  return service.requestApproval({ ...input, idempotencyKey: input.idempotencyKey ?? `test-approval-${++nextApprovalKey}` });
}

function receiptForApproval(approval: ExecutionApproval, status: ExecutionReceipt["status"]): ExecutionReceipt {
  return {
    id: `execution_${crypto.randomUUID()}`, workspaceId: approval.workspaceId,
    actorUserId: approval.actorUserId, principalKey: approval.principalKey,
    toolId: approval.toolId, manifestHash: approval.manifestHash,
    connectionId: approval.connectionId, providerConnectionId: approval.providerConnectionId,
    idempotencyKey: approval.idempotencyKey, requestHash: approval.requestHash!,
    approvalId: approval.id, status, result: status === "succeeded" ? { id: "issue_1" } : null,
    errorCode: null, startedAt: approval.updatedAt, completedAt: null,
    createdAt: approval.updatedAt, updatedAt: approval.updatedAt,
  };
}

function action(name: string, effect: ToolEffect) {
  return {
    name,
    displayName: name,
    description: `${name} action`,
    parameters: { type: "object" },
    returns: { type: "object" },
    contract: {
      version: "1.0.0",
      effect,
      requiredScopes: effect === "read" ? ["issues:read"] : ["repo"],
      resources: [],
      sensitiveKeys: ["passphrase", "privateKey"],
      pagination: { kind: "none" as const },
      retry: effect === "read" ? "safe" as const : "never" as const,
    },
  };
}

describe("execution service", () => {
  it("shows approval status only to the exact client grant and current member", async () => {
    const { service, workspace, workspaceStore } = await fixture();
    const principal = { kind: "client" as const, userId: "user_1", workspaceId: workspace.id,
      clientId: "client_1", grantId: "grant_1", capabilities: ["tools:write", "approvals:create"] as
        ("tools:write" | "approvals:create")[] };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue", params: {} });
    expect((await service.approvalStatus(principal, approval.id)).status).toBe("pending");
    await expect(service.approvalStatus({ ...principal, grantId: "grant_2" }, approval.id))
      .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    await expect(service.approvalStatus({ ...principal, capabilities: ["tools:write"] }, approval.id))
      .rejects.toMatchObject({ code: "EXECUTION_CAPABILITY_DENIED" });
    workspaceStore.removeMembership(workspace.id, principal.userId);
    await expect(service.approvalStatus(principal, approval.id))
      .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
  });

  it("keeps memory approval fingerprints and membership decisions fail closed", async () => {
    const { approvals, service, workspace, workspaceStore } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const legacy = await requestApproval(service, { principal, toolId: "linear.create_issue",
      params: {}, idempotencyKey: "legacy-without-fingerprint" });
    approvals.approvals.set(legacy.id, { ...legacy, requestHash: undefined });
    await expect(requestApproval(service, { principal, toolId: "linear.create_issue",
      params: {}, idempotencyKey: legacy.idempotencyKey }))
      .rejects.toMatchObject({ code: "EXECUTION_IDEMPOTENCY_CONFLICT" });

    const pending = await requestApproval(service, { principal, toolId: "linear.create_issue", params: {} });
    const approved = await requestApproval(service, { principal, toolId: "linear.create_issue", params: {} });
    await service.approve(approved.id, principal.userId);
    expect(workspaceStore.removeMembership(workspace.id, principal.userId)).toBe(true);
    await expect(service.approve(pending.id, principal.userId)).rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    await expect(service.reject(pending.id, principal.userId)).rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    await expect(service.executeApproved(principal, approved.id)).rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
  });

  it("keeps uncontracted unknown actions approvable with an opaque preview and no early effect", async () => {
    const { approvals, actionCall, catalog, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const params = { body: "private body", nested: { token: "private token" } };
    const pending = await requestApproval(service, { principal, toolId: "linear.uncontracted", params });
    expect(actionCall).not.toHaveBeenCalled();
    for (const record of [pending, ...(await approvals.listForActor({ workspaceId: workspace.id,
      actorUserId: principal.userId, limit: 10 }))]) {
      const preview = publicApproval(record, catalog.get(record.toolId));
      expect(preview).toMatchObject({ previewReady: true, previewMode: "opaque",
        effect: "unknown", params: "[REDACTED]" });
      expect(JSON.stringify(preview)).not.toMatch(/private body|private token/);
    }
    const approved = await service.approve(pending.id, principal.userId);
    expect(publicApproval(approved, catalog.get(approved.toolId))).toMatchObject({
      previewReady: true, previewMode: "opaque", params: "[REDACTED]",
    });
    expect(actionCall).not.toHaveBeenCalled();
    const receipt = await service.executeApproved(principal, approved.id);
    expect(receipt.status).toBe("succeeded");
    expect(actionCall).toHaveBeenCalledTimes(1);
    expect(actionCall).toHaveBeenCalledWith("linear", "uncontracted", expect.objectContaining({
      params, retry: { maxAttempts: 1, backoff: "exponential" },
    }));
    await expect(service.executeApproved(principal, approved.id))
      .resolves.toMatchObject({ id: receipt.id, status: "succeeded" });
  });

  it("rejects unsafe unknown previews while preserving explicit unknown contracts", async () => {
    const { actionCall, approvals, catalog, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const manifest = catalog.get("linear.uncontracted")!;
    expect(approvalPreviewReady(manifest, manifest.hash, ["secret"])).toBe(false);
    expect(approvalPreviewReady(manifest, manifest.hash, "secret")).toBe(false);
    expect(approvalPreviewReady({ ...manifest, contract: { ...manifest.contract,
      resources: [{ kind: "issue", parameter: "target" }],
    } }, manifest.hash, { target: "secret" })).toBe(false);
    await expect(requestApproval(service, { principal, toolId: manifest.id, params: ["secret"] }))
      .rejects.toBeInstanceOf(ExecutionInputError);
    const explicit = await requestApproval(service, { principal, toolId: "linear.mystery",
      params: { title: "visible", passphrase: "hidden" } });
    expect(publicApproval(explicit, catalog.get(explicit.toolId))).toMatchObject({
      previewReady: true, previewMode: "redacted",
      params: { title: "visible", passphrase: "[REDACTED]" },
    });
    expect(approvals.approvals.size).toBe(1);
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("derives a stable fingerprint key distinct from the result wrapping key", async () => {
    const wrapping = new Uint8Array(32).fill(7);
    const derived = await deriveExecutionFingerprintKey(wrapping);
    expect(derived).toHaveLength(32);
    expect(derived).not.toEqual(wrapping);
    expect(await deriveExecutionFingerprintKey(wrapping)).toEqual(derived);
    expect(await deriveExecutionFingerprintKey(new Uint8Array(32).fill(8))).not.toEqual(derived);
  });
  it("advertises only actions granted by the effective selected binding across selection and revocation", async () => {
    const { catalog, connections, firstBinding, workspace } = await fixture();
    const second = await connections.attach({
      actorUserId: "user_1", workspaceId: workspace.id, provider: "linear",
      providerConnectionId: "plug_linear_repo", ownership: "personal", label: "Elevated",
    });
    const scopes = new Map([["plug_linear", ["read:user"]], ["plug_linear_repo", ["repo"]]]);
    const visible = () => usableToolIds(catalog, [{ provider: "linear", state: "ready" }], async (provider) => {
      try {
        const binding = await connections.resolve({ actorUserId: "user_1", workspaceId: workspace.id, provider });
        return scopes.get(binding.providerConnectionId);
      } catch (error) {
        if (error instanceof ConnectionSelectionRequiredError) return null;
        throw error;
      }
    });
    expect(await visible()).toEqual(new Set());
    await connections.select({ actorUserId: "user_1", workspaceId: workspace.id,
      provider: "linear", connectionId: firstBinding.id });
    expect((await visible()).has("linear.create_issue")).toBe(false);
    await connections.select({ actorUserId: "user_1", workspaceId: workspace.id,
      provider: "linear", connectionId: second.id });
    expect((await visible()).has("linear.create_issue")).toBe(true);
    await connections.revoke("user_1", second.id);
    expect((await visible()).has("linear.create_issue")).toBe(false);
  });

  it("rejects insufficient grants before reads and approvals, then rechecks revoked grants on approval execution", async () => {
    const { actionCall, approvals, receipts, service, workspace, setScopes } =
      await fixture(undefined, ["read:user"]);
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    await expect(service.execute({ principal, toolId: "linear.get_issue", params: {} }))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    await expect(service.execute({ principal, toolId: "linear.create_issue", params: {} }))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    await expect(requestApproval(service, { principal, toolId: "linear.create_issue", params: {} }))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    expect(approvals.approvals.size).toBe(0);
    expect(receipts.receipts.size).toBe(0);
    setScopes(["issues:read", "repo"]);
    await expect(service.execute({ principal, toolId: "linear.get_issue", params: {} }))
      .resolves.toMatchObject({ status: "succeeded" });
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue", params: {} });
    await service.approve(approval.id, "user_1");
    setScopes(["issues:read"]);
    await expect(service.executeApproved(principal, approval.id))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    expect(approvals.approvals.get(approval.id)?.status).toBe("failed");
    expect(actionCall).toHaveBeenCalledTimes(1);
  });

  it("fails closed for an unknown grant even when actions require no scopes", async () => {
    const { actionCall, approvals, receipts, service, workspace, setScopes } = await fixture(undefined, [], true);
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await requestApproval(service, { principal, toolId: "linear.no_scope_write", params: {} });
    await service.approve(approval.id, "user_1");
    setScopes(undefined);
    await expect(service.execute({ principal, toolId: "linear.no_scope_read", params: {} }))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    await expect(requestApproval(service, { principal, toolId: "linear.no_scope_write", params: {} }))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    await expect(service.executeApproved(principal, approval.id))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    expect(approvals.approvals.get(approval.id)?.status).toBe("failed");
    expect(receipts.receipts.size).toBe(0);
    expect(actionCall).not.toHaveBeenCalled();
    setScopes([]);
    await expect(service.execute({ principal, toolId: "linear.no_scope_read", params: {} }))
      .resolves.toMatchObject({ status: "succeeded" });
  });

  it("degrades a deleted remote binding across direct, approval request, and approved execution", async () => {
    for (const entry of ["direct", "request", "approved"] as const) {
      const { actionCall, approvals, connections, firstBinding, receipts, service, workspace, setRemoteError } = await fixture();
      const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
      let approvalId: string | undefined;
      if (entry === "approved") {
        const approval = await requestApproval(service, { principal, toolId: "linear.create_issue", params: {} });
        await service.approve(approval.id, "user_1");
        approvalId = approval.id;
      }
      setRemoteError(Object.assign(new Error("remote missing"), { code: "CONNECTION_NOT_FOUND" }));
      const call = entry === "direct"
        ? service.execute({ principal, toolId: "linear.get_issue", params: {} })
        : entry === "request"
          ? requestApproval(service, { principal, toolId: "linear.create_issue", params: {} })
          : service.executeApproved(principal, approvalId!);
      await expect(call).rejects.toBeInstanceOf(ConnectionUnavailableError);
      expect(await connections.listAvailable({ actorUserId: "user_1", workspaceId: workspace.id, provider: "linear" }))
        .toContainEqual(expect.objectContaining({
          id: firstBinding.id, status: "needs_reauth", readiness: "unavailable",
          healthReason: "plugfn_connection_missing",
        }));
      expect(actionCall).not.toHaveBeenCalled();
      expect(receipts.receipts.size).toBe(0);
      if (entry === "request") expect(approvals.approvals.size).toBe(0);
      if (entry === "approved") expect(approvals.approvals.get(approvalId!)?.status).toBe("failed");
      await expect(service.execute({ principal, toolId: "github.get_issue", params: {} }))
        .resolves.toMatchObject({ status: "succeeded" });
    }
  });

  it("does not translate unrelated remote lookup failures into unavailable connections", async () => {
    const { connections, firstBinding, service, workspace, setRemoteError } = await fixture();
    const failure = new Error("PlugFn outage");
    setRemoteError(failure);
    await expect(service.execute({
      principal: { kind: "web", userId: "user_1", workspaceId: workspace.id },
      toolId: "linear.get_issue", params: {},
    })).rejects.toBe(failure);
    expect(await connections.listAvailable({ actorUserId: "user_1", workspaceId: workspace.id }))
      .toContainEqual(expect.objectContaining({ id: firstBinding.id, status: "active", readiness: "ready" }));
  });

  it("degrades a remote binding deleted after scopes were checked and records a sanitized receipt", async () => {
    const { actionCall, connections, firstBinding, receipts, service, workspace } = await fixture();
    actionCall.mockRejectedValueOnce(Object.assign(new Error("remote connection missing"), {
      code: "CONNECTION_NOT_FOUND",
    }));
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const request = { principal, toolId: "linear.get_issue", params: {}, idempotencyKey: "missing-after-dispatch" };
    const outcome = await service.execute(request)
      .catch((error: unknown) => error) as { code: string; receiptId: string };
    expect(outcome).toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
    expect([...receipts.receipts.values()]).toEqual([
      expect.objectContaining({ id: outcome.receiptId, status: "uncertain", errorCode: "provider_outcome_unknown" }),
    ]);
    expect(await connections.listAvailable({ actorUserId: "user_1", workspaceId: workspace.id }))
      .toContainEqual(expect.objectContaining({ id: firstBinding.id, status: "needs_reauth" }));
    await expect(service.execute(request)).rejects.toMatchObject({
      code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: outcome.receiptId,
    });
    expect(actionCall).toHaveBeenCalledTimes(1);
    await expect(service.execute({ principal, toolId: "github.get_issue", params: {} }))
      .resolves.toMatchObject({ status: "succeeded" });
  });

  it("keeps an approved effect uncertain after a missing-remote reply, including approval replay", async () => {
    const { actionCall, approvals, receipts, service, workspace, workspaceStore } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue", params: {} });
    await service.approve(approval.id, principal.userId);
    let effectApplied = 0;
    actionCall.mockImplementationOnce(async () => {
      effectApplied += 1;
      throw Object.assign(new Error("reply lost after effect"), { code: "CONNECTION_NOT_FOUND" });
    });
    const outcome = await service.executeApproved(principal, approval.id)
      .catch((error: unknown) => error) as { code: string; receiptId: string };
    expect(outcome.code).toBe("EXECUTION_OUTCOME_UNKNOWN");
    expect(receipts.receipts.get(outcome.receiptId)).toMatchObject({ status: "uncertain" });
    expect(approvals.approvals.get(approval.id)).toMatchObject({
      status: "uncertain", executionReceiptId: outcome.receiptId,
    });
    await expect(service.executeApproved(principal, approval.id)).rejects.toMatchObject({
      code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: outcome.receiptId,
    });
    approvals.approvals.get(approval.id)!.status = "executing";
    approvals.approvals.get(approval.id)!.executionReceiptId = null;
    receipts.receipts.get(outcome.receiptId)!.status = "running";
    await expect(service.executeApproved(principal, approval.id)).rejects.toMatchObject({
      code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: outcome.receiptId,
    });
    workspaceStore.memberships.clear();
    await expect(service.executeApproved(principal, approval.id)).rejects.toMatchObject({
      code: "APPROVAL_UNAVAILABLE",
    });
    expect(effectApplied).toBe(1);
    expect(actionCall).toHaveBeenCalledTimes(1);
  });

  it("rechecks current identity before disclosing an uncertain read receipt", async () => {
    let currentGrant = true;
    const guard: ExecutionInvocationGuard = {
      run: async (_input, invoke) => invoke(() => undefined),
      runIdentity: async (_input, report) => {
        if (!currentGrant) throw new ConnectionAccessDeniedError();
        return report();
      },
    };
    const { actionCall, service, workspace } = await fixture(undefined, undefined, false, guard);
    const principal = { kind: "client" as const, userId: "user_1", workspaceId: workspace.id,
      clientId: "client_1", grantId: "grant_1", capabilities: ["tools:read" as const] };
    const request = { principal, toolId: "linear.get_issue", params: {}, idempotencyKey: "uncertain-read" };
    actionCall.mockRejectedValueOnce(new Error("upstream response lost"));
    const first = await service.execute(request).catch((error: unknown) => error) as { receiptId: string };
    await expect(service.execute(request)).rejects.toMatchObject({
      code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: first.receiptId,
    });
    currentGrant = false;
    await expect(service.execute(request)).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(actionCall).toHaveBeenCalledTimes(1);
  });

  it("keeps missing-remote responses deterministic when recording health fails", async () => {
    for (const phase of ["scope", "action"] as const) {
      const { actionCall, connections, firstBinding, receipts, service, workspace, setRemoteError } = await fixture();
      const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
      const recordHealth = vi.spyOn(connections, "recordHealth")
        .mockRejectedValue(new Error("health store unavailable"));
      const missing = Object.assign(new Error("remote missing"), { code: "CONNECTION_NOT_FOUND" });
      if (phase === "scope") setRemoteError(missing);
      else actionCall.mockRejectedValueOnce(missing);
      const outcome = await service.execute({ principal, toolId: "linear.get_issue", params: {} })
        .catch((error: unknown) => error) as { code: string; receiptId: string };
      expect(outcome).toMatchObject({ code: phase === "scope"
        ? "CONNECTION_UNAVAILABLE" : "EXECUTION_OUTCOME_UNKNOWN" });
      expect(recordHealth).toHaveBeenCalledExactlyOnceWith({
        connectionId: firstBinding.id,
        status: "needs_reauth",
        readiness: "unavailable",
        reason: "plugfn_connection_missing",
      });
      expect([...receipts.receipts.values()]).toEqual(phase === "scope" ? [] : [
        expect.objectContaining({ id: outcome.receiptId, status: "uncertain", errorCode: "provider_outcome_unknown" }),
      ]);
    }
  });

  it("keeps approval paths unavailable when a deleted remote cannot be recorded", async () => {
    for (const entry of ["request", "approved"] as const) {
      const { actionCall, approvals, connections, firstBinding, receipts, service, workspace, setRemoteError } = await fixture();
      const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
      let approvalId: string | undefined;
      if (entry === "approved") {
        const approval = await requestApproval(service, { principal, toolId: "linear.create_issue", params: {} });
        approvalId = approval.id;
        await service.approve(approvalId, "user_1");
      }
      const recordHealth = vi.spyOn(connections, "recordHealth")
        .mockRejectedValue(new Error("health store unavailable"));
      setRemoteError(Object.assign(new Error("remote missing"), { code: "CONNECTION_NOT_FOUND" }));
      const call = entry === "request"
        ? requestApproval(service, { principal, toolId: "linear.create_issue", params: {} })
        : service.executeApproved(principal, approvalId!);
      await expect(call).rejects.toBeInstanceOf(ConnectionUnavailableError);
      expect(recordHealth).toHaveBeenCalledExactlyOnceWith({
        connectionId: firstBinding.id,
        status: "needs_reauth",
        readiness: "unavailable",
        reason: "plugfn_connection_missing",
      });
      expect(actionCall).not.toHaveBeenCalled();
      expect(receipts.receipts.size).toBe(0);
      if (entry === "request") expect(approvals.approvals.size).toBe(0);
      else expect(approvals.approvals.get(approvalId!)?.status).toBe("failed");
      await expect(service.execute({ principal, toolId: "github.get_issue", params: {} }))
        .resolves.toMatchObject({ status: "succeeded" });
    }
  });

  it("does not execute or request approval for an unconfigured provider, even with a ready old binding", async () => {
    const { actionCall, service, workspace } = await fixture(new Set());
    const input = {
      principal: { kind: "web" as const, userId: "user_1", workspaceId: workspace.id },
      toolId: "linear.get_issue", params: {},
    };
    await expect(service.execute(input)).rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    await expect(requestApproval(service, { ...input, toolId: "linear.create_issue" }))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("executes reads through the selected opaque PlugFn connection and records a receipt", async () => {
    const { actionCall, service, workspace, advance } = await fixture();
    advance(1_000);
    const receipt = await service.execute({
      principal: { kind: "web", userId: "user_1", workspaceId: workspace.id },
      toolId: "linear.get_issue",
      params: { id: "issue_1" },
      idempotencyKey: "request-1",
    });

    expect(receipt).toMatchObject({
      status: "succeeded",
      toolId: "linear.get_issue",
      providerConnectionId: "plug_linear",
      result: { id: "issue_1", title: "Fixed" },
    });
    expect(actionCall).toHaveBeenCalledWith("linear", "get_issue", expect.objectContaining({
      connectionId: "plug_linear",
      retry: { maxAttempts: 3, backoff: "exponential" },
      cache: false,
    }));
  });

  it("enforces client capabilities before connection resolution or provider calls", async () => {
    const { actionCall, service, workspace } = await fixture();
    await expect(service.execute({
      principal: {
        kind: "client",
        userId: "user_1",
        workspaceId: workspace.id,
        clientId: "client_1",
        grantId: "grant_1",
        capabilities: ["tools:discover"],
      },
      toolId: "linear.get_issue",
      params: {},
    })).rejects.toBeInstanceOf(ExecutionCapabilityDeniedError);
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("denies an explicit connection from another workspace before any provider effect", async () => {
    const { actionCall, firstBinding, service } = await fixture();
    await expect(service.execute({
      principal: { kind: "client", userId: "user_1", workspaceId: "workspace_other",
        clientId: "client_other", grantId: "grant_other", capabilities: ["tools:read"] },
      toolId: "linear.get_issue", connectionId: firstBinding.id, params: {},
    })).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(actionCall).not.toHaveBeenCalled();
  });

  it.each(["linear.create_issue", "linear.mystery"])(
    "requires approval for %s without calling PlugFn",
    async (toolId) => {
      const { actionCall, service, workspace } = await fixture();
      await expect(service.execute({
        principal: { kind: "web", userId: "user_1", workspaceId: workspace.id },
        toolId,
        params: {},
      })).rejects.toBeInstanceOf(ExecutionApprovalRequiredError);
      expect(actionCall).not.toHaveBeenCalled();
    },
  );

  it("replays completed idempotent requests without a second provider call", async () => {
    const { actionCall, service, workspace } = await fixture();
    const request = {
      principal: { kind: "web" as const, userId: "user_1", workspaceId: workspace.id },
      toolId: "linear.get_issue",
      params: { id: "issue_1" } as const,
      idempotencyKey: "same-request",
    };
    const first = await service.execute(request);
    const replay = await service.execute(request);
    expect(replay.id).toBe(first.id);
    expect(actionCall).toHaveBeenCalledTimes(1);
  });

  it("reuses one pending approval for a retry and rejects changed parameters", async () => {
    const { actionCall, approvals, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const request = { principal, toolId: "linear.create_issue", params: { title: "first" },
      idempotencyKey: "approval-retry" } as const;
    const first = await requestApproval(service, request);
    expect((await requestApproval(service, request)).id).toBe(first.id);
    await expect(requestApproval(service, { ...request, params: { title: "changed" } }))
      .rejects.toBeInstanceOf(ExecutionIdempotencyConflictError);
    expect(approvals.approvals.size).toBe(1);
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("binds approval lifetime to the idempotency key while retaining the original expiry on a true retry", async () => {
    const { approvals, service, workspace, advance } = await fixture();
    const request = { principal: { kind: "web" as const, userId: "user_1", workspaceId: workspace.id },
      toolId: "linear.create_issue", params: { title: "same" }, idempotencyKey: "ttl-retry", ttlMs: 60_000 };
    const first = await requestApproval(service, request);
    advance(1_000);
    expect(await requestApproval(service, request)).toMatchObject({ id: first.id, expiresAt: first.expiresAt });
    await expect(requestApproval(service, { ...request, ttlMs: 120_000 }))
      .rejects.toBeInstanceOf(ExecutionIdempotencyConflictError);
    expect(approvals.approvals.size).toBe(1);
  });

  it("allows only one concurrent approved invocation and blocks revoked bindings", async () => {
    const { actionCall, connections, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue", params: {} });
    await service.approve(approval.id, principal.userId);
    const results = await Promise.allSettled([
      service.executeApproved(principal, approval.id),
      service.executeApproved(principal, approval.id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(actionCall).toHaveBeenCalledTimes(1);

    const later = await requestApproval(service, { principal, toolId: "linear.create_issue", params: {} });
    await service.approve(later.id, principal.userId);
    await connections.revoke(principal.userId, later.connectionId);
    await expect(service.executeApproved(principal, later.id)).rejects.toMatchObject({
      code: "CONNECTION_ACCESS_DENIED",
    });
    expect(actionCall).toHaveBeenCalledTimes(1);
  });

  it.each([null, "approval_other"])("never attributes a %s receipt to an approved replay", async (foreignApprovalId) => {
    for (const status of ["reserved", "failed", "running", "succeeded", "uncertain"] as const) {
      const { actionCall, approvals, receipts, service, workspace } = await fixture();
      const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
      const approval = await requestApproval(service, { principal, toolId: "linear.create_issue", params: {} });
      await service.approve(approval.id, principal.userId);
      const original = await service.executeApproved(principal, approval.id);
      const stored = receipts.receipts.get(original.id)!;
      receipts.receipts.set(original.id, { ...stored, approvalId: foreignApprovalId, status });
      approvals.approvals.get(approval.id)!.status = "uncertain";
      await expect(service.executeApproved(principal, approval.id)).rejects.toMatchObject({
        code: "APPROVAL_UNAVAILABLE",
      });
      approvals.approvals.get(approval.id)!.status = "approved";
      approvals.approvals.get(approval.id)!.executionReceiptId = null;

      await expect(service.executeApproved(principal, approval.id)).rejects.toMatchObject({
        code: "EXECUTION_IDEMPOTENCY_CONFLICT",
      });
      expect(actionCall).toHaveBeenCalledTimes(1);
      expect(approvals.approvals.get(approval.id)).toMatchObject({ status: "failed", executionReceiptId: null });
      expect(receipts.receipts.get(original.id)?.approvalId).toBe(foreignApprovalId);
      expect(receipts.receipts.get(original.id)?.status).toBe(status);
    }
  });

  it("masks every parameter when preview metadata is absent", async () => {
    const { approvals, catalog, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue",
      params: { title: "visible", nested: { passphrase: "secret-value", privateKey: "private-value" } } });
    const records = [approval, await service.approve(approval.id, principal.userId),
      ...(await approvals.listForActor({ workspaceId: workspace.id, actorUserId: principal.userId, limit: 10 }))];
    const manifest = catalog.get(approval.toolId)!;
    const withoutMetadata = { ...manifest, contract: { ...manifest.contract, sensitiveKeys: [] } };
    for (const record of records) {
      const projected = publicApproval(record, withoutMetadata);
      expect(projected.params).toBe("[REDACTED]");
      expect(projected.previewReady).toBe(false);
      expect(JSON.stringify(projected)).not.toMatch(/plug_linear|secret-value|private-value/);
      expect(projected).not.toHaveProperty("requestHash");
    }
    const receipt = await service.execute({ principal, toolId: "linear.get_issue", params: {} });
    expect(publicReceipt(receipt, false)).toMatchObject({ result: null, status: "succeeded" });
    expect(JSON.stringify(publicReceipt(receipt, false))).not.toContain("plug_linear");
  });

  it("masks every preview field when the current manifest no longer matches the approval", async () => {
    const { approvals, catalog, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue",
      params: { title: "visible", passphrase: "old manifest secret" } });
    const changed = { ...catalog.get(approval.toolId)!, hash: "replacement-manifest" };
    const projections = [approval, await service.approve(approval.id, principal.userId),
      ...(await approvals.listForActor({ workspaceId: workspace.id, actorUserId: principal.userId, limit: 10 }))];
    for (const record of projections) {
      const preview = publicApproval(record, changed);
      expect(preview).toMatchObject({ manifestCurrent: false, params: "[REDACTED]" });
      expect(JSON.stringify(preview)).not.toContain("old manifest secret");
      expect(preview).not.toHaveProperty("requestHash");
    }
  });

  it("blocks old pending and approved envelopes when safe preview metadata disappears", async () => {
    const { approvals, actionCall, catalog, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const params = { title: "visible", passphrase: "private-passphrase" };
    const pending = await requestApproval(service, { principal, toolId: "linear.create_issue", params });
    const approved = await requestApproval(service, { principal, toolId: "linear.create_issue", params });
    await service.approve(approved.id, principal.userId);
    const originalGet = catalog.get.bind(catalog);
    vi.spyOn(catalog, "get").mockImplementation((id) => {
      const manifest = originalGet(id);
      return manifest ? { ...manifest, contract: { ...manifest.contract, sensitiveKeys: [] } } : null;
    });
    const records = [pending, approved,
      ...(await approvals.listForActor({ workspaceId: workspace.id, actorUserId: principal.userId, limit: 10 }))];
    for (const record of records) {
      const projected = publicApproval(record, catalog.get(record.toolId));
      expect(projected).toMatchObject({ previewReady: false, params: "[REDACTED]" });
      expect(JSON.stringify(projected)).not.toContain("private-passphrase");
    }
    await expect(service.approve(pending.id, principal.userId)).rejects.toBeInstanceOf(ApprovalUnavailableError);
    await expect(service.executeApproved(principal, approved.id)).rejects.toBeInstanceOf(ApprovalUnavailableError);
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("projects a full late target while masking declared secrets across approval states", async () => {
    const { approvals, catalog, service, workspace, actionCall } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue",
      params: { body: "x".repeat(700), target: "late-resource", passphrase: "private-passphrase" } });
    const records = [approval, await service.approve(approval.id, principal.userId),
      ...(await approvals.listForActor({ workspaceId: workspace.id, actorUserId: principal.userId, limit: 10 }))];
    for (const record of records) {
      const projected = publicApproval(record, catalog.get(record.toolId));
      expect(projected).toMatchObject({ previewReady: true, action: "create_issue",
        params: { target: "late-resource", passphrase: "[REDACTED]" } });
      expect(JSON.stringify(projected)).toContain("late-resource");
      expect(JSON.stringify(projected)).not.toContain("private-passphrase");
    }
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("rejects primitive approval arguments because their value cannot be safely previewed", async () => {
    const { actionCall, approvals, service, workspace } = await fixture();
    await expect(requestApproval(service, { principal: { kind: "web", userId: "user_1",
      workspaceId: workspace.id }, toolId: "linear.create_issue", params: "hidden-secret" }))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    expect(approvals.approvals.size).toBe(0);
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("requires each declared target to be present and visible before reserving approval", async () => {
    const { actionCall, approvals, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    await expect(requestApproval(service, { principal, toolId: "linear.targeted", params: { title: "hidden target" } }))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    await expect(requestApproval(service, { principal, toolId: "linear.secret_target",
      params: { passphrase: "secret target" } })).rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    const approval = await requestApproval(service, { principal, toolId: "linear.targeted",
      params: { target: "issue-123", passphrase: "private-passphrase" } });
    expect(approval.params).toMatchObject({ target: "issue-123" });
    expect(approvals.approvals.size).toBe(1);
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("rejects a target hidden by an ancestor at request, decision, overview, and execution", async () => {
    const { actionCall, approvals, catalog, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const params = { payload: { target: "issue-123", note: "private" }, title: "visible" };
    const pending = await requestApproval(service, { principal, toolId: "linear.create_issue", params });
    const approved = await requestApproval(service, { principal, toolId: "linear.create_issue", params });
    await service.approve(approved.id, principal.userId);
    const originalGet = catalog.get.bind(catalog);
    const changed = { ...originalGet(pending.toolId)!, contract: {
      ...originalGet(pending.toolId)!.contract,
      resources: [{ kind: "issue", parameter: "payload.target" }], sensitiveKeys: ["payload"],
    } };
    vi.spyOn(catalog, "get").mockImplementation((id) => id === pending.toolId ? changed : originalGet(id));
    await expect(requestApproval(service, { principal, toolId: pending.toolId, params }))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    const records = [pending, approved,
      ...(await approvals.listForActor({ workspaceId: workspace.id, actorUserId: principal.userId, limit: 10 }))];
    for (const record of records) {
      const preview = publicApproval(record, catalog.get(record.toolId));
      expect(preview).toMatchObject({ previewReady: false, params: "[REDACTED]" });
      expect(JSON.stringify(preview)).not.toContain("issue-123");
    }
    await expect(service.approve(pending.id, principal.userId)).rejects.toBeInstanceOf(ApprovalUnavailableError);
    await expect(service.executeApproved(principal, approved.id)).rejects.toBeInstanceOf(ApprovalUnavailableError);
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("uses own target properties and masks indexed array secrets in complete previews", async () => {
    const { catalog, service, workspace } = await fixture();
    const manifest = catalog.get("linear.create_issue")!;
    const indexed = { ...manifest, contract: { ...manifest.contract,
      resources: [{ kind: "issue", parameter: "items.0.target" }],
      sensitiveKeys: ["items.0.privatePart", "items[].hiddenPart"],
    } };
    const params = { items: [{ target: "issue-" + "x".repeat(700), privatePart: "nested-secret",
      hiddenPart: "array-secret" }] };
    expect(approvalPreviewReady(indexed, manifest.hash, params)).toBe(true);
    const approval = await requestApproval(service, { principal: { kind: "web", userId: "user_1",
      workspaceId: workspace.id }, toolId: manifest.id, params });
    const preview = publicApproval(approval, indexed);
    expect(preview).toMatchObject({ previewReady: true,
      params: { items: [{ target: params.items[0]!.target, privatePart: "[REDACTED]",
        hiddenPart: "[REDACTED]" }] } });
    expect(JSON.stringify(preview)).not.toContain("nested-secret");
    expect(JSON.stringify(preview)).not.toContain("array-secret");
    const inherited = Object.create({ target: "inherited-target" }) as { target: string };
    const targetManifest = { ...manifest, contract: { ...manifest.contract,
      resources: [{ kind: "issue", parameter: "target" }] } };
    expect(approvalPreviewReady(targetManifest, manifest.hash, inherited)).toBe(false);
    expect(approvalPreviewReady(targetManifest, manifest.hash, {})).toBe(false);
  });

  it("masks wildcard array and object secrets in every approval projection and rejects hidden targets", async () => {
    const { actionCall, approvals, catalog, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const originalGet = catalog.get.bind(catalog);
    const manifest = originalGet("linear.create_issue")!;
    const wildcard = { ...manifest, contract: { ...manifest.contract,
      sensitiveKeys: ["items[*].pin", "metadata.*.pin"],
    } };
    vi.spyOn(catalog, "get").mockImplementation((id) => id === manifest.id ? wildcard : originalGet(id));
    const params = { title: "Review", items: [{ pin: "array-PIN", target: "issue-1" }],
      metadata: { first: { pin: "object-PIN" } } };
    const pending = await requestApproval(service, { principal, toolId: manifest.id, params });
    const approved = await requestApproval(service, { principal, toolId: manifest.id, params });
    await service.approve(approved.id, principal.userId);
    const projections = [pending, approved,
      ...(await approvals.listForActor({ workspaceId: workspace.id, actorUserId: principal.userId, limit: 10 }))];
    for (const record of projections) {
      const preview = publicApproval(record, catalog.get(record.toolId));
      expect(preview).toMatchObject({ previewReady: true,
        params: { items: [{ pin: "[REDACTED]", target: "issue-1" }],
          metadata: { first: { pin: "[REDACTED]" } } } });
      expect(JSON.stringify(preview)).not.toMatch(/array-PIN|object-PIN/);
    }
    expect(actionCall).not.toHaveBeenCalled();
    const hiddenTarget = { ...wildcard, contract: { ...wildcard.contract,
      resources: [{ kind: "issue", parameter: "items.0.pin" }] } };
    expect(approvalPreviewReady(hiddenTarget, manifest.hash, params)).toBe(false);
    expect(approvalPreviewReady({ ...wildcard, contract: { ...wildcard.contract,
      sensitiveKeys: ["items[?].pin"] } }, manifest.hash, params)).toBe(false);
    vi.spyOn(catalog, "get").mockImplementation((id) => id === manifest.id ? hiddenTarget : originalGet(id));
    await expect(requestApproval(service, { principal, toolId: manifest.id, params }))
      .rejects.toBeInstanceOf(ExecutionInputError);
    await expect(service.approve(pending.id, principal.userId)).rejects.toBeInstanceOf(ApprovalUnavailableError);
    await expect(service.executeApproved(principal, approved.id)).rejects.toBeInstanceOf(ApprovalUnavailableError);
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("masks whole array elements and nested arrays across request, decision, and overview", async () => {
    const { actionCall, approvals, catalog, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const originalGet = catalog.get.bind(catalog);
    const manifest = originalGet("linear.create_issue")!;
    const protectedManifest = { ...manifest, contract: { ...manifest.contract,
      sensitiveKeys: ["items[*]", "nested.rows[*][*]"],
    } };
    vi.spyOn(catalog, "get").mockImplementation((id) => id === manifest.id ? protectedManifest : originalGet(id));
    const params = { title: "Review", items: ["array-secret", { value: "object-secret" }],
      nested: { rows: [["nested-secret", { value: "deep-secret" }]] } };
    const pending = await requestApproval(service, { principal, toolId: manifest.id, params });
    const approved = await requestApproval(service, { principal, toolId: manifest.id, params });
    await service.approve(approved.id, principal.userId);
    const records = [pending, approved,
      ...(await approvals.listForActor({ workspaceId: workspace.id, actorUserId: principal.userId, limit: 10 }))];
    for (const record of records) {
      const preview = publicApproval(record, catalog.get(record.toolId));
      expect(preview).toMatchObject({ previewReady: true, params: { title: "Review",
        items: ["[REDACTED]", "[REDACTED]"], nested: { rows: [["[REDACTED]", "[REDACTED]"]] } } });
      expect(JSON.stringify(preview)).not.toMatch(/array-secret|object-secret|nested-secret|deep-secret/);
    }
    expect(actionCall).not.toHaveBeenCalled();

    for (const malformed of [
      { title: "Review", items: "array-secret" },
      { title: "Review", nested: { rows: ["nested-secret"] } },
    ]) {
      expect(approvalPreviewReady(protectedManifest, manifest.hash, malformed)).toBe(false);
      await expect(requestApproval(service, { principal, toolId: manifest.id, params: malformed }))
        .rejects.toBeInstanceOf(ExecutionInputError);
    }
    expect(approvals.approvals.size).toBe(2);
    const hiddenTarget = { ...protectedManifest, contract: { ...protectedManifest.contract,
      resources: [{ kind: "issue", parameter: "items.0" }] } };
    expect(approvalPreviewReady(hiddenTarget, manifest.hash, params)).toBe(false);
    vi.spyOn(catalog, "get").mockImplementation((id) => id === manifest.id ? hiddenTarget : originalGet(id));
    await expect(requestApproval(service, { principal, toolId: manifest.id, params }))
      .rejects.toBeInstanceOf(ExecutionInputError);
    await expect(service.approve(pending.id, principal.userId)).rejects.toBeInstanceOf(ApprovalUnavailableError);
    await expect(service.executeApproved(principal, approved.id)).rejects.toBeInstanceOf(ApprovalUnavailableError);
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("fails closed on noncanonical array indices at request and for stored approvals", async () => {
    const { actionCall, approvals, catalog, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const originalGet = catalog.get.bind(catalog);
    const manifest = originalGet("linear.create_issue")!;
    const params = { title: "Review", items: [{ pin: "array-secret" }],
      nested: { rows: [[{ pin: "nested-secret" }]] } };
    const canonical = { ...manifest, contract: { ...manifest.contract,
      sensitiveKeys: ["items[0].pin", "nested.rows[0][0].pin"],
    } };
    expect(approvalPreviewReady(canonical, manifest.hash, params)).toBe(true);
    const pending = await requestApproval(service, { principal, toolId: manifest.id, params });
    const approved = await requestApproval(service, { principal, toolId: manifest.id, params });
    await service.approve(approved.id, principal.userId);
    expect(publicApproval(pending, canonical).params).toMatchObject({
      items: [{ pin: "[REDACTED]" }], nested: { rows: [[{ pin: "[REDACTED]" }]] },
    });

    for (const selector of ["items[00].pin", "items.00.pin", "nested.rows[0][00].pin",
      "nested.rows.0.00.pin", "items[4294967295].pin", ".items[0].pin",
      "items.[0].pin"]) {
      const changed = { ...manifest, contract: { ...manifest.contract, sensitiveKeys: [selector] } };
      vi.spyOn(catalog, "get").mockImplementation((id) => id === manifest.id ? changed : originalGet(id));
      expect(approvalPreviewReady(changed, manifest.hash, params)).toBe(false);
      for (const record of [pending, approved,
        ...(await approvals.listForActor({ workspaceId: workspace.id, actorUserId: principal.userId, limit: 10 }))]) {
        const preview = publicApproval(record, catalog.get(record.toolId));
        expect(preview).toMatchObject({ previewReady: false, params: "[REDACTED]" });
        expect(JSON.stringify(preview)).not.toMatch(/array-secret|nested-secret/);
      }
      await expect(requestApproval(service, { principal, toolId: manifest.id, params }))
        .rejects.toBeInstanceOf(ExecutionInputError);
      await expect(service.approve(pending.id, principal.userId)).rejects.toBeInstanceOf(ApprovalUnavailableError);
      await expect(service.executeApproved(principal, approved.id)).rejects.toBeInstanceOf(ApprovalUnavailableError);
    }
    expect(approvals.approvals.size).toBe(2);
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("stores keyed request fingerprints that do not reveal a guessable parameter digest", async () => {
    const { approvals, receipts, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue",
      params: { passphrase: "short secret" } });
    await service.execute({ principal, toolId: "linear.get_issue", params: { passphrase: "short secret" } });
    expect(approval.requestHash).toMatch(/^hmac-sha256-[a-f0-9]{64}$/);
    expect([...receipts.receipts.values()][0]?.requestHash).toMatch(/^hmac-sha256-[a-f0-9]{64}$/);
    expect(approvals.approvals.get(approval.id)?.requestHash).toBe(approval.requestHash);
    const plainDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("short secret"));
    const guess = [...new Uint8Array(plainDigest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(approval.requestHash).not.toContain(guess);
  });

  it("rejects reuse of an idempotency key for different parameters", async () => {
    const { actionCall, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    await service.execute({
      principal,
      toolId: "linear.get_issue",
      params: { id: "issue_1" },
      idempotencyKey: "collision",
    });
    await expect(service.execute({
      principal,
      toolId: "linear.get_issue",
      params: { id: "issue_2" },
      idempotencyKey: "collision",
    })).rejects.toBeInstanceOf(ExecutionIdempotencyConflictError);
    expect(actionCall).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty idempotency key before creating approval or receipt state", async () => {
    const { actionCall, approvals, receipts, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    await expect(service.execute({ principal, toolId: "linear.get_issue", params: {},
      idempotencyKey: "" })).rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    await expect(requestApproval(service, { principal, toolId: "linear.create_issue", params: {},
      idempotencyKey: "" })).rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    await expect(service.requestApproval({ principal, toolId: "linear.create_issue", params: {},
      idempotencyKey: 123 as never })).rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    expect(receipts.receipts.size).toBe(0);
    expect(approvals.approvals.size).toBe(0);
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("records uncertain upstream outcomes without leaking provider details or allowing replay", async () => {
    const { actionCall, receipts, service, workspace } = await fixture();
    actionCall.mockRejectedValueOnce(new Error("provider secret detail"));
    const request = {
      principal: { kind: "web", userId: "user_1", workspaceId: workspace.id },
      toolId: "linear.get_issue",
      params: {},
      idempotencyKey: "uncertain-read",
    } as const;
    await expect(service.execute(request)).rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
    expect([...receipts.receipts.values()][0]).toMatchObject({
      status: "uncertain",
      errorCode: "provider_outcome_unknown",
    });
    expect(JSON.stringify([...receipts.receipts.values()])).not.toContain("provider secret detail");
    await expect(service.execute(request)).rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
    expect(actionCall).toHaveBeenCalledTimes(1);
  });

  it("keeps a successful provider effect non-replayable if result persistence fails", async () => {
    const { actionCall, receipts, service, workspace } = await fixture();
    vi.spyOn(receipts, "succeed").mockRejectedValueOnce(new Error("database write failed"));
    const request = { principal: { kind: "web" as const, userId: "user_1", workspaceId: workspace.id },
      toolId: "linear.get_issue", params: {}, idempotencyKey: "persist-failure" };
    await expect(service.execute(request)).rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
    expect([...receipts.receipts.values()][0]).toMatchObject({ status: "uncertain",
      errorCode: "receipt_persist_failed" });
    await expect(service.execute(request)).rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
    expect(actionCall).toHaveBeenCalledTimes(1);
  });

  it("binds a single-use approval to the exact actor, principal, manifest, connection, and params", async () => {
    const { actionCall, approvals, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await requestApproval(service, {
      principal,
      toolId: "linear.create_issue",
      params: { title: "Approved title" },
      idempotencyKey: "approved-write",
    });
    expect(approval).toMatchObject({ status: "pending", toolId: "linear.create_issue" });
    await expect(service.approve(approval.id, "user_2"))
      .rejects.toBeInstanceOf(ApprovalUnavailableError);
    await expect(service.approve(approval.id, "user_1")).resolves.toMatchObject({
      status: "approved",
      approvedBy: "user_1",
    });

    const receipt = await service.executeApproved(principal, approval.id);
    expect(receipt).toMatchObject({ status: "succeeded", toolId: "linear.create_issue" });
    expect(receipt.approvalId).toBe(approval.id);
    expect(publicReceipt(receipt)).toHaveProperty("approvalId", approval.id);
    expect(publicReceipt(receipt, false)).not.toHaveProperty("approvalId");
    expect(actionCall).toHaveBeenCalledWith("linear", "create_issue", expect.objectContaining({
      params: { title: "Approved title" },
      retry: { maxAttempts: 1, backoff: "exponential" },
    }));
    expect(approvals.approvals.get(approval.id)).toMatchObject({
      status: "consumed",
      executionReceiptId: receipt.id,
    });
    await expect(service.executeApproved(principal, approval.id))
      .resolves.toMatchObject({ id: receipt.id, status: "succeeded" });
    expect(actionCall).toHaveBeenCalledTimes(1);
  });

  it("leaves both records nonterminal when approved completion cannot commit", async () => {
    const { actionCall, approvals, receipts, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue", params: {},
      idempotencyKey: "consume-failure" });
    await service.approve(approval.id, principal.userId);
    vi.spyOn(approvals, "succeedWithReceipt").mockRejectedValueOnce(new Error("approval store unavailable"));
    const error = await service.executeApproved(principal, approval.id).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: expect.any(String) });
    expect(receipts.receipts.get(error.receiptId)).toMatchObject({ status: "uncertain" });
    expect(approvals.approvals.get(approval.id)).toMatchObject({
      status: "uncertain", executionReceiptId: error.receiptId,
    });
    expect(actionCall).toHaveBeenCalledTimes(1);
    await expect(service.executeApproved(principal, approval.id))
      .rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: error.receiptId });
  });

  it.each([
    "provider ambiguity",
    "receipt persistence failure",
  ])("retains a reconcilable approval after %s", async (failure) => {
    const guard: ExecutionInvocationGuard = { run: async (_input, invoke) => {
      return invoke(() => undefined);
    }, runIdentity: async (_input, invoke) => invoke() };
    const { actionCall, approvals, receipts, service, workspace } = await fixture(
      undefined, undefined, false, guard,
    );
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue",
      params: {}, idempotencyKey: `write-${failure.replaceAll(" ", "-")}` });
    await service.approve(approval.id, principal.userId);
    if (failure === "provider ambiguity") actionCall.mockRejectedValueOnce(new Error("secret upstream detail"));
    if (failure === "receipt persistence failure") {
      vi.spyOn(approvals, "succeedWithReceipt").mockRejectedValueOnce(new Error("database write failed"));
    }
    const error = await service.executeApproved(principal, approval.id).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: expect.any(String) });
    expect(approvals.approvals.get(approval.id)).toMatchObject({
      status: "uncertain", executionReceiptId: error.receiptId,
    });
    expect(receipts.receipts.get(error.receiptId)?.status).toBe("uncertain");
    await expect(service.executeApproved(principal, approval.id))
      .rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: error.receiptId });
    expect(actionCall).toHaveBeenCalledTimes(1);
  });

  it("returns durable approved success after guard COMMIT fails and replays without dispatch", async () => {
    const guard: ExecutionInvocationGuard = { run: async (_input, invoke) => {
      await invoke(() => undefined);
      throw new Error("COMMIT failed");
    } };
    const { actionCall, approvals, receipts, service, workspace } = await fixture(
      undefined, undefined, false, guard,
    );
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue",
      params: {}, idempotencyKey: "guard-commit-success" });
    await service.approve(approval.id, principal.userId);
    const receipt = await service.executeApproved(principal, approval.id);
    expect(receipt.status).toBe("succeeded");
    expect(receipts.receipts.get(receipt.id)?.status).toBe("succeeded");
    expect(approvals.approvals.get(approval.id)).toMatchObject({
      status: "consumed", executionReceiptId: receipt.id,
    });
    await expect(service.executeApproved(principal, approval.id))
      .resolves.toMatchObject({ id: receipt.id, status: "succeeded" });
    expect(actionCall).toHaveBeenCalledTimes(1);
  });

  it.each(["web", "client"] as const)("authorizes a consumed %s approval again before exposing its result", async (kind) => {
    let workspaceId = "";
    let revoked = false;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("connection_bindings")) return { rows: [{ workspace_id: workspaceId,
        provider_connection_id: "plug_linear", ownership: "personal", owner_user_id: "user_1",
        status: "active", readiness: "ready" }] };
      if (sql.includes("workspace_memberships")) return { rows: [{ id: "membership_1" }] };
      if (sql.includes("omr_identity.sessions")) return { rows: revoked ? [] : [{ id: "session_1",
        expires_at: new Date(Date.now() + 60_000) }] };
      if (sql.includes("omr_control.clients")) return { rows: [{ workspace_id: workspaceId,
        revoked_at: null }] };
      if (sql.includes("client_grants")) return { rows: [{ client_id: "client_1",
        workspace_id: workspaceId, user_id: "user_1",
        capabilities: ["tools:read", "tools:write", "approvals:create"],
        revoked_at: revoked ? "2026-09-27" : null,
        expires_at: new Date(Date.now() + 60_000) }] };
      return { rows: [] };
    });
    const guard = new PostgresExecutionInvocationGuard({ query,
      end: vi.fn(async () => undefined) } as never);
    const { actionCall, service, workspace } = await fixture(undefined, undefined, false, guard);
    workspaceId = workspace.id;
    const principal = kind === "web"
      ? { kind, userId: "user_1", workspaceId, sessionId: "session_1" } as const
      : { kind, userId: "user_1", workspaceId, clientId: "client_1", grantId: "grant_1",
        capabilities: ["tools:read", "tools:write", "approvals:create"] as const };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue", params: {} });
    await service.approve(approval.id, principal.userId);
    const first = await service.executeApproved(principal, approval.id);
    expect(await service.executeApproved(principal, approval.id)).toMatchObject({ id: first.id });
    revoked = true;
    await expect(service.executeApproved(principal, approval.id))
      .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(actionCall).toHaveBeenCalledOnce();
  });

  it("keeps the original deadline and stable receipt when a provider returns late", async () => {
    const { actionCall, approvals, receipts, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue", params: {} });
    await service.approve(approval.id, principal.userId);
    const started = Date.now();
    let clock = started;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      actionCall.mockImplementation(async () => {
        clock = started + 60_001;
        return { id: "late-effect" };
      });
      const failure = await service.executeApproved(principal, approval.id).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: expect.any(String) });
      expect(receipts.receipts.get(failure.receiptId)).toMatchObject({ status: "uncertain" });
      expect(approvals.approvals.get(approval.id)).toMatchObject({ status: "uncertain",
        executionReceiptId: failure.receiptId });
      expect(actionCall).toHaveBeenCalledOnce();
    } finally {
      now.mockRestore();
    }
  });

  it("replays a durable read after guard COMMIT fails without another provider call", async () => {
    const guard: ExecutionInvocationGuard = { run: async (_input, invoke) => {
      await invoke(() => undefined);
      throw new Error("COMMIT failed");
    } };
    const { actionCall, service, workspace } = await fixture(undefined, undefined, false, guard);
    const request = { principal: { kind: "web" as const, userId: "user_1", workspaceId: workspace.id },
      toolId: "linear.get_issue", params: {}, idempotencyKey: "read-commit-replay" };
    const receipt = await service.execute(request);
    await expect(service.execute(request)).resolves.toMatchObject({
      id: receipt.id, status: "succeeded",
    });
    expect(actionCall).toHaveBeenCalledTimes(1);
  });

  it("reconciles a legacy uncertain approval with an exact succeeded receipt", async () => {
    const { actionCall, approvals, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue",
      params: {}, idempotencyKey: "legacy-success-replay" });
    await service.approve(approval.id, principal.userId);
    const receipt = await service.executeApproved(principal, approval.id);
    approvals.approvals.get(approval.id)!.status = "uncertain";
    await expect(service.executeApproved(principal, approval.id))
      .resolves.toMatchObject({ id: receipt.id, status: "succeeded" });
    expect(approvals.approvals.get(approval.id)).toMatchObject({
      status: "consumed", executionReceiptId: receipt.id,
    });
    expect(actionCall).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "reserved", "failed"] as const)(
    "reconciles a stale executing approval with a %s predispatch receipt", async (state) => {
      const { actionCall, advance, approvals, receipts, service, workspace } = await fixture();
      const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
      const approval = await requestApproval(service, { principal, toolId: "linear.create_issue",
        params: {}, idempotencyKey: `stale-${state}` });
      await service.approve(approval.id, principal.userId);
      const stored = approvals.approvals.get(approval.id)!;
      stored.status = "executing";
      if (state !== "missing") {
        const receipt = receiptForApproval(approval, "reserved");
        await receipts.reserve(receipt);
        if (state === "failed") receipts.receipts.get(receipt.id)!.status = "failed";
      }
      await expect(service.executeApproved(principal, approval.id))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      expect(stored.status).toBe("executing");
      advance(65_001);
      await expect(service.executeApproved(principal, approval.id))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      expect(stored.status).toBe("failed");
      expect(stored.executionReceiptId).toBeNull();
      if (state === "reserved") {
        const receipt = [...receipts.receipts.values()].find((candidate) => candidate.approvalId === approval.id)!;
        expect(receipt).toMatchObject({ status: "failed", errorCode: "reservation_expired" });
        expect(receipt.completedAt).not.toBeNull();
      }
      expect(actionCall).not.toHaveBeenCalled();
    },
  );

  it.each(["running", "uncertain", "succeeded"] as const)(
    "keeps the exact %s effect receipt on executing approval retries", async (status) => {
      const { actionCall, advance, approvals, receipts, service, workspace } = await fixture();
      const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
      const approval = await requestApproval(service, { principal, toolId: "linear.create_issue",
        params: {}, idempotencyKey: `effect-${status}` });
      await service.approve(approval.id, principal.userId);
      approvals.approvals.get(approval.id)!.status = "executing";
      const receipt = receiptForApproval(approval, "reserved");
      await receipts.reserve(receipt);
      Object.assign(receipts.receipts.get(receipt.id)!, {
        status, result: status === "succeeded" ? { id: "issue_1" } : null,
      });
      for (const age of [0, 65_001]) {
        advance(age);
        if (status === "succeeded") {
          await expect(service.executeApproved(principal, approval.id))
            .resolves.toMatchObject({ id: receipt.id, status: "succeeded" });
        } else {
          await expect(service.executeApproved(principal, approval.id))
            .rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: receipt.id });
        }
        expect(approvals.approvals.get(approval.id)).toMatchObject({
          status: status === "succeeded" ? "consumed" : age === 0 ? "executing" : "uncertain",
          executionReceiptId: status === "succeeded" || age !== 0 ? receipt.id : null,
        });
        expect(receipts.receipts.get(receipt.id)?.status).toBe(
          status === "running" && age !== 0 ? "uncertain" : status);
      }
      expect(actionCall).not.toHaveBeenCalled();
    },
  );

  it("links one exact receipt under concurrent stale approval retries", async () => {
    const { actionCall, advance, approvals, receipts, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue",
      params: {}, idempotencyKey: "concurrent-stale-effect" });
    await service.approve(approval.id, principal.userId);
    approvals.approvals.get(approval.id)!.status = "executing";
    const receipt = receiptForApproval(approval, "reserved");
    await receipts.reserve(receipt);
    receipts.receipts.get(receipt.id)!.status = "running";
    advance(65_001);
    const retries = await Promise.allSettled(Array.from({ length: 4 },
      () => service.executeApproved(principal, approval.id)));
    for (const retry of retries) {
      expect(retry).toMatchObject({ status: "rejected", reason: {
        code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: receipt.id,
      } });
    }
    expect(approvals.approvals.get(approval.id)).toMatchObject({
      status: "uncertain", executionReceiptId: receipt.id,
    });
    expect(receipts.receipts.get(receipt.id)).toMatchObject({
      status: "uncertain", errorCode: "stale_approval",
    });
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("replays a success committed between the stale receipt read and reconciliation", async () => {
    const { actionCall, advance, approvals, receipts, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue",
      params: {}, idempotencyKey: "completion-during-stale-replay" });
    await service.approve(approval.id, principal.userId);
    approvals.approvals.get(approval.id)!.status = "executing";
    const receipt = receiptForApproval(approval, "reserved");
    await receipts.reserve(receipt);
    receipts.receipts.get(receipt.id)!.status = "running";
    advance(65_001);

    const originalClaim = approvals.claim.bind(approvals);
    vi.spyOn(approvals, "claim").mockImplementationOnce(async (input) => {
      await approvals.succeedWithReceipt({ approvalId: approval.id, receipt,
        result: { id: "committed_issue" }, now: input.now, deadlineAt: input.deadlineAt });
      return originalClaim(input);
    });

    await expect(service.executeApproved(principal, approval.id)).resolves.toMatchObject({
      id: receipt.id, status: "succeeded", result: { id: "committed_issue" },
    });
    expect(approvals.approvals.get(approval.id)).toMatchObject({
      status: "consumed", executionReceiptId: receipt.id,
    });
    expect(receipts.receipts.get(receipt.id)).toMatchObject({
      status: "succeeded", result: { id: "committed_issue" },
    });
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("links a stale succeeded receipt without disclosing its result after binding revocation", async () => {
    const { actionCall, advance, approvals, connections, receipts, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue",
      params: {}, idempotencyKey: "revoked-stale-success" });
    await service.approve(approval.id, principal.userId);
    approvals.approvals.get(approval.id)!.status = "executing";
    const receipt = receiptForApproval(approval, "reserved");
    await receipts.reserve(receipt);
    Object.assign(receipts.receipts.get(receipt.id)!, { status: "succeeded", result: { id: "issue_1" } });
    advance(65_001);
    await connections.revoke(principal.userId, approval.connectionId);
    await expect(service.executeApproved(principal, approval.id))
      .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(approvals.approvals.get(approval.id)).toMatchObject({
      status: "uncertain", executionReceiptId: receipt.id,
    });
    expect(receipts.receipts.get(receipt.id)).toMatchObject({
      status: "succeeded", result: { id: "issue_1" },
    });
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("rejects a mismatched effect receipt instead of adopting it during stale reconciliation", async () => {
    const { actionCall, advance, approvals, receipts, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue",
      params: {}, idempotencyKey: "foreign-effect" });
    await service.approve(approval.id, principal.userId);
    approvals.approvals.get(approval.id)!.status = "executing";
    const receipt = receiptForApproval(approval, "reserved");
    await receipts.reserve(receipt);
    Object.assign(receipts.receipts.get(receipt.id)!, { status: "running", approvalId: "foreign" });
    await expect(service.executeApproved(principal, approval.id))
      .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    advance(65_001);
    await expect(service.executeApproved(principal, approval.id))
      .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    expect(approvals.approvals.get(approval.id)?.status).toBe("executing");
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("marks a timed-out provider invocation uncertain and denies replay", async () => {
    let workspaceId = "";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("connection_bindings")) return { rows: [{ workspace_id: workspaceId,
        provider_connection_id: "plug_linear", ownership: "personal", owner_user_id: "user_1",
        status: "active", readiness: "ready" }] };
      if (sql.includes("workspace_memberships")) return { rows: [{ id: "membership_1" }] };
      if (sql.includes("omr_identity.sessions")) return { rows: [{ id: "session_1",
        expires_at: new Date(Date.now() + 60_000) }] };
      return { rows: [] };
    });
    const end = vi.fn(async () => undefined);
    const guard = new PostgresExecutionInvocationGuard({ query, end } as never, 15);
    const { actionCall, approvals, receipts, service, workspace } = await fixture(
      undefined, undefined, false, guard,
    );
    workspaceId = workspace.id;
    const principal = { kind: "web" as const, userId: "user_1", workspaceId, sessionId: "session_1" };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue", params: {} });
    await service.approve(approval.id, principal.userId);
    actionCall.mockImplementation(() => new Promise(() => undefined));
    const error = await service.executeApproved(principal, approval.id).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: expect.any(String) });
    expect(receipts.receipts.get(error.receiptId)).toMatchObject({ status: "uncertain",
      errorCode: "invocation_outcome_unknown" });
    expect(approvals.approvals.get(approval.id)).toMatchObject({ status: "uncertain",
      executionReceiptId: error.receiptId });
    await expect(service.executeApproved(principal, approval.id))
      .rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: error.receiptId });
    expect(actionCall).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it.each([
    ["web", "read"], ["web", "approved effect"],
    ["client", "read"], ["client", "approved effect"],
  ] as const)("does not dispatch a %s %s after reservation outlives the revocation lock", async (kind, operation) => {
    let workspaceId = "";
    let revoked = false;
    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("connection_bindings")) return { rows: [{ workspace_id: workspaceId,
        provider_connection_id: "plug_linear", ownership: "personal", owner_user_id: "user_1",
        status: revoked ? "revoked" : "active", readiness: "ready" }] };
      if (sql.includes("workspace_memberships")) return { rows: [{ id: "membership_1" }] };
      if (sql.includes("omr_identity.sessions")) return { rows: [{ id: "session_1",
        expires_at: new Date(Date.now() + 60_000) }] };
      if (sql.includes("omr_control.clients")) return { rows: [{ workspace_id: workspaceId, revoked_at: null }] };
      if (sql.includes("client_grants")) return { rows: [{ client_id: "client_1",
        workspace_id: workspaceId, user_id: "user_1", capabilities: ["tools:read", "tools:write"],
        revoked_at: null, expires_at: new Date(Date.now() + 60_000) }] };
      return { rows: [] };
    });
    const end = vi.fn(async () => undefined);
    const guard = new PostgresExecutionInvocationGuard({ query, end } as never, 150);
    const { actionCall, approvals, receipts, service, workspace } = await fixture(undefined, undefined, false, guard);
    workspaceId = workspace.id;
    const principal = kind === "web"
      ? { kind, userId: "user_1", workspaceId, sessionId: "session_1" } as const
      : { kind, userId: "user_1", workspaceId, clientId: "client_1", grantId: "grant_1",
        capabilities: ["tools:read", "tools:write", "approvals:create"] as const };
    const approval = operation === "approved effect"
      ? await requestApproval(service, { principal, toolId: "linear.create_issue", params: {} })
      : null;
    if (approval) await service.approve(approval.id, principal.userId);
    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const reserved = new Promise<void>((resolve) => { entered = resolve; });
    const reserve = receipts.reserve.bind(receipts);
    vi.spyOn(receipts, "reserve").mockImplementation(async (receipt) => {
      entered();
      await hold;
      return reserve(receipt);
    });
    const pending = approval
      ? service.executeApproved(principal, approval.id)
      : service.execute({ principal, toolId: "linear.get_issue", params: {} });
    await reserved;
    await expect(pending).rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
    expect(end).toHaveBeenCalledOnce();
    expect(queries.at(-1)).not.toBe("ROLLBACK");
    // A revocation can now commit because the transaction has released its locks.
    revoked = true;
    release();
    await vi.waitFor(() => expect([...receipts.receipts.values()][0]?.status).toBe("failed"));
    expect(actionCall).not.toHaveBeenCalled();
    if (approval) {
      expect(approvals.approvals.get(approval.id)?.status).toBe("failed");
      await expect(service.executeApproved(principal, approval.id))
        .rejects.toBeInstanceOf(ApprovalUnavailableError);
    }
  });

  it.each([
    ["web", "read"], ["web", "approved effect"],
    ["client", "read"], ["client", "approved effect"],
  ] as const)("reconciles a committed %s %s reservation whose INSERT response is lost", async (kind, operation) => {
    let workspaceId = "";
    let closed = false;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("connection_bindings")) return { rows: [{ workspace_id: workspaceId,
        provider_connection_id: "plug_linear", ownership: "personal", owner_user_id: "user_1",
        status: "active", readiness: "ready" }] };
      if (sql.includes("workspace_memberships")) return { rows: [{ id: "membership_1" }] };
      if (sql.includes("omr_identity.sessions")) return { rows: [{ id: "session_1",
        expires_at: new Date(Date.now() + 60_000) }] };
      if (sql.includes("omr_control.clients")) return { rows: [{ workspace_id: workspaceId, revoked_at: null }] };
      if (sql.includes("client_grants")) return { rows: [{ client_id: "client_1",
        workspace_id: workspaceId, user_id: "user_1", capabilities: ["tools:read", "tools:write"],
        revoked_at: null, expires_at: new Date(Date.now() + 60_000) }] };
      return { rows: [] };
    });
    const end = vi.fn(async () => { closed = true; });
    const guard = new PostgresExecutionInvocationGuard({ query, end } as never, 40);
    const { actionCall, approvals, receipts, service, workspace } = await fixture(undefined, undefined, false, guard);
    workspaceId = workspace.id;
    const principal = kind === "web"
      ? { kind, userId: "user_1", workspaceId, sessionId: "session_1" } as const
      : { kind, userId: "user_1", workspaceId, clientId: "client_1", grantId: "grant_1",
        capabilities: ["tools:read", "tools:write", "approvals:create"] as const };
    const approval = operation === "approved effect"
      ? await requestApproval(service, { principal, toolId: "linear.create_issue", params: {},
        idempotencyKey: `lost-insert-${kind}` })
      : null;
    if (approval) await service.approve(approval.id, principal.userId);
    let release!: () => void;
    let inserted!: () => void;
    const heldResponse = new Promise<void>((resolve) => { release = resolve; });
    const committed = new Promise<void>((resolve) => { inserted = resolve; });
    const reserve = receipts.reserve.bind(receipts);
    vi.spyOn(receipts, "reserve").mockImplementation(async (receipt) => {
      const result = await reserve(receipt); // Commit before the response reaches the service.
      inserted();
      await heldResponse;
      return result;
    });
    const fail = receipts.fail.bind(receipts);
    vi.spyOn(receipts, "fail").mockImplementation((...args) => closed
      ? Promise.reject(new Error("receipt client closed")) : fail(...args));
    const pending = approval
      ? service.executeApproved(principal, approval.id)
      : service.execute({ principal, toolId: "linear.get_issue", params: {},
        idempotencyKey: `lost-insert-${kind}` });
    await committed;
    await expect(pending).rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
    expect(closed).toBe(true);
    expect(actionCall).not.toHaveBeenCalled();
    const stored = [...receipts.receipts.values()][0]!;
    expect(stored.status).toBe("reserved");
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actionCall).not.toHaveBeenCalled();
    const replay = await reserve({ ...stored, id: `execution_replay_${kind}_${operation}`,
      startedAt: stored.startedAt + 65_001 });
    expect(replay).toMatchObject({ created: false, receipt: { id: stored.id,
      status: "failed", errorCode: "reservation_expired" } });
    if (approval) {
      expect(approvals.approvals.get(approval.id)?.status).toBe("failed");
      await expect(service.executeApproved(principal, approval.id))
        .rejects.toBeInstanceOf(ApprovalUnavailableError);
    }
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("treats a stale dispatch transition as uncertain instead of replayable", async () => {
    const store = new MemoryExecutionReceiptStore(() => true);
    const { receipts, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const first = await service.execute({ principal, toolId: "linear.get_issue", params: {},
      idempotencyKey: "stale-dispatch-control" });
    const receipt = receipts.receipts.get(first.id)!;
    const reserved = { ...receipt, id: "execution_stale_dispatch", status: "reserved" as const,
      result: null, errorCode: null, completedAt: null, startedAt: 1_700_000_000_000,
      createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
      idempotencyKey: "stale-dispatch" };
    await store.reserve(reserved);
    await store.beginDispatch(reserved.id, reserved.startedAt + 1);
    const replay = await store.reserve({ ...reserved, id: "execution_retry",
      startedAt: reserved.startedAt + 65_001 });
    expect(replay).toMatchObject({ created: false, receipt: { id: reserved.id,
      status: "uncertain", errorCode: "invocation_outcome_unknown" } });
    await expect(store.beginDispatch(reserved.id, reserved.startedAt + 65_002))
      .rejects.toThrow("Execution reservation is unavailable");
  });

  it.each(["web", "client"] as const)("rechecks %s credential expiry at the actual dispatch boundary", async (kind) => {
    let workspaceId = "";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("connection_bindings")) return { rows: [{ workspace_id: workspaceId,
        provider_connection_id: "plug_linear", ownership: "personal", owner_user_id: "user_1",
        status: "active", readiness: "ready" }] };
      if (sql.includes("workspace_memberships")) return { rows: [{ id: "membership_1" }] };
      if (sql.includes("omr_identity.sessions")) return { rows: [{ id: "session_1",
        expires_at: new Date(Date.now() + 300) }] };
      if (sql.includes("omr_control.clients")) return { rows: [{ workspace_id: workspaceId, revoked_at: null }] };
      if (sql.includes("client_grants")) return { rows: [{ client_id: "client_1",
        workspace_id: workspaceId, user_id: "user_1", capabilities: ["tools:read"],
        revoked_at: null, expires_at: new Date(Date.now() + 300) }] };
      return { rows: [] };
    });
    const guard = new PostgresExecutionInvocationGuard({ query } as never, 2_000);
    const { actionCall, receipts, service, workspace } = await fixture(undefined, undefined, false, guard);
    workspaceId = workspace.id;
    const principal = kind === "web"
      ? { kind, userId: "user_1", workspaceId, sessionId: "session_1" } as const
      : { kind, userId: "user_1", workspaceId, clientId: "client_1", grantId: "grant_1",
        capabilities: ["tools:read"] as const };
    const reserve = receipts.reserve.bind(receipts);
    vi.spyOn(receipts, "reserve").mockImplementation(async (receipt) => {
      await new Promise((resolve) => setTimeout(resolve, 450));
      return reserve(receipt);
    });
    await expect(service.execute({ principal, toolId: "linear.get_issue", params: {} }))
      .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(actionCall).not.toHaveBeenCalled();
    expect([...receipts.receipts.values()][0]?.status).toBe("failed");
  });

  it("rechecks approval expiry after reservation before provider dispatch", async () => {
    const { actionCall, advance, approvals, receipts, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await requestApproval(service, { principal, toolId: "linear.create_issue", params: {} });
    await service.approve(approval.id, principal.userId);
    const reserve = receipts.reserve.bind(receipts);
    vi.spyOn(receipts, "reserve").mockImplementation(async (receipt) => {
      const result = await reserve(receipt);
      advance(600_001);
      return result;
    });
    await expect(service.executeApproved(principal, approval.id))
      .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    expect(actionCall).not.toHaveBeenCalled();
    expect(approvals.approvals.get(approval.id)?.status).toBe("failed");
    expect([...receipts.receipts.values()][0]?.status).toBe("failed");
  });

  it("binds the empty-workspace web approval route to actor, workspace, and current membership", async () => {
    let member = true;
    let expectedWorkspaceId = "";
    const guard: ExecutionInvocationGuard = { run: vi.fn(async ({ principal }, invoke) => {
      expect(principal.workspaceId).toBe(expectedWorkspaceId);
      if (!member) throw Object.assign(new Error("membership revoked"), { code: "CONNECTION_ACCESS_DENIED" });
      return invoke(() => undefined);
    }) };
    const { actionCall, approvals, service, workspace } = await fixture(undefined, undefined, false, guard);
    expectedWorkspaceId = workspace.id;
    const requestPrincipal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const makeApproval = async () => {
      const approval = await requestApproval(service, { principal: requestPrincipal,
        toolId: "linear.create_issue", params: {} });
      await service.approve(approval.id, requestPrincipal.userId);
      return approval;
    };
    const actorBound = await makeApproval();
    await expect(service.executeApproved({ kind: "web", userId: "user_2", workspaceId: "" }, actorBound.id))
      .rejects.toBeInstanceOf(ApprovalUnavailableError);
    const workspaceBound = await makeApproval();
    await expect(service.executeApproved({ ...requestPrincipal, workspaceId: "workspace_other" }, workspaceBound.id))
      .rejects.toBeInstanceOf(ApprovalUnavailableError);
    const revoked = await makeApproval();
    member = false;
    await expect(service.executeApproved({ ...requestPrincipal, workspaceId: "", sessionId: "session_1" }, revoked.id))
      .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(approvals.approvals.get(revoked.id)?.status).toBe("failed");
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("requires client approval capability and rejects expired approvals", async () => {
    const { actionCall, service, workspace, advance } = await fixture();
    const client = {
      kind: "client" as const,
      userId: "user_1",
      workspaceId: workspace.id,
      clientId: "client_1",
      grantId: "grant_1",
      capabilities: ["tools:write" as const],
    };
    await expect(requestApproval(service, {
      principal: client,
      toolId: "linear.create_issue",
      params: {},
    })).rejects.toBeInstanceOf(ExecutionCapabilityDeniedError);

    const approval = await requestApproval(service, {
      principal: { kind: "web", userId: "user_1", workspaceId: workspace.id },
      toolId: "linear.create_issue",
      params: {},
      ttlMs: 60_000,
    });
    advance(60_001);
    await expect(service.approve(approval.id, "user_1"))
      .rejects.toBeInstanceOf(ApprovalUnavailableError);
    expect(actionCall).not.toHaveBeenCalled();
  });

  it("lists activity only for the requested actor and workspace", async () => {
    const { approvals, receipts, service, workspace } = await fixture();
    await service.execute({
      principal: { kind: "web", userId: "user_1", workspaceId: workspace.id },
      toolId: "linear.get_issue",
      params: { id: "issue_1" },
    });
    await requestApproval(service, {
      principal: { kind: "web", userId: "user_1", workspaceId: workspace.id },
      toolId: "linear.create_issue",
      params: { title: "Review me" },
    });

    await expect(receipts.listForActor({
      workspaceId: workspace.id,
      actorUserId: "user_1",
      limit: 20,
    })).resolves.toEqual([
      expect.objectContaining({ toolId: "linear.get_issue", status: "succeeded" }),
    ]);
    await expect(approvals.listForActor({
      workspaceId: workspace.id,
      actorUserId: "user_1",
      limit: 20,
    })).resolves.toEqual([
      expect.objectContaining({
        toolId: "linear.create_issue",
        params: { title: "Review me" },
        status: "pending",
      }),
    ]);
    await expect(approvals.listForActor({
      workspaceId: workspace.id,
      actorUserId: "user_2",
      limit: 20,
    })).resolves.toEqual([]);
  });
});
