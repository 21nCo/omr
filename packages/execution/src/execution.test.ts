import { describe, expect, it, vi } from "vitest";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { ConnectionAuthority, ConnectionSelectionRequiredError } from "@oh-my-router/connections";
import { MemoryConnectionBindingStore } from "@oh-my-router/connections/testing";
import { ToolCatalog, usableToolIds, type ToolEffect } from "@oh-my-router/tools";

import {
  ApprovalUnavailableError,
  ExecutionApprovalRequiredError,
  ExecutionCapabilityDeniedError,
  ExecutionIdempotencyConflictError,
  ExecutionService,
} from "./execution.js";
import { MemoryExecutionApprovalStore, MemoryExecutionReceiptStore } from "./testing.js";

async function fixture(allowedProviders?: ReadonlySet<string>, initialScopes = ["issues:read", "repo"]) {
  let now = 1_700_000_000_000;
  let grantedScopes = initialScopes;
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
      },
    }] },
  }, (value) => value as never, allowedProviders);
  const actionCall = vi.fn(async () => ({ id: "issue_1", title: "Fixed" }));
  const receipts = new MemoryExecutionReceiptStore();
  const approvals = new MemoryExecutionApprovalStore();
  return {
    actionCall,
    approvals,
    catalog,
    connections,
    firstBinding,
    receipts,
    workspace,
    setScopes(scopes: string[]) { grantedScopes = scopes; },
    service: new ExecutionService(
      catalog,
      connections,
      { action: actionCall },
      receipts,
      async () => grantedScopes,
      () => now,
      approvals,
    ),
    advance(ms: number) { now += ms; },
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
      sensitiveKeys: [],
      pagination: { kind: "none" as const },
      retry: effect === "read" ? "safe" as const : "never" as const,
    },
  };
}

describe("execution service", () => {
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
    await expect(service.requestApproval({ principal, toolId: "linear.create_issue", params: {} }))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    expect(approvals.approvals.size).toBe(0);
    expect(receipts.receipts.size).toBe(0);
    setScopes(["issues:read", "repo"]);
    await expect(service.execute({ principal, toolId: "linear.get_issue", params: {} }))
      .resolves.toMatchObject({ status: "succeeded" });
    const approval = await service.requestApproval({ principal, toolId: "linear.create_issue", params: {} });
    await service.approve(approval.id, "user_1");
    setScopes(["issues:read"]);
    await expect(service.executeApproved(principal, approval.id))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    expect(approvals.approvals.get(approval.id)?.status).toBe("failed");
    expect(actionCall).toHaveBeenCalledTimes(1);
  });

  it("does not execute or request approval for an unconfigured provider, even with a ready old binding", async () => {
    const { actionCall, service, workspace } = await fixture(new Set());
    const input = {
      principal: { kind: "web" as const, userId: "user_1", workspaceId: workspace.id },
      toolId: "linear.get_issue", params: {},
    };
    await expect(service.execute(input)).rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    await expect(service.requestApproval({ ...input, toolId: "linear.create_issue" }))
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

  it("records a sanitized failed receipt while preserving the provider error for the caller", async () => {
    const { actionCall, receipts, service, workspace } = await fixture();
    actionCall.mockRejectedValueOnce(new Error("provider secret detail"));
    await expect(service.execute({
      principal: { kind: "web", userId: "user_1", workspaceId: workspace.id },
      toolId: "linear.get_issue",
      params: {},
    })).rejects.toThrow("provider secret detail");
    expect([...receipts.receipts.values()][0]).toMatchObject({
      status: "failed",
      errorCode: "provider_execution_failed",
    });
    expect(JSON.stringify([...receipts.receipts.values()])).not.toContain("provider secret detail");
  });

  it("binds a single-use approval to the exact actor, principal, manifest, connection, and params", async () => {
    const { actionCall, approvals, service, workspace } = await fixture();
    const principal = { kind: "web" as const, userId: "user_1", workspaceId: workspace.id };
    const approval = await service.requestApproval({
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
    expect(actionCall).toHaveBeenCalledWith("linear", "create_issue", expect.objectContaining({
      params: { title: "Approved title" },
      retry: { maxAttempts: 1, backoff: "exponential" },
    }));
    expect(approvals.approvals.get(approval.id)).toMatchObject({
      status: "consumed",
      executionReceiptId: receipt.id,
    });
    await expect(service.executeApproved(principal, approval.id))
      .rejects.toBeInstanceOf(ApprovalUnavailableError);
    expect(actionCall).toHaveBeenCalledTimes(1);
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
    await expect(service.requestApproval({
      principal: client,
      toolId: "linear.create_issue",
      params: {},
    })).rejects.toBeInstanceOf(ExecutionCapabilityDeniedError);

    const approval = await service.requestApproval({
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
    await service.requestApproval({
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
