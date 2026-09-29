import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { OMRHttpError } from "@oh-my-router/client";
import { ConnectionAuthority } from "@oh-my-router/connections";
import { MemoryConnectionBindingStore } from "@oh-my-router/connections/testing";
import { ExecutionService, ExecutionInvocationDeadlineError, ExecutionOutcomeUnknownError,
  publicApproval, publicReceipt, type ExecutionInvocationGuard,
  type ExecutionReceipt,
  type ExecutionPrincipal } from "@oh-my-router/execution";
import { PostgresExecutionInvocationGuard } from "@oh-my-router/execution/postgres";
import { MemoryExecutionApprovalStore, MemoryExecutionReceiptStore } from "@oh-my-router/execution/testing";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { ToolCatalog, type ToolEffect } from "@oh-my-router/tools";
import { createOMRMcpServer } from "@oh-my-router/mcp";
import { createOMRRouter, type ExecutionRouteServices, type ToolRouteServices } from "../../apps/web/src/lib/server/router.js";

const execFileAsync = promisify(execFile);

function action(name: string, effect: ToolEffect) {
  return { name, displayName: name, description: name, parameters: { type: "object" },
    returns: { type: "object" }, contract: { version: "1.0.0", effect,
      requiredScopes: [], resources: [], sensitiveKeys: ["secretField", "items[*].pin", "metadata.*.pin",
        "wholeItems[*]", "nested.rows[*][*]"],
      pagination: { kind: "none" as const }, retry: "never" as const } };
}

