import { execFile, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const binary = resolve("packages/mcp/dist/bin.js");
const roots: string[] = [];
const servers: Server[] = [];
const clients: Client[] = [];
const manifest = (effect: "read" | "write") => ({
  catalogSchemaVersion: "1.0.0", id: `demo.${effect}`, provider: "demo",
  providerVersion: "1.0.0", action: effect, displayName: effect, description: effect,
  hash: `hash-${effect}`,
  contract: { version: "1.0.0", effect, requiredScopes: [], resources: [], sensitiveKeys: [],
    pagination: { kind: "none" }, retry: effect === "read" ? "safe" : "never" },
  inputSchema: { type: "object", properties: { value: { type: "string" } },
    required: ["value"], additionalProperties: false }, outputSchema: { type: "object" },
});

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ...Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => !key.startsWith("OMR_") && value !== undefined)), ...extra } as Record<string, string>;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omr-stdio-"));
  roots.push(root);
  const config = join(root, "config");
  const calls: Array<{ path: string; workspace: string | null; auth: string | undefined; body: unknown }> = [];
  let revoked = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let raw = "";
    for await (const chunk of request) raw += chunk.toString();
    const body = raw ? JSON.parse(raw) as unknown : null;
    calls.push({ path: url.pathname, workspace: url.searchParams.get("workspaceId"),
      auth: request.headers.authorization, body });
    const answer = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== "Bearer local-secret" || revoked)
      return answer(401, { error: "CLIENT_CREDENTIAL_INVALID" });
    if (url.pathname === "/api/tools") return answer(200, {
      catalogSchemaVersion: "1.0.0", revision: "fixture", tools: [manifest("read"), manifest("write")],
    });
    if (url.pathname === "/api/tools/execute") return answer(200, { status: "succeeded", output: { ok: true } });
    if (url.pathname === "/api/approvals") return answer(201, { id: "approval-1", status: "pending" });
    if (url.pathname === "/api/approvals/execute") return answer(200, { id: "receipt-1", status: "succeeded" });
    return answer(404, { error: "NOT_FOUND" });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const url = `http://127.0.0.1:${address.port}`;
  const saveProfile = (name: string, workspaceId = "workspace-1") => {
    mkdirSync(join(config, "profiles"), { recursive: true, mode: 0o700 });
    writeFileSync(join(config, "profiles", `${name}.json`),
      JSON.stringify({ backend: url, key: "local-secret", workspaceId }), { mode: 0o600 });
  };
  return { root, config, url, calls, saveProfile, revoke: () => { revoked = true; } };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe("stdio-mcp-contract", () => {
  it("selects a saved profile and forwards discovery, reads, and approval handoff, then stops on revocation", async () => {
    const f = await fixture();
    f.saveProfile("host", "workspace-host");
    f.saveProfile("other", "workspace-other");
    writeFileSync(join(f.config, "active-profile"), "other\n", { mode: 0o600 });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [binary, "--profile", "host"], env: cleanEnv({ OMR_CONFIG_DIR: f.config }), stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const client = new Client({ name: "fixture-host", version: "1.0.0" }, { capabilities: {} });
    clients.push(client);
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain("demo.read");
    expect(listed.tools.find((tool) => tool.name === "demo.write")?.inputSchema.required)
      .toContain("_omrIdempotencyKey");
    expect((await client.callTool({ name: "demo.read", arguments: { value: "a" } })).structuredContent)
      .toMatchObject({ status: "succeeded" });
    expect((await client.callTool({ name: "demo.write", arguments: {
      value: "b", _omrIdempotencyKey: "stable-key",
    } })).structuredContent).toMatchObject({ status: "approval_required", approvalId: "approval-1" });
    expect((await client.callTool({ name: "omr.approvals.execute", arguments: {
      approvalId: "approval-1",
    } })).structuredContent).toMatchObject({ id: "receipt-1" });
    expect(f.calls.find((call) => call.path === "/api/tools")?.workspace).toBe("workspace-host");
    expect(f.calls.filter((call) => call.path === "/api/approvals").at(-1)?.body)
      .toMatchObject({ workspaceId: "workspace-host", idempotencyKey: "stable-key" });
    expect(f.calls.filter((call) => call.path === "/api/tools/execute")).toHaveLength(1);
    expect(stderr).toBe("");

    f.revoke();
    await expect(client.callTool({ name: "demo.read", arguments: { value: "after" } }))
      .rejects.toThrow();
    expect(f.calls.filter((call) => call.path === "/api/tools/execute")).toHaveLength(1);
    expect(stderr).not.toContain("local-secret");
  });

  it("selects an explicit headless grant and rejects incomplete or missing login before protocol startup", async () => {
    const f = await fixture();
    const env = cleanEnv({ OMR_CONFIG_DIR: f.config, OMR_BACKEND: f.url,
      OMR_API_KEY: "local-secret", OMR_WORKSPACE_ID: "headless-workspace" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [binary], env, stderr: "pipe" });
    const client = new Client({ name: "headless", version: "1.0.0" }, { capabilities: {} });
    clients.push(client);
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("demo.read");
    expect(f.calls.find((call) => call.path === "/api/tools")?.workspace).toBe("headless-workspace");
    await client.close();
    clients.splice(clients.indexOf(client), 1);

    for (const extra of [{ OMR_BACKEND: f.url }, { OMR_WORKSPACE_ID: "workspace-1" }]) {
      const result = await exec(process.execPath, [binary], { env: cleanEnv({ OMR_CONFIG_DIR: f.config, ...extra }) })
        .then(() => ({ stderr: "" }), (error: { stderr: string }) => ({ stderr: error.stderr }));
      expect(result.stderr).toContain("Set OMR_BACKEND and OMR_API_KEY together");
      expect(result.stderr).not.toContain("local-secret");
    }
    const missing = await exec(process.execPath, [binary, "--profile", "missing"],
      { env: cleanEnv({ OMR_CONFIG_DIR: f.config }) })
      .then(() => ({ stderr: "" }), (error: { stderr: string }) => ({ stderr: error.stderr }));
    expect(missing.stderr).toContain("run omr login");
  });

  it("keeps stdout protocol-only on malformed input and exits when the host closes stdin", async () => {
    const f = await fixture();
    const child = spawn(process.execPath, [binary], { env: cleanEnv({ OMR_CONFIG_DIR: f.config,
      OMR_BACKEND: f.url, OMR_API_KEY: "local-secret", OMR_WORKSPACE_ID: "workspace-1" }) });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code) => resolve(code));
    });
    try {
      child.stdin.write("not-json\n");
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {},
          clientInfo: { name: "raw-fixture", version: "1.0.0" } } })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
      for (let n = 0; n < 150 && !stdout.includes('"id":2'); n++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stdout).toContain('"id":2');
      child.stdin.end();
      expect(await closed).toBe(0);
      expect(stdout).not.toContain("local-secret");
      expect(stderr).not.toContain("local-secret");
      for (const line of stdout.trim().split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
      expect(stdout).toContain("demo.read");
    } finally { child.kill(); }
  });

  it("installs both archives without workspace dependencies or changing another host entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "omr-mcp-pack-"));
    roots.push(root);
    const prefix = join(root, "prefix");
    mkdirSync(prefix);
    const hostConfig = join(prefix, "host.json");
    const original = '{"mcpServers":{"other":{"command":"/existing/tool"}}}';
    writeFileSync(hostConfig, original);
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const pack = async (workspace: string) => {
      const { stdout } = await exec(npm, ["pack", `--workspace=${workspace}`,
        "--pack-destination", root], { cwd: resolve("."), env: cleanEnv() });
      return join(root, stdout.trim().split("\n").at(-1)!);
    };
    const cliArchive = await pack("@oh-my-router/cli");
    const mcpArchive = await pack("@oh-my-router/mcp");
    await exec(npm, ["install", "--prefix", prefix, "--ignore-scripts", "--no-package-lock",
      "--no-audit", "--no-fund", cliArchive, mcpArchive], { cwd: root, env: cleanEnv() });
    const installed = join(prefix, "node_modules", "@oh-my-router", "mcp", "dist", "bin.js");
    const binDir = join(prefix, "node_modules", ".bin");
    expect(existsSync(installed)).toBe(true);
    expect(existsSync(join(binDir, process.platform === "win32" ? "omr-mcp.cmd" : "omr-mcp"))).toBe(true);
    expect(existsSync(join(binDir, process.platform === "win32" ? "omr.cmd" : "omr"))).toBe(true);
    expect(readFileSync(hostConfig, "utf8")).toBe(original);
    const executable = process.platform === "win32" ? process.execPath : join(binDir, "omr-mcp");
    const args = process.platform === "win32" ? [installed] : [];
    const missing = await exec(executable, args, { cwd: root,
      env: cleanEnv({ OMR_CONFIG_DIR: join(root, "missing-config") }) })
      .then(() => ({ stderr: "" }), (error: { stderr: string }) => ({ stderr: error.stderr }));
    expect(missing.stderr).toContain("run omr login");
    expect(missing.stderr).not.toContain("Cannot find package");
    await expect(import(join(prefix, "node_modules", "@oh-my-router", "mcp", "dist", "index.js")))
      .resolves.toHaveProperty("createOMRMcpServer");
  }, 30_000);
});
