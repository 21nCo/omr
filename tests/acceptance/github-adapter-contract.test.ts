import { describe, expect, it, vi } from "vitest";
import { createPlugFnToolCatalog, hasRequiredScopes } from "@oh-my-router/tools";
import { omrGithubProvider } from "@oh-my-router/plugfn-runtime";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { ConnectionAuthority } from "@oh-my-router/connections";
import { MemoryConnectionBindingStore } from "@oh-my-router/connections/testing";
import { ExecutionService } from "@oh-my-router/execution";
import { MemoryExecutionApprovalStore, MemoryExecutionReceiptStore } from "@oh-my-router/execution/testing";

const actions = omrGithubProvider.actions;

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

  it("keeps the public write behind approval, scoped selection and revocation", async () => {
    const workspaceStore = new MemoryWorkspaceStore();
    const workspaces = new WorkspaceAuthority(workspaceStore);
    const { workspace } = await workspaces.provisionPersonalWorkspace({ userId: "alice" });
    const other = await workspaces.createTeam({ ownerUserId: "alice", name: "Other" });
    const connections = new ConnectionAuthority(new MemoryConnectionBindingStore(workspaceStore));
    const binding = await connections.attach({ actorUserId: "alice", workspaceId: workspace.id,
      provider: "github", providerConnectionId: "remote_alice", ownership: "personal", label: "Alice" });
    const provider = vi.fn(async () => ({ id: 9, html_url: "https://github.com/org/repo/issues/1#issuecomment-9" }));
    const isMember = (workspaceId: string, actorUserId: string) =>
      [...workspaceStore.memberships.values()].some((member) =>
        member.workspaceId === workspaceId && member.userId === actorUserId);
    const receipts = new MemoryExecutionReceiptStore(isMember);
    const approvals = new MemoryExecutionApprovalStore(isMember, receipts);
    const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrGithubProvider] } });
    let scopes = ["read:user"];
    const service = new ExecutionService(catalog, connections, { action: provider }, receipts,
      async () => scopes, Date.now, approvals, undefined, new Uint8Array(32).fill(7));
    const principal = { kind: "web" as const, userId: "alice", workspaceId: workspace.id };
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
    await expect(service.requestApproval({ principal: { ...principal, workspaceId: other.workspace.id },
      toolId, params, connectionId: binding.id, idempotencyKey: "other-1" }))
      .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    const next = await service.requestApproval({ principal, toolId, params, idempotencyKey: "comment-2" });
    await service.approve(next.id, "alice");
    await connections.revoke("alice", binding.id);
    await expect(service.executeApproved(principal, next.id)).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("turns definite GitHub read denials into explicit safe errors", async () => {
    const workspaceStore = new MemoryWorkspaceStore();
    const { workspace } = await new WorkspaceAuthority(workspaceStore)
      .provisionPersonalWorkspace({ userId: "alice" });
    const connections = new ConnectionAuthority(new MemoryConnectionBindingStore(workspaceStore));
    await connections.attach({ actorUserId: "alice", workspaceId: workspace.id, provider: "github",
      providerConnectionId: "remote_alice", ownership: "personal", label: "Alice" });
    const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrGithubProvider] } });
    const receipts = new MemoryExecutionReceiptStore();
    const provider = vi.fn(async () => { throw Object.assign(new Error("provider private details"), { status: 404 }); });
    const service = new ExecutionService(catalog, connections, { action: provider }, receipts,
      async () => ["read:user"], Date.now, undefined, undefined, new Uint8Array(32).fill(7));
    await expect(service.execute({ principal: { kind: "web", userId: "alice", workspaceId: workspace.id },
      toolId: "github.repos.get", params: { owner: "org", repo: "private" } }))
      .rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE",
        message: expect.stringContaining("private-repository access") });
    expect([...receipts.receipts.values()][0]?.status).toBe("failed");
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["private", { private: true }, null, "GITHUB_PUBLIC_REPOSITORY_REQUIRED"],
    ["malformed", null, null, "GITHUB_PUBLIC_REPOSITORY_REQUIRED"],
    ["denied", null, 403, "GITHUB_ACCESS_DENIED"],
  ] as const)("settles a %s comment preflight without posting or crossing workspaces", async (
    _case, repository, status, code,
  ) => {
    const workspaceStore = new MemoryWorkspaceStore();
    const workspaces = new WorkspaceAuthority(workspaceStore);
    const { workspace } = await workspaces.provisionPersonalWorkspace({ userId: "alice" });
    const other = await workspaces.createTeam({ ownerUserId: "alice", name: "Other" });
    const connections = new ConnectionAuthority(new MemoryConnectionBindingStore(workspaceStore));
    const binding = await connections.attach({ actorUserId: "alice", workspaceId: workspace.id,
      provider: "github", providerConnectionId: "remote_alice", ownership: "personal", label: "Alice" });
    const isMember = (workspaceId: string, userId: string) =>
      [...workspaceStore.memberships.values()].some((member) => member.workspaceId === workspaceId && member.userId === userId);
    const receipts = new MemoryExecutionReceiptStore(isMember);
    const approvals = new MemoryExecutionApprovalStore(isMember, receipts);
    const get = vi.fn(async () => {
      if (status) throw Object.assign(new Error("provider secret"), { status });
      return repository === null ? null : { data: repository };
    });
    const post = vi.fn(async () => ({ data: { id: 9 } }));
    const provider = vi.fn(async (_provider: string, _action: string, options: { params: unknown }) =>
      actions["issues.commentPublic"]!.execute(options.params as never, {
        provider: { baseUrl: "https://api.github.com" }, http: { get, post },
      } as never));
    const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrGithubProvider] } });
    const service = new ExecutionService(catalog, connections, { action: provider }, receipts,
      async () => ["read:user", "public_repo"], Date.now, approvals, undefined, new Uint8Array(32).fill(7));
    const principal = { kind: "web" as const, userId: "alice", workspaceId: workspace.id };
    const params = { owner: "org", repo: "repo", issueNumber: 1, body: "Hello" };
    await expect(service.requestApproval({ principal: { ...principal, workspaceId: other.workspace.id },
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
      errorCode: "github_write_preflight_failed",
    })]);
    expect(approvals.approvals.get(approval.id)?.status).toBe("failed");
    await expect(service.executeApproved(principal, approval.id)).rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("keeps an ambiguous comment POST uncertain after successful preflight", async () => {
    const workspaceStore = new MemoryWorkspaceStore();
    const { workspace } = await new WorkspaceAuthority(workspaceStore).provisionPersonalWorkspace({ userId: "alice" });
    const connections = new ConnectionAuthority(new MemoryConnectionBindingStore(workspaceStore));
    await connections.attach({ actorUserId: "alice", workspaceId: workspace.id,
      provider: "github", providerConnectionId: "remote_alice", ownership: "personal", label: "Alice" });
    const receipts = new MemoryExecutionReceiptStore(() => true);
    const approvals = new MemoryExecutionApprovalStore(() => true, receipts);
    const post = vi.fn(async () => { throw new Error("POST outcome unknown"); });
    const provider = vi.fn(async (_provider: string, _action: string, options: { params: unknown }) =>
      actions["issues.commentPublic"]!.execute(options.params as never, {
        provider: { baseUrl: "https://api.github.com" },
        http: { get: async () => ({ data: { private: false } }), post },
      } as never));
    const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrGithubProvider] } });
    const service = new ExecutionService(catalog, connections, { action: provider }, receipts,
      async () => ["public_repo"], Date.now, approvals, undefined, new Uint8Array(32).fill(7));
    const principal = { kind: "web" as const, userId: "alice", workspaceId: workspace.id };
    const approval = await service.requestApproval({ principal, toolId: "github.issues.commentPublic",
      params: { owner: "org", repo: "repo", issueNumber: 1, body: "Hello" }, idempotencyKey: "ambiguous" });
    await service.approve(approval.id, "alice");
    await expect(service.executeApproved(principal, approval.id)).rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
    expect(post).toHaveBeenCalledTimes(1);
    expect([...receipts.receipts.values()][0]?.status).toBe("uncertain");
    expect(approvals.approvals.get(approval.id)?.status).toBe("uncertain");
  });

  it("uses the explicitly selected GitHub account when several are ready", async () => {
    const workspaceStore = new MemoryWorkspaceStore();
    const { workspace } = await new WorkspaceAuthority(workspaceStore)
      .provisionPersonalWorkspace({ userId: "alice" });
    const connections = new ConnectionAuthority(new MemoryConnectionBindingStore(workspaceStore));
    for (const suffix of ["one", "two"]) {
      await connections.attach({ actorUserId: "alice", workspaceId: workspace.id,
        provider: "github", providerConnectionId: `remote_${suffix}`, ownership: "personal", label: suffix });
    }
    const provider = vi.fn(async (_provider: string, _action: string,
      options: { connectionId?: string }) => ({ login: options.connectionId }));
    const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrGithubProvider] } });
    const service = new ExecutionService(catalog, connections, { action: provider },
      new MemoryExecutionReceiptStore(), async () => ["read:user"], Date.now,
      undefined, undefined, new Uint8Array(32).fill(7));
    const principal = { kind: "web" as const, userId: "alice", workspaceId: workspace.id };
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
