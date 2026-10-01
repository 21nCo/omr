import { describe, expect, it, vi } from "vitest";
import { createPlugFnToolCatalog, hasRequiredScopes } from "@oh-my-router/tools";
import { omrGithubProvider } from "@oh-my-router/plugfn-runtime";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { ConnectionAuthority, type ConnectionBindingRecord } from "@oh-my-router/connections";
import { MemoryConnectionBindingStore } from "@oh-my-router/connections/testing";
import { ExecutionService } from "@oh-my-router/execution";
import { MemoryExecutionApprovalStore, MemoryExecutionReceiptStore } from "@oh-my-router/execution/testing";

const actions = omrGithubProvider.actions;

/** Give each contract case workspace-bound bindings and fenced stores. */
async function executionFixture(options: { otherWorkspace?: boolean; accounts?: string[] } = {}) {
  const workspaceStore = new MemoryWorkspaceStore();
  const workspaces = new WorkspaceAuthority(workspaceStore);
  const { workspace } = await workspaces.provisionPersonalWorkspace({ userId: "alice" });
  const other = options.otherWorkspace
    ? await workspaces.createTeam({ ownerUserId: "alice", name: "Other" }) : undefined;
  const connections = new ConnectionAuthority(new MemoryConnectionBindingStore(workspaceStore));
  const bindings: ConnectionBindingRecord[] = [];
  for (const account of options.accounts ?? ["alice"]) {
    bindings.push(await connections.attach({ actorUserId: "alice", workspaceId: workspace.id,
      provider: "github", providerConnectionId: `remote_${account}`, ownership: "personal", label: account }));
  }
  const isMember = (workspaceId: string, userId: string) =>
    [...workspaceStore.memberships.values()].some((member) => member.workspaceId === workspaceId && member.userId === userId);
  const receipts = new MemoryExecutionReceiptStore(isMember);
  const approvals = new MemoryExecutionApprovalStore(isMember, receipts);
  const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrGithubProvider] } });
  const principal = { kind: "web" as const, userId: "alice", workspaceId: workspace.id };
  return { workspaceStore, workspace, other, connections, bindings, binding: bindings[0]!,
    receipts, approvals, catalog, principal };
}

