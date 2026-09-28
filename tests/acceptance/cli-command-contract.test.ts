import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const binary = resolve("packages/cli/dist/bin.js");
const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const lastError = (stderr: string): Record<string, any> => JSON.parse(stderr.trim().split("\n").at(-1)!);

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
    if (path === "/api/device/authorization") return answer(201, {
      deviceCode: "private-device-code", userCode: "ABCD-EFGH", verificationUriComplete: "http://localhost/device",
      expiresInSeconds: 5, pollIntervalSeconds: 0,
    });
    if (path === "/api/device/token" && deviceLost) { request.socket.destroy(); return; }
    if (path === "/api/device/token") return answer(200, deviceReply ?? {
      credential: nextGrantKey, clientId: "client_1", grantId: "grant_1", workspaceId: grantWorkspace,
    });
    if (request.headers.authorization !== "Bearer omr_fixture_secret" &&
        request.headers.authorization !== "Bearer replacement_secret" &&
        request.headers.authorization !== "Bearer headless_secret") return answer(401, { error: "CLIENT_CREDENTIAL_INVALID" });
    if (revoked) return answer(401, { error: "CLIENT_CREDENTIAL_INVALID" });
    if (path === "/api/client-grants/revoke-self") {
      if (revokeHeld) await new Promise<void>((resolve) => { releaseRevoke = resolve; });
      if (revokeLost) { request.socket.destroy(); return; }
      if (formerMember) return answer(401, { error: "CLIENT_CREDENTIAL_INVALID" });
      revoked = true; return answer(200, { revoked: true });
    }
    if (path === "/api/tools") {
      if (catalogHeld) await new Promise<void>((resolve) => { releaseCatalog = resolve; });
      if (new URL(request.url!, "http://localhost").searchParams.get("workspaceId") !== grantWorkspace)
        return answer(403, { error: "CONNECTION_ACCESS_DENIED" });
      return answer(200, { tools: emptyCatalog ? [] : [{ id: "linear.read" }], cursor: null });
    }
    if (path === "/api/tools/manifest") return answer(200, { id: "linear.read", hash: "v1" });
    if (path === "/api/connections/list") return answer(200, [{ id: "connection_1" }]);
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
      toolId: "linear.write", status: approvalStatus, expiresAt });
    if (path === "/api/approvals/execute") {
      if (approvalStatus !== "approved" || expiresAt <= Date.now()) return answer(409, { error: "APPROVAL_UNAVAILABLE" });
      return answer(200, { id: "receipt_approved", workspaceId: "workspace_1", toolId: "linear.write",
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
    malformedSuccess: (path: string, kind: "json" | "empty" | "shape") => { malformedSuccess.set(path, kind); },
    clearMalformed: () => malformedSuccess.clear(),
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

describe("cli-command-contract", () => {
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
    expect(lastError(lostAutomatic.stderr).details.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
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

  it("keeps a saved grant when a successful revocation reply is invalid", async () => {
    const f = await fixture();
    expect((await f.run(["login", "--url", f.url, "--json"])).code).toBe(0);
    f.malformedSuccess("/api/client-grants/revoke-self", "shape");
    const logout = await f.run(["logout", "--json"]);
    expect(logout.code).toBe(1);
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
    for (const failure of ["former-member", "revoked", "unreachable"] as const) {
      const f = await fixture();
      expect((await f.run(["login", "--url", f.url, "--json"])).code).toBe(0);
      if (failure === "former-member") f.formerMember();
      if (failure === "revoked") f.revoke();
      if (failure === "unreachable") f.loseRevoke();
      const logout = await f.run(["logout", "--json"]);
      expect(logout.code).toBe(failure === "unreachable" ? 1 : 3);
      if (failure !== "unreachable") expect(JSON.parse(logout.stderr).error).toBe("REVOCATION_UNVERIFIED");
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
    expect((await migrating).code).toBe(0);
    expect((await removing).code).toBe(0);
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
    expect((await f.run(["approvals", "status", "approval_1", "--json"], env)).code).toBe(23);
    const uncertain = await f.run(["tools", "run", "linear.uncertain", "--json"], env);
    expect(uncertain.code).toBe(23);
    expect(lastError(uncertain.stderr).details.receiptId).toBe("receipt_1");
    const lost = await f.run(["tools", "run", "linear.lost", "--idempotency", "retry-this-key", "--json"], env);
    expect(lost.code).toBe(23);
    expect(JSON.parse(lost.stderr)).toMatchObject({ error: "EXECUTION_EFFECT_UNCERTAIN",
      details: { idempotencyKey: "retry-this-key" } });
    const truncated = await f.run(["tools", "run", "linear.truncated", "--idempotency", "retry-truncated-key", "--json"], env);
    expect(truncated.code).toBe(23);
    expect(JSON.parse(truncated.stderr)).toMatchObject({ error: "EXECUTION_EFFECT_UNCERTAIN",
      details: { idempotencyKey: "retry-truncated-key" } });
    const badError = await f.run(["tools", "run", "linear.bad-error", "--json"], env);
    expect(badError.code).toBe(1);
    expect(badError.stdout + badError.stderr).not.toContain("omr_fixture_secret");
    expect((await f.run(["tools", "run", "linear.read", "--params", "{bad secret}", "--json"], env)).code).toBe(2);
    expect((await f.run(["tools", "list", "--json"], { OMR_BACKEND: f.url })).code).toBe(2);
    f.revoke();
    expect((await f.run(["tools", "list", "--json"], env)).code).toBe(3);
  });

  it("refuses symlinked profile targets", async () => {
    const f = await fixture();
    expect((await f.run(["login", "--url", f.url, "--json"])).code).toBe(0);
    const profile = join(f.config, "profiles", "default.json");
    rmSync(profile);
    symlinkSync(join(f.root, "outside"), profile);
    expect((await f.run(["profiles", "show", "--json"])).code).toBe(1);
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
