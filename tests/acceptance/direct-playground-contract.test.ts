import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { compile } from "svelte/compiler";
import { ConnectionAuthority } from "@oh-my-router/connections";
import { MemoryConnectionBindingStore } from "@oh-my-router/connections/testing";
import { ExecutionService, publicApproval, publicReceipt } from "@oh-my-router/execution";
import { MemoryExecutionApprovalStore, MemoryExecutionReceiptStore } from "@oh-my-router/execution/testing";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { ToolCatalog } from "@oh-my-router/tools";
import { createOMRRouter } from "../../apps/web/src/lib/server/router.js";
import { publicBrowserApprovalStatus } from "../../apps/web/src/lib/server/reconciliation-receipts.js";
import { createPlaygroundRequest, parsePlaygroundArguments, playgroundConnectionReady,
  playgroundError, resumablePlaygroundApproval, schemaHints } from "../../apps/web/src/lib/direct-playground.js";
import { directPlaygroundEnabled } from "../../apps/web/src/lib/server/direct-playground-rollout.js";
import { load as playgroundLoad } from "../../apps/web/src/routes/app/playground/+page.server.js";

describe("direct-playground-contract", () => {
  it("keeps the rollout closed and offers schema and keyboard-friendly JSON guidance", async () => {
    expect(directPlaygroundEnabled(undefined)).toBe(false);
    expect(directPlaygroundEnabled({ OMR_DIRECT_PLAYGROUND_ENABLED: "false" })).toBe(false);
    expect(directPlaygroundEnabled({ OMR_DIRECT_PLAYGROUND_ENABLED: "true" })).toBe(true);
    await expect(Promise.resolve().then(() => playgroundLoad({ platform: { env: {} } } as never)))
      .rejects.toMatchObject({ status: 404 });
    expect(playgroundLoad({ platform: { env: { OMR_DIRECT_PLAYGROUND_ENABLED: "true" } } } as never))
      .toEqual({});
    const source = readFileSync(new URL("../../apps/web/src/routes/app/playground/+page.svelte",
      import.meta.url), "utf8");
    const compiled = compile(source, { filename: "+page.svelte" });
    expect(compiled.warnings.filter((warning) => warning.code.startsWith("a11y_"))).toEqual([]);
    for (const control of ["playground-workspace", "playground-connection", "playground-tool",
      "playground-arguments"]) {
      expect(source).toContain(`for="${control}"`);
      expect(source).toContain(`id="${control}"`);
    }
    expect(source).toContain('role="alert"');
    expect(() => parsePlaygroundArguments("[1]")).toThrow("JSON object");
    expect(() => parsePlaygroundArguments("{")).toThrow("valid JSON");
    expect(parsePlaygroundArguments('{"title":"Hello"}')).toEqual({ title: "Hello" });
    const catalog = await ToolCatalog.create({ providers: { list: () => [{
      name: "demo", displayName: "Demo", version: "1.0.0", description: "Fixture",
      actions: { read: { name: "read", displayName: "Read", description: "Read a fixture",
        parameters: { type: "object", required: ["title"], properties: {
          title: { type: "string", description: "Fixture title" }, optional: { type: "number" },
        } }, returns: { type: "object" } } },
    }] } }, (value) => value as never);
    expect(schemaHints(catalog.get("demo.read"))).toEqual([
      { name: "title", type: "string", required: true, description: "Fixture title" },
      { name: "optional", type: "number", required: false, description: "" },
    ]);
    const readyConnection = { id: "one", workspaceId: "mine", provider: "demo",
      label: "Account", status: "active", readiness: "ready", selected: true,
      providerState: "ready", selectable: true };
    expect(playgroundConnectionReady(readyConnection, "mine")).toBe(true);
    expect(playgroundConnectionReady({ ...readyConnection, workspaceId: "other" }, "mine")).toBe(false);
    expect(playgroundConnectionReady({ ...readyConnection, providerState: "unconfigured",
      selectable: false }, "mine")).toBe(false);
    expect(playgroundConnectionReady({ ...readyConnection, selectable: false }, "mine")).toBe(false);
    const browserApproval = { id: "approval", workspaceId: "mine", connectionId: "one",
      toolId: "demo.write", status: "pending", params: {}, previewReady: true,
      manifestCurrent: true, expiresAt: Date.now() + 60_000, browserActionable: true };
    expect(resumablePlaygroundApproval(browserApproval, "mine")).toBe(true);
    expect(resumablePlaygroundApproval({ ...browserApproval, browserActionable: false }, "mine")).toBe(false);
    expect(resumablePlaygroundApproval(browserApproval, "other")).toBe(false);
  });

  it("uses the shared catalog and execution service for a read and an approved write", async () => {
    const actorUserId = "web_user";
    const workspaceStore = new MemoryWorkspaceStore();
    const workspaces = new WorkspaceAuthority(workspaceStore);
    const { workspace } = await workspaces.provisionPersonalWorkspace({ userId: actorUserId });
    const { workspace: foreign } = await workspaces.provisionPersonalWorkspace({ userId: "other_user" });
    const connections = new ConnectionAuthority(new MemoryConnectionBindingStore(workspaceStore));
    const binding = await connections.attach({ actorUserId, workspaceId: workspace.id,
      provider: "demo", providerConnectionId: "provider_demo", ownership: "personal", label: "Demo" });
    await connections.select({ actorUserId, workspaceId: workspace.id, provider: "demo",
      connectionId: binding.id });
    const catalog = await ToolCatalog.create({ providers: { list: () => [{
      name: "demo", displayName: "Demo", version: "1.0.0", description: "Fixture",
      actions: Object.fromEntries(["read", "write"].map((name) => [name, {
        name, displayName: name, description: `Fixture ${name}`,
        parameters: { type: "object", required: ["title"], properties: {
          title: { type: "string", minLength: 1 }, secret: { type: "string" },
        }, additionalProperties: false }, returns: { type: "object" },
        contract: { version: "1.0.0", effect: name === "read" ? "read" : "write",
          requiredScopes: [], resources: [{ kind: "item", parameter: "title" }],
          sensitiveKeys: ["secret"], pagination: { kind: "none" }, retry: "never" },
      }])),
    }] } }, (value) => value as never);
    const canAccess = (workspaceId: string, userId: string) =>
      [...workspaceStore.memberships.values()].some((member) =>
        member.workspaceId === workspaceId && member.userId === userId);
    const receipts = new MemoryExecutionReceiptStore(canAccess);
    const approvals = new MemoryExecutionApprovalStore(canAccess, receipts);
    const provider = vi.fn(async (_id: string, action: string, params: unknown) => ({ action, params }));
    const service = new ExecutionService(catalog, connections, { action: provider }, receipts,
      async () => [], Date.now, approvals, undefined, new Uint8Array(32).fill(4));
    const principal = (workspaceId: string) => ({ kind: "web" as const, userId: actorUserId, workspaceId });
    const router = createOMRRouter(undefined, undefined, {
      discover: async (_request, input) => { await workspaces.requireMembership(input.workspaceId, actorUserId);
        return catalog.discover({ ...input }); },
      manifest: async (_request, toolId, workspaceId) => {
        await workspaces.requireMembership(workspaceId, actorUserId); return catalog.get(toolId);
      },
    }, {
      execute: async (_request, input) => publicReceipt(await service.execute({ ...input,
        principal: principal(input.workspaceId), params: input.params as never })),
      requestApproval: async (_request, input) => publicApproval(await service.requestApproval({ ...input,
        principal: principal(input.workspaceId), params: input.params as never }), catalog.get(input.toolId)),
      approve: async (_request, id) => publicApproval(await service.approve(id, actorUserId), catalog.get("demo.write")),
      reject: async (_request, id) => publicApproval(await service.reject(id, actorUserId), catalog.get("demo.write")),
      executeApproved: async (_request, id) => publicReceipt(await service.executeApproved(
        principal(workspace.id), id)),
      approvalStatus: async (_request, id, workspaceId) => publicBrowserApprovalStatus(
        await service.approvalStatus(principal(workspaceId ?? ""), id), catalog.get("demo.write"), true),
    });
    const api = createPlaygroundRequest(async (path, init) => router.handle(new Request(
      `https://omr.invalid${path}`, init)), () => { throw new Error("unexpected login redirect"); });

    const discovered = await api<{ tools: { id: string }[] }>(`/api/tools?workspaceId=${workspace.id}`);
    expect(discovered.tools.map((tool) => tool.id)).toEqual(["demo.read", "demo.write"]);
    const read = await api<{ id: string; status: string; result: unknown }>("/api/tools/execute", {
      workspaceId: workspace.id, connectionId: binding.id, toolId: "demo.read", params: { title: "fixture" },
    });
    expect(read).toMatchObject({ status: "succeeded", result: { action: "read" } });
    expect(read.id).toBeTruthy();
    expect(provider).toHaveBeenCalledTimes(1);

    await expect(api("/api/tools/execute", { workspaceId: workspace.id, connectionId: binding.id,
      toolId: "demo.read", params: { wrong: true } })).rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    await expect(api("/api/tools/execute", { workspaceId: foreign.id, connectionId: binding.id,
      toolId: "demo.read", params: { title: "foreign" } })).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(provider).toHaveBeenCalledTimes(1);

    const approval = await api<{ id: string; status: string; params: unknown; previewReady: boolean }>(
      "/api/approvals", { workspaceId: workspace.id, connectionId: binding.id, toolId: "demo.write",
        params: { title: "fixture", secret: "hidden" }, idempotencyKey: "fixture-write-1" });
    expect(approval).toMatchObject({ status: "pending", previewReady: true,
      params: { title: "fixture", secret: "[REDACTED]" } });
    expect(provider).toHaveBeenCalledTimes(1);
    await expect(api("/api/approvals/execute", { approvalId: approval.id }))
      .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    expect(provider).toHaveBeenCalledTimes(1);
    await api("/api/approvals/approve", { approvalId: approval.id });
    const write = await api<{ id: string; status: string; result: unknown }>("/api/approvals/execute",
      { approvalId: approval.id });
    expect(write).toMatchObject({ status: "succeeded", result: { action: "write" } });
    expect(write.id).toBeTruthy();
    expect(provider).toHaveBeenCalledTimes(2);
    const settled = await api<{ status: string; actionKeyDigest: string }>(
      `/api/approvals/status?approvalId=${approval.id}&workspaceId=${workspace.id}`);
    expect(settled.status).toBe("consumed");
    expect(settled.actionKeyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(settled)).not.toContain("fixture-write-1");
    const replay = await api<{ id: string }>("/api/approvals/execute", { approvalId: approval.id });
    expect(replay.id).toBe(write.id);
    expect(provider).toHaveBeenCalledTimes(2);
    await expect(api(`/api/approvals/status?approvalId=${approval.id}&workspaceId=${foreign.id}`))
      .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    const repeated = await api<{ id: string; status: string }>("/api/approvals", {
      workspaceId: workspace.id, connectionId: binding.id, toolId: "demo.write",
      params: { title: "fixture", secret: "hidden" }, idempotencyKey: "fixture-write-1",
    });
    expect(repeated).toMatchObject({ id: approval.id, status: "consumed" });
    expect(provider).toHaveBeenCalledTimes(2);
    await connections.revoke(actorUserId, binding.id);
    await expect(api("/api/tools/execute", { workspaceId: workspace.id, connectionId: binding.id,
      toolId: "demo.read", params: { title: "after revoke" } })).rejects
      .toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("surfaces provider and interruption errors with receipt guidance", async () => {
    const request = createPlaygroundRequest(async () => Response.json({
      error: "EXECUTION_OUTCOME_UNKNOWN", receiptId: "receipt_1",
    }, { status: 502 }), vi.fn());
    await expect(request("/api/approvals/execute", { approvalId: "approval_1" }))
      .rejects.toSatisfy((error: unknown) => playgroundError(error).includes("Receipt: receipt_1") &&
        playgroundError(error).includes("Verify the receipt"));
  });
});
