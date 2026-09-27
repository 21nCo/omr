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
import { ExecutionService, publicApproval, publicReceipt, type ExecutionPrincipal } from "@oh-my-router/execution";
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
      requiredScopes: [], resources: [], sensitiveKeys: ["secretField"],
      pagination: { kind: "none" as const }, retry: "never" as const } };
}

describe("execution-policy-contract", () => {
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
        opaque: { ...action("opaque", "unknown"), contract: undefined } },
    }] } }, (value) => value as never);
    const provider = vi.fn(async () => ({ result: "private provider result" }));
    const approvalStore = new MemoryExecutionApprovalStore();
    const service = new ExecutionService(catalog, connections, { action: provider },
      new MemoryExecutionReceiptStore(), async () => [], Date.now,
      approvalStore, undefined, new Uint8Array(32).fill(7));
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
      approve: async (_request, id) => publicApproval(await service.approve(id, "user_1"), catalog.get("linear.write")),
      reject: async (_request, id) => publicApproval(await service.reject(id, "user_1"), catalog.get("linear.write")),
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
        privateKey: "private-key-secret" }, idempotencyKey: `${surface}-write` };

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
        const read = await runCli(["tools", "run", "linear.read"]);
        expect(JSON.parse(read.stdout)).toMatchObject({ status: "succeeded" });
        await expect(runCli(["approvals", "request", "linear.opaque", "--params", "{}",
          "--idempotency", "opaque-cli"])).rejects.toMatchObject({ code: 1 });
        expect(approvalStore.approvals.size).toBe(0);
        await expect(runCli(["tools", "run", "linear.write", "--params", JSON.stringify(request.params)]))
          .rejects.toMatchObject({ code: 1 });
        expect(provider).toHaveBeenCalledTimes(1);
        await expect(runCli(["approvals", "request", "linear.write", "--params",
          JSON.stringify(request.params)])).rejects.toMatchObject({ code: 1 });
        expect(approvalStore.approvals.size).toBe(0);
        const pending = await runCli(["approvals", "request", "linear.write", "--params",
          JSON.stringify(request.params), "--idempotency", request.idempotencyKey]);
        const approval = JSON.parse(pending.stdout) as { id: string; params: unknown };
        const retried = await runCli(["approvals", "request", "linear.write", "--params",
          JSON.stringify(request.params), "--idempotency", request.idempotencyKey]);
        expect(JSON.parse(retried.stdout)).toMatchObject({ id: approval.id });
        expect(approval.params).toEqual({ title: "Review", secretField: "[REDACTED]",
          passphrase: "[REDACTED]", privateKey: "[REDACTED]" });
        expect(pending.stdout).not.toContain("fixture-secret");
        expect(pending.stdout).not.toMatch(/passphrase-secret|private-key-secret/);
        expect(pending.stdout).not.toContain("requestHash");
        expect(provider).toHaveBeenCalledTimes(1);
        await webPost("/api/approvals/approve", { approvalId: approval.id });
        const executed = await runCli(["approvals", "execute", approval.id]);
        expect(JSON.parse(executed.stdout)).toMatchObject({ status: "succeeded" });
        await expect(runCli(["approvals", "execute", approval.id])).rejects.toMatchObject({ code: 1 });
        expect(provider).toHaveBeenCalledTimes(2);
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
        expect(await client.callTool({ name: "linear.opaque", arguments: {
          _omrIdempotencyKey: "opaque-mcp",
        } })).toMatchObject({ isError: true });
        expect(approvalStore.approvals.size).toBe(0);
        expect(await client.callTool({ name: "linear.write", arguments: request.params }))
          .toMatchObject({ isError: true });
        expect(approvalStore.approvals.size).toBe(0);
        const args = { ...(request.params as Record<string, unknown>), _omrIdempotencyKey: request.idempotencyKey };
        const pending = await client.callTool({ name: "linear.write", arguments: args });
        expect(pending).toMatchObject({ structuredContent: { status: "approval_required", executed: false } });
        const approvalId = (pending.structuredContent as { approvalId: string }).approvalId;
        const retried = await client.callTool({ name: "linear.write", arguments: args });
        expect(retried).toMatchObject({ structuredContent: { approvalId } });
        expect(JSON.stringify(pending)).not.toContain("fixture-secret");
        expect(JSON.stringify(pending)).not.toContain("requestHash");
        expect(provider).toHaveBeenCalledTimes(1);
        await webPost("/api/approvals/approve", { approvalId });
        expect(await client.callTool({ name: "omr.approvals.execute", arguments: { approvalId } }))
          .toMatchObject({ structuredContent: { status: "succeeded" } });
        expect(await client.callTool({ name: "omr.approvals.execute", arguments: { approvalId } }))
          .toMatchObject({ isError: true });
        expect(provider).toHaveBeenCalledTimes(2);
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
    await expect(client.requestApproval({ workspaceId: workspace.id, toolId: "linear.opaque",
      params: {}, idempotencyKey: "opaque-web" })).rejects.toMatchObject({ status: 400,
      body: { error: "EXECUTION_INPUT_INVALID" } });
    expect(approvalStore.approvals.size).toBe(0);
    await expect(client.execute(request)).rejects.toMatchObject({ status: 409,
      body: { error: "EXECUTION_APPROVAL_REQUIRED" } });
    expect(provider).toHaveBeenCalledTimes(1);
    await expect(client.requestApproval({ ...request, idempotencyKey: undefined })).rejects.toMatchObject({ status: 400 });
    expect(approvalStore.approvals.size).toBe(0);
    // The first response is lost after the server creates its approval.
    const lost = await router.handle(new Request("https://omr.example/api/approvals", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://omr.example" },
      body: JSON.stringify(request),
    }));
    expect(lost.status).toBe(201);
    const storedId = [...approvalStore.approvals.keys()][0];
    const approval = await client.requestApproval(request) as { id: string; params: unknown };
    expect(approval.id).toBe(storedId);
    expect(approvalStore.approvals.size).toBe(1);
    expect(approval.params).toEqual({ title: "Review", secretField: "[REDACTED]",
      passphrase: "[REDACTED]", privateKey: "[REDACTED]" });
    expect(JSON.stringify(approval)).not.toContain("remote_secret_handle");
    expect(JSON.stringify(approval)).not.toContain("fixture-secret");
    expect(approval).not.toHaveProperty("requestHash");
    expect((await client.requestApproval(request) as { id: string }).id).toBe(approval.id);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await client.approve(approval.id)).not.toHaveProperty("requestHash");
    const receipt = await client.executeApproved(approval.id) as { id: string; status: string };
    expect(receipt.status).toBe("succeeded");
    expect(JSON.stringify(receipt)).not.toContain("remote_secret_handle");
    await expect(client.executeApproved(approval.id)).rejects.toMatchObject({ status: 409,
      body: { error: "APPROVAL_UNAVAILABLE" } });
    expect(provider).toHaveBeenCalledTimes(2);
  });
});
