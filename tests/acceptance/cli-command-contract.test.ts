import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const binary = resolve("packages/cli/dist/bin.js");
const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const lastError = (stderr: string): Record<string, unknown> => JSON.parse(stderr.trim().split("\n").at(-1)!);
const errorDetails = (stderr: string): Record<string, unknown> => {
  const details = lastError(stderr).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) throw new Error("Missing error details");
  return details as Record<string, unknown>;
};
const toolManifest = {
  catalogSchemaVersion: "1.0.0", id: "linear.read", provider: "linear", providerVersion: "1.0.0",
  action: "read", displayName: "Read", description: "Read a Linear item", hash: "v1",
  contract: { version: "1.0.0", effect: "read", requiredScopes: [], resources: [],
    sensitiveKeys: [], pagination: { kind: "none" }, retry: "safe" },
  inputSchema: { type: "object" }, outputSchema: { type: "object" },
};
const catalogPage = { catalogSchemaVersion: "1.0.0", revision: "revision-1",
  tools: [toolManifest] };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

async function fixture() {
  const calls: { path: string; url: string; body: unknown; authorization: string | undefined }[] = [];
  let revoked = false;
  let deviceLost = false;
  let approvalLost = false;
  let formerMember = false;
  let revokeLost = false;
  let revokeFailureStatus: number | undefined;
  let emptyCatalog = false;
  let grantWorkspace = "workspace_1";
  let nextGrantKey = "omr_fixture_secret";
  let deviceReply: Record<string, unknown> | undefined;
  let releaseRevoke: (() => void) | undefined;
  let revokeHeld = false;
  let releaseCatalog: (() => void) | undefined;
  let catalogHeld = false;
  let selectionOverride: Record<string, unknown> | undefined;
  let approvalStatus: string = "pending";
  let expiresAt = Date.now() + 600_000;
  const malformedSuccess = new Map<string, "json" | "empty" | "shape">();
  const successOverride = new Map<string, unknown>();
  const failureReply = new Map<string, { status: number; body: unknown; committed: boolean }>();
  const committedMutations: { path: string; identity: unknown }[] = [];
  const interrupted = new Map<string, string>();
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    let raw = "";
    for await (const chunk of request) raw += chunk.toString();
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
    calls.push({ path, url: request.url!, body, authorization: request.headers.authorization });
    const answer = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const malformed = malformedSuccess.get(path);
    if (malformed) {
      response.writeHead(path === "/api/approvals" ? 201 : 200, { "content-type": "application/json" });
      const partial = path === "/api/tools/execute" || path === "/api/approvals/execute"
        ? { id: "receipt_partial", status: "succeeded", result: {} }
        : path === "/api/approvals" ? { id: "approval_partial", status: "pending", expiresAt } : {};
      response.end(malformed === "json" ? "{broken" : malformed === "empty" ? "" : JSON.stringify(partial));
      return;
    }
    if (successOverride.has(path)) return answer(path === "/api/device/authorization" ? 201 : 200,
      successOverride.get(path));
    if (path === "/api/device/authorization") return answer(201, {
      deviceCode: "private-device-code", userCode: "ABCD-EFGH", verificationUri: "http://localhost/device",
      verificationUriComplete: "http://localhost/device",
      expiresInSeconds: 5, pollIntervalSeconds: 0,
    });
    if (path === "/api/device/token" && deviceLost) { request.socket.destroy(); return; }
    if (path === "/api/device/token") {
      const failure = failureReply.get(path);
      if (failure) {
        if (failure.committed) committedMutations.push({ path, identity: body?.deviceCode });
        return answer(failure.status, failure.body);
      }
    }
    if (path === "/api/device/token") return answer(200, deviceReply ?? {
      credential: nextGrantKey, clientId: "client_1", grantId: "grant_1", workspaceId: grantWorkspace,
    });
    if (request.headers.authorization !== "Bearer omr_fixture_secret" &&
        request.headers.authorization !== "Bearer replacement_secret" &&
        request.headers.authorization !== "Bearer headless_secret") return answer(401, { error: "CLIENT_CREDENTIAL_INVALID" });
    if (revoked) return answer(401, { error: "CLIENT_CREDENTIAL_INVALID" });
    const failure = failureReply.get(path);
    if (failure) {
      if (failure.committed) committedMutations.push({ path, identity: path === "/api/approvals/execute"
        ? body?.approvalId : body?.idempotencyKey });
      return answer(failure.status, failure.body);
    }
    if (path === "/api/client-grants/revoke-self") {
      if (revokeHeld) await new Promise<void>((resolve) => { releaseRevoke = resolve; });
      if (revokeLost) { request.socket.destroy(); return; }
      if (revokeFailureStatus) return answer(revokeFailureStatus, { error: "SERVER_UNAVAILABLE" });
      if (formerMember) return answer(401, { error: "CLIENT_CREDENTIAL_INVALID" });
      revoked = true; return answer(200, { revoked: true });
    }
    if (path === "/api/tools") {
      if (catalogHeld) await new Promise<void>((resolve) => { releaseCatalog = resolve; });
      if (new URL(request.url!, "http://localhost").searchParams.get("workspaceId") !== grantWorkspace)
        return answer(403, { error: "CONNECTION_ACCESS_DENIED" });
      return answer(200, { ...catalogPage, tools: emptyCatalog ? [] : [toolManifest] });
    }
    if (path === "/api/tools/manifest") return answer(200, toolManifest);
    if (path === "/api/connections/list") return answer(200, [{ id: "connection_1", workspaceId: "workspace_1", provider: "linear" }]);
    if (path === "/api/connections/select") return answer(200, selectionOverride ?? {
      workspaceId: body?.workspaceId, provider: body?.provider, connectionId: body?.connectionId,
      userId: "user_1", createdAt: 1, updatedAt: 1,
    });
    if (path === "/api/tools/execute") {
      if (body?.toolId === "linear.interrupted") {
        const key = String(body.idempotencyKey);
        const prior = interrupted.get(key);
        if (!prior) { interrupted.set(key, `receipt_${interrupted.size + 1}`); return; }
        return answer(200, { id: prior, workspaceId: "workspace_1", toolId: "linear.interrupted",
          status: "succeeded", result: { ok: true } });
      }
      if (body?.toolId === "linear.lost") { request.socket.destroy(); return; }
      if (body?.toolId === "linear.truncated") {
        response.writeHead(200, { "content-type": "application/json", "content-length": "100" });
        response.write('{"status":"succeeded"}');
        response.socket?.destroy();
        return;
      }
      if (body?.toolId === "linear.bad-error") return answer(500, {
        error: "omr_fixture_secret", message: "omr_fixture_secret", receiptId: "omr_fixture_secret",
      });
      if (body?.toolId === "linear.write") return answer(409, { error: "EXECUTION_APPROVAL_REQUIRED" });
      if (body?.toolId === "linear.in-progress") return answer(409,
        { error: "EXECUTION_IN_PROGRESS", receiptId: "receipt_running" });
      if (body?.toolId === "linear.uncertain") return answer(502, { error: "EXECUTION_OUTCOME_UNKNOWN", receiptId: "receipt_1" });
      if (body?.toolId === "linear.receipt-uncertain") return answer(200,
        { id: "receipt_pending", workspaceId: "workspace_1", toolId: body.toolId, status: "uncertain", result: null });
      if (body?.toolId === "linear.receipt-failed") return answer(200,
        { id: "receipt_failed", workspaceId: "workspace_1", toolId: body.toolId, status: "failed", result: null });
      return answer(200, { id: "receipt_1", workspaceId: "workspace_1", toolId: body?.toolId,
        status: "succeeded", result: body?.params });
    }
    if (path === "/api/approvals") {
      if (approvalLost) { request.socket.destroy(); return; }
      return answer(201, { id: "approval_1", workspaceId: "workspace_1", toolId: body?.toolId,
        status: approvalStatus, expiresAt });
    }
    if (path === "/api/approvals/status") return answer(200, { id: "approval_1", workspaceId: "workspace_1",
      toolId: "linear.write", connectionId: "connection_1", status: approvalStatus, expiresAt });
    if (path === "/api/approvals/execute") {
      if (approvalStatus === "executing") return answer(409,
        { error: "EXECUTION_IN_PROGRESS", receiptId: "receipt_approved_running" });
      if (approvalStatus !== "approved" || expiresAt <= Date.now()) return answer(409, { error: "APPROVAL_UNAVAILABLE" });
      return answer(200, { id: "receipt_approved", approvalId: "approval_1", workspaceId: "workspace_1", toolId: "linear.write", connectionId: "connection_1",
        status: "succeeded", result: { ok: true } });
    }
    return answer(404, { error: "NOT_FOUND" });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  const root = mkdtempSync(join(tmpdir(), "omr-cli-contract-"));
  roots.push(root);
  const config = join(root, "config");
  const url = `http://127.0.0.1:${address.port}`;
  async function run(args: string[], env: Record<string, string | undefined> = {}) {
    try {
      const { stdout, stderr } = await exec(process.execPath, [binary, ...args], {
        cwd: root, env: { ...process.env, OMR_CONFIG_DIR: config, OMR_BACKEND: undefined,
          OMR_API_KEY: undefined, OMR_WORKSPACE_ID: undefined, OMR_PROFILE: undefined, ...env },
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    }
  }
  return { run, url, root, config, calls, loseDevice: () => { deviceLost = true; },
    loseApproval: () => { approvalLost = true; }, formerMember: () => { formerMember = true; },
    loseRevoke: () => { revokeLost = true; },
    failRevoke: (status: number) => { revokeFailureStatus = status; },
    clearRevokeFailure: () => { revokeFailureStatus = undefined; },
    malformedSuccess: (path: string, kind: "json" | "empty" | "shape") => { malformedSuccess.set(path, kind); },
    clearMalformed: () => malformedSuccess.clear(),
    successReply: (path: string, value: unknown) => { successOverride.set(path, value); },
    clearSuccessReply: () => successOverride.clear(),
    failAfterCommit: (path: string, status: number, body: unknown) => {
      failureReply.set(path, { status, body, committed: true });
    },
    failureResponse: (path: string, status: number, body: unknown) => {
      failureReply.set(path, { status, body, committed: false });
    },
    clearFailureResponse: () => failureReply.clear(),
    committedMutations,
    interrupted,
    holdRevoke: () => { revokeHeld = true; },
    releaseRevoke: () => { revokeHeld = false; releaseRevoke?.(); },
    holdCatalog: () => { catalogHeld = true; },
    releaseCatalog: () => { catalogHeld = false; releaseCatalog?.(); },
    nextGrant: (key: string) => { nextGrantKey = key; },
    deviceReply: (value: Record<string, unknown>) => { deviceReply = value; },
    selectionReply: (value: Record<string, unknown>) => { selectionOverride = value; },
    emptyCatalog: () => { emptyCatalog = true; },
    setGrantWorkspace: (value: string) => { grantWorkspace = value; },
    setApproval: (status: string, expiry = Date.now() + 600_000) => {
    approvalStatus = status; expiresAt = expiry;
  }, revoke: () => { revoked = true; } };
}

// These contracts launch multiple CLI processes per case; parallel suites can delay their startup.
describe("cli-command-contract", { timeout: 15_000 }, () => {
  it("isolates a malformed active pointer and lets explicit selection repair the default", async () => {
    const f = await fixture();
    expect((await f.run(["login", "--url", f.url, "--profile", "good", "--json"])).code).toBe(0);
    const active = join(f.config, "active-profile");
    writeFileSync(active, "../bad\n", { mode: 0o600 });
    for (const args of [["profiles", "list"], ["workspaces", "list"]]) {
      const listed = await f.run([...args, "--json"]);
      expect(listed.code).toBe(0);
      expect(JSON.parse(listed.stdout)).toMatchObject([{ active: false }]);
      expect(lastError(listed.stderr)).toEqual({ warning: "PROFILE_UNREADABLE", file: "active-profile" });
      expect(listed.stdout + listed.stderr).not.toContain("../bad");
    }
    const defaultShow = await f.run(["workspaces", "show", "--json"]);
    expect(defaultShow.code).toBe(1);
    expect(lastError(defaultShow.stderr).message).toContain("active-profile");
    expect(defaultShow.stdout + defaultShow.stderr).not.toContain("../bad");
    expect((await f.run(["profiles", "show", "--profile", "good", "--json"])).code).toBe(0);
    expect((await f.run(["workspaces", "show", "--profile", "good", "--json"])).code).toBe(0);
    expect((await f.run(["login", "--url", f.url, "--profile", "new", "--json"])).code).toBe(0);
    writeFileSync(active, "../bad\n", { mode: 0o600 });
    expect((await f.run(["logout", "--local", "--profile", "new", "--json"])).code).toBe(0);
    expect((await f.run(["profiles", "use", "good", "--json"])).code).toBe(0);
    expect(JSON.parse((await f.run(["workspaces", "show", "--json"])).stdout)).toMatchObject({
      profile: "good", workspaceId: "workspace_1",
    });
    expect(JSON.parse((await f.run(["profiles", "list", "--json"])).stdout)).toMatchObject([
      { name: "good", active: true },
    ]);
  });

  it("isolates a corrupt sibling profile while listing, selecting and creating profiles", async () => {
    const f = await fixture();
    expect((await f.run(["login", "--url", f.url, "--profile", "good", "--json"])).code).toBe(0);
    const bad = join(f.config, "profiles", "bad.json");
    writeFileSync(bad, '{"key":"corrupt_private_secret",', { mode: 0o600 });
    const listed = await f.run(["profiles", "list", "--json"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject([{ name: "good", workspaceId: "workspace_1" }]);
    expect(lastError(listed.stderr)).toEqual({ warning: "PROFILE_UNREADABLE", file: "bad.json" });
    expect(listed.stdout + listed.stderr).not.toContain("corrupt_private_secret");
    const workspaces = await f.run(["workspaces", "list", "--profile", "good", "--json"]);
    expect(workspaces.code).toBe(0);
    expect(JSON.parse(workspaces.stdout)).toHaveLength(1);
    expect(lastError(workspaces.stderr).file).toBe("bad.json");
    expect((await f.run(["profiles", "use", "good", "--json"])).code).toBe(0);
    const explicit = await f.run(["profiles", "show", "--profile", "bad", "--json"]);
    expect(explicit.code).toBe(1);
    expect(lastError(explicit.stderr).message).toContain("bad.json");
    expect(explicit.stdout + explicit.stderr).not.toContain("corrupt_private_secret");
    const before = f.calls.length;
    const duplicate = await f.run(["login", "--url", f.url, "--profile", "bad", "--json"]);
    expect(lastError(duplicate.stderr).error).toBe("PROFILE_EXISTS");
    expect(f.calls).toHaveLength(before);
    expect((await f.run(["login", "--url", f.url, "--profile", "new", "--json"])).code).toBe(0);
    expect(readFileSync(bad, "utf8")).toContain("corrupt_private_secret");
  });

  it("cleans credential temp files left by an interrupted writer during the next mutation", async () => {
    const f = await fixture();
    mkdirSync(join(f.config, "profiles"), { recursive: true });
    const orphan = "99999999.12345678-1234-1234-1234-123456789abc.tmp";
    const leftovers = [join(f.config, `credentials.${orphan}`),
      join(f.config, `credentials.lock.${orphan}`),
      join(f.config, "profiles", `bad.json.${orphan}`)];
    for (const path of leftovers) writeFileSync(path, "orphan_private_secret", { mode: 0o600 });
    const live = join(f.config, "profiles", `live.json.${process.pid}.12345678-1234-1234-1234-123456789abc.tmp`);
    writeFileSync(live, "live_private_secret", { mode: 0o600 });
    const wrongDirectory = [join(f.config, `bad.json.${orphan}`),
      join(f.config, "profiles", `credentials.${orphan}`)];
    for (const path of wrongDirectory) writeFileSync(path, "retain", { mode: 0o600 });
    const unrelated = join(f.config, "profiles", "notes.tmp");
    writeFileSync(unrelated, "retain");
    expect((await f.run(["login", "--url", f.url, "--profile", "new", "--json"])).code).toBe(0);
    for (const path of leftovers) expect(existsSync(path)).toBe(false);
    expect(readFileSync(live, "utf8")).toBe("live_private_secret");
    for (const path of wrongDirectory) expect(readFileSync(path, "utf8")).toBe("retain");
    expect(readFileSync(unrelated, "utf8")).toBe("retain");
  });

  it("consumes option values without treating positional arguments or terminators as options", async () => {
    const f = await fixture();
    const env = { OMR_BACKEND: f.url, OMR_API_KEY: "headless_secret", OMR_WORKSPACE_ID: "workspace_1" };
    const search = await f.run(["tools", "search", "--query=issue", "--provider", "linear", "--json"], env);
    expect(search.code).toBe(0);
    expect(JSON.parse(search.stdout).tools[0].id).toBe("linear.read");
    const before = f.calls.length;
    const duplicate = await f.run(["tools", "search", "--query", "issue", "--query=again", "--json"], env);
    expect(duplicate.code).toBe(2);
    expect(lastError(duplicate.stderr).error).toBe("INPUT_INVALID");
    const terminator = await f.run(["tools", "list", "--", "--unknown", "another", "--json"], env);
    expect(terminator.code).toBe(2);
    expect(lastError(terminator.stderr).error).toBe("INPUT_INVALID");
    expect(f.calls).toHaveLength(before);
  });

  it("logs in, switches profiles, selects grant-scoped workspace, and stores no printed secret", async () => {
    const f = await fixture();
    const login = await f.run(["login", "--url", f.url, "--profile", "work", "--json"]);
    expect(login.code).toBe(0);
    expect(JSON.parse(login.stdout)).toMatchObject({ profile: "work", workspaceId: "workspace_1" });
    expect(login.stdout + login.stderr).not.toContain("omr_fixture_secret");
    expect(login.stdout + login.stderr).not.toContain("private-device-code");
    expect(JSON.parse((await f.run(["profiles", "list", "--json"])).stdout)).toMatchObject([
      { name: "work", active: true, workspaceId: "workspace_1" },
    ]);
    expect((await f.run(["profiles", "use", "../../escape", "--json"])).code).toBe(2);
    expect((await f.run(["workspaces", "use", "workspace_other", "--json"])).code).toBe(1);
    expect(JSON.parse((await f.run(["workspaces", "show", "--json"])).stdout).workspaceId).toBe("workspace_1");
    const file = join(f.config, "profiles", "work.json");
    expect(readFileSync(file, "utf8")).toContain("omr_fixture_secret");
    if (process.platform !== "win32") {
      expect(statSync(f.config).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(f.config)).not.toContain("credentials");
    expect((await f.run(["logout", "--profile", "work", "--json"])).code).toBe(0);
    expect((await f.run(["tools", "list", "--profile", "work", "--json"])).code).toBe(1);
    expect(f.calls.some((call) => call.path === "/api/client-grants/revoke-self")).toBe(true);
  });

  it("retains a manual remote MCP profile until self-revocation is verified", async () => {
    const f = await fixture();
    const login = await f.run(["login", "--url", f.url, "--kind", "mcp_remote",
      "--capabilities", "tools:discover,tools:read", "--profile", "host", "--json"]);
    expect(login.code).toBe(0);
    expect(f.calls.find((call) => call.path === "/api/device/authorization")?.body)
      .toMatchObject({ clientKind: "mcp_remote", requestedCapabilities: ["tools:discover", "tools:read"] });
    expect(login.stdout + login.stderr).not.toContain("omr_fixture_secret");

    f.failRevoke(503);
    const failed = await f.run(["logout", "--profile", "host", "--json"]);
    expect(failed.code).toBe(3);
    expect(lastError(failed.stderr).error).toBe("REVOCATION_UNVERIFIED");
    expect((await f.run(["profiles", "show", "--profile", "host", "--json"])).code).toBe(0);

    f.clearRevokeFailure();
    const logout = await f.run(["logout", "--profile", "host", "--json"]);
    expect(logout.code).toBe(0);
    expect(JSON.parse(logout.stdout)).toMatchObject({ profile: "host", revoked: true });
    expect(f.calls.filter((call) => call.path === "/api/client-grants/revoke-self"))
      .toHaveLength(2);
    expect((await f.run(["profiles", "show", "--profile", "host", "--json"])).code).toBe(1);
    expect((await fetch(`${f.url}/api/tools?workspaceId=workspace_1`, {
      headers: { authorization: "Bearer omr_fixture_secret" },
    })).status).toBe(401);
  });

  it("defaults manual remote grants to discovery and rejects invalid scope selection before device authorization", async () => {
    const f = await fixture();
    const invalid = [
      ["--kind", "mcp_remote", "--capabilities", "tools:read"],
      ["--kind", "mcp_remote", "--capabilities", "tools:discover,unknown"],
      ["--kind", "mcp_remote", "--capabilities", "tools:discover,"],
      ["--kind", "cli", "--capabilities", "tools:discover"],
    ];
    for (const options of invalid) {
      const result = await f.run(["login", "--url", f.url, ...options, "--json"]);
      expect(result.code).toBe(2);
      expect(lastError(result.stderr).error).toBe("INPUT_INVALID");
    }
    expect(f.calls.filter((call) => call.path === "/api/device/authorization")).toHaveLength(0);
    const login = await f.run(["login", "--url", f.url, "--kind", "mcp_remote", "--json"]);
    expect(login.code).toBe(0);
    expect(f.calls.find((call) => call.path === "/api/device/authorization")?.body)
      .toMatchObject({ requestedCapabilities: ["tools:discover"] });
  });

  it("uses the shared catalog, connection and execution endpoints with JSON flag, file and stdin", async () => {
    const f = await fixture();
    const env = { OMR_BACKEND: f.url, OMR_API_KEY: "headless_secret", OMR_WORKSPACE_ID: "workspace_1" };
    expect(JSON.parse((await f.run(["tools", "search", "--query", "issue", "--provider", "linear", "--json"], env)).stdout).tools[0].id).toBe("linear.read");
    expect(JSON.parse((await f.run(["tools", "inspect", "linear.read", "--json"], env)).stdout).hash).toBe("v1");
    expect(JSON.parse((await f.run(["connections", "list", "--json"], env)).stdout)[0].id).toBe("connection_1");
    expect(JSON.parse((await f.run(["connections", "select", "connection_1", "--provider", "linear", "--json"], env)).stdout).connectionId).toBe("connection_1");
    const path = join(f.root, "params.json"); writeFileSync(path, '{"id":"from-file"}');
    expect(JSON.parse((await f.run(["tools", "run", "linear.read", "--params-file", path, "--json"], env)).stdout).result).toEqual({ id: "from-file" });
    // Supply stdin through a shell-free child process to cover the actual pipe contract.
    const fromStdin = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [binary, "tools", "run", "linear.read", "--params", "-", "--json"],
        { cwd: f.root, env: { ...process.env, ...env, OMR_CONFIG_DIR: f.config } });
      let stdout = ""; child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.on("error", reject); child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
      child.stdin.end('{"id":"from-stdin"}');
    });
    expect(fromStdin.code).toBe(0);
    expect(JSON.parse(fromStdin.stdout).result).toEqual({ id: "from-stdin" });
    expect(f.calls.filter((call) => call.path === "/api/tools/execute").map((call) => (call.body as { params: unknown }).params))
      .toEqual([{ id: "from-file" }, { id: "from-stdin" }]);
  });

  it("switches between two saved profiles and persists an authorized workspace selection", async () => {
    const f = await fixture();
    expect((await f.run(["login", "--url", f.url, "--profile", "work", "--json"])).code).toBe(0);
    const workFile = join(f.config, "profiles", "work.json");
    writeFileSync(workFile, JSON.stringify({ ...JSON.parse(readFileSync(workFile, "utf8")), workspaceId: "workspace_old" }));
    expect((await f.run(["workspaces", "use", "workspace_1", "--json"])).code).toBe(0);
    expect(JSON.parse(readFileSync(workFile, "utf8")).workspaceId).toBe("workspace_1");
    f.setGrantWorkspace("workspace_2");
    expect((await f.run(["login", "--url", f.url, "--profile", "personal", "--json"])).code).toBe(0);
    expect((await f.run(["workspaces", "use", "workspace_2", "--json"])).code).toBe(0);
    expect(JSON.parse((await f.run(["workspaces", "show", "--json"])).stdout)).toMatchObject({
      profile: "personal", workspaceId: "workspace_2",
    });
    expect((await f.run(["profiles", "use", "work", "--json"])).code).toBe(0);
    expect(JSON.parse((await f.run(["workspaces", "show", "--json"])).stdout)).toMatchObject({
      profile: "work", workspaceId: "workspace_1",
    });
    expect(JSON.parse((await f.run(["profiles", "list", "--json"])).stdout)).toMatchObject([
      { name: "personal", active: false }, { name: "work", active: true },
    ]);
  });

  it("maps idempotent approval creation to its actual state and keeps retry keys on lost replies", async () => {
    const f = await fixture();
    const env = { OMR_BACKEND: f.url, OMR_API_KEY: "headless_secret", OMR_WORKSPACE_ID: "workspace_1" };
    const explicit = ["approvals", "request", "linear.write", "--idempotency", "stable-key", "--json"];
    for (const [state, expiry, expected] of [
      ["pending", Date.now() + 600_000, 20],
      ["rejected", Date.now() + 600_000, 21],
      ["approved", Date.now() - 1_000, 22],
      ["consumed", Date.now() + 600_000, 0],
      ["uncertain", Date.now() + 600_000, 23],
    ] as const) {
      f.setApproval(state, expiry);
      const request = await f.run(explicit, env);
      expect(request.code).toBe(expected);
      expect(JSON.parse(request.stdout).status).toBe(state);
    }
    for (const [state, expiry, expected] of [
      ["rejected", Date.now() + 600_000, 21],
      ["pending", Date.now() - 1_000, 22],
      ["consumed", Date.now() + 600_000, 0],
    ] as const) {
      f.setApproval(state, expiry);
      const automatic = await f.run(["tools", "run", "linear.write", "--idempotency", "auto-key", "--json"], env);
      expect(automatic.code).toBe(expected);
      expect(JSON.parse(automatic.stdout)).toMatchObject({ status: state, idempotencyKey: "auto-key" });
    }
    f.loseApproval();
    const lostExplicit = await f.run(explicit, env);
    expect(lostExplicit.code).toBe(23);
    expect(JSON.parse(lostExplicit.stderr)).toMatchObject({ error: "APPROVAL_DELIVERY_UNCERTAIN",
      details: { idempotencyKey: "stable-key" } });
    const lostAutomatic = await f.run(["tools", "run", "linear.write", "--json"], env);
    expect(lostAutomatic.code).toBe(23);
    expect(lastError(lostAutomatic.stderr)).toMatchObject({ error: "APPROVAL_DELIVERY_UNCERTAIN",
      details: { idempotencyKey: expect.any(String) } });
    expect(errorDetails(lostAutomatic.stderr).idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("emits a generated retry key before dispatch and replays it after an interrupted run", async () => {
    const f = await fixture();
    const env = { ...process.env, OMR_BACKEND: f.url, OMR_API_KEY: "headless_secret",
      OMR_WORKSPACE_ID: "workspace_1", OMR_CONFIG_DIR: f.config };
    const child = spawn(process.execPath, [binary, "tools", "run", "linear.interrupted", "--json"],
      { cwd: f.root, env });
    const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
    let stderr = ""; let stdout = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    try {
      for (let n = 0; n < 100 && !f.calls.some((call) => call.path === "/api/tools/execute"); n++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(f.calls.some((call) => call.path === "/api/tools/execute")).toBe(true);
    } finally { child.kill("SIGTERM"); }
    await closed;
    expect(stdout).toBe("");
    const event = JSON.parse(stderr.trim());
    expect(event).toMatchObject({ event: "IDEMPOTENCY_KEY", idempotencyKey: expect.any(String) });
    const first = f.calls.find((call) => call.path === "/api/tools/execute")!.body as { idempotencyKey: string };
    expect(event.idempotencyKey).toBe(first.idempotencyKey);
    const replay = await f.run(["tools", "run", "linear.interrupted", "--idempotency", event.idempotencyKey, "--json"],
      { OMR_BACKEND: f.url, OMR_API_KEY: "headless_secret", OMR_WORKSPACE_ID: "workspace_1" });
    expect(replay.code).toBe(0);
    expect(JSON.parse(replay.stdout)).toMatchObject({ id: "receipt_1", status: "succeeded" });
    expect(f.interrupted.size).toBe(1);
  });

  it("rejects malformed successful responses and preserves recovery identities", async () => {
    const f = await fixture();
    const env = { OMR_BACKEND: f.url, OMR_API_KEY: "headless_secret", OMR_WORKSPACE_ID: "workspace_1" };
    for (const kind of ["json", "empty", "shape"] as const) {
      f.malformedSuccess("/api/tools/execute", kind);
      const run = await f.run(["tools", "run", "linear.read", "--idempotency", `retry-${kind}`, "--json"], env);
      expect(run.code).toBe(23);
      expect(run.stdout).toBe("");
      expect(JSON.parse(run.stderr)).toMatchObject({ error: "EXECUTION_EFFECT_UNCERTAIN",
        details: { idempotencyKey: `retry-${kind}` } });
      f.clearMalformed();

      f.malformedSuccess("/api/approvals", kind);
      const approval = await f.run(["approvals", "request", "linear.write", "--idempotency", `approval-${kind}`, "--json"], env);
      expect(approval.code).toBe(23);
      expect(JSON.parse(approval.stderr)).toMatchObject({ error: "APPROVAL_DELIVERY_UNCERTAIN",
        details: { idempotencyKey: `approval-${kind}` } });
      f.clearMalformed();

      f.malformedSuccess("/api/approvals/execute", kind);
      const execute = await f.run(["approvals", "execute", "approval_1", "--json"], env);
      expect(execute.code).toBe(23);
      expect(JSON.parse(execute.stderr)).toMatchObject({ error: "EXECUTION_EFFECT_UNCERTAIN",
        details: { approvalId: "approval_1" } });
      f.clearMalformed();
    }
    for (const [path, args] of [
      ["/api/tools", ["tools", "list"]],
      ["/api/tools/manifest", ["tools", "inspect", "linear.read"]],
      ["/api/connections/list", ["connections", "list"]],
      ["/api/approvals/status", ["approvals", "status", "approval_1"]],
    ] as const) {
      f.malformedSuccess(path, "shape");
      const read = await f.run([...args, "--json"], env);
      expect(read.code).toBe(1);
      expect(read.stdout).toBe("");
      expect(JSON.parse(read.stderr).error).toBe("CLI_ERROR");
      f.clearMalformed();
    }
    expect((await f.run(["tools", "run", "linear.receipt-uncertain", "--idempotency", "uncertain-receipt", "--json"], env)).code).toBe(23);
    expect((await f.run(["tools", "run", "linear.receipt-failed", "--idempotency", "failed-receipt", "--json"], env)).code).toBe(1);
  });

  it("binds successful execution and approval replies to the requested identity", async () => {
    const f = await fixture();
    const env = { OMR_BACKEND: f.url, OMR_API_KEY: "headless_secret", OMR_WORKSPACE_ID: "workspace_1" };
    for (const [path, args, wrong, error, detail] of [
      ["/api/tools/execute", ["tools", "run", "linear.read", "--idempotency", "run-key"],
        { id: "receipt_other", workspaceId: "workspace_other", toolId: "linear.read", status: "succeeded", result: {} },
        "EXECUTION_EFFECT_UNCERTAIN", { idempotencyKey: "run-key" }],
      ["/api/tools/execute", ["tools", "run", "linear.read", "--idempotency", "run-key"],
        { id: "receipt_other", workspaceId: "workspace_1", toolId: "other.write", status: "succeeded", result: {} },
        "EXECUTION_EFFECT_UNCERTAIN", { idempotencyKey: "run-key" }],
      ["/api/tools/execute", ["tools", "run", "linear.read", "--connection", "connection_1", "--idempotency", "run-key"],
        { id: "receipt_other", workspaceId: "workspace_1", toolId: "linear.read", connectionId: "connection_other", status: "succeeded", result: {} },
        "EXECUTION_EFFECT_UNCERTAIN", { idempotencyKey: "run-key" }],
      ["/api/approvals", ["approvals", "request", "linear.write", "--idempotency", "approval-key"],
        { id: "approval_other", workspaceId: "workspace_other", toolId: "linear.write", status: "pending", expiresAt: Date.now() + 600_000 },
        "APPROVAL_DELIVERY_UNCERTAIN", { idempotencyKey: "approval-key" }],
      ["/api/approvals", ["approvals", "request", "linear.write", "--idempotency", "approval-key"],
        { id: "approval_other", workspaceId: "workspace_1", toolId: "other.write", status: "pending", expiresAt: Date.now() + 600_000 },
        "APPROVAL_DELIVERY_UNCERTAIN", { idempotencyKey: "approval-key" }],
      ["/api/approvals", ["approvals", "request", "linear.write", "--connection", "connection_1", "--idempotency", "approval-key"],
        { id: "approval_other", workspaceId: "workspace_1", toolId: "linear.write", connectionId: "connection_other", status: "pending", expiresAt: Date.now() + 600_000 },
        "APPROVAL_DELIVERY_UNCERTAIN", { idempotencyKey: "approval-key" }],
      ["/api/approvals/execute", ["approvals", "execute", "approval_1"],
        { id: "receipt_other", approvalId: "approval_other", workspaceId: "workspace_1", toolId: "linear.write", status: "succeeded", result: {} },
        "EXECUTION_EFFECT_UNCERTAIN", { approvalId: "approval_1" }],
    ] as const) {
      f.successReply(path, wrong);
      const response = await f.run([...args, "--json"], env);
      expect(response.code).toBe(23);
      expect(response.stdout).toBe("");
      expect(lastError(response.stderr)).toMatchObject({ error, details: detail });
      f.clearSuccessReply();
    }
  });

  it("rejects cross-request identities in catalog, account and approval reads", async () => {
    const f = await fixture();
    const env = { OMR_BACKEND: f.url, OMR_API_KEY: "headless_secret", OMR_WORKSPACE_ID: "workspace_1" };
    for (const [path, args, wrong] of [
      ["/api/tools", ["tools", "list", "--provider", "linear"],
        { tools: [{ id: "other.read", provider: "github" }] }],
      ["/api/tools/manifest", ["tools", "inspect", "linear.read"],
        { id: "other.write", hash: "v1" }],
      ["/api/connections/list", ["connections", "list", "--provider", "linear"],
        [{ id: "connection_other", workspaceId: "workspace_other", provider: "linear" }]],
      ["/api/approvals/status", ["approvals", "status", "approval_1"],
        { id: "approval_other", workspaceId: "workspace_1", toolId: "linear.write", status: "pending", expiresAt: Date.now() + 600_000 }],
    ] as const) {
      f.successReply(path, wrong);
      const response = await f.run([...args, "--json"], env);
      expect(response.code).toBe(1);
      expect(response.stdout).toBe("");
      f.clearSuccessReply();
    }
    f.successReply("/api/approvals/status", { id: "approval_1", workspaceId: "workspace_other",
      toolId: "linear.write", status: "approved", expiresAt: Date.now() + 600_000 });
    const status = await f.run(["approvals", "status", "approval_1", "--json"], env);
    expect(status.code).toBe(1);
    expect(status.stdout).toBe("");
  });

  it("keeps a saved grant when a successful revocation reply is invalid", async () => {
    const f = await fixture();
    expect((await f.run(["login", "--url", f.url, "--json"])).code).toBe(0);
    f.malformedSuccess("/api/client-grants/revoke-self", "shape");
    const logout = await f.run(["logout", "--json"]);
    expect(logout.code).toBe(3);
    expect(lastError(logout.stderr).error).toBe("REVOCATION_UNVERIFIED");
    expect((await f.run(["profiles", "show", "--json"])).code).toBe(0);
  });

  it("does not delete a replacement profile after revoking the former grant", async () => {
    const f = await fixture();
    expect((await f.run(["login", "--url", f.url, "--json"])).code).toBe(0);
    f.holdRevoke();
    const oldLogout = f.run(["logout", "--json"]);
    try {
      for (let n = 0; n < 100 && !f.calls.some((call) => call.path === "/api/client-grants/revoke-self"); n++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(f.calls.some((call) => call.path === "/api/client-grants/revoke-self")).toBe(true);
      expect((await f.run(["logout", "--local", "--json"])).code).toBe(0);
      f.nextGrant("replacement_secret");
      expect((await f.run(["login", "--url", f.url, "--json"])).code).toBe(0);
    } finally { f.releaseRevoke(); }
    const response = await oldLogout;
    expect(response.code).toBe(1);
    expect(JSON.parse(response.stderr).error).toBe("PROFILE_CHANGED");
    expect(JSON.parse(readFileSync(join(f.config, "profiles", "default.json"), "utf8")).key)
      .toBe("replacement_secret");
  });

  it("does not apply an old grant's workspace selection to a replacement profile", async () => {
    const f = await fixture();
    expect((await f.run(["login", "--url", f.url, "--json"])).code).toBe(0);
    f.holdCatalog();
    const oldSelection = f.run(["workspaces", "use", "workspace_1", "--json"]);
    try {
      for (let n = 0; n < 100 && !f.calls.some((call) => call.path === "/api/tools"); n++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(f.calls.some((call) => call.path === "/api/tools")).toBe(true);
      expect((await f.run(["logout", "--local", "--json"])).code).toBe(0);
      f.nextGrant("replacement_secret");
      f.setGrantWorkspace("workspace_2");
      expect((await f.run(["login", "--url", f.url, "--json"])).code).toBe(0);
      f.setGrantWorkspace("workspace_1");
    } finally { f.releaseCatalog(); }
    const response = await oldSelection;
    expect(response.code).toBe(1);
    expect(JSON.parse(response.stderr).error).toBe("PROFILE_CHANGED");
    expect(response.stdout).toBe("");
    expect(JSON.parse(readFileSync(join(f.config, "profiles", "default.json"), "utf8")))
      .toMatchObject({ key: "replacement_secret", workspaceId: "workspace_2" });
  });

  it("rejects account selection replies without the requested identity", async () => {
    const f = await fixture();
    const env = { OMR_BACKEND: f.url, OMR_API_KEY: "headless_secret", OMR_WORKSPACE_ID: "workspace_1" };
    const args = ["connections", "select", "connection_1", "--provider", "linear", "--json"];
    for (const reply of [{},
      { workspaceId: "workspace_other", provider: "linear", connectionId: "connection_1", userId: "user_1" },
      { workspaceId: "workspace_1", provider: "linear", connectionId: "connection_other", userId: "user_1" },
      { workspaceId: "workspace_1", provider: "github", connectionId: "connection_1", userId: "user_1" }]) {
      f.selectionReply(reply);
      const response = await f.run(args, env);
      expect(response.code).toBe(1);
      expect(response.stdout).toBe("");
      expect(JSON.parse(response.stderr).error).toBe("CLI_ERROR");
    }
    for (const kind of ["json", "empty", "shape"] as const) {
      f.malformedSuccess("/api/connections/select", kind);
      const response = await f.run(args, env);
      expect(response.code).toBe(1);
      expect(response.stdout).toBe("");
      f.clearMalformed();
    }
  });

  it("keeps the credential when logout cannot prove revocation", async () => {
    for (const failure of ["former-member", "revoked", "unreachable", "server-error"] as const) {
      const f = await fixture();
      expect((await f.run(["login", "--url", f.url, "--json"])).code).toBe(0);
      if (failure === "former-member") f.formerMember();
      if (failure === "revoked") f.revoke();
      if (failure === "unreachable") f.loseRevoke();
      if (failure === "server-error") f.failRevoke(503);
      const logout = await f.run(["logout", "--json"]);
      expect(logout.code).toBe(3);
      expect(JSON.parse(logout.stderr).error).toBe("REVOCATION_UNVERIFIED");
      expect(logout.stdout + logout.stderr).not.toContain("omr_fixture_secret");
      expect(JSON.parse((await f.run(["profiles", "show", "--json"])).stdout).name).toBe("default");
      expect((await f.run(["logout", "--local", "--json"])).code).toBe(0);
      expect((await f.run(["profiles", "show", "--json"])).code).toBe(1);
    }
  });

  it("uses and removes a prior CLI/MCP credential profile without issuing a second grant", async () => {
    const f = await fixture();
    mkdirSync(join(f.config, "profiles"), { recursive: true });
    const oldProfile = join(f.config, "profiles", "default.json");
    writeFileSync(oldProfile, '{"workspaceId":"workspace_1"}\n', { mode: 0o644 });
    const oldCredentials = join(f.config, "credentials");
    writeFileSync(oldCredentials, `[default]\nbackend=${f.url}\nkey=omr_fixture_secret\n`, { mode: 0o600 });
    const list = await f.run(["profiles", "list", "--json"]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject([{ name: "default", workspaceId: "workspace_1" }]);
    expect((await f.run(["tools", "list", "--json"])).code).toBe(0);
    const login = await f.run(["login", "--url", f.url, "--json"]);
    expect(JSON.parse(login.stderr).error).toBe("PROFILE_EXISTS");
    expect(f.calls.filter((call) => call.path === "/api/device/authorization")).toHaveLength(0);
    if (process.platform !== "win32") expect(statSync(oldProfile).mode & 0o777).toBe(0o600);

    const mcp = spawn(process.execPath, [resolve("packages/mcp/dist/bin.js")], {
      cwd: f.root, env: { ...process.env, OMR_CONFIG_DIR: f.config, OMR_PROFILE: undefined,
        OMR_BACKEND: undefined, OMR_API_KEY: undefined, OMR_WORKSPACE_ID: undefined },
    });
    let mcpError = "";
    mcp.stderr.on("data", (chunk: Buffer) => { mcpError += chunk.toString(); });
    try {
      for (let n = 0; n < 100 && !f.calls.some((call) => call.path === "/api/tools" &&
        call.authorization === "Bearer omr_fixture_secret"); n++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(f.calls.some((call) => call.path === "/api/tools" &&
        call.authorization === "Bearer omr_fixture_secret")).toBe(true);
      expect(mcpError).toBe("");
    } finally { mcp.kill(); }

    const logout = await f.run(["logout", "--json"]);
    expect(logout.code).toBe(0);
    expect(JSON.parse(logout.stdout).revoked).toBe(true);
    expect(readFileSync(oldCredentials, "utf8")).not.toContain("omr_fixture_secret");
    expect((await f.run(["profiles", "show", "--json"])).code).toBe(1);
  });

  it("moves a selected legacy profile to private unified storage without dropping sibling grants", async () => {
    const f = await fixture();
    mkdirSync(join(f.config, "profiles"), { recursive: true });
    for (const name of ["default", "other"]) {
      writeFileSync(join(f.config, "profiles", `${name}.json`), '{"workspaceId":"workspace_1"}\n');
    }
    const credentials = join(f.config, "credentials");
    writeFileSync(credentials, `[default]\nbackend=${f.url}\nkey=omr_fixture_secret\n[other]\nbackend=${f.url}\nkey=other_secret\n`, { mode: 0o600 });
    const selection = await f.run(["workspaces", "use", "workspace_1", "--json"]);
    expect(selection.code).toBe(0);
    expect(JSON.parse(readFileSync(join(f.config, "profiles", "default.json"), "utf8"))).toMatchObject({
      backend: f.url, key: "omr_fixture_secret", workspaceId: "workspace_1",
    });
    expect(readFileSync(credentials, "utf8")).not.toContain("omr_fixture_secret");
    expect(readFileSync(credentials, "utf8")).toContain("other_secret");
    expect(JSON.parse((await f.run(["profiles", "list", "--json"])).stdout)).toHaveLength(2);
    expect((await f.run(["logout", "--local", "--json"])).code).toBe(0);
    expect(readFileSync(credentials, "utf8")).toContain("other_secret");
  });

  it("flushes the unified grant and its directory before removing the legacy copy", async () => {
    const f = await fixture();
    mkdirSync(join(f.config, "profiles"), { recursive: true });
    const profile = join(f.config, "profiles", "default.json");
    const credentials = join(f.config, "credentials");
    const events = join(f.root, "storage-events");
    const preload = join(f.root, "trace-storage.cjs");
    writeFileSync(profile, '{"workspaceId":"workspace_1"}\n', { mode: 0o600 });
    writeFileSync(credentials, `[default]\nbackend=${f.url}\nkey=omr_fixture_secret\n`, { mode: 0o600 });
    writeFileSync(preload, `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const profile = ${JSON.stringify(profile)}, credentials = ${JSON.stringify(credentials)};
const directory = ${JSON.stringify(join(f.config, "profiles"))}, events = ${JSON.stringify(events)};
const handles = new Map();
const open = fs.openSync, close = fs.closeSync, flush = fs.fsyncSync, rename = fs.renameSync;
fs.openSync = function(path, ...rest) { const fd = open.call(this, path, ...rest); handles.set(fd, path); return fd; };
fs.closeSync = function(fd) { handles.delete(fd); return close.call(this, fd); };
fs.fsyncSync = function(fd) {
  const path = handles.get(fd);
  if (path === directory) fs.appendFileSync(events, "profile-dir-flush\\n");
  if (typeof path === "string" && path.startsWith(profile + ".")) fs.appendFileSync(events, "profile-file-flush\\n");
  return flush.call(this, fd);
};
fs.renameSync = function(source, target) {
  if (target === profile) fs.appendFileSync(events, "profile-publish\\n");
  if (target === credentials) fs.appendFileSync(events, "legacy-remove\\n");
  return rename.call(this, source, target);
};
syncBuiltinESMExports();
`);
    const selected = await f.run(["workspaces", "use", "workspace_1", "--json"], {
      NODE_OPTIONS: `--require=${preload}`,
    });
    expect(selected.code, selected.stderr).toBe(0);
    const order = readFileSync(events, "utf8").trim().split("\n");
    expect(order).toContain("profile-file-flush");
    expect(order.indexOf("profile-file-flush")).toBeLessThan(order.indexOf("profile-publish"));
    if (process.platform !== "win32") {
      expect(order.indexOf("profile-publish")).toBeLessThan(order.indexOf("profile-dir-flush"));
      expect(order.indexOf("profile-dir-flush")).toBeLessThan(order.indexOf("legacy-remove"));
    } else {
      expect(order).not.toContain("profile-dir-flush");
      expect(order.indexOf("profile-publish")).toBeLessThan(order.indexOf("legacy-remove"));
    }
    expect(readFileSync(credentials, "utf8")).not.toContain("omr_fixture_secret");
  });

  it("keeps an orphaned legacy grant visible and prevents login from shadowing it", async () => {
    const f = await fixture();
    mkdirSync(join(f.config, "profiles"), { recursive: true });
    const credentials = join(f.config, "credentials");
    writeFileSync(credentials, `[work]\nbackend=${f.url}\nkey=omr_fixture_secret\n`, { mode: 0o600 });
    const listed = await f.run(["profiles", "list", "--json"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([]);
    expect(lastError(listed.stderr)).toMatchObject({ warning: "PROFILE_UNREADABLE", file: "credentials" });
    const priorCalls = f.calls.length;
    const blocked = await f.run(["login", "--url", f.url, "--profile", "work", "--json"]);
    expect(blocked.code).toBe(2);
    expect(lastError(blocked.stderr).error).toBe("PROFILE_EXISTS");
    expect(f.calls.slice(priorCalls)).toHaveLength(0);
    const recovery = await f.run(["profiles", "show", "--profile", "work", "--json"]);
    expect(recovery.code).toBe(1);
    expect(lastError(recovery.stderr).error).toBe("PROFILE_RECOVERY_REQUIRED");
    expect(lastError(recovery.stderr).message).toContain("/app/clients");
    expect(recovery.stderr).not.toContain("omr_fixture_secret");
    expect((await f.run(["logout", "--local", "--profile", "work", "--json"])).code).toBe(0);
    expect(readFileSync(credentials, "utf8")).not.toContain("omr_fixture_secret");
  });

  it("rejects a profile name with a trailing newline before issuing a grant", async () => {
    const f = await fixture();
    const response = await f.run(["login", "--url", f.url, "--profile", "work\n", "--json"]);
    expect(response.code).toBe(2);
    expect(lastError(response.stderr).error).toBe("INPUT_INVALID");
    expect(f.calls).toHaveLength(0);
  });

  it("classifies invalid login URLs before issuing a device request", async () => {
    const f = await fixture();
    for (const json of [true, false]) {
      for (const url of ["not a URL", "ftp://example.test", "http://example.test",
        "https://user:pass@example.test", "https://example.test?token=private",
        "https://example.test#fragment", ` ${f.url}`]) {
        const response = await f.run(["login", "--url", url, ...(json ? ["--json"] : [])]);
        expect(response.code, url).toBe(2);
        if (json) expect(lastError(response.stderr).error).toBe("INPUT_INVALID");
        else expect(response.stderr).toContain("INPUT_INVALID:");
        const output = response.stdout + response.stderr;
        expect(output).not.toContain("private");
        expect(output).not.toContain("user:pass");
        expect(output).not.toContain("https://user:pass@example.test");
      }
    }
    expect(f.calls).toHaveLength(0);
  });

  it("keeps a grant discoverable when active profile publication fails", async () => {
    const f = await fixture();
    mkdirSync(f.config, { recursive: true });
    symlinkSync(join(f.root, "outside"), join(f.config, "active-profile"));
    const first = await f.run(["login", "--url", f.url, "--profile", "work", "--json"]);
    expect(first.code).toBe(1);
    expect(lastError(first.stderr).error).toBe("LOCAL_STORAGE_FAILED");
    expect(JSON.parse(readFileSync(join(f.config, "profiles", "work.json"), "utf8"))).toMatchObject({
      key: "omr_fixture_secret", workspaceId: "workspace_1",
    });
    const second = await f.run(["login", "--url", f.url, "--profile", "work", "--json"]);
    expect(lastError(second.stderr).error).toBe("PROFILE_EXISTS");
    expect(f.calls.filter((call) => call.path === "/api/device/authorization")).toHaveLength(1);
  });

  it("preserves a primary credential error when lock cleanup also fails", async () => {
    const f = await fixture();
    const lock = join(f.config, "credentials.lock");
    const preload = join(f.root, "fail-lock-cleanup.cjs");
    writeFileSync(preload, `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const remove = fs.rmSync;
fs.rmSync = function(path, ...rest) {
  if (path === ${JSON.stringify(lock)}) throw new Error("secondary cleanup failure");
  return remove.call(this, path, ...rest);
};
syncBuiltinESMExports();
`);
    const response = await f.run(["logout", "--local", "--profile", "missing", "--json"], {
      NODE_OPTIONS: `--require=${preload}`,
    });
    expect(response.code).toBe(1);
    expect(lastError(response.stderr).message).toContain("Profile missing is missing");
    expect(response.stderr).not.toContain("secondary cleanup failure");
    expect(existsSync(lock)).toBe(true);
  });

  it("recovers interrupted legacy cleanup for workspace migration and confirmed revocation", async () => {
    for (const operation of ["workspace", "revoke"] as const) {
      const f = await fixture();
      mkdirSync(join(f.config, "profiles"), { recursive: true });
      writeFileSync(join(f.config, "profiles", "default.json"), '{"workspaceId":"workspace_1"}\n');
      const credentials = join(f.config, "credentials");
      writeFileSync(credentials, `[default]\nbackend=${f.url}\nkey=omr_fixture_secret\n[other]\nbackend=${f.url}\nkey=other_secret\n`, { mode: 0o600 });
      const lock = `${credentials}.lock`;
      writeFileSync(lock, "", { mode: 0o600 });
      utimesSync(lock, new Date(0), new Date(0));
      const response = await f.run(operation === "workspace"
        ? ["workspaces", "use", "workspace_1", "--json"] : ["logout", "--json"]);
      expect(response.code).toBe(0);
      expect(existsSync(lock)).toBe(false);
      expect(readFileSync(credentials, "utf8")).not.toContain("omr_fixture_secret");
      expect(readFileSync(credentials, "utf8")).toContain("other_secret");
      if (operation === "revoke") {
        expect(f.calls.some((call) => call.path === "/api/client-grants/revoke-self")).toBe(true);
        expect(existsSync(join(f.config, "profiles", "default.json"))).toBe(false);
      }
    }
  });

  it("recovers an abandoned lock without a matching legacy entry and waits for a concurrent owner", async () => {
    const f = await fixture();
    mkdirSync(join(f.config, "profiles"), { recursive: true });
    for (const name of ["default", "other"]) {
      writeFileSync(join(f.config, "profiles", `${name}.json`), '{"workspaceId":"workspace_1"}\n');
    }
    const credentials = join(f.config, "credentials");
    writeFileSync(credentials, `[default]\nbackend=${f.url}\nkey=omr_fixture_secret\n[other]\nbackend=${f.url}\nkey=other_secret\n`, { mode: 0o600 });
    const lock = `${credentials}.lock`;
    writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
    const migrating = f.run(["workspaces", "use", "workspace_1", "--json"]);
    const removing = f.run(["logout", "--local", "--profile", "other", "--json"]);
    await new Promise((resolve) => setTimeout(resolve, 750));
    rmSync(lock);
    const migrated = await migrating;
    expect(migrated.code, migrated.stderr).toBe(0);
    const removed = await removing;
    expect(removed.code, removed.stderr).toBe(0);
    expect(existsSync(lock)).toBe(false);
    expect(readFileSync(credentials, "utf8")).not.toContain("omr_fixture_secret");
    expect(readFileSync(credentials, "utf8")).not.toContain("other_secret");
    expect(JSON.parse(readFileSync(join(f.config, "profiles", "default.json"), "utf8"))).toMatchObject({
      key: "omr_fixture_secret", workspaceId: "workspace_1",
    });
    expect(existsSync(join(f.config, "profiles", "other.json"))).toBe(false);

    writeFileSync(lock, "", { mode: 0o600 });
    utimesSync(lock, new Date(0), new Date(0));
    expect((await f.run(["logout", "--local", "--json"])).code).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it("recovers an interrupted reclaim guard without losing the legacy grant", async () => {
    const f = await fixture();
    mkdirSync(join(f.config, "profiles"), { recursive: true });
    const profile = join(f.config, "profiles", "default.json");
    writeFileSync(profile, '{"workspaceId":"workspace_1"}\n');
    const credentials = join(f.config, "credentials");
    writeFileSync(credentials, `[default]\nbackend=${f.url}\nkey=omr_fixture_secret\n`, { mode: 0o600 });
    const lock = `${credentials}.lock`;
    writeFileSync(lock, "", { mode: 0o600 });
    utimesSync(lock, new Date(0), new Date(0));
    const guard = `${lock}.reclaim`;
    writeFileSync(guard, "99999999\n", { mode: 0o600 });
    const result = await f.run(["logout", "--local", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(guard)).toBe(false);
    expect(existsSync(profile)).toBe(false);
    expect(readFileSync(credentials, "utf8")).not.toContain("omr_fixture_secret");
  }, 10_000);

  it("reads a legacy grant atomically with concurrent workspace migration", async () => {
    const f = await fixture();
    mkdirSync(join(f.config, "profiles"), { recursive: true });
    const profile = join(f.config, "profiles", "default.json");
    writeFileSync(profile, '{"workspaceId":"workspace_1"}\n', { mode: 0o600 });
    writeFileSync(join(f.config, "profiles", "other.json"), '{"workspaceId":"workspace_1"}\n', { mode: 0o600 });
    const credentials = join(f.config, "credentials");
    writeFileSync(credentials, `[default]\nbackend=${f.url}\nkey=omr_fixture_secret\n[other]\nbackend=${f.url}\nkey=other_secret\n`, { mode: 0o600 });
    const marker = join(f.root, "reader-held"), release = join(f.root, "release-reader");
    const preload = join(f.root, "pause-legacy-read.cjs");
    writeFileSync(preload, `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const profile = ${JSON.stringify(profile)}, marker = ${JSON.stringify(marker)}, release = ${JSON.stringify(release)};
const wait = new Int32Array(new SharedArrayBuffer(4));
let paused = false;
const read = fs.readFileSync;
fs.readFileSync = function(path, ...args) {
  const value = read.call(this, path, ...args);
  if (!paused && path === profile) {
    paused = true;
    fs.writeFileSync(marker, "held");
    while (!fs.existsSync(release)) Atomics.wait(wait, 0, 0, 10);
  }
  return value;
};
syncBuiltinESMExports();
`);
    const reader = f.run(["profiles", "show", "--json"], { NODE_OPTIONS: `--require=${preload}` });
    let writer: ReturnType<typeof f.run> | undefined;
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(marker) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(marker)).toBe(true);
      writer = f.run(["workspaces", "use", "workspace_1", "--json"]);
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally { writeFileSync(release, "go"); }
    const readResult = await reader;
    const writeResult = await writer!;
    expect(readResult.code, readResult.stderr).toBe(0);
    expect(JSON.parse(readResult.stdout)).toMatchObject({ workspaceId: "workspace_1", backend: f.url });
    expect(writeResult.code, writeResult.stderr).toBe(0);
    expect(JSON.parse(readFileSync(profile, "utf8"))).toMatchObject({ key: "omr_fixture_secret" });
    expect(readFileSync(credentials, "utf8")).toContain("other_secret");
  }, 10_000);

  it("keeps a live lock exclusive while legacy workspace migration overlaps logout", async () => {
    const f = await fixture();
    mkdirSync(join(f.config, "profiles"), { recursive: true });
    for (const name of ["default", "other"])
      writeFileSync(join(f.config, "profiles", `${name}.json`), '{"workspaceId":"workspace_1"}\n');
    const credentials = join(f.config, "credentials");
    writeFileSync(credentials, `[default]\nbackend=${f.url}\nkey=omr_fixture_secret\n[other]\nbackend=${f.url}\nkey=other_secret\n`, { mode: 0o600 });
    const lock = `${credentials}.lock`;
    const marker = join(f.root, "lock-held");
    const release = join(f.root, "release-lock");
    const preload = join(f.root, "pause-lock.cjs");
    // Pause immediately after the lock name becomes visible. The old open(wx)
    // path exposed an empty file here; the atomic publication path has a PID.
    writeFileSync(preload, `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const lock = ${JSON.stringify(lock)}, marker = ${JSON.stringify(marker)}, release = ${JSON.stringify(release)};
const sleep = new Int32Array(new SharedArrayBuffer(4));
function pause() {
  fs.writeFileSync(marker, "held");
  while (!fs.existsSync(release)) Atomics.wait(sleep, 0, 0, 20);
}
const open = fs.openSync;
fs.openSync = function(path, flags, ...rest) {
  const fd = open.call(this, path, flags, ...rest);
  if (path === lock && flags === "wx") pause();
  return fd;
};
const link = fs.linkSync;
fs.linkSync = function(source, target) {
  const result = link.call(this, source, target);
  if (target === lock) pause();
  return result;
};
syncBuiltinESMExports();
`);
    const first = spawn(process.execPath, [binary, "workspaces", "use", "workspace_1", "--json"], {
      cwd: f.root, env: { ...process.env, OMR_CONFIG_DIR: f.config,
        OMR_BACKEND: undefined, OMR_API_KEY: undefined, OMR_WORKSPACE_ID: undefined,
        OMR_PROFILE: undefined, NODE_OPTIONS: `--require=${preload}` },
    });
    let firstOut = "", firstErr = "";
    first.stdout.on("data", (chunk) => { firstOut += chunk.toString(); });
    first.stderr.on("data", (chunk) => { firstErr += chunk.toString(); });
    const firstDone = new Promise<number | null>((resolve, reject) => {
      first.once("error", reject);
      first.once("exit", (code) => resolve(code));
    });
    let secondDone: ReturnType<typeof f.run> | undefined;
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(marker) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(marker)).toBe(true);
      secondDone = f.run(["logout", "--local", "--profile", "other", "--json"]);
      const completedEarly = await Promise.race([
        secondDone.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 600)),
      ]);
      expect(completedEarly).toBe(false);
      expect(readFileSync(lock, "utf8")).toBe(`${first.pid}\n`);
    } finally {
      writeFileSync(release, "go");
    }
    expect(await firstDone, firstErr).toBe(0);
    expect(JSON.parse(firstOut).workspaceId).toBe("workspace_1");
    expect((await secondDone!).code).toBe(0);
    expect(existsSync(lock)).toBe(false);
    expect(readFileSync(credentials, "utf8")).not.toMatch(/omr_fixture_secret|other_secret/);
    expect(JSON.parse(readFileSync(join(f.config, "profiles", "default.json"), "utf8"))).toMatchObject({
      key: "omr_fixture_secret", workspaceId: "workspace_1",
    });
    expect(existsSync(join(f.config, "profiles", "other.json"))).toBe(false);
  }, 10_000);

  it("serializes stale-lock reclamation across replacement, migration, and concurrent logouts", async () => {
    const f = await fixture();
    mkdirSync(join(f.config, "profiles"), { recursive: true });
    for (const name of ["default", "other"])
      writeFileSync(join(f.config, "profiles", `${name}.json`), '{"workspaceId":"workspace_1"}\n');
    const credentials = join(f.config, "credentials");
    writeFileSync(credentials, `[default]\nbackend=${f.url}\nkey=omr_fixture_secret\n[other]\nbackend=${f.url}\nkey=other_secret\n`, { mode: 0o600 });
    const lock = `${credentials}.lock`;
    writeFileSync(lock, "", { mode: 0o600 });
    utimesSync(lock, new Date(0), new Date(0));
    const before = join(f.root, "before-unlink"), after = join(f.root, "after-unlink");
    const releaseBefore = join(f.root, "release-before"), releaseAfter = join(f.root, "release-after");
    const live = join(f.root, "replacement-held"), releaseLive = join(f.root, "release-replacement");
    const preload = join(f.root, "reclaim-race.cjs");
    writeFileSync(preload, `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const lock = ${JSON.stringify(lock)}, before = ${JSON.stringify(before)}, after = ${JSON.stringify(after)};
const releaseBefore = ${JSON.stringify(releaseBefore)}, releaseAfter = ${JSON.stringify(releaseAfter)};
const live = ${JSON.stringify(live)}, releaseLive = ${JSON.stringify(releaseLive)};
const wait = new Int32Array(new SharedArrayBuffer(4));
function until(path) { while (!fs.existsSync(path)) Atomics.wait(wait, 0, 0, 10); }
let removed = false;
const rm = fs.rmSync;
fs.rmSync = function(path, ...rest) {
  if (process.env.OMR_RACE_ROLE === "reclaimer" && path === lock && !removed) {
    removed = true;
    fs.writeFileSync(before, "ready"); until(releaseBefore);
    const result = rm.call(this, path, ...rest);
    fs.writeFileSync(after, "removed"); until(releaseAfter);
    return result;
  }
  return rm.call(this, path, ...rest);
};
const link = fs.linkSync;
fs.linkSync = function(source, target) {
  const result = link.call(this, source, target);
  if (process.env.OMR_RACE_ROLE === "replacement" && target === lock) {
    fs.writeFileSync(live, "held"); until(releaseLive);
  }
  return result;
};
syncBuiltinESMExports();
`);
    const raceEnv = { NODE_OPTIONS: `--require=${preload}` };
    const waitFor = async (path: string) => {
      const deadline = Date.now() + 5_000;
      while (!existsSync(path) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(path), `Missing marker ${path}`).toBe(true);
    };
    const migrating = f.run(["workspaces", "use", "workspace_1", "--json"],
      { ...raceEnv, OMR_RACE_ROLE: "reclaimer" });
    let removingOther: ReturnType<typeof f.run> | undefined;
    let removingDefault: ReturnType<typeof f.run> | undefined;
    try {
      await waitFor(before);
      expect(readFileSync(lock, "utf8")).toBe("");
      expect(existsSync(`${lock}.reclaim`)).toBe(true);
      removingOther = f.run(["logout", "--local", "--profile", "other", "--json"]);
      const early = await Promise.race([removingOther,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 250))]);
      expect(early, JSON.stringify(early)).toBeNull();
      writeFileSync(releaseBefore, "go");
      await waitFor(after);
      removingDefault = f.run(["logout", "--local", "--json"],
        { ...raceEnv, OMR_RACE_ROLE: "replacement" });
      await waitFor(live);
      writeFileSync(releaseAfter, "go");
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(readFileSync(lock, "utf8")).toMatch(/^[1-9]\d*\n$/);
      expect(existsSync(join(f.config, "profiles", "default.json"))).toBe(true);
    } finally {
      writeFileSync(releaseBefore, "go");
      writeFileSync(releaseAfter, "go");
      writeFileSync(releaseLive, "go");
    }
    expect((await removingDefault!).code).toBe(0);
    expect((await migrating).code).toBe(1);
    expect((await removingOther!).code).toBe(0);
    expect(existsSync(lock)).toBe(false);
    expect(readFileSync(credentials, "utf8")).not.toMatch(/omr_fixture_secret|other_secret/);
    expect(existsSync(join(f.config, "profiles", "default.json"))).toBe(false);
    expect(existsSync(join(f.config, "profiles", "other.json"))).toBe(false);
  }, 15_000);

  it("preserves MCP headless workspace fallback from legacy metadata and explicit override", async () => {
    const f = await fixture();
    f.emptyCatalog();
    mkdirSync(join(f.config, "profiles"), { recursive: true });
    writeFileSync(join(f.config, "profiles", "default.json"), '{"workspaceId":"workspace_1"}\n');
    const launch = async (workspaceId?: string) => {
      const before = f.calls.length;
      const child = spawn(process.execPath, [resolve("packages/mcp/dist/bin.js")], {
        cwd: f.root, env: { ...process.env, OMR_CONFIG_DIR: f.config, OMR_PROFILE: undefined,
          OMR_BACKEND: f.url, OMR_API_KEY: "headless_secret", OMR_WORKSPACE_ID: workspaceId },
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      try {
        for (let n = 0; n < 100 && !f.calls.slice(before).some((call) => call.path === "/api/tools"); n++)
          await new Promise((resolve) => setTimeout(resolve, 20));
        expect(f.calls.slice(before).some((call) => call.path === "/api/tools" &&
          new URL(call.url, f.url).searchParams.get("workspaceId") === (workspaceId ?? "workspace_1") &&
          call.authorization === "Bearer headless_secret" &&
          (call.body === undefined))).toBe(true);
        expect(stderr).toBe("");
      } finally { child.kill(); }
    };
    await launch();
    f.setGrantWorkspace("workspace_2");
    rmSync(join(f.config, "profiles", "default.json"));
    await launch("workspace_2");
  });

  it("identifies OMR_WORKSPACE_ID when a headless MCP launch has no saved workspace", async () => {
    const f = await fixture();
    const { stderr } = await exec(process.execPath, [resolve("packages/mcp/dist/bin.js")], {
      cwd: f.root, env: { ...process.env, OMR_CONFIG_DIR: f.config, OMR_PROFILE: undefined,
        OMR_BACKEND: f.url, OMR_API_KEY: "headless_secret", OMR_WORKSPACE_ID: undefined },
    }).then(() => ({ stderr: "" }), (error: { stderr: string }) => ({ stderr: error.stderr }));
    expect(stderr).toContain("OMR_WORKSPACE_ID is required");
    expect(stderr).not.toContain("Profile default is missing");
  });

  it("never changes a saved profile while headless logout is configured", async () => {
    for (const saved of [false, true]) {
      const f = await fixture();
      if (saved) expect((await f.run(["login", "--url", f.url, "--json"])).code).toBe(0);
      const complete = { OMR_BACKEND: f.url, OMR_API_KEY: "headless_secret", OMR_WORKSPACE_ID: "workspace_1" };
      for (const env of [complete, { OMR_BACKEND: f.url }]) {
        for (const local of [false, true]) {
          const response = await f.run(["logout", ...(local ? ["--local"] : []), "--json"], env);
          expect(response.code).toBe(2);
          expect(JSON.parse(response.stderr).error).toBe(env === complete ? "HEADLESS_READ_ONLY" : "HEADLESS_INCOMPLETE");
        }
      }
      expect(f.calls.filter((call) => call.path === "/api/client-grants/revoke-self")).toHaveLength(0);
      expect((await f.run(["profiles", "list", "--json"])).code).toBe(0);
      expect(JSON.parse((await f.run(["profiles", "list", "--json"])).stdout)).toHaveLength(saved ? 1 : 0);
    }
  });

  it("classifies command shape and unreadable JSON input before profile or network access", async () => {
    const f = await fixture();
    for (const args of [["bogus"], ["tools"], ["approvals", "request"], ["connections", "select"]]) {
      const response = await f.run([...args, "--json"]);
      expect(response.code).toBe(2);
      expect(JSON.parse(response.stderr).error).toBe("USAGE");
    }
    for (const args of [["profiles", "use", "../bad"], ["profiles", "show", "--profile", "../bad"],
      ["login", "--profile", "../bad", "--url", f.url], ["tools", "list", "--profile", "../bad"]]) {
      const response = await f.run([...args, "--json"]);
      expect(response.code).toBe(2);
      expect(JSON.parse(response.stderr).error).toBe("INPUT_INVALID");
    }
    const env = { OMR_BACKEND: f.url, OMR_API_KEY: "headless_secret", OMR_WORKSPACE_ID: "workspace_1" };
    for (const args of [["--params", "@missing.json"], ["--params-file", "missing.json"]]) {
      const response = await f.run(["tools", "run", "linear.read", ...args, "--json"], env);
      expect(response.code).toBe(2);
      expect(JSON.parse(response.stderr).error).toBe("INPUT_INVALID");
      expect(response.stdout).toBe("");
    }
    const stdin = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [binary, "tools", "run", "linear.read", "--params", "-", "--json"],
        { cwd: f.root, env: { ...process.env, ...env, OMR_CONFIG_DIR: f.config } });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
      child.stdin.end();
    });
    expect(stdin.code).toBe(2);
    expect(JSON.parse(stdin.stderr).error).toBe("INPUT_INVALID");
    if (process.platform !== "win32") {
      const fd = openSync(f.root, "r");
      const unreadable = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [binary, "tools", "run", "linear.read", "--params", "-", "--json"],
          { cwd: f.root, env: { ...process.env, ...env, OMR_CONFIG_DIR: f.config }, stdio: [fd, "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
      });
      closeSync(fd);
      expect(unreadable.code).toBe(2);
      expect(JSON.parse(unreadable.stderr).error).toBe("INPUT_INVALID");
    }
    expect(f.calls).toHaveLength(0);
  });

  it("distinguishes pending, denied, expired, uncertain and invalid input without echoing parameters", async () => {
    const f = await fixture();
    const env = { OMR_BACKEND: f.url, OMR_API_KEY: "headless_secret", OMR_WORKSPACE_ID: "workspace_1" };
    const pending = await f.run(["tools", "run", "linear.write", "--params", '{"secret":"sensitive"}', "--json"], env);
    expect(pending.code).toBe(20);
    expect(JSON.parse(pending.stdout)).toMatchObject({ id: "approval_1", status: "pending" });
    expect(pending.stdout + pending.stderr).not.toContain("sensitive");
    expect((await f.run(["approvals", "status", "approval_1", "--json"], env)).code).toBe(20);
    f.setApproval("rejected");
    expect((await f.run(["approvals", "execute", "approval_1", "--json"], env)).code).toBe(21);
    f.setApproval("approved", Date.now() - 1000);
    expect((await f.run(["approvals", "execute", "approval_1", "--json"], env)).code).toBe(22);
    f.setApproval("approved");
    expect((await f.run(["approvals", "execute", "approval_1", "--json"], env)).code).toBe(0);
    f.setApproval("failed");
    expect((await f.run(["approvals", "execute", "approval_1", "--json"], env)).code).toBe(1);
    f.setApproval("executing");
    expect((await f.run(["approvals", "status", "approval_1", "--json"], env)).code).toBe(25);
    const uncertain = await f.run(["tools", "run", "linear.uncertain", "--json"], env);
    expect(uncertain.code).toBe(23);
    expect(errorDetails(uncertain.stderr).receiptId).toBe("receipt_1");
    const lost = await f.run(["tools", "run", "linear.lost", "--idempotency", "retry-this-key", "--json"], env);
    expect(lost.code).toBe(23);
    expect(JSON.parse(lost.stderr)).toMatchObject({ error: "EXECUTION_EFFECT_UNCERTAIN",
      details: { idempotencyKey: "retry-this-key" } });
    const truncated = await f.run(["tools", "run", "linear.truncated", "--idempotency", "retry-truncated-key", "--json"], env);
    expect(truncated.code).toBe(23);
    expect(JSON.parse(truncated.stderr)).toMatchObject({ error: "EXECUTION_EFFECT_UNCERTAIN",
      details: { idempotencyKey: "retry-truncated-key" } });
    const badError = await f.run(["tools", "run", "linear.bad-error", "--json"], env);
    expect(badError.code).toBe(23);
    expect(badError.stdout + badError.stderr).not.toContain("omr_fixture_secret");
    expect((await f.run(["tools", "run", "linear.read", "--params", "{bad secret}", "--json"], env)).code).toBe(2);
    expect((await f.run(["tools", "list", "--json"], { OMR_BACKEND: f.url })).code).toBe(2);
    f.revoke();
    expect((await f.run(["tools", "list", "--json"], env)).code).toBe(3);
  });

  it("reports in-progress execution with a distinct exit and both recovery identities", async () => {
    const f = await fixture();
    const env = { OMR_BACKEND: f.url, OMR_API_KEY: "headless_secret", OMR_WORKSPACE_ID: "workspace_1" };
    const runArgs = ["tools", "run", "linear.in-progress", "--idempotency", "same-run-key", "--json"];
    const pendingRun = await f.run(runArgs, env);
    expect(pendingRun.code).toBe(25);
    expect(pendingRun.stdout).toBe("");
    expect(lastError(pendingRun.stderr)).toMatchObject({ error: "EXECUTION_IN_PROGRESS",
      details: { receiptId: "receipt_running", idempotencyKey: "same-run-key" } });
    for (const status of ["reserved", "running"]) {
      f.successReply("/api/tools/execute", { id: "receipt_running", workspaceId: "workspace_1",
        toolId: "linear.in-progress", status, result: null });
      expect((await f.run(runArgs, env)).code).toBe(25);
      f.clearSuccessReply();
    }
    for (const [status, exit] of [["succeeded", 0], ["failed", 1], ["uncertain", 23]] as const) {
      f.successReply("/api/tools/execute", { id: "receipt_running", workspaceId: "workspace_1",
        toolId: "linear.in-progress", status, result: null });
      const resolved = await f.run(runArgs, env);
      expect(resolved.code).toBe(exit);
      expect(JSON.parse(resolved.stdout)).toMatchObject({ id: "receipt_running", status });
      f.clearSuccessReply();
    }

    f.setApproval("executing");
    const executeArgs = ["approvals", "execute", "approval_1", "--json"];
    const pendingApproval = await f.run(executeArgs, env);
    expect(pendingApproval.code).toBe(25);
    expect(pendingApproval.stdout).toBe("");
    expect(lastError(pendingApproval.stderr)).toMatchObject({ error: "EXECUTION_IN_PROGRESS",
      details: { receiptId: "receipt_approved_running", approvalId: "approval_1" } });
    f.setApproval("approved");
    for (const status of ["reserved", "running"]) {
      f.successReply("/api/approvals/execute", { id: "receipt_approved_running", approvalId: "approval_1",
        workspaceId: "workspace_1", toolId: "linear.write", status, result: null });
      expect((await f.run(executeArgs, env)).code).toBe(25);
      f.clearSuccessReply();
    }
    for (const [status, exit] of [["succeeded", 0], ["failed", 1], ["uncertain", 23]] as const) {
      f.successReply("/api/approvals/execute", { id: "receipt_approved_running", approvalId: "approval_1",
        workspaceId: "workspace_1", toolId: "linear.write", status, result: null });
      const resolved = await f.run(executeArgs, env);
      expect(resolved.code).toBe(exit);
      expect(JSON.parse(resolved.stdout)).toMatchObject({ id: "receipt_approved_running", status });
      f.clearSuccessReply();
    }
  });

  it("preserves an unavailable approval error when its status lookup also fails", async () => {
    const f = await fixture();
    const env = { OMR_BACKEND: f.url, OMR_API_KEY: "headless_secret", OMR_WORKSPACE_ID: "workspace_1" };
    f.setApproval("pending");
    f.failureResponse("/api/approvals/status", 503, { error: "SERVER_UNAVAILABLE" });
    const response = await f.run(["approvals", "execute", "approval_1", "--json"], env);
    expect(response.code).toBe(1);
    expect(lastError(response.stderr).error).toBe("APPROVAL_UNAVAILABLE");
    expect(response.stdout).toBe("");
  });

  it("keeps retry identities when a gateway fails after mutation, while preserving known outcomes", async () => {
    const f = await fixture();
    const env = { OMR_BACKEND: f.url, OMR_API_KEY: "headless_secret", OMR_WORKSPACE_ID: "workspace_1" };
    const cases = [
      { path: "/api/tools/execute", args: ["tools", "run", "linear.read", "--idempotency", "run-after-commit", "--json"],
        identity: { idempotencyKey: "run-after-commit" } },
      { path: "/api/approvals", args: ["approvals", "request", "linear.write", "--idempotency", "approval-after-commit", "--json"],
        identity: { idempotencyKey: "approval-after-commit" } },
      { path: "/api/approvals/execute", args: ["approvals", "execute", "approval_1", "--json"],
        identity: { approvalId: "approval_1" } },
    ];
    for (const { path, args, identity } of cases) {
      f.failAfterCommit(path, 502, { error: "BAD_GATEWAY", message: "omr_fixture_secret" });
      const response = await f.run(args, env);
      expect(response.code).toBe(23);
      expect(response.stdout).toBe("");
      expect(lastError(response.stderr)).toMatchObject({ details: identity });
      expect(response.stderr).not.toContain("omr_fixture_secret");
      f.clearFailureResponse();
    }
    expect(f.committedMutations).toEqual([
      { path: "/api/tools/execute", identity: "run-after-commit" },
      { path: "/api/approvals", identity: "approval-after-commit" },
      { path: "/api/approvals/execute", identity: "approval_1" },
    ]);

    f.failureResponse("/api/tools/execute", 502, { error: "EXECUTION_FAILED", receiptId: "receipt_failed" });
    const failed = await f.run(cases[0]!.args, env);
    expect(failed.code).toBe(1);
    expect(lastError(failed.stderr)).toMatchObject({ error: "EXECUTION_FAILED", details: { receiptId: "receipt_failed" } });
    f.failureResponse("/api/tools/execute", 504, { error: "EXECUTION_INVOCATION_TIMEOUT" });
    const predispatch = await f.run(cases[0]!.args, env);
    expect(predispatch.code).toBe(24);
    expect(lastError(predispatch.stderr).error).toBe("EXECUTION_INVOCATION_TIMEOUT");
    f.failureResponse("/api/tools/execute", 502, { error: "EXECUTION_FAILED" });
    const incompleteFailure = await f.run(cases[0]!.args, env);
    expect(incompleteFailure.code).toBe(23);
    expect(lastError(incompleteFailure.stderr)).toMatchObject({ error: "EXECUTION_EFFECT_UNCERTAIN",
      details: { idempotencyKey: "run-after-commit" } });
    f.clearFailureResponse();

    f.failAfterCommit("/api/approvals/execute", 502,
      { error: "EXECUTION_OUTCOME_UNKNOWN", receiptId: "receipt_approved_uncertain" });
    const unknown = await f.run(cases[2]!.args, env);
    expect(unknown.code).toBe(23);
    expect(lastError(unknown.stderr)).toMatchObject({ error: "EXECUTION_OUTCOME_UNKNOWN",
      details: { approvalId: "approval_1", receiptId: "receipt_approved_uncertain" } });
  });

  it("refuses symlinked profile targets", async () => {
    const f = await fixture();
    expect((await f.run(["login", "--url", f.url, "--json"])).code).toBe(0);
    const profile = join(f.config, "profiles", "default.json");
    rmSync(profile);
    symlinkSync(join(f.root, "outside"), profile);
    expect((await f.run(["profiles", "show", "--json"])).code).toBe(1);
  });

  it("rejects hard-linked legacy metadata before changing an outside inode", async (context) => {
    if (process.platform === "win32") context.skip();
    const f = await fixture();
    mkdirSync(join(f.config, "profiles"), { recursive: true });
    const outside = join(f.root, "outside.json");
    writeFileSync(outside, '{"workspaceId":"workspace_1"}\n', { mode: 0o644 });
    linkSync(outside, join(f.config, "profiles", "default.json"));
    const result = await f.run(["profiles", "show", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("workspace_1");
    expect(readFileSync(outside, "utf8")).toBe('{"workspaceId":"workspace_1"}\n');
    expect(statSync(outside).mode & 0o777).toBe(0o644);
    expect(statSync(outside).nlink).toBe(2);
  });

  it("reports uncertain one-time device delivery without storing or printing a credential", async () => {
    const f = await fixture();
    f.loseDevice();
    const result = await f.run(["login", "--url", f.url, "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr.trim().split("\n").at(-1)!)).toMatchObject({ error: "DEVICE_DELIVERY_UNCERTAIN" });
    expect(result.stdout + result.stderr).not.toContain("omr_fixture_secret");
    expect(JSON.parse((await f.run(["profiles", "list", "--json"])).stdout)).toEqual([]);
  });

  it("guides recovery after a consumed device code receives a gateway error", async () => {
    const f = await fixture();
    f.failAfterCommit("/api/device/token", 502, { error: "BAD_GATEWAY", message: "omr_fixture_secret" });
    const response = await f.run(["login", "--url", f.url, "--json"]);
    expect(response.code).toBe(1);
    expect(lastError(response.stderr)).toMatchObject({ error: "DEVICE_DELIVERY_UNCERTAIN" });
    expect(response.stderr).toContain("/app/clients");
    expect(response.stdout + response.stderr).not.toContain("omr_fixture_secret");
    expect(f.committedMutations).toEqual([{ path: "/api/device/token", identity: "private-device-code" }]);
    expect(JSON.parse((await f.run(["profiles", "list", "--json"])).stdout)).toEqual([]);
  });

  it("preserves known device-token errors even when the server returns 5xx", async () => {
    for (const [code, exit] of [["DEVICE_AUTHORIZATION_EXPIRED", 22],
      ["DEVICE_AUTHORIZATION_INVALID", 1]] as const) {
      const f = await fixture();
      f.failureResponse("/api/device/token", 500, { error: code });
      const response = await f.run(["login", "--url", f.url, "--json"]);
      expect(response.code).toBe(exit);
      expect(lastError(response.stderr).error).toBe(code);
      expect(response.stderr).not.toContain("/app/clients");
      expect(JSON.parse((await f.run(["profiles", "list", "--json"])).stdout)).toEqual([]);
    }
  });

  it("does not save malformed successful one-time device grants", async () => {
    for (const reply of [
      { credential: { secret: "omr_fixture_secret" }, clientId: "client_1", grantId: "grant_1", workspaceId: "workspace_1" },
      { credential: "omr_fixture_secret", clientId: "client_1", grantId: "grant_1", workspaceId: { id: "workspace_1" } },
      { credential: "omr_fixture_secret", clientId: "client_1", grantId: "", workspaceId: "workspace_1" },
    ]) {
      const f = await fixture();
      f.deviceReply(reply);
      const response = await f.run(["login", "--url", f.url, "--json"]);
      expect(response.code).toBe(1);
      expect(lastError(response.stderr).error).toBe("DEVICE_DELIVERY_UNCERTAIN");
      expect(response.stdout).toBe("");
      expect(response.stderr).not.toContain("omr_fixture_secret");
      expect(JSON.parse((await f.run(["profiles", "list", "--json"])).stdout)).toEqual([]);
    }
  });

  it("rejects malformed successful device authorization before displaying or polling it", async () => {
    for (const broken of [
      { userCode: undefined }, { userCode: 42 }, { deviceCode: undefined },
      { deviceCode: { value: "private-device-code" } },
      { verificationUri: undefined }, { verificationUriComplete: "javascript:alert(1)" },
      { verificationUriComplete: "http://localhost/device\nINJECTED" },
      { userCode: "ABCD\nINJECTED" },
    ]) {
      const f = await fixture();
      f.successReply("/api/device/authorization", {
        deviceCode: "private-device-code", userCode: "ABCD-EFGH",
        verificationUri: "http://localhost/device",
        verificationUriComplete: "http://localhost/device?user_code=ABCD-EFGH",
        expiresInSeconds: 5, pollIntervalSeconds: 0, ...broken,
      });
      const response = await f.run(["login", "--url", f.url, "--json"]);
      expect(response.code).toBe(1);
      expect(response.stdout).toBe("");
      expect(lastError(response.stderr).error).toBe("DEVICE_RESPONSE_INVALID");
      expect(response.stderr).not.toContain("Open ");
      expect(response.stderr).not.toContain("Confirm device code");
      expect(f.calls.map(({ path }) => path)).toEqual(["/api/device/authorization"]);
      expect(JSON.parse((await f.run(["profiles", "list", "--json"])).stdout)).toEqual([]);
    }
  });

  it("rejects incomplete catalog pages and manifests across discovery commands", async () => {
    const f = await fixture();
    const env = { OMR_BACKEND: f.url, OMR_API_KEY: "headless_secret", OMR_WORKSPACE_ID: "workspace_1" };
    for (const [reply, args] of [
      [{ tools: [toolManifest] }, ["tools", "list"]],
      [{ ...catalogPage, tools: [{ id: "linear.read", provider: "linear" }] }, ["tools", "search", "--query", "read"]],
      [{ ...catalogPage, tools: [{ ...toolManifest, contract: undefined }] }, ["tools", "list"]],
    ] as const) {
      f.successReply("/api/tools", reply);
      const response = await f.run([...args, "--json"], env);
      expect(response.code).toBe(1);
      expect(response.stdout).toBe("");
      f.clearSuccessReply();
    }
    f.successReply("/api/tools/manifest", { id: "linear.read", hash: "v1" });
    const inspect = await f.run(["tools", "inspect", "linear.read", "--json"], env);
    expect(inspect.code).toBe(1);
    expect(inspect.stdout).toBe("");
    f.clearSuccessReply();

    expect((await f.run(["login", "--url", f.url, "--json"])).code).toBe(0);
    const profileFile = join(f.config, "profiles", "default.json");
    writeFileSync(profileFile, JSON.stringify({ ...JSON.parse(readFileSync(profileFile, "utf8")),
      workspaceId: "workspace_old" }));
    f.successReply("/api/tools", { tools: [] });
    const selection = await f.run(["workspaces", "use", "workspace_1", "--json"]);
    expect(selection.code).toBe(1);
    expect(selection.stdout).toBe("");
    expect(JSON.parse((await f.run(["workspaces", "show", "--json"])).stdout).workspaceId).toBe("workspace_old");
  });

  it.skipIf(process.platform === "win32")("refuses a credential file readable by other users", async () => {
    const f = await fixture();
    expect((await f.run(["login", "--url", f.url, "--json"])).code).toBe(0);
    const profile = join(f.config, "profiles", "default.json");
    chmodSync(profile, 0o644);
    const result = await f.run(["tools", "list", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("omr_fixture_secret");
  });
});
