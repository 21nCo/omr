import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolManifest } from "@oh-my-router/tools";
import { afterEach, describe, expect, it } from "vitest";

import { createOMRMcpServer } from "./server.js";

function requestUrl(request: RequestInfo | URL): URL {
  if (typeof request === "string") return new URL(request);
  return request instanceof URL ? request : new URL(request.url);
}

function manifest(id: string, effect: ToolManifest["contract"]["effect"]): ToolManifest {
  const [provider, ...actionParts] = id.split(".");
  return {
    catalogSchemaVersion: "1.0.0",
    id,
    provider: provider!,
    providerVersion: "1.0.0",
    action: actionParts.join("."),
    displayName: id,
    description: `Test tool ${id}`,
    contract: {
      version: "1.0.0",
      effect,
      requiredScopes: [],
      resources: [],
      sensitiveKeys: [],
      pagination: { kind: "none" },
      retry: effect === "read" ? "safe" : "never",
    },
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    hash: `hash-${id}`,
  };
}

describe("OMR MCP server", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close().catch(() => undefined)));
  });

  it("projects reads, creates approvals for writes, and exposes control-plane tools", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl: typeof fetch = async (request, init) => {
      const url = requestUrl(request);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      requests.push({ path: url.pathname, body });
      if (url.pathname === "/api/tools") {
        return Response.json({
          catalogSchemaVersion: "1.0.0",
          revision: "revision-1",
          tools: [manifest("demo.read", "read"), manifest("demo.write", "write")],
        });
      }
      if (url.pathname === "/api/tools/execute") {
        return Response.json({ status: "succeeded", output: { value: "read" } });
      }
      if (url.pathname === "/api/connections/list") {
        return Response.json([{ id: "connection-1", provider: "demo" }]);
      }
      if (url.pathname === "/api/connections/select") {
        return Response.json({ provider: "demo", connectionId: "connection-1" });
      }
      if (url.pathname === "/api/approvals") {
        return Response.json({
          id: "approval-1",
          status: "pending",
          expiresAt: 1_800_000,
        }, { status: 201 });
      }
      if (url.pathname === "/api/approvals/execute") {
        return Response.json({ id: "receipt-1", status: "succeeded" });
      }
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    };
    const server = await createOMRMcpServer({
      baseUrl: "https://omr.test",
      credential: "credential",
      workspaceId: "workspace-1",
      fetchImpl,
    });
    const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual([
      "demo.read",
      "demo.write",
      "omr.approvals.execute",
      "omr.catalog.providers",
      "omr.catalog.refresh",
      "omr.connections.list",
      "omr.connections.select",
    ]);

    await expect(client.callTool({
      name: "demo.read",
      arguments: { value: "read" },
    })).resolves.toMatchObject({
      structuredContent: { status: "succeeded", output: { value: "read" } },
    });
    const discoveryCalls = requests.filter(({ path }) => path === "/api/tools").length;
    await expect(client.callTool({
      name: "omr.connections.list",
      arguments: { provider: "demo" },
    })).resolves.toMatchObject({
      structuredContent: { connections: [{ id: "connection-1", provider: "demo" }] },
    });
    expect(requests.filter(({ path }) => path === "/api/tools")).toHaveLength(discoveryCalls);
    await expect(client.callTool({
      name: "omr.connections.select",
      arguments: { provider: "demo", connectionId: "connection-1" },
    })).resolves.toMatchObject({
      structuredContent: { provider: "demo", connectionId: "connection-1" },
    });
    expect(requests.find(({ path }) => path === "/api/connections/select")?.body).toEqual({
      workspaceId: "workspace-1", provider: "demo", connectionId: "connection-1",
    });
    await expect(client.callTool({
      name: "demo.write",
      arguments: { value: "write" },
    })).resolves.toMatchObject({
      structuredContent: {
        status: "approval_required",
        executed: false,
        approvalId: "approval-1",
        toolId: "demo.write",
        resume: {
          tool: "omr.approvals.execute",
          arguments: { approvalId: "approval-1" },
        },
      },
    });
    await expect(client.callTool({
      name: "omr.approvals.execute",
      arguments: { approvalId: "approval-1" },
    })).resolves.toMatchObject({
      structuredContent: { id: "receipt-1", status: "succeeded" },
    });

    expect(requests.filter(({ path }) => path === "/api/tools/execute")).toHaveLength(1);
    expect(requests.find(({ path }) => path === "/api/approvals")?.body).toEqual({
      workspaceId: "workspace-1",
      toolId: "demo.write",
      params: { value: "write" },
    });
    expect(requests.find(({ path }) => path === "/api/approvals/execute")?.body).toEqual({
      approvalId: "approval-1",
    });
  });

  it("preserves OMR error response details in MCP tool errors", async () => {
    const fetchImpl: typeof fetch = async (request) => {
      const url = requestUrl(request);
      if (url.pathname === "/api/tools") {
        return Response.json({
          catalogSchemaVersion: "1.0.0",
          revision: "revision-1",
          tools: [],
        });
      }
      return Response.json({ error: "APPROVAL_UNAVAILABLE" }, { status: 409 });
    };
    const server = await createOMRMcpServer({
      baseUrl: "https://omr.test",
      credential: "credential",
      workspaceId: "workspace-1",
      fetchImpl,
    });
    const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    await expect(client.callTool({
      name: "omr.approvals.execute",
      arguments: { approvalId: "approval-missing" },
    })).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          code: "OMR_HTTP_ERROR",
          details: { error: "APPROVAL_UNAVAILABLE" },
        },
      },
    });
  });

  it("keeps control tools callable during discovery failure and fails closed for projected actions", async () => {
    let catalogFails = false;
    let executions = 0;
    const fetchImpl: typeof fetch = async (request) => {
      const path = requestUrl(request).pathname;
      if (path === "/api/tools") return catalogFails
        ? Response.json({ error: "CATALOG_UNAVAILABLE" }, { status: 503 })
        : Response.json({ catalogSchemaVersion: "1.0.0", revision: "test", tools: [manifest("demo.read", "read")] });
      if (path === "/api/connections/list") return Response.json([{ id: "binding", provider: "demo" }]);
      if (path === "/api/approvals/execute") return Response.json({ id: "receipt", status: "succeeded" });
      if (path === "/api/tools/execute") executions += 1;
      return Response.json({ status: "succeeded" });
    };
    const server = await createOMRMcpServer({
      baseUrl: "https://omr.test", credential: "credential", workspaceId: "workspace-1", fetchImpl,
    });
    const client = new Client({ name: "outage", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);
    expect((await client.listTools()).tools.some(({ name }) => name === "demo.read")).toBe(true);

    catalogFails = true;
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toContain("omr.connections.list");
    expect(listed.tools.some(({ name }) => name === "demo.read")).toBe(false);
    await expect(client.callTool({ name: "omr.connections.list", arguments: {} }))
      .resolves.toMatchObject({ structuredContent: { connections: [{ id: "binding" }] } });
    await expect(client.callTool({ name: "omr.approvals.execute", arguments: { approvalId: "approved" } }))
      .resolves.toMatchObject({ structuredContent: { id: "receipt" } });
    for (const name of ["omr.catalog.providers", "omr.catalog.refresh"]) {
      await expect(client.callTool({ name, arguments: {} })).resolves.toMatchObject({
        isError: true,
        structuredContent: { ok: false, error: { code: "OMR_HTTP_ERROR" } },
      });
    }
    await expect(client.callTool({ name: "demo.read", arguments: {} })).rejects.toThrow(/not found/);
    expect(executions).toBe(0);
  });

  it("refreshes newly connected tools and hides revoked or changed tools on the same session", async () => {
    let current: ToolManifest[] = [];
    const fetchImpl: typeof fetch = async (request) =>
      requestUrl(request).pathname === "/api/tools"
        ? Response.json({ catalogSchemaVersion: "1.0.0", revision: "test", tools: current })
        : Response.json({ status: "succeeded" });
    const server = await createOMRMcpServer({
      baseUrl: "https://omr.test", credential: "credential", workspaceId: "workspace-1", fetchImpl,
    });
    const client = new Client({ name: "transition", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    expect((await client.listTools()).tools.some(({ name }) => name === "demo.read")).toBe(false);
    current = [manifest("demo.read", "read")];
    expect((await client.listTools()).tools.some(({ name }) => name === "demo.read")).toBe(false);
    await client.callTool({ name: "omr.catalog.refresh", arguments: {} });
    expect((await client.listTools()).tools.find(({ name }) => name === "demo.read")?._meta)
      .toMatchObject({ manifestHash: "hash-demo.read" });

    current = [];
    expect((await client.listTools()).tools.some(({ name }) => name === "demo.read")).toBe(false);
    await expect(client.callTool({ name: "demo.read", arguments: { value: "x" } }))
      .rejects.toThrow(/not found/);
    current = [{ ...manifest("demo.read", "read"), hash: "changed-schema" }];
    expect((await client.listTools()).tools.some(({ name }) => name === "demo.read")).toBe(false);
    const refresh = await client.callTool({ name: "omr.catalog.refresh", arguments: {} });
    expect(refresh.isError).toBe(true);
  });

  it("notifies a caching client when an already registered tool disappears and reappears", async () => {
    let current = [manifest("demo.read", "read")];
    const fetchImpl: typeof fetch = async () => Response.json({
      catalogSchemaVersion: "1.0.0", revision: "test", tools: current,
    });
    const server = await createOMRMcpServer({
      baseUrl: "https://omr.test", credential: "credential", workspaceId: "workspace-1", fetchImpl,
    });
    const client = new Client({ name: "notifications", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);
    const notifications: string[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notifications.push("changed");
    });
    current = [];
    await client.callTool({ name: "omr.catalog.refresh", arguments: {} });
    expect((await client.listTools()).tools.some(({ name }) => name === "demo.read")).toBe(false);
    expect(notifications).toEqual(["changed"]);
    current = [manifest("demo.read", "read")];
    const restored = await client.callTool({ name: "omr.catalog.refresh", arguments: {} });
    expect(restored.structuredContent).toMatchObject({ added: 0, tools: 1 });
    expect(notifications).toEqual(["changed", "changed"]);
    expect((await client.listTools()).tools.some(({ name }) => name === "demo.read")).toBe(true);
    await client.callTool({ name: "omr.catalog.refresh", arguments: {} });
    expect(notifications).toHaveLength(2);
  });

  it("serves the projected catalog over stateless Streamable HTTP", async () => {
    const apiFetch: typeof fetch = async (request) => {
      if (requestUrl(request).pathname === "/api/tools") {
        return Response.json({
          catalogSchemaVersion: "1.0.0",
          revision: "revision-1",
          tools: [manifest("demo.read", "read")],
        });
      }
      return Response.json({ status: "succeeded", output: { value: "remote" } });
    };
    const server = await createOMRMcpServer({
      baseUrl: "https://omr.test",
      credential: "credential",
      workspaceId: "workspace-1",
      fetchImpl: apiFetch,
    });
    const handler = await server.createWebStandardHandler({ enableJsonResponse: true });
    const transport = new StreamableHTTPClientTransport(new URL("https://omr.test/mcp"), {
      fetch: async (request, init) => handler(new Request(request, init)),
    });
    const client = new Client({ name: "remote-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    closeables.push(client, server);

    await expect(client.listTools()).resolves.toMatchObject({
      tools: expect.arrayContaining([expect.objectContaining({ name: "demo.read" })]),
    });
    await expect(client.callTool({ name: "demo.read", arguments: { value: "remote" } }))
      .resolves.toMatchObject({
        structuredContent: { status: "succeeded", output: { value: "remote" } },
      });
  });
});