describe("github-adapter-contract", () => {
  it("publishes only typed v1 actions with the minimum distinct GitHub grants", async () => {
    const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrGithubProvider] } });
    expect(catalog.list().map((tool) => tool.id)).toEqual([
      "github.account.get", "github.issues.commentPublic", "github.repos.get",
      "github.repos.listPrivate", "github.repos.listPublic",
    ]);
    expect(catalog.get("github.pulls.review")).toBeNull();
    const comment = catalog.get("github.issues.commentPublic")!;
    const privateList = catalog.get("github.repos.listPrivate")!;
    expect(comment.contract).toMatchObject({ effect: "write", requiredScopes: ["public_repo"], retry: "never" });
    expect(privateList.contract).toMatchObject({ effect: "read", requiredScopes: ["repo"] });
    expect(hasRequiredScopes(comment, ["read:user"])).toBe(false);
    expect(hasRequiredScopes(comment, ["repo"])).toBe(false);
    expect(hasRequiredScopes(privateList, ["public_repo"])).toBe(false);
    expect(comment.inputSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["owner", "repo", "issueNumber", "body"]) });
    expect(() => actions["issues.commentPublic"]!.parameters.parse({ owner: "org", repo: "../other", issueNumber: 1, body: "Hello" })).toThrow();
    expect(() => actions["issues.commentPublic"]!.parameters.parse({ owner: "org", repo: "..", issueNumber: 1, body: "Hello" })).toThrow();
  });

  it("uses the selected account for reads and never posts to an unverified private repository", async () => {
    const get = vi.fn(async (url: string) => ({ data: url.endsWith("/user")
      ? { id: 7, login: "alice", html_url: "https://github.com/alice" }
      : { private: true } }));
    const post = vi.fn(async () => ({ data: { id: 9 } }));
    const context = { provider: { baseUrl: "https://api.github.com" },
      http: { get, post } } as never;
    expect(await actions["account.get"]!.execute({}, context)).toMatchObject({ login: "alice" });
    await expect(actions["issues.commentPublic"]!.execute({ owner: "org", repo: "private", issueNumber: 1,
      body: "Hello" }, context)).rejects.toMatchObject({ reason: "unverified_public_repository" });
    expect(post).not.toHaveBeenCalled();
    get.mockResolvedValueOnce({ data: { private: false } });
    await actions["issues.commentPublic"]!.execute({ owner: "org", repo: "public", issueNumber: 1,
      body: "Hello" }, context);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/org/public/issues/1/comments");
  });

  it.each([
    ["account.get", {}],
    ["repos.listPublic", {}],
    ["repos.listPrivate", {}],
    ["repos.get", { owner: "org", repo: "public" }],
  ])("keeps %s 429 timing outside PlugFn's long retry wait", async (action, params) => {
    const headers = new Headers({ "Retry-After": "120", "X-RateLimit-Reset": "1800000000" });
    const get = vi.fn(async () => { throw Object.assign(new Error("private provider text"), { status: 429, headers }); });
    await expect(actions[action]!.execute(params, {
      provider: { baseUrl: "https://api.github.com" }, http: { get },
    } as never)).rejects.toMatchObject({ code: "GITHUB_READ_RATE_LIMIT", headers });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("keeps the public write behind approval, scoped selection and revocation", async () => {
    const { workspace, other, connections, binding, receipts, approvals, catalog, principal } =
      await executionFixture({ otherWorkspace: true });
    const provider = vi.fn(async () => ({ id: 9, html_url: "https://github.com/org/repo/issues/1#issuecomment-9" }));
    let scopes = ["read:user"];
    const service = new ExecutionService(catalog, connections, { action: provider }, receipts,
      async () => scopes, Date.now, approvals, undefined, new Uint8Array(32).fill(7));
    const toolId = "github.issues.commentPublic";
    const params = { owner: "org", repo: "repo", issueNumber: 1, body: "Hello" };
    await expect(service.requestApproval({ principal, toolId, params, idempotencyKey: "comment-1" }))
      .rejects.toThrow("public_repo");
    expect(provider).not.toHaveBeenCalled();
    scopes = ["read:user", "public_repo"];
    const approval = await service.requestApproval({ principal, toolId, params, idempotencyKey: "comment-1" });
    expect(provider).not.toHaveBeenCalled();
    await expect(service.execute({ principal, toolId, params })).rejects.toMatchObject({ code: "EXECUTION_APPROVAL_REQUIRED" });
    await service.approve(approval.id, "alice");
    await service.executeApproved(principal, approval.id);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0]?.[2]).toMatchObject({ connectionId: "remote_alice",
      actor: { tenantId: workspace.id } });
    await service.executeApproved(principal, approval.id);
    expect(provider).toHaveBeenCalledTimes(1);
    await expect(service.requestApproval({ principal: { ...principal, workspaceId: other!.workspace.id },
      toolId, params, connectionId: binding.id, idempotencyKey: "other-1" }))
      .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    const next = await service.requestApproval({ principal, toolId, params, idempotencyKey: "comment-2" });
    await service.approve(next.id, "alice");
    await connections.revoke("alice", binding.id);
    await expect(service.executeApproved(principal, next.id)).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("turns definite GitHub read denials into explicit safe errors", async () => {
    const { connections, catalog, receipts, principal } = await executionFixture();
    const provider = vi.fn(async () => { throw Object.assign(new Error("provider private details"), { status: 404 }); });
    const service = new ExecutionService(catalog, connections, { action: provider }, receipts,
      async () => ["read:user"], Date.now, undefined, undefined, new Uint8Array(32).fill(7));
    await expect(service.execute({ principal,
      toolId: "github.repos.get", params: { owner: "org", repo: "private" } }))
      .rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE",
        message: expect.stringContaining("private-repository access") });
    expect([...receipts.receipts.values()][0]?.status).toBe("failed");
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ status: 429 }, "GITHUB_RATE_LIMITED"],
    [{ status: 429, headers: new Headers({ "Retry-After": "45", "X-RateLimit-Reset": "1800000000" }) }, "GITHUB_RATE_LIMITED"],
    [{ status: 403, headers: { "X-RateLimit-Remaining": "0" } }, "GITHUB_RATE_LIMITED"],
    [{ status: 403, headers: new Headers({ "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1800000000" }) }, "GITHUB_RATE_LIMITED"],
    [{ status: 403, data: { message: "secondary rate limit exceeded" } }, "GITHUB_RATE_LIMITED"],
    [{ status: 403, headers: { "Retry-After": "60" } }, "GITHUB_RATE_LIMITED"],
    [{ status: 403, headers: new Headers({ "Retry-After": "60" }) }, "GITHUB_RATE_LIMITED"],
    [{ status: 403 }, "GITHUB_ACCESS_DENIED"],
  ] as const)("classifies GitHub read failure %j without an uncertain receipt", async (failure, code) => {
    const { connections, catalog, receipts, principal } = await executionFixture();
    const provider = vi.fn(async () => { throw Object.assign(new Error("provider secret"), failure); });
    const service = new ExecutionService(catalog, connections, { action: provider }, receipts,
      async () => ["read:user"], Date.now, undefined, undefined, new Uint8Array(32).fill(7));
    const error = await service.execute({ principal,
      toolId: "github.repos.get", params: { owner: "org", repo: "public" } }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code, receiptId: expect.any(String) });
    expect(error.message).not.toContain("provider secret");
    if (failure.headers instanceof Headers) {
      expect(error.retryAfterSeconds).toBe(failure.headers.has("retry-after")
        ? Number(failure.headers.get("retry-after")) : undefined);
      expect(error.rateLimitResetAt).toBe(failure.headers.has("x-ratelimit-reset")
        ? Number(failure.headers.get("x-ratelimit-reset")) : undefined);
    }
    expect(receipts.receipts.get(error.receiptId)).toMatchObject({ status: "failed", errorCode: "github_read_denied" });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ owner: "org", repo: "repo", issueNumber: "1", body: "Hello" }, "wrong issue type"],
    [{ owner: "org", repo: "repo", issueNumber: 1 }, "missing body"],
    [{ owner: "org", repo: "repo", issueNumber: 1, body: "" }, "empty body"],
    [{ owner: "org", repo: ".", issueNumber: 1, body: "Hello" }, "dot repository"],
    [{ owner: "org", repo: "..", issueNumber: 1, body: "Hello" }, "dot dot repository"],
  ])("rejects %s before GitHub write approval and provider dispatch (%s)", async (params) => {
    const { connections, catalog, receipts, approvals, principal } = await executionFixture();
    const provider = vi.fn(async () => ({ id: 9 }));
    const service = new ExecutionService(catalog, connections, { action: provider }, receipts,
      async () => ["public_repo"], Date.now, approvals, undefined, new Uint8Array(32).fill(7));
    await expect(service.requestApproval({ principal, toolId: "github.issues.commentPublic",
      params, idempotencyKey: "invalid-comment" })).rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    expect(approvals.approvals.size).toBe(0);
    expect(receipts.receipts.size).toBe(0);
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([".", ".."])("rejects repository %s on read and legacy approval before provider dispatch", async (repo) => {
    const { connections, catalog, receipts, approvals, principal } = await executionFixture();
    const provider = vi.fn(async () => ({ id: 9 }));
    const service = new ExecutionService(catalog, connections, { action: provider }, receipts,
      async () => ["read:user", "public_repo"], Date.now, approvals, undefined, new Uint8Array(32).fill(7));
    await expect(service.execute({ principal, toolId: "github.repos.get", params: { owner: "org", repo } }))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    const approval = await service.requestApproval({ principal, toolId: "github.issues.commentPublic",
      params: { owner: "org", repo: "safe", issueNumber: 1, body: "Hello" }, idempotencyKey: `legacy-${repo.length}` });
    approvals.approvals.set(approval.id, { ...approval, params: { ...approval.params as object, repo } });
    await expect(service.approve(approval.id, "alice")).rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    await expect(service.executeApproved(principal, approval.id)).rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    expect(receipts.receipts.size).toBe(0);
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    ["private", { private: true }, null, "GITHUB_PUBLIC_REPOSITORY_REQUIRED"],
    ["malformed", null, null, "GITHUB_PUBLIC_REPOSITORY_REQUIRED"],
    ["denied", null, 403, "GITHUB_ACCESS_DENIED"],
    ["deleted remote", null, 404, "CONNECTION_UNAVAILABLE"],
  ] as const)("settles a %s comment preflight without posting or crossing workspaces", async (
    _case, repository, status, code,
  ) => {
    const { workspace, other, connections, binding, receipts, approvals, catalog, principal } =
      await executionFixture({ otherWorkspace: true });
    const get = vi.fn(async () => {
      if (status) throw Object.assign(new Error("provider secret"), {
        status, ...(status === 404 ? { code: "CONNECTION_NOT_FOUND" } : {}),
      });
      return repository === null ? null : { data: repository };
    });
    const post = vi.fn(async () => ({ data: { id: 9 } }));
    const provider = vi.fn(async (_provider: string, _action: string, options: { params: unknown }) =>
      actions["issues.commentPublic"]!.execute(options.params as never, {
        provider: { baseUrl: "https://api.github.com" }, http: { get, post },
      } as never));
    const service = new ExecutionService(catalog, connections, { action: provider }, receipts,
      async () => ["read:user", "public_repo"], Date.now, approvals, undefined, new Uint8Array(32).fill(7));
    const params = { owner: "org", repo: "repo", issueNumber: 1, body: "Hello" };
    await expect(service.requestApproval({ principal: { ...principal, workspaceId: other!.workspace.id },
      toolId: "github.issues.commentPublic", params, connectionId: binding.id,
      idempotencyKey: "other-workspace" })).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(provider).not.toHaveBeenCalled();
    const approval = await service.requestApproval({ principal,
      toolId: "github.issues.commentPublic", params, idempotencyKey: "preflight" });
    await service.approve(approval.id, "alice");
    await expect(service.executeApproved(principal, approval.id)).rejects.toMatchObject({ code });
    expect(post).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
    expect([...receipts.receipts.values()]).toEqual([expect.objectContaining({
      workspaceId: workspace.id, approvalId: approval.id, status: "failed",
      errorCode: status === 404 ? "connection_unavailable" : "github_write_preflight_failed",
    })]);
    expect(approvals.approvals.get(approval.id)?.status).toBe("failed");
    if (status === 404) {
      await expect(connections.resolve({ actorUserId: "alice", workspaceId: workspace.id,
        provider: "github", connectionId: binding.id })).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    }
    await expect(service.executeApproved(principal, approval.id)).rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("keeps an ambiguous comment POST uncertain after successful preflight", async () => {
    const { connections, catalog, receipts, approvals, principal } = await executionFixture();
    const post = vi.fn(async () => { throw new Error("POST outcome unknown"); });
    const provider = vi.fn(async (_provider: string, _action: string, options: { params: unknown }) =>
      actions["issues.commentPublic"]!.execute(options.params as never, {
        provider: { baseUrl: "https://api.github.com" },
        http: { get: async () => ({ data: { private: false } }), post },
      } as never));
    const service = new ExecutionService(catalog, connections, { action: provider }, receipts,
      async () => ["public_repo"], Date.now, approvals, undefined, new Uint8Array(32).fill(7));
    const approval = await service.requestApproval({ principal, toolId: "github.issues.commentPublic",
      params: { owner: "org", repo: "repo", issueNumber: 1, body: "Hello" }, idempotencyKey: "ambiguous" });
    await service.approve(approval.id, "alice");
    await expect(service.executeApproved(principal, approval.id)).rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
    expect(post).toHaveBeenCalledTimes(1);
    expect([...receipts.receipts.values()][0]?.status).toBe("uncertain");
    expect(approvals.approvals.get(approval.id)?.status).toBe("uncertain");
  });

  it("uses the explicitly selected GitHub account when several are ready", async () => {
    const { workspace, connections, catalog, receipts, principal } =
      await executionFixture({ accounts: ["one", "two"] });
    const provider = vi.fn(async (_provider: string, _action: string,
      options: { connectionId?: string }) => ({ login: options.connectionId }));
    const service = new ExecutionService(catalog, connections, { action: provider },
      receipts, async () => ["read:user"], Date.now,
      undefined, undefined, new Uint8Array(32).fill(7));
    await expect(service.execute({ principal, toolId: "github.account.get", params: {} }))
      .rejects.toMatchObject({ code: "CONNECTION_SELECTION_REQUIRED" });
    expect(provider).not.toHaveBeenCalled();
    const second = (await connections.listAvailable({ actorUserId: "alice", workspaceId: workspace.id,
      provider: "github" })).find((binding) => binding.providerConnectionId === "remote_two")!;
    await connections.select({ actorUserId: "alice", workspaceId: workspace.id,
      provider: "github", connectionId: second.id });
    await service.execute({ principal, toolId: "github.account.get", params: {} });
    expect(provider).toHaveBeenCalledExactlyOnceWith("github", "account.get",
      expect.objectContaining({ connectionId: "remote_two" }));
  });
});