async function protocolHarness(server: ReturnType<typeof createServer>, name: string,
  cliTimeout: number) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Protocol fixture listener is unavailable");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const mcp = await createOMRMcpServer({ baseUrl, credential: "mcp-fixture", workspaceId: "workspace_1" });
  const client = new McpClient({ name, version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  return { baseUrl, client,
    runCli: (args: string[]) => execFileAsync(process.execPath,
      [join(process.cwd(), "packages/cli/dist/bin.js"), ...args, "--json"], {
        env: { ...process.env, OMR_BACKEND: baseUrl, OMR_API_KEY: "cli-fixture",
          OMR_WORKSPACE_ID: "workspace_1" }, timeout: cliTimeout,
      }).then(() => { throw new Error("CLI unexpectedly succeeded"); },
        (error: { code: number; stdout: string; stderr: string }) => error),
    close: async () => {
      await Promise.all([client.close(), mcp.close()]);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

describe("execution-policy-contract", () => {
  it("returns a near-deadline SQL wait through web, CLI and MCP before their client timeout", async () => {
    const catalog = await ToolCatalog.create({ providers: { list: () => [{
      name: "linear", displayName: "Linear", version: "1.0.0", description: "Linear",
      actions: { read: action("read", "read") },
    }] } }, (value) => value as never);
    const provider = vi.fn();
    const timeline: string[] = [];
    const run = async (afterDispatch: boolean) => {
      let releaseWait!: () => void;
      const wait = new Promise<void>((resolve) => { releaseWait = resolve; });
      let queue = Promise.resolve();
      const query = vi.fn((sql: string) => {
        const result = queue.then(async () => {
          timeline.push(sql);
          if (sql.includes("connection_bindings")) return { rows: [{ workspace_id: "workspace_1",
            provider_connection_id: "remote_1", ownership: "workspace", owner_user_id: null,
            status: "active", readiness: "ready" }] };
          if (sql.includes("workspace_memberships")) {
            if (!afterDispatch) await wait;
            return { rows: [{ id: "membership_1" }] };
          }
          if (sql.includes("omr_control.clients")) return { rows: [{ workspace_id: "workspace_1", revoked_at: null }] };
          if (sql.includes("client_grants")) return { rows: [{ client_id: "client_1",
            workspace_id: "workspace_1", user_id: "user_1", capabilities: ["tools:read", "tools:write"],
            revoked_at: null, expires_at: new Date(Date.now() + 60_000) }] };
          return { rows: [] };
        });
        queue = result.then(() => undefined, () => undefined);
        return result;
      });
      const end = vi.fn(async () => { timeline.push("DISCONNECT"); releaseWait(); });
      const guard = new PostgresExecutionInvocationGuard({ query, end } as never, 140);
      try {
        return await guard.run({ principal: { kind: "client", userId: "user_1",
          workspaceId: "workspace_1", clientId: "client_1", grantId: "grant_1",
          capabilities: ["tools:read", "tools:write"] },
        connection: { id: "binding_1", workspaceId: "workspace_1", providerConnectionId: "remote_1" } as never,
        capability: afterDispatch ? "tools:write" : "tools:read" }, async () => {
          provider();
          return new Promise<never>(() => undefined);
        });
      } catch (error) {
        if (afterDispatch && error instanceof ExecutionInvocationDeadlineError) {
          throw new ExecutionOutcomeUnknownError("receipt_after_dispatch");
        }
        throw error;
      }
    };
    const execution: ExecutionRouteServices = {
      execute: async () => run(false),
      requestApproval: async () => ({}),
      approve: async () => ({}),
      reject: async () => ({}),
      executeApproved: async (_request, approvalId) => run(approvalId === "after-dispatch"),
    };
    const tools: ToolRouteServices = {
      discover: async () => catalog.discover(),
      manifest: async () => null,
    };
    const router = createOMRRouter(undefined, undefined, tools, execution);
    const server = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const response = await router.handle(new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method, headers: incoming.headers as HeadersInit,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    });
    const harness = await protocolHarness(server, "queued-sql", 5_000);
    const { baseUrl, client, runCli } = harness;
    try {
      const [web, cliRead, cliBefore, cliAfter, mcpRead, mcpBefore, mcpAfter] = await Promise.all([
        fetch(`${baseUrl}/api/tools/execute`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId: "workspace_1", toolId: "linear.read", params: {} }) }),
        runCli(["tools", "run", "linear.read"]),
        runCli(["approvals", "execute", "before-dispatch"]),
        runCli(["approvals", "execute", "after-dispatch"]),
        client.callTool({ name: "linear.read", arguments: {} }),
        client.callTool({ name: "omr.approvals.execute", arguments: { approvalId: "before-dispatch" } }),
        client.callTool({ name: "omr.approvals.execute", arguments: { approvalId: "after-dispatch" } }),
      ]);
      expect(web.status).toBe(504);
      await expect(web.json()).resolves.toEqual({ error: "EXECUTION_INVOCATION_TIMEOUT" });
      for (const error of [cliRead, cliBefore]) {
        expect(error.code).toBe(24);
        expect(error.stdout + error.stderr).toContain("EXECUTION_INVOCATION_TIMEOUT");
      }
      expect(cliAfter.stdout + cliAfter.stderr).toContain("EXECUTION_OUTCOME_UNKNOWN");
      expect(cliAfter.stdout + cliAfter.stderr).toContain("receipt_after_dispatch");
      for (const response of [mcpRead, mcpBefore]) {
        expect(response).toMatchObject({ isError: true, structuredContent: { ok: false,
          error: { details: { error: "EXECUTION_INVOCATION_TIMEOUT" } } } });
      }
      expect(mcpAfter).toMatchObject({ isError: true, structuredContent: { ok: false,
        error: { details: { error: "EXECUTION_OUTCOME_UNKNOWN", receiptId: "receipt_after_dispatch" } } } });
      expect(timeline.filter((sql) => sql === "DISCONNECT")).toHaveLength(7);
      expect(timeline).not.toContain("ROLLBACK");
      expect(provider).toHaveBeenCalledTimes(2);
    } finally {
      await harness.close();
    }
  }, 10_000);

  it("delivers delayed execution errors through CLI and MCP after the old client timeout", async () => {
    const catalog = await ToolCatalog.create({ providers: { list: () => [{
      name: "linear", displayName: "Linear", version: "1.0.0", description: "Linear",
      actions: { read: action("read", "read") },
    }] } }, (value) => value as never);
    const server = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      if (incoming.url?.startsWith("/api/tools?")) {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(catalog.discover()));
        return;
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as { approvalId?: string } : {};
      const uncertain = incoming.url === "/api/approvals/execute" && body.approvalId === "after-dispatch";
      setTimeout(() => {
        outgoing.writeHead(uncertain ? 502 : 504, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(uncertain
          ? { error: "EXECUTION_OUTCOME_UNKNOWN", receiptId: "receipt_after_dispatch" }
          : { error: "EXECUTION_INVOCATION_TIMEOUT" }));
      }, 30_100);
    });
    const harness = await protocolHarness(server, "delayed-errors", 75_000);
    const { client, runCli } = harness;
    try {
      const [cliRead, cliBefore, cliAfter, mcpRead, mcpBefore, mcpAfter] = await Promise.all([
        runCli(["tools", "run", "linear.read"]),
        runCli(["approvals", "execute", "before-dispatch"]),
        runCli(["approvals", "execute", "after-dispatch"]),
        client.callTool({ name: "linear.read", arguments: {} }),
        client.callTool({ name: "omr.approvals.execute", arguments: { approvalId: "before-dispatch" } }),
        client.callTool({ name: "omr.approvals.execute", arguments: { approvalId: "after-dispatch" } }),
      ]);
      for (const error of [cliRead, cliBefore]) {
        expect(error.code).toBe(24);
        expect(error.stdout + error.stderr).toContain("EXECUTION_INVOCATION_TIMEOUT");
        expect(error.stdout + error.stderr).not.toContain("AbortError");
      }
      expect(cliAfter.stdout + cliAfter.stderr).toContain("EXECUTION_OUTCOME_UNKNOWN");
      expect(cliAfter.stdout + cliAfter.stderr).toContain("receipt_after_dispatch");
      for (const response of [mcpRead, mcpBefore]) {
        expect(response).toMatchObject({ isError: true, structuredContent: { ok: false,
          error: { details: { error: "EXECUTION_INVOCATION_TIMEOUT" } } } });
      }
      expect(mcpAfter).toMatchObject({ isError: true, structuredContent: { ok: false,
        error: { details: { error: "EXECUTION_OUTCOME_UNKNOWN", receiptId: "receipt_after_dispatch" } } } });
    } finally {
      await harness.close();
    }
  }, 80_000);

  it("keeps predispatch timeout and postdispatch uncertainty distinct in CLI JSON errors", async () => {
    const server = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as { approvalId?: string } : {};
      const uncertain = incoming.url === "/api/approvals/execute" && body.approvalId === "after-dispatch";
      outgoing.writeHead(uncertain ? 502 : 504, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(uncertain
        ? { error: "EXECUTION_OUTCOME_UNKNOWN", receiptId: "receipt_after_dispatch" }
        : { error: "EXECUTION_INVOCATION_TIMEOUT" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("CLI fixture listener is unavailable");
      const runCli = (args: string[]) => execFileAsync(process.execPath,
        [join(process.cwd(), "packages/cli/dist/bin.js"), ...args, "--json"], {
          env: { ...process.env, OMR_BACKEND: `http://127.0.0.1:${address.port}`,
            OMR_API_KEY: "cli-fixture", OMR_WORKSPACE_ID: "workspace_1" },
          timeout: 10_000,
        }).then(() => { throw new Error("CLI unexpectedly succeeded"); },
          (error: { code: number; stdout: string; stderr: string }) => error);
      for (const args of [
        ["tools", "run", "linear.read"],
        ["approvals", "execute", "before-dispatch"],
      ]) {
        const error = await runCli(args);
        expect(error.code).toBe(24);
        expect(error.stdout + error.stderr).toContain("EXECUTION_INVOCATION_TIMEOUT");
        expect(error.stdout + error.stderr).not.toContain("receipt_after_dispatch");
      }
      const uncertain = await runCli(["approvals", "execute", "after-dispatch"]);
      expect(uncertain.code).toBe(23);
      expect(uncertain.stdout + uncertain.stderr).toContain("EXECUTION_OUTCOME_UNKNOWN");
      expect(uncertain.stdout + uncertain.stderr).toContain("receipt_after_dispatch");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each(["web", "cli", "mcp"] as const)("uses the same approval, replay and receipt policy on %s", async (surface) => {
    const workspaceStore = new MemoryWorkspaceStore();
    const workspace = (await new WorkspaceAuthority(workspaceStore)
      .provisionPersonalWorkspace({ userId: "user_1" })).workspace;
    const connections = new ConnectionAuthority(new MemoryConnectionBindingStore(workspaceStore));
    await connections.attach({ actorUserId: "user_1", workspaceId: workspace.id,
      provider: "linear", providerConnectionId: "remote_secret_handle",
      ownership: "personal", label: "Linear" });
    const catalog = await ToolCatalog.create({ providers: { list: () => [{
      name: "linear", displayName: "Linear", version: "1.0.0", description: "Linear",
      actions: { read: action("read", "read"), write: action("write", "write"),
        unknown: action("unknown", "unknown"),
        noncanonical: { ...action("noncanonical", "write"), contract: {
          ...action("noncanonical", "write").contract, sensitiveKeys: ["items[00].pin"],
        } },
        opaque: { ...action("opaque", "unknown"), contract: undefined } },
    }] } }, (value) => value as never);
    const provider = vi.fn(async () => ({ result: "private provider result" }));
    const isMember = (workspaceId: string, actorUserId: string) =>
      [...workspaceStore.memberships.values()].some((member) =>
        member.workspaceId === workspaceId && member.userId === actorUserId);
    const receiptStore = new MemoryExecutionReceiptStore(isMember);
    const approvalStore = new MemoryExecutionApprovalStore(isMember, receiptStore);
    const guard: ExecutionInvocationGuard = { run: async (_input, invoke) => {
      await invoke(() => undefined);
      throw new Error("guard COMMIT response lost after durable completion");
    }, runIdentity: async (_input, invoke) => invoke() };
    const service = new ExecutionService(catalog, connections, { action: provider },
      receiptStore, async () => [], Date.now,
      approvalStore, guard, new Uint8Array(32).fill(7));
    const principal = (request: Request): ExecutionPrincipal => surface === "web"
      ? { kind: "web", userId: "user_1", workspaceId: workspace.id }
      : { kind: "client", userId: "user_1", workspaceId: workspace.id,
        clientId: surface, grantId: `${surface}_grant`,
        capabilities: ["tools:read", "tools:write", "approvals:create"] };
    const services: ExecutionRouteServices = {
      execute: async (request, input) => publicReceipt(await service.execute({
        principal: principal(request), ...input, params: input.params as never })),
      requestApproval: async (request, input) => {
        const approval = await service.requestApproval({ principal: principal(request), ...input,
          params: input.params as never });
        return publicApproval(approval, catalog.get(approval.toolId));
      },
      approve: async (_request, id) => {
        const approval = await service.approve(id, "user_1");
        return publicApproval(approval, catalog.get(approval.toolId));
      },
      reject: async (_request, id) => {
        const approval = await service.reject(id, "user_1");
        return publicApproval(approval, catalog.get(approval.toolId));
      },
      executeApproved: async (request, id) => publicReceipt(await service.executeApproved(principal(request), id)),
    };
    const tools: ToolRouteServices = {
      discover: async (_request, input) => catalog.discover(input),
      manifest: async (_request, id) => catalog.get(id),
    };
    const router = createOMRRouter(undefined, undefined, tools, services);
    const fetchImpl = ((request: string | URL | Request, init?: RequestInit) => router.handle(
      request instanceof Request ? request : new Request(request, init),
    )) as typeof fetch;
    const webPost = async (path: string, body: object): Promise<unknown> => {
      const response = await router.handle(new Request(`https://omr.example${path}`, {
        method: "POST", headers: { "content-type": "application/json", origin: "https://omr.example" },
        body: JSON.stringify(body),
      }));
      const payload = await response.json();
      if (!response.ok) throw new OMRHttpError(response.status, path, payload);
      return payload;
    };
    const request = { workspaceId: workspace.id, toolId: "linear.write",
      params: { title: "Review", secretField: "fixture-secret", passphrase: "passphrase-secret",
        privateKey: "private-key-secret", items: [{ pin: "array-PIN" }],
        metadata: { first: { pin: "object-PIN" } }, wholeItems: ["whole-array-secret"],
        nested: { rows: [["nested-array-secret"]] } }, idempotencyKey: `${surface}-write` };
    const seedStaleEffect = async (status: "running" | "uncertain") => {
      const approval = await service.requestApproval({
        principal: principal(new Request("https://omr.example")), workspaceId: workspace.id,
        toolId: "linear.write", params: {}, idempotencyKey: `${surface}-stale-${status}`,
      });
      await service.approve(approval.id, "user_1");
      const stored = approvalStore.approvals.get(approval.id)!;
      stored.status = "executing";
      stored.updatedAt = Date.now() - 70_000;
      const receipt: ExecutionReceipt = {
        id: `execution_${crypto.randomUUID()}`, workspaceId: stored.workspaceId,
        actorUserId: stored.actorUserId, principalKey: stored.principalKey,
        toolId: stored.toolId, manifestHash: stored.manifestHash,
        connectionId: stored.connectionId, providerConnectionId: stored.providerConnectionId,
        idempotencyKey: stored.idempotencyKey, requestHash: stored.requestHash!,
        approvalId: stored.id, status: "reserved", result: null, errorCode: null,
        startedAt: Date.now(), completedAt: null, createdAt: Date.now(), updatedAt: Date.now(),
      };
      await receiptStore.reserve(receipt);
      await receiptStore.beginDispatch(receipt.id, Date.now());
      if (status === "uncertain") await receiptStore.uncertain(receipt.id, "unknown", Date.now());
      return { approvalId: stored.id, receiptId: receipt.id, status };
    };
    const assertSettled = (approvalId: string, receiptId: string,
      status: "running" | "uncertain") => {
      expect(approvalStore.approvals.get(approvalId)).toMatchObject({
        status: "uncertain", executionReceiptId: receiptId,
      });
      expect(receiptStore.receipts.get(receiptId)?.status).toBe(
        status === "running" ? "uncertain" : status);
    };

    if (surface === "cli") {
      const server = createServer(async (incoming, outgoing) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value) headers.set(name, Array.isArray(value) ? value.join(",") : value);
          }
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("CLI fixture listener is unavailable");
          const response = await router.handle(new Request(
            `http://127.0.0.1:${address.port}${incoming.url}`, {
              method: incoming.method, headers,
              ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
            },
          ));
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(await response.text());
        } catch {
          outgoing.writeHead(500);
          outgoing.end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("CLI fixture listener is unavailable");
        const runCli = (args: string[]) => execFileAsync(process.execPath,
          [join(process.cwd(), "packages/cli/dist/bin.js"), ...args, "--json"], {
            env: { ...process.env, OMR_BACKEND: `http://127.0.0.1:${address.port}`,
              OMR_API_KEY: "cli-fixture", OMR_WORKSPACE_ID: workspace.id },
            timeout: 10_000,
          });
        const requestCliApproval = async (args: string[]) => {
          const response = await runCli(args).then(
            () => { throw new Error("Pending approval must exit 20"); },
            (error: { code: number; stdout: string; stderr: string }) => error,
          );
          expect(response.code).toBe(20);
          return response;
        };
        const read = await runCli(["tools", "run", "linear.read"]);
        expect(JSON.parse(read.stdout)).toMatchObject({ status: "succeeded" });
        const opaquePending = await requestCliApproval(["approvals", "request", "linear.opaque", "--params",
          JSON.stringify({ body: "opaque-cli-secret" }), "--idempotency", "opaque-cli"]);
        const opaque = JSON.parse(opaquePending.stdout) as { id: string; params: unknown; previewMode: string };
        expect(opaque).toMatchObject({ params: "[REDACTED]", previewMode: "opaque" });
        expect(opaquePending.stdout).not.toContain("opaque-cli-secret");
        expect(approvalStore.approvals.size).toBe(1);
        await expect(runCli(["tools", "run", "linear.write", "--params", JSON.stringify(request.params)]))
          .rejects.toMatchObject({ code: 20 });
        expect(provider).toHaveBeenCalledTimes(1);
        await expect(runCli(["approvals", "request", "linear.write", "--params",
          JSON.stringify(request.params)])).rejects.toMatchObject({ code: 2 });
        expect(approvalStore.approvals.size).toBe(2);
        await expect(runCli(["approvals", "request", "linear.noncanonical", "--params",
          JSON.stringify({ items: [{ pin: "noncanonical-secret" }] }), "--idempotency", "bad-selector-cli"]))
          .rejects.toMatchObject({ code: 2 });
        expect(approvalStore.approvals.size).toBe(2);
        expect(provider).toHaveBeenCalledTimes(1);
        const pending = await requestCliApproval(["approvals", "request", "linear.write", "--params",
          JSON.stringify(request.params), "--idempotency", request.idempotencyKey]);
        const approval = JSON.parse(pending.stdout) as { id: string; params: unknown };
        const retried = await requestCliApproval(["approvals", "request", "linear.write", "--params",
          JSON.stringify(request.params), "--idempotency", request.idempotencyKey]);
        expect(JSON.parse(retried.stdout)).toMatchObject({ id: approval.id });
        expect(approval.params).toMatchObject({ title: "Review", secretField: "[REDACTED]",
          passphrase: "[REDACTED]", privateKey: "[REDACTED]",
          items: [{ pin: "[REDACTED]" }], metadata: { first: { pin: "[REDACTED]" } },
          wholeItems: ["[REDACTED]"], nested: { rows: [["[REDACTED]"]] } });
        expect(pending.stdout).not.toContain("fixture-secret");
        expect(pending.stdout).not.toMatch(/passphrase-secret|private-key-secret|array-PIN|object-PIN|whole-array-secret|nested-array-secret/);
        expect(pending.stdout).not.toContain("requestHash");
        expect(provider).toHaveBeenCalledTimes(1);
        await webPost("/api/approvals/approve", { approvalId: approval.id });
        const executed = await runCli(["approvals", "execute", approval.id]);
        expect(JSON.parse(executed.stdout)).toMatchObject({ status: "succeeded" });
        expect(JSON.parse((await runCli(["approvals", "execute", approval.id])).stdout))
          .toMatchObject({ id: JSON.parse(executed.stdout).id, status: "succeeded" });
        expect(provider).toHaveBeenCalledTimes(2);
        await webPost("/api/approvals/approve", { approvalId: opaque.id });
        expect(JSON.parse((await runCli(["approvals", "execute", opaque.id])).stdout))
          .toMatchObject({ status: "succeeded" });
        expect(provider).toHaveBeenCalledTimes(3);
        const ambiguous = JSON.parse((await requestCliApproval(["approvals", "request", "linear.write",
          "--params", "{}", "--idempotency", "cli-ambiguous-effect"])).stdout) as { id: string };
        await webPost("/api/approvals/approve", { approvalId: ambiguous.id });
        const staleEffects = await Promise.all(
          (["running", "uncertain"] as const).map(seedStaleEffect));
        provider.mockRejectedValueOnce(Object.assign(new Error("reply lost after effect"), {
          code: "CONNECTION_NOT_FOUND",
        }));
        const failed = await runCli(["approvals", "execute", ambiguous.id])
          .catch((error: { code: number; stdout: string; stderr: string }) => error);
        const errorText = failed.stdout + failed.stderr;
        expect(errorText).toContain("EXECUTION_OUTCOME_UNKNOWN");
        const receiptId = errorText.match(/execution_[\w-]+/)?.[0];
        expect(receiptId).toBeTruthy();
        const replay = await runCli(["approvals", "execute", ambiguous.id]).then(
          () => { throw new Error("An uncertain approval replay unexpectedly succeeded"); },
          (error: { code: number; stdout: string; stderr: string }) => error,
        );
        expect(replay.code).toBe(23);
        expect(replay.stdout + replay.stderr).toContain("EXECUTION_OUTCOME_UNKNOWN");
        expect(replay.stdout + replay.stderr).toContain(receiptId);
        expect(provider).toHaveBeenCalledTimes(4);
        for (const stale of staleEffects) {
          const retry = await runCli(["approvals", "execute", stale.approvalId]).then(
            () => { throw new Error("A stale effect retry unexpectedly succeeded"); },
            (error: { code: number; stdout: string; stderr: string }) => error,
          );
          expect(retry.code).toBe(23);
          expect(retry.stdout + retry.stderr).toContain("EXECUTION_OUTCOME_UNKNOWN");
          expect(retry.stdout + retry.stderr).toContain(stale.receiptId);
          assertSettled(stale.approvalId, stale.receiptId, stale.status);
        }
        expect(provider).toHaveBeenCalledTimes(4);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      return;
    }

    if (surface === "mcp") {
      const server = await createOMRMcpServer({ baseUrl: "https://omr.example", credential: "mcp-fixture",
        workspaceId: workspace.id, fetchImpl });
      const client = new McpClient({ name: "execution-policy-contract", version: "1.0.0" }, { capabilities: {} });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        expect(await client.callTool({ name: "linear.read", arguments: {} }))
          .toMatchObject({ structuredContent: { status: "succeeded" } });
        const opaquePending = await client.callTool({ name: "linear.opaque", arguments: {
          body: "opaque-mcp-secret", _omrIdempotencyKey: "opaque-mcp",
        } });
        expect(opaquePending).toMatchObject({ structuredContent: {
          status: "approval_required", executed: false,
        } });
        expect(JSON.stringify(opaquePending)).not.toContain("opaque-mcp-secret");
        const opaqueId = (opaquePending.structuredContent as { approvalId: string }).approvalId;
        expect(approvalStore.approvals.size).toBe(1);
        expect(await client.callTool({ name: "linear.write", arguments: request.params }))
          .toMatchObject({ isError: true });
        expect(approvalStore.approvals.size).toBe(1);
        expect(await client.callTool({ name: "linear.noncanonical", arguments: {
          items: [{ pin: "noncanonical-secret" }], _omrIdempotencyKey: "bad-selector-mcp",
        } })).toMatchObject({ isError: true });
        expect(approvalStore.approvals.size).toBe(1);
        expect(provider).toHaveBeenCalledTimes(1);
        const args = { ...(request.params as Record<string, unknown>), _omrIdempotencyKey: request.idempotencyKey };
        const pending = await client.callTool({ name: "linear.write", arguments: args });
        expect(pending).toMatchObject({ structuredContent: { status: "approval_required", executed: false } });
        const approvalId = (pending.structuredContent as { approvalId: string }).approvalId;
        const retried = await client.callTool({ name: "linear.write", arguments: args });
        expect(retried).toMatchObject({ structuredContent: { approvalId } });
        expect(JSON.stringify(pending)).not.toContain("fixture-secret");
        expect(JSON.stringify(pending)).not.toMatch(/array-PIN|object-PIN|whole-array-secret|nested-array-secret/);
        expect(JSON.stringify(pending)).not.toContain("requestHash");
        expect(provider).toHaveBeenCalledTimes(1);
        await webPost("/api/approvals/approve", { approvalId });
        const executed = await client.callTool({ name: "omr.approvals.execute", arguments: { approvalId } });
        expect(executed).toMatchObject({ structuredContent: { status: "succeeded" } });
        expect(await client.callTool({ name: "omr.approvals.execute", arguments: { approvalId } }))
          .toMatchObject({ structuredContent: { id: executed.structuredContent?.id, status: "succeeded" } });
        expect(provider).toHaveBeenCalledTimes(2);
        await webPost("/api/approvals/approve", { approvalId: opaqueId });
        expect(await client.callTool({ name: "omr.approvals.execute", arguments: { approvalId: opaqueId } }))
          .toMatchObject({ structuredContent: { status: "succeeded" } });
        expect(provider).toHaveBeenCalledTimes(3);
        const ambiguous = await client.callTool({ name: "linear.write", arguments: {
          _omrIdempotencyKey: "mcp-ambiguous-effect",
        } });
        const ambiguousId = (ambiguous.structuredContent as { approvalId: string }).approvalId;
        await webPost("/api/approvals/approve", { approvalId: ambiguousId });
        const staleEffects = await Promise.all(
          (["running", "uncertain"] as const).map(seedStaleEffect));
        provider.mockRejectedValueOnce(Object.assign(new Error("reply lost after effect"), {
          code: "CONNECTION_NOT_FOUND",
        }));
        const failed = await client.callTool({ name: "omr.approvals.execute", arguments: { approvalId: ambiguousId } });
        expect(failed).toMatchObject({ isError: true, structuredContent: { ok: false,
          error: { details: { error: "EXECUTION_OUTCOME_UNKNOWN", receiptId: expect.any(String) } } } });
        const failedDetails = ((failed.structuredContent as { error: { details: { receiptId: string } } })
          .error.details);
        expect(await client.callTool({ name: "omr.approvals.execute", arguments: { approvalId: ambiguousId } }))
          .toMatchObject({ isError: true, structuredContent: { ok: false,
            error: { details: { error: "EXECUTION_OUTCOME_UNKNOWN",
              receiptId: failedDetails.receiptId } } } });
        expect(failedDetails.receiptId).toMatch(/^execution_/);
        expect(provider).toHaveBeenCalledTimes(4);
        for (const stale of staleEffects) {
          const retry = await client.callTool({ name: "omr.approvals.execute",
            arguments: { approvalId: stale.approvalId } });
          expect(retry).toMatchObject({ isError: true, structuredContent: { ok: false,
            error: { details: { error: "EXECUTION_OUTCOME_UNKNOWN",
              receiptId: stale.receiptId } } } });
          assertSettled(stale.approvalId, stale.receiptId, stale.status);
        }
        expect(provider).toHaveBeenCalledTimes(4);
      } finally {
        await Promise.all([client.close(), server.close()]);
      }
      return;
    }

    const client = {
      execute: (input: object) => webPost("/api/tools/execute", input),
      requestApproval: (input: object) => webPost("/api/approvals", input),
      approve: (id: string) => webPost("/api/approvals/approve", { approvalId: id }),
      executeApproved: (id: string) => webPost("/api/approvals/execute", { approvalId: id }),
    };

    const read = await client.execute({ workspaceId: workspace.id, toolId: "linear.read", params: {} });
    expect(read).toMatchObject({ status: "succeeded" });
    const opaque = await client.requestApproval({ workspaceId: workspace.id, toolId: "linear.opaque",
      params: { body: "opaque-web-secret" }, idempotencyKey: "opaque-web" }) as {
        id: string; params: unknown; previewMode: string;
      };
    expect(opaque).toMatchObject({ params: "[REDACTED]", previewMode: "opaque" });
    expect(JSON.stringify(opaque)).not.toContain("opaque-web-secret");
    expect(approvalStore.approvals.size).toBe(1);
    await expect(client.execute(request)).rejects.toMatchObject({ status: 409,
      body: { error: "EXECUTION_APPROVAL_REQUIRED" } });
    expect(provider).toHaveBeenCalledTimes(1);
    await expect(client.requestApproval({ ...request, idempotencyKey: undefined })).rejects.toMatchObject({ status: 400 });
    expect(approvalStore.approvals.size).toBe(1);
    await expect(client.requestApproval({ workspaceId: workspace.id, toolId: "linear.noncanonical",
      params: { items: [{ pin: "noncanonical-secret" }] }, idempotencyKey: "bad-selector-web" }))
      .rejects.toMatchObject({ status: 400, body: { error: "EXECUTION_INPUT_INVALID" } });
    expect(approvalStore.approvals.size).toBe(1);
    expect(provider).toHaveBeenCalledTimes(1);
    // The first response is lost after the server creates its approval.
    const lost = await router.handle(new Request("https://omr.example/api/approvals", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://omr.example" },
      body: JSON.stringify(request),
    }));
    expect(lost.status).toBe(201);
    const storedId = [...approvalStore.approvals.values()].find((item) =>
      item.idempotencyKey === request.idempotencyKey)?.id;
    const approval = await client.requestApproval(request) as { id: string; params: unknown };
    expect(approval.id).toBe(storedId);
    expect(approvalStore.approvals.size).toBe(2);
    expect(approval.params).toMatchObject({ title: "Review", secretField: "[REDACTED]",
      passphrase: "[REDACTED]", privateKey: "[REDACTED]",
      items: [{ pin: "[REDACTED]" }], metadata: { first: { pin: "[REDACTED]" } },
      wholeItems: ["[REDACTED]"], nested: { rows: [["[REDACTED]"]] } });
    expect(JSON.stringify(approval)).not.toContain("remote_secret_handle");
    expect(JSON.stringify(approval)).not.toContain("fixture-secret");
    expect(JSON.stringify(approval)).not.toMatch(/array-PIN|object-PIN|whole-array-secret|nested-array-secret/);
    expect(approval).not.toHaveProperty("requestHash");
    expect((await client.requestApproval(request) as { id: string }).id).toBe(approval.id);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await client.approve(approval.id)).not.toHaveProperty("requestHash");
    const receipt = await client.executeApproved(approval.id) as { id: string; status: string };
    expect(receipt.status).toBe("succeeded");
    expect(JSON.stringify(receipt)).not.toContain("remote_secret_handle");
    await expect(client.executeApproved(approval.id)).resolves.toMatchObject({
      id: receipt.id, status: "succeeded",
    });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(await client.approve(opaque.id)).toMatchObject({ previewMode: "opaque",
      params: "[REDACTED]" });
    expect(await client.executeApproved(opaque.id)).toMatchObject({ status: "succeeded" });
    expect(provider).toHaveBeenCalledTimes(3);
    const ambiguous = await client.requestApproval({ workspaceId: workspace.id, toolId: "linear.write",
      params: {}, idempotencyKey: "web-ambiguous-effect" }) as { id: string };
    await client.approve(ambiguous.id);
    const staleEffects = await Promise.all(
      (["running", "uncertain"] as const).map(seedStaleEffect));
    provider.mockRejectedValueOnce(Object.assign(new Error("reply lost after effect"), {
      code: "CONNECTION_NOT_FOUND",
    }));
    const failed = await client.executeApproved(ambiguous.id)
      .catch((error: unknown) => error) as OMRHttpError;
    expect(failed).toMatchObject({ status: 502, body: {
      error: "EXECUTION_OUTCOME_UNKNOWN", receiptId: expect.any(String),
    } });
    await expect(client.executeApproved(ambiguous.id)).rejects.toMatchObject({ status: 502, body: {
      error: "EXECUTION_OUTCOME_UNKNOWN", receiptId: failed.body.receiptId,
    } });
    expect(provider).toHaveBeenCalledTimes(4);
    for (const stale of staleEffects) {
      await expect(client.executeApproved(stale.approvalId)).rejects.toMatchObject({ status: 502,
        body: { error: "EXECUTION_OUTCOME_UNKNOWN", receiptId: stale.receiptId } });
      assertSettled(stale.approvalId, stale.receiptId, stale.status);
    }
    expect(provider).toHaveBeenCalledTimes(4);
  });
});
