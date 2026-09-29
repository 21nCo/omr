import assert from "node:assert/strict";

// Load the distributable after Worker globals are installed. The MCP SDK's
// bundled validator selects its CSP-safe path when its module first loads.
globalThis.WebSocketPair = class {};
const NativeFunction = globalThis.Function;
globalThis.Function = new Proxy(NativeFunction, {
  apply() { throw new Error("Worker forbids dynamic code generation"); },
  construct() { throw new Error("Worker forbids dynamic code generation"); },
});

const { createOMRMcpServer } = await import("../../packages/mcp/dist/index.js");
let executions = 0;
const manifest = {
  catalogSchemaVersion: "1.0.0",
  id: "demo.read",
  provider: "demo",
  providerVersion: "1.0.0",
  action: "read",
  displayName: "Read demo",
  description: "Read a demo value",
  contract: {
    version: "1.0.0", effect: "read", requiredScopes: [], resources: [],
    sensitiveKeys: [], pagination: { kind: "none" }, retry: "safe",
  },
  inputSchema: {
    type: "object", properties: { value: { type: "string" } },
    required: ["value"], additionalProperties: false,
  },
  outputSchema: { type: "object" },
  hash: "hash-demo.read",
};
const fetchImpl = async (request) => {
  const path = new URL(typeof request === "string" ? request : request.url).pathname;
  if (path === "/api/tools") {
    return Response.json({ catalogSchemaVersion: "1.0.0", revision: "test", tools: [manifest] });
  }
  assert.equal(path, "/api/tools/execute");
  executions += 1;
  return Response.json({ status: "succeeded", output: { value: "remote" } });
};

const server = await createOMRMcpServer({
  baseUrl: "https://omr.test", credential: "test", workspaceId: "workspace-1",
  fetchImpl, statelessHttp: true,
});
try {
  const handler = await server.createWebStandardHandler({ enableJsonResponse: true });
  const call = async (id, value) => {
    const response = await handler(new Request("https://omr.test/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id, method: "tools/call",
        params: { name: "demo.read", arguments: { value } },
      }),
    }));
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const valid = await call(1, "remote");
  assert.equal(valid.structuredContent.output.value, "remote");
  const invalid = await call(2, 42);
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, "MCPFN_INVALID_ARGUMENTS");
  assert.equal(executions, 1);
  process.stdout.write(JSON.stringify({
    valid: valid.structuredContent.output.value,
    invalid: invalid.structuredContent.error.code,
    executions,
  }));
} finally {
  await server.close();
}
