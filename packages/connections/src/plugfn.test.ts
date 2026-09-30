import { describe, expect, it, vi } from "vitest";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";

import { ConnectionAccessDeniedError, ConnectionAuthority, ConnectionUnavailableError } from "./connections.js";
import {
  PlugFnConnectionOrchestrator,
  ProviderUnavailableError,
  type PlugFnConnection,
  type PlugFnConnectionPort,
} from "./plugfn.js";
import { MemoryConnectionBindingStore } from "./testing.js";
import { finishRaceTest, raceStep, settleRaceRequest, waitForRaceBarrier } from "../test-support/race-test-barrier.js";

/** Create deterministic provider and workspace state without external accounts. */
async function fixture() {
  let now = 1_700_000_000_000;
  const workspaceStore = new MemoryWorkspaceStore();
  const workspaces = new WorkspaceAuthority(workspaceStore, () => now);
  const team = await workspaces.createTeam({ ownerUserId: "user_owner", name: "PlugFn" });
  for (const [userId, role] of [["user_admin", "admin"], ["user_member", "member"]] as const) {
    const email = `${userId}@example.com`;
    const invite = await workspaces.inviteMember({
      actorUserId: "user_owner",
      workspaceId: team.workspace.id,
      email,
      role,
    });
    await workspaces.acceptInvitation({ token: invite.token, userId, email, emailVerified: true });
  }
  const store = new MemoryConnectionBindingStore(workspaceStore);
  const authority = new ConnectionAuthority(store, () => now);
  const plugfn = fakePlugFn();
  return {
    authority,
    orchestrator: new PlugFnConnectionOrchestrator(authority, plugfn.port),
    plugfn,
    store,
    workspaceStore,
    workspaceId: team.workspace.id,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

function fakePlugFn() {
  const connection = (overrides: Partial<PlugFnConnection> = {}): PlugFnConnection => ({
    id: "plug_connection",
    userId: "user_owner",
    provider: "linear",
    ownerKind: "organization",
    ownerId: "workspace_placeholder",
    organizationId: "workspace_placeholder",
    tenantId: "workspace_placeholder",
    installedByUserId: "user_owner",
    status: "active",
    ...overrides,
  });
  const methods = {
    getAuthUrl: vi.fn(async () => "https://provider.example/oauth"),
    handleCallback: vi.fn(async () => ({ connection: connection() })),
    connect: vi.fn(async () => connection()),
    get: vi.fn(async () => connection()),
    isValid: vi.fn(async () => true),
    refresh: vi.fn(async () => connection()),
    disconnect: vi.fn(async () => ({
      disconnected: true,
      connectionId: "plug_connection",
      remoteRevokeAttempted: false,
      remoteRevokeSucceeded: false,
      localDeleted: true,
      connectionDeleted: true,
    })),
  };
  const port: PlugFnConnectionPort = {
    config: { integrations: { github: { type: "oauth2" } } },
    connections: methods,
    providers: {
      get: (name) => name === "github"
        ? {
            name: "github",
            displayName: "GitHub",
            auth: { type: "oauth2" },
            actions: { get_user: {} },
          }
        : name === "linear"
        ? {
            name: "linear",
            displayName: "Linear",
            auth: { type: "api-key" },
            actions: { issue_create: {} },
          }
        : undefined,
    },
  };
  return { port, methods, connection };
}

describe("PlugFn connection orchestration", () => {
  it("revokes an orphan locally without impersonating its former owner at PlugFn", async () => {
    const { authority, orchestrator, plugfn, store, workspaceStore, workspaceId } = await fixture();
    const binding = await authority.attach({ actorUserId: "user_member", workspaceId,
      provider: "linear", providerConnectionId: "remote_orphan", ownership: "personal", label: "Old member" });
    await authority.select({ actorUserId: "user_member", workspaceId,
      provider: "linear", connectionId: binding.id });
    expect(workspaceStore.removeMembership(workspaceId, "user_member")).toBe(true);
    await expect(orchestrator.refresh("user_admin", binding.id))
      .rejects.toBeInstanceOf(ConnectionAccessDeniedError);
    await expect(orchestrator.checkHealth("user_admin", binding.id))
      .rejects.toBeInstanceOf(ConnectionAccessDeniedError);
    await expect(authority.select({ actorUserId: "user_admin", workspaceId,
      provider: "linear", connectionId: binding.id }))
      .rejects.toBeInstanceOf(ConnectionUnavailableError);
    expect(plugfn.methods.refresh).not.toHaveBeenCalled();
    expect(plugfn.methods.isValid).not.toHaveBeenCalled();
    const result = await orchestrator.disconnect("user_admin", binding.id);
    expect(result).toMatchObject({
      connection: { healthReason: "provider_cleanup_requires_owner" },
      provider: { remoteRevokeAttempted: false },
    });
    expect(plugfn.methods.disconnect).not.toHaveBeenCalled();
    expect(store.connections.get(binding.id)).toMatchObject({ status: "revoked", readiness: "unavailable" });
    expect(store.selections.size).toBe(0);
    await expect(authority.resolve({ actorUserId: "user_owner", workspaceId, provider: "linear",
      connectionId: binding.id })).rejects.toBeInstanceOf(ConnectionAccessDeniedError);
    await expect(orchestrator.disconnect("user_owner", binding.id)).resolves.toMatchObject({
      connection: { status: "revoked", readiness: "unavailable", healthReason: "provider_cleanup_requires_owner" },
    });
    expect(plugfn.methods.disconnect).not.toHaveBeenCalled();
  });

  it("persists owner guidance after an orphan cleanup write retry", async () => {
    const { authority, orchestrator, plugfn, store, workspaceStore, workspaceId } = await fixture();
    const binding = await authority.attach({ actorUserId: "user_member", workspaceId,
      provider: "linear", providerConnectionId: "remote_orphan_retry", ownership: "personal", label: "Former" });
    expect(workspaceStore.removeMembership(workspaceId, "user_member")).toBe(true);
    const finalize = store.finalizeCleanupClaim.bind(store);
    let finalizationAttempts = 0;
    vi.spyOn(store, "finalizeCleanupClaim").mockImplementation(async (input) => {
      if (++finalizationAttempts === 1) {
        throw new Error("fixture transient write failure");
      }
      return finalize(input);
    });
    await expect(orchestrator.disconnect("user_admin", binding.id)).resolves.toMatchObject({
      connection: { status: "revoked", readiness: "unavailable",
        healthReason: "provider_cleanup_requires_owner" },
    });
    expect(finalizationAttempts).toBe(2);
    expect(plugfn.methods.disconnect).not.toHaveBeenCalled();
  });

  it("lets only a returning personal owner retry orphan provider cleanup", async () => {
    const { authority, orchestrator, plugfn, store, workspaceStore, workspaceId } = await fixture();
    const binding = await authority.attach({ actorUserId: "user_member", workspaceId,
      provider: "linear", providerConnectionId: "remote_returning", ownership: "personal", label: "Former" });
    await authority.select({ actorUserId: "user_member", workspaceId,
      provider: "linear", connectionId: binding.id });
    expect(workspaceStore.removeMembership(workspaceId, "user_member")).toBe(true);
    await orchestrator.disconnect("user_admin", binding.id);
    const workspaces = new WorkspaceAuthority(workspaceStore);
    const invite = await workspaces.inviteMember({ actorUserId: "user_owner", workspaceId,
      email: "user_member@example.com", role: "member" });
    await workspaces.acceptInvitation({ token: invite.token, userId: "user_member",
      email: "user_member@example.com", emailVerified: true });
    await expect(orchestrator.disconnect("user_admin", binding.id))
      .rejects.toBeInstanceOf(ConnectionAccessDeniedError);
    plugfn.methods.disconnect.mockRejectedValueOnce(new Error("provider secret"));
    await expect(orchestrator.disconnect("user_member", binding.id)).resolves.toMatchObject({
      connection: { status: "revoked", readiness: "unavailable", healthReason: "remote_revoke_failed" },
    });
    expect(plugfn.methods.disconnect).toHaveBeenCalledTimes(1);
    expect(store.selections.size).toBe(0);
    await expect(authority.resolve({ actorUserId: "user_member", workspaceId, provider: "linear" }))
      .rejects.toBeInstanceOf(ConnectionUnavailableError);
    await expect(orchestrator.refresh("user_member", binding.id))
      .rejects.toBeInstanceOf(ConnectionUnavailableError);
    await orchestrator.disconnect("user_member", binding.id);
    expect(store.connections.get(binding.id)).toMatchObject({ status: "revoked", healthReason: null });
  });

  it("keeps old healthy bindings visible but ineligible when support or config is removed", async () => {
    const { authority, orchestrator, plugfn, workspaceId } = await fixture();
    const github = await authority.attach({ actorUserId: "user_owner", workspaceId,
      provider: "github", providerConnectionId: "remote_github", ownership: "personal", label: "GitHub" });
    const expired = await authority.attach({ actorUserId: "user_owner", workspaceId,
      provider: "github", providerConnectionId: "remote_expired", ownership: "personal", label: "Expired" });
    await authority.recordHealth({ connectionId: expired.id, status: "needs_reauth",
      readiness: "unavailable", reason: "expired" });
    const stripe = await authority.attach({ actorUserId: "user_owner", workspaceId,
      provider: "stripe", providerConnectionId: "remote_stripe", ownership: "personal", label: "Stripe" });
    const input = { actorUserId: "user_owner", workspaceId };
    expect(await orchestrator.listAvailable(input)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: github.id, providerState: "ready", selectable: true }),
      expect.objectContaining({ id: expired.id, providerState: "ready", selectable: false }),
      expect.objectContaining({ id: stripe.id, providerState: "unsupported", selectable: false }),
    ]));
    await expect(orchestrator.select({ ...input, provider: "stripe", connectionId: stripe.id }))
      .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", state: "unsupported" });
    plugfn.port.config!.integrations = {};
    expect(await orchestrator.listAvailable(input)).toContainEqual(expect.objectContaining({
      id: github.id, status: "active", readiness: "ready", providerState: "unconfigured", selectable: false,
    }));
    await expect(orchestrator.select({ ...input, provider: "github", connectionId: github.id }))
      .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", state: "unconfigured" });
    plugfn.port.config!.integrations = { github: { type: "oauth2" } };
    await expect(orchestrator.select({ ...input, provider: "github", connectionId: github.id }))
      .resolves.toMatchObject({ connectionId: github.id });
  });
  it("reports provider setup readiness without exposing credentials", async () => {
    const { orchestrator } = await fixture();
    expect(orchestrator.providerReadiness(" Linear ")).toMatchObject({
      provider: "linear",
      available: true,
      authMode: "api_key",
      actionCount: 1,
      state: "disconnected",
    });
    expect(orchestrator.providerReadiness("github")).toMatchObject({
      provider: "github",
      available: true,
      authMode: "oauth",
      state: "disconnected",
    });
  });

  it("refuses experimental, unconfigured and wrong-mode connection attempts before PlugFn side effects", async () => {
    const { orchestrator, plugfn, workspaceId } = await fixture();
    await expect(orchestrator.startOAuth({
      actorUserId: "user_owner", workspaceId, provider: "stripe", ownership: "personal",
      redirectUri: "https://omr.example/app/oauth/callback", label: "Stripe",
    })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", state: "unsupported" });
    plugfn.port.config!.integrations = {};
    expect(orchestrator.providerReadiness("github").state).toBe("unconfigured");
    await expect(orchestrator.startOAuth({
      actorUserId: "user_owner", workspaceId, provider: "github", ownership: "personal",
      redirectUri: "https://omr.example/app/oauth/callback", label: "GitHub",
    })).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(orchestrator.completeOAuth({
      actorUserId: "user_owner", workspaceId, provider: "github", ownership: "personal",
      code: "code", state: "state", label: "GitHub",
    })).rejects.toBeInstanceOf(ProviderUnavailableError);
    plugfn.port.config!.integrations = { github: { type: "oauth2" } };
    expect(orchestrator.providerReadiness("github").state).toBe("disconnected");
    await expect(orchestrator.connectApiKey({
      actorUserId: "user_owner", workspaceId, provider: "github", ownership: "personal",
      apiKey: "not-a-real-key", label: "GitHub",
    })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", state: "disconnected" });
    expect(plugfn.methods.getAuthUrl).not.toHaveBeenCalled();
    expect(plugfn.methods.handleCallback).not.toHaveBeenCalled();
    expect(plugfn.methods.connect).not.toHaveBeenCalled();
  });

  it("authorizes installs before starting OAuth or storing API keys", async () => {
    const { orchestrator, plugfn, workspaceId } = await fixture();
    await expect(
      orchestrator.startOAuth({
        actorUserId: "user_member",
        workspaceId,
        provider: "linear",
        ownership: "workspace",
        redirectUri: "https://omr.example/callback",
        label: "Team Linear",
      }),
    ).rejects.toBeInstanceOf(ConnectionAccessDeniedError);
    await expect(
      orchestrator.connectApiKey({
        actorUserId: "user_member",
        workspaceId,
        provider: "linear",
        ownership: "workspace",
        apiKey: "secret",
        label: "Team Linear",
      }),
    ).rejects.toBeInstanceOf(ConnectionAccessDeniedError);
    expect(plugfn.methods.getAuthUrl).not.toHaveBeenCalled();
    expect(plugfn.methods.connect).not.toHaveBeenCalled();
  });

  it("requests only the read-only GitHub profile scope by default", async () => {
    const { orchestrator, plugfn, workspaceId } = await fixture();
    await orchestrator.startOAuth({
      actorUserId: "user_owner",
      workspaceId,
      provider: "github",
      ownership: "personal",
      redirectUri: "https://omr.example/app/oauth/callback",
      label: "Public GitHub",
    });
    expect(plugfn.methods.getAuthUrl).toHaveBeenCalledWith(expect.objectContaining({
      provider: "github",
      scopes: ["read:user"],
    }));
  });

  it("requests only the selected GitHub tier and rejects a tier for another provider", async () => {
    const { orchestrator, plugfn, workspaceId } = await fixture();
    const input = { actorUserId: "user_owner", workspaceId, provider: "github",
      ownership: "personal" as const, redirectUri: "https://omr.example/app/oauth/callback", label: "GitHub" };
    await orchestrator.startOAuth({ ...input, githubAccess: "public_write" });
    expect(plugfn.methods.getAuthUrl).toHaveBeenLastCalledWith(expect.objectContaining({
      scopes: ["read:user", "public_repo"],
    }));
    await orchestrator.startOAuth({ ...input, githubAccess: "private_repositories" });
    expect(plugfn.methods.getAuthUrl).toHaveBeenLastCalledWith(expect.objectContaining({
      scopes: ["read:user", "repo"],
    }));
    await expect(orchestrator.startOAuth({ ...input, githubAccess: "invalid" as never }))
      .rejects.toMatchObject({ code: "CONNECTION_INPUT_INVALID" });
    expect(plugfn.methods.getAuthUrl).toHaveBeenCalledTimes(2);
  });

  it("stores only the opaque PlugFn id after a direct API-key connection", async () => {
    const { orchestrator, plugfn, store, workspaceId } = await fixture();
    plugfn.methods.connect.mockResolvedValueOnce(plugfn.connection({
      ownerId: workspaceId,
      organizationId: workspaceId,
      tenantId: workspaceId,
    }));

    const binding = await orchestrator.connectApiKey({
      actorUserId: "user_owner",
      workspaceId,
      provider: "linear",
      ownership: "workspace",
      apiKey: "lin_api_secret",
      label: "Team Linear",
    });

    expect(binding.providerConnectionId).toBe("plug_connection");
    expect(JSON.stringify([...store.connections.values()])).not.toContain("lin_api_secret");
    expect(plugfn.methods.connect).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { type: "api-key", apiKey: "lin_api_secret" },
      owner: expect.objectContaining({ organizationId: workspaceId }),
    }));
  });

  it("binds OAuth callbacks to the pre-authorized actor and owner", async () => {
    const { orchestrator, plugfn, workspaceId } = await fixture();
    plugfn.methods.handleCallback.mockResolvedValueOnce({
      connection: plugfn.connection({
        provider: "github",
        ownerKind: "user",
        ownerId: "user_member",
        userId: "user_member",
        tenantId: workspaceId,
        organizationId: undefined,
      }),
      returnTo: "/connections",
    });

    await expect(orchestrator.completeOAuth({
      actorUserId: "user_member",
      workspaceId,
      provider: "github",
      ownership: "personal",
      code: "oauth-code",
      state: "oauth-state",
      label: "My GitHub",
    })).resolves.toMatchObject({
      connection: { provider: "github", ownership: "personal" },
      returnTo: "/connections",
    });
    expect(plugfn.methods.handleCallback).toHaveBeenCalledWith(expect.objectContaining({
      expectedOwner: { kind: "user", userId: "user_member", tenantId: workspaceId },
      actor: { userId: "user_member", tenantId: workspaceId },
    }));
  });

  it("rejects failed callbacks without binding a remote account or exposing provider text", async () => {
    const { orchestrator, plugfn, store, workspaceId } = await fixture();
    plugfn.methods.handleCallback.mockRejectedValueOnce(new Error("token=secret-from-provider"));
    await expect(orchestrator.completeOAuth({ actorUserId: "user_owner", workspaceId,
      provider: "github", ownership: "personal", code: "failed", state: "state", label: "GitHub" }))
      .rejects.toMatchObject({ code: "CONNECTION_PROVIDER_FAILED", operation: "oauth_callback",
        message: "Provider authorization failed. Start a new connection." });
    expect(store.connections.size).toBe(0);
  });

  it("cleans up an inactive credential result instead of exposing it as ready", async () => {
    const { orchestrator, plugfn, store, workspaceId } = await fixture();
    plugfn.methods.connect.mockResolvedValueOnce(plugfn.connection({
      status: "expired", ownerId: workspaceId, organizationId: workspaceId, tenantId: workspaceId,
    }));
    await expect(orchestrator.connectApiKey({ actorUserId: "user_owner", workspaceId,
      provider: "linear", ownership: "workspace", apiKey: "secret", label: "Linear" }))
      .rejects.toMatchObject({ code: "CONNECTION_PROVIDER_FAILED", operation: "api_key" });
    expect([...store.connections.values()]).toEqual([expect.objectContaining({
      status: "revoked", readiness: "unavailable", providerConnectionId: "plug_connection",
    })]);
    expect(plugfn.methods.disconnect).toHaveBeenCalledOnce();
  });

  for (const mode of ["oauth", "api_key"] as const) {
    it(`retains an inactive ${mode} remote handle after failed cleanup for an owner retry`, async () => {
      const { authority, orchestrator, plugfn, store, workspaceId } = await fixture();
      const remote = plugfn.connection({ provider: mode === "oauth" ? "github" : "linear",
        status: "expired", ownerKind: "user", ownerId: "user_owner", tenantId: workspaceId,
        organizationId: undefined });
      if (mode === "oauth") plugfn.methods.handleCallback.mockResolvedValueOnce({ connection: remote });
      else plugfn.methods.connect.mockResolvedValueOnce(remote);
      plugfn.methods.disconnect.mockRejectedValueOnce(new Error("provider secret"));
      const attempt = mode === "oauth"
        ? orchestrator.completeOAuth({ actorUserId: "user_owner", workspaceId,
          provider: "github", ownership: "personal", code: "code", state: "state", label: "GitHub" })
        : orchestrator.connectApiKey({ actorUserId: "user_owner", workspaceId,
          provider: "linear", ownership: "personal", apiKey: "secret", label: "Linear" });
      await expect(attempt).rejects.toMatchObject({ code: "CONNECTION_PROVIDER_FAILED" });
      const [record] = [...store.connections.values()];
      expect(record).toMatchObject({ providerConnectionId: remote.id, status: "revoked",
        readiness: "unavailable", healthReason: "remote_revoke_failed" });
      expect(JSON.stringify(record)).not.toContain("secret");
      await expect(authority.resolve({ actorUserId: "user_owner", workspaceId,
        provider: remote.provider })).rejects.toBeInstanceOf(ConnectionUnavailableError);
      await expect(orchestrator.disconnect("user_member", record!.id))
        .rejects.toBeInstanceOf(ConnectionAccessDeniedError);
      await orchestrator.disconnect("user_owner", record!.id);
      expect(store.connections.get(record!.id)?.healthReason)
        .toBe(mode === "oauth" ? "remote_revocation_unavailable" : null);
      expect(plugfn.methods.disconnect).toHaveBeenCalledTimes(2);
    });
  }

  it("does not delete an unreserved active handle after a cleanup-store outage", async () => {
    const { orchestrator, plugfn, store, workspaceId } = await fixture();
    plugfn.methods.connect.mockResolvedValueOnce(plugfn.connection({ ownerKind: "user",
      ownerId: "user_owner", organizationId: undefined, tenantId: workspaceId }));
    vi.spyOn(store, "attach").mockRejectedValueOnce(new Error("database secret"));
    vi.spyOn(store, "attachForCleanup").mockRejectedValueOnce(new Error("database secret"));
    await expect(orchestrator.connectApiKey({ actorUserId: "user_owner", workspaceId,
      provider: "linear", ownership: "personal", apiKey: "key-secret", label: "Linear" }))
      .rejects.toMatchObject({ code: "CONNECTION_CLEANUP_UNTRACKED",
        message: "Provider cleanup could not be confirmed or saved. Revoke this connection in the provider account." });
    expect(store.connections.size).toBe(0);
    expect(plugfn.methods.disconnect).not.toHaveBeenCalled();
  });

  it("records an attach failure for cleanup before a rejected provider deletion", async () => {
    const { orchestrator, plugfn, store, workspaceId } = await fixture();
    plugfn.methods.connect.mockResolvedValueOnce(plugfn.connection({
      ownerKind: "user", ownerId: "user_owner", tenantId: workspaceId, organizationId: undefined,
    }));
    const attach = store.attach.bind(store);
    let first = true;
    vi.spyOn(store, "attach").mockImplementation(async (input) => {
      if (first) { first = false; throw new Error("transient attach failure"); }
      return attach(input);
    });
    plugfn.methods.disconnect.mockRejectedValueOnce(new Error("provider secret"));
    await expect(orchestrator.connectApiKey({ actorUserId: "user_owner", workspaceId,
      provider: "linear", ownership: "personal", apiKey: "secret", label: "Linear" }))
      .rejects.toMatchObject({ code: "CONNECTION_PROVIDER_FAILED", operation: "binding" });
    expect([...store.connections.values()]).toEqual([expect.objectContaining({
      status: "revoked", readiness: "unavailable", healthReason: "remote_revoke_failed",
    })]);
  });

  it("reuses a duplicate callback binding without deleting its live remote account", async () => {
    const { authority, orchestrator, plugfn, store, workspaceId } = await fixture();
    const existing = await authority.attach({ actorUserId: "user_owner", workspaceId,
      provider: "github", providerConnectionId: "plug_connection", ownership: "personal", label: "Existing" });
    plugfn.methods.handleCallback.mockResolvedValueOnce({ connection: plugfn.connection({
      provider: "github", ownerKind: "user", ownerId: "user_owner",
      tenantId: workspaceId, organizationId: undefined,
    }) });
    await expect(orchestrator.completeOAuth({ actorUserId: "user_owner", workspaceId,
      provider: "github", ownership: "personal", code: "duplicate", state: "state", label: "GitHub" }))
      .resolves.toMatchObject({ connection: { id: existing.id, status: "active" } });
    expect(store.connections.size).toBe(1);
    expect(plugfn.methods.disconnect).not.toHaveBeenCalled();
  });

  it("preserves an existing binding when a repeated result reports that remote account inactive", async () => {
    const { authority, orchestrator, plugfn, store, workspaceId } = await fixture();
    const existing = await authority.attach({ actorUserId: "user_owner", workspaceId,
      provider: "linear", providerConnectionId: "plug_connection", ownership: "personal", label: "Existing" });
    await authority.select({ actorUserId: "user_owner", workspaceId,
      provider: "linear", connectionId: existing.id });
    plugfn.methods.connect.mockResolvedValueOnce(plugfn.connection({ status: "expired",
      ownerKind: "user", ownerId: "user_owner", tenantId: workspaceId, organizationId: undefined }));
    await expect(orchestrator.connectApiKey({ actorUserId: "user_owner", workspaceId,
      provider: "linear", ownership: "personal", apiKey: "secret", label: "Linear" }))
      .rejects.toMatchObject({ code: "CONNECTION_PROVIDER_FAILED" });
    expect(store.connections.get(existing.id)).toMatchObject({ status: "active", readiness: "ready" });
    expect(store.selections.size).toBe(1);
    expect(plugfn.methods.disconnect).not.toHaveBeenCalled();
  });

  for (const [mode, firstStatus] of [
    ["oauth", "expired"], ["oauth", "active"],
    ["api_key", "expired"], ["api_key", "active"],
  ] as const) {
    it(`keeps a concurrent ${mode} binding when ${firstStatus} cleanup loses the claim`, async () => {
      const { authority, orchestrator, plugfn, store, workspaceId } = await fixture();
      const provider = mode === "oauth" ? "github" : "linear";
      const remote = { provider, ownerKind: "user" as const, ownerId: "user_owner",
        organizationId: undefined, tenantId: workspaceId };
      const inactive = plugfn.connection({ ...remote, status: firstStatus });
      const active = plugfn.connection(remote);
      if (mode === "oauth") {
        plugfn.methods.handleCallback.mockResolvedValueOnce({ connection: inactive });
        plugfn.methods.handleCallback.mockResolvedValueOnce({ connection: active });
      } else {
        plugfn.methods.connect.mockResolvedValueOnce(inactive);
        plugfn.methods.connect.mockResolvedValueOnce(active);
      }
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const attachForCleanup = store.attachForCleanup.bind(store);
      if (firstStatus === "active") {
        vi.spyOn(store, "attach").mockRejectedValueOnce(new Error("first attach unavailable"));
      }
      vi.spyOn(store, "attachForCleanup").mockImplementationOnce(async (input) => {
        entered();
        await barrier;
        return attachForCleanup(input);
      });
      const connect = () => mode === "oauth"
        ? orchestrator.completeOAuth({ actorUserId: "user_owner", workspaceId,
          provider, ownership: "personal", code: "code", state: "state", label: "Account" })
        : orchestrator.connectApiKey({ actorUserId: "user_owner", workspaceId,
          provider, ownership: "personal", apiKey: "key-secret", label: "Account" });
      const first = connect();
      let secondRequest: ReturnType<typeof connect> | undefined;
      let primaryError: unknown;
      try {
        await waitForRaceBarrier(waiting, first, `${mode} ${firstStatus} cleanup claim`);
        secondRequest = connect();
        const second = await raceStep(secondRequest, `${mode} active competing connect`);
        const binding = "connection" in second ? second.connection : second;
        await authority.select({ actorUserId: "user_owner", workspaceId,
          provider, connectionId: binding.id });
        release();
        await expect(first).rejects.toMatchObject({ code: "CONNECTION_PROVIDER_FAILED" });
        expect(store.connections.get(binding.id)).toMatchObject({ status: "active", readiness: "ready" });
        await expect(authority.resolve({ actorUserId: "user_owner", workspaceId, provider }))
          .resolves.toMatchObject({ id: binding.id, providerConnectionId: active.id });
        expect(store.selections.size).toBe(1);
        expect(plugfn.methods.disconnect).not.toHaveBeenCalled();
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        release();
        await finishRaceTest(primaryError, [async () => {
          const outcomes = await Promise.allSettled([
            settleRaceRequest(first, `${mode} ${firstStatus} cleanup`),
            ...(secondRequest ? [settleRaceRequest(secondRequest, `${mode} active connect`)] : []),
          ]);
          const failure = outcomes.find((outcome) => outcome.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }]);
      }
    }, 15_000);
  }

  it("keeps a cleanup reservation unavailable when it wins before a later active result", async () => {
    const { authority, orchestrator, plugfn, store, workspaceId } = await fixture();
    const remote = { provider: "linear", ownerKind: "user" as const, ownerId: "user_owner",
      organizationId: undefined, tenantId: workspaceId };
    plugfn.methods.connect.mockResolvedValueOnce(plugfn.connection({ ...remote, status: "expired" }));
    plugfn.methods.connect.mockResolvedValueOnce(plugfn.connection(remote));
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    plugfn.methods.disconnect.mockImplementationOnce(async () => {
      entered();
      await barrier;
      return { disconnected: true, remoteRevokeAttempted: true, remoteRevokeSucceeded: true,
        localDeleted: true, connectionDeleted: true };
    });
    const connect = () => orchestrator.connectApiKey({ actorUserId: "user_owner", workspaceId,
      provider: "linear", ownership: "personal", apiKey: "key-secret", label: "Account" });
    const first = connect();
    let secondRequest: ReturnType<typeof connect> | undefined;
    let primaryError: unknown;
    try {
      await waitForRaceBarrier(waiting, first, "API-key cleanup reservation disconnect");
      secondRequest = connect();
      await expect(raceStep(secondRequest, "API-key active result after cleanup reservation"))
        .rejects.toMatchObject({ code: "CONNECTION_PROVIDER_FAILED" });
      release();
      await expect(first).rejects.toMatchObject({ code: "CONNECTION_PROVIDER_FAILED" });
      expect([...store.connections.values()]).toEqual([expect.objectContaining({
        status: "revoked", readiness: "unavailable", providerConnectionId: "plug_connection",
      })]);
      await expect(authority.resolve({ actorUserId: "user_owner", workspaceId, provider: "linear" }))
        .rejects.toBeInstanceOf(ConnectionUnavailableError);
      expect(plugfn.methods.disconnect).toHaveBeenCalledOnce();
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      release();
      await finishRaceTest(primaryError, [async () => {
        const outcomes = await Promise.allSettled([
          settleRaceRequest(first, "API-key cleanup reservation"),
          ...(secondRequest ? [settleRaceRequest(secondRequest, "API-key active result")] : []),
        ]);
        const failure = outcomes.find((outcome) => outcome.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }]);
    }
  }, 15_000);

  it("surfaces manual guidance when no cleanup claim can be saved", async () => {
    const { orchestrator, plugfn, store, workspaceId } = await fixture();
    plugfn.methods.connect.mockResolvedValueOnce(plugfn.connection({ status: "expired",
      ownerKind: "user", ownerId: "user_owner", tenantId: workspaceId, organizationId: undefined }));
    vi.spyOn(store, "attach").mockRejectedValue(new Error("database secret"));
    vi.spyOn(store, "attachForCleanup").mockRejectedValue(new Error("database secret"));
    await expect(orchestrator.connectApiKey({ actorUserId: "user_owner", workspaceId,
      provider: "linear", ownership: "personal", apiKey: "secret", label: "Linear" }))
      .rejects.toMatchObject({ code: "CONNECTION_CLEANUP_UNTRACKED",
        message: "Provider cleanup could not be confirmed or saved. Revoke this connection in the provider account." });
    expect(plugfn.methods.disconnect).not.toHaveBeenCalled();
    expect(store.connections.size).toBe(0);
  });

  for (const mode of ["oauth", "api_key"] as const) {
    it(`${mode}: never deletes a handle without a durable cleanup claim`, async () => {
      const { orchestrator, plugfn, store, workspaceId } = await fixture();
      const provider = mode === "oauth" ? "github" : "linear";
      const returned = plugfn.connection({ provider, status: "expired", ownerKind: "user",
        ownerId: "user_owner", organizationId: undefined, tenantId: workspaceId });
      if (mode === "oauth") plugfn.methods.handleCallback.mockResolvedValueOnce({ connection: returned });
      else plugfn.methods.connect.mockResolvedValueOnce(returned);
      vi.spyOn(store, "attachForCleanup").mockRejectedValueOnce(new Error("database secret"));
      const attempt = mode === "oauth"
        ? orchestrator.completeOAuth({ actorUserId: "user_owner", workspaceId, provider,
            ownership: "personal", code: "code-secret", state: "state", label: "GitHub" })
        : orchestrator.connectApiKey({ actorUserId: "user_owner", workspaceId, provider,
            ownership: "personal", apiKey: "key-secret", label: "Linear" });
      await expect(attempt).rejects.toMatchObject({ code: "CONNECTION_CLEANUP_UNTRACKED" });
      expect(store.connections.size).toBe(0);
      expect(plugfn.methods.disconnect).not.toHaveBeenCalled();
    });
  }

  it("restores a degraded same-owner duplicate after a validated reconnect", async () => {
    const { authority, orchestrator, plugfn, store, workspaceId } = await fixture();
    const binding = await authority.attach({ actorUserId: "user_owner", workspaceId,
      provider: "linear", providerConnectionId: "plug_connection", ownership: "personal", label: "Old" });
    await authority.recordHealth({ connectionId: binding.id, status: "needs_reauth",
      readiness: "unavailable", reason: "expired" });
    await expect(authority.resolve({ actorUserId: "user_owner", workspaceId, provider: "linear" }))
      .rejects.toBeInstanceOf(ConnectionUnavailableError);
    plugfn.methods.connect.mockResolvedValueOnce(plugfn.connection({ ownerKind: "user",
      ownerId: "user_owner", organizationId: undefined, tenantId: workspaceId }));
    await expect(orchestrator.connectApiKey({ actorUserId: "user_owner", workspaceId,
      provider: "linear", ownership: "personal", apiKey: "key-secret", label: "New" }))
      .resolves.toMatchObject({ id: binding.id, status: "active", readiness: "ready", healthReason: null });
    await expect(authority.resolve({ actorUserId: "user_owner", workspaceId, provider: "linear" }))
      .resolves.toMatchObject({ id: binding.id });
    expect(store.connections.size).toBe(1);
    expect(plugfn.methods.disconnect).not.toHaveBeenCalled();
  });

  it("does not delete another owner's bound handle after a duplicate provider result", async () => {
    const { authority, orchestrator, plugfn, store, workspaceId } = await fixture();
    const member = await authority.attach({ actorUserId: "user_member", workspaceId,
      provider: "linear", providerConnectionId: "plug_connection", ownership: "personal", label: "Member" });
    plugfn.methods.connect.mockResolvedValueOnce(plugfn.connection({ ownerKind: "user",
      ownerId: "user_owner", organizationId: undefined, tenantId: workspaceId }));
    await expect(orchestrator.connectApiKey({ actorUserId: "user_owner", workspaceId,
      provider: "linear", ownership: "personal", apiKey: "key-secret", label: "Owner" }))
      .rejects.toMatchObject({ code: "CONNECTION_PROVIDER_FAILED", operation: "binding" });
    expect(store.connections.get(member.id)).toMatchObject({ status: "active", readiness: "ready" });
    expect(plugfn.methods.disconnect).not.toHaveBeenCalled();
  });

  it("preserves a bound handle when installer membership ends during reconnect", async () => {
    const { authority, orchestrator, plugfn, store, workspaceStore, workspaceId } = await fixture();
    const binding = await authority.attach({ actorUserId: "user_member", workspaceId,
      provider: "linear", providerConnectionId: "plug_connection", ownership: "personal", label: "Member" });
    plugfn.methods.connect.mockImplementationOnce(async () => {
      workspaceStore.removeMembership(workspaceId, "user_member");
      return plugfn.connection({ userId: "user_member", ownerKind: "user", ownerId: "user_member",
        organizationId: undefined, tenantId: workspaceId });
    });
    await expect(orchestrator.connectApiKey({ actorUserId: "user_member", workspaceId,
      provider: "linear", ownership: "personal", apiKey: "key-secret", label: "Member" }))
      .rejects.toMatchObject({ code: "CONNECTION_PROVIDER_FAILED", operation: "binding" });
    expect(store.connections.get(binding.id)).toMatchObject({ status: "active", readiness: "ready" });
    expect(plugfn.methods.disconnect).not.toHaveBeenCalled();
    await expect(authority.resolve({ actorUserId: "user_member", workspaceId, provider: "linear" }))
      .rejects.toBeInstanceOf(ConnectionAccessDeniedError);
  });

  it("keeps revoked duplicate handles terminal after a validated reconnect", async () => {
    const { authority, orchestrator, plugfn, store, workspaceId } = await fixture();
    const binding = await authority.attach({ actorUserId: "user_owner", workspaceId,
      provider: "linear", providerConnectionId: "plug_connection", ownership: "personal", label: "Old" });
    await authority.revoke("user_owner", binding.id, "provider_cleanup_failed");
    plugfn.methods.connect.mockResolvedValueOnce(plugfn.connection({ ownerKind: "user",
      ownerId: "user_owner", organizationId: undefined, tenantId: workspaceId }));
    await expect(orchestrator.connectApiKey({ actorUserId: "user_owner", workspaceId,
      provider: "linear", ownership: "personal", apiKey: "key-secret", label: "New" }))
      .rejects.toMatchObject({ code: "CONNECTION_PROVIDER_FAILED" });
    expect(store.connections.get(binding.id)).toMatchObject({ status: "revoked", readiness: "unavailable" });
    await expect(authority.resolve({ actorUserId: "user_owner", workspaceId, provider: "linear" }))
      .rejects.toBeInstanceOf(ConnectionUnavailableError);
  });

  it("retains cleanup state if a member leaves after PlugFn accepts the credential", async () => {
    const { orchestrator, plugfn, store, workspaceStore, workspaceId } = await fixture();
    plugfn.methods.connect.mockImplementationOnce(async () => {
      expect(workspaceStore.removeMembership(workspaceId, "user_member")).toBe(true);
      return plugfn.connection({ status: "expired", userId: "user_member", ownerKind: "user",
        ownerId: "user_member", tenantId: workspaceId, organizationId: undefined });
    });
    await expect(orchestrator.connectApiKey({ actorUserId: "user_member", workspaceId,
      provider: "linear", ownership: "personal", apiKey: "secret", label: "Member" }))
      .rejects.toMatchObject({ code: "CONNECTION_PROVIDER_FAILED" });
    expect([...store.connections.values()]).toEqual([expect.objectContaining({
      status: "revoked", readiness: "unavailable", providerConnectionId: "plug_connection",
      healthReason: "provider_cleanup_failed",
    })]);
    expect(plugfn.methods.disconnect).not.toHaveBeenCalled();
  });

  it("updates health and never lets another member probe a personal connection", async () => {
    const { authority, orchestrator, plugfn, workspaceId } = await fixture();
    const personal = await authority.attach({
      actorUserId: "user_member",
      workspaceId,
      provider: "linear",
      providerConnectionId: "plug_personal",
      ownership: "personal",
      label: "Personal",
    });
    plugfn.methods.isValid.mockResolvedValueOnce(false);
    plugfn.methods.get.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "CONNECTION_NOT_FOUND" }));

    await expect(orchestrator.checkHealth("user_admin", personal.id))
      .rejects.toBeInstanceOf(ConnectionAccessDeniedError);
    expect(plugfn.methods.isValid).not.toHaveBeenCalled();
    await expect(orchestrator.checkHealth("user_member", personal.id)).resolves.toMatchObject({
      status: "needs_reauth",
      readiness: "unavailable",
      healthReason: "plugfn_connection_missing",
    });
  });

  it("keeps revocation terminal across in-flight health and refresh operations", async () => {
    const { authority, orchestrator, plugfn, store, workspaceId } = await fixture();
    const binding = await authority.attach({
      actorUserId: "user_owner", workspaceId, provider: "linear",
      providerConnectionId: "plug_racing", ownership: "personal", label: "Racing",
    });
    let finishProbe!: (valid: boolean) => void;
    plugfn.methods.isValid.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishProbe = resolve; }));
    const pending = orchestrator.checkHealth("user_owner", binding.id);
    await vi.waitFor(() => expect(plugfn.methods.isValid).toHaveBeenCalledTimes(1));
    await authority.revoke("user_owner", binding.id);
    finishProbe(true);
    await expect(pending).rejects.toBeInstanceOf(ConnectionUnavailableError);
    await expect(orchestrator.checkHealth("user_owner", binding.id))
      .rejects.toBeInstanceOf(ConnectionUnavailableError);
    await expect(orchestrator.refresh("user_owner", binding.id))
      .rejects.toBeInstanceOf(ConnectionUnavailableError);
    expect(plugfn.methods.refresh).not.toHaveBeenCalled();
    expect(plugfn.methods.isValid).toHaveBeenCalledTimes(1);
    expect(store.connections.get(binding.id)).toMatchObject({ status: "revoked", readiness: "unavailable" });

    const other = await authority.attach({
      actorUserId: "user_owner", workspaceId, provider: "linear",
      providerConnectionId: "plug_refresh", ownership: "personal", label: "Refresh",
    });
    let finishRefresh!: (value: PlugFnConnection) => void;
    plugfn.methods.refresh.mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
    const refreshing = orchestrator.refresh("user_owner", other.id);
    await vi.waitFor(() => expect(plugfn.methods.refresh).toHaveBeenCalledTimes(1));
    await authority.revoke("user_owner", other.id);
    finishRefresh(plugfn.connection({ id: "plug_refresh" }));
    await expect(refreshing).rejects.toBeInstanceOf(ConnectionUnavailableError);
    expect(store.connections.get(other.id)).toMatchObject({ status: "revoked", readiness: "unavailable" });
  });

  it("records a remote revocation failure while removing local access", async () => {
    const { authority, orchestrator, plugfn, workspaceId } = await fixture();
    const shared = await authority.attach({
      actorUserId: "user_owner",
      workspaceId,
      provider: "linear",
      providerConnectionId: "plug_shared",
      ownership: "workspace",
      label: "Shared",
    });
    plugfn.methods.disconnect.mockResolvedValueOnce({
      disconnected: true,
      connectionId: "plug_shared",
      remoteRevokeAttempted: true,
      remoteRevokeSucceeded: false,
      localDeleted: true,
      connectionDeleted: true,
      revokeError: { message: "provider unavailable" },
    });

    await expect(orchestrator.disconnect("user_admin", shared.id)).resolves.toMatchObject({
      connection: {
        status: "revoked",
        readiness: "unavailable",
        healthReason: "remote_revocation_unavailable",
      },
      provider: { remoteRevokeSucceeded: false },
    });
    expect(plugfn.methods.disconnect).toHaveBeenCalledWith(expect.objectContaining({
      actor: expect.objectContaining({ organizationId: workspaceId, roles: ["org:admin"] }),
    }));
    await orchestrator.disconnect("user_admin", shared.id);
    expect(plugfn.methods.disconnect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["health", "active", "ready", "probe_ok"],
    ["refresh", "needs_reauth", "unavailable", "refresh_failed"],
  ] as const)("claims local revocation after an interleaved %s update", async (_operation, status, readiness, reason) => {
    const { authority, orchestrator, plugfn, store, workspaceId } = await fixture();
    const binding = await authority.attach({ actorUserId: "user_owner", workspaceId,
      provider: "linear", providerConnectionId: "remote_interleave", ownership: "workspace", label: "Interleave" });
    await authority.select({ actorUserId: "user_member", workspaceId, provider: "linear", connectionId: binding.id });
    const getRevocable = store.getRevocable.bind(store);
    const recordHealth = vi.spyOn(authority, "recordHealth");
    vi.spyOn(store, "getRevocable").mockImplementationOnce(async (input) => {
      const stale = await getRevocable(input);
      await authority.recordHealth({ connectionId: binding.id, status, readiness, reason });
      return stale;
    });

    const result = await orchestrator.disconnect("user_owner", binding.id);
    expect(recordHealth).toHaveBeenCalledWith({ connectionId: binding.id, status, readiness, reason });
    expect(result.connection).toMatchObject({ status: "revoked", readiness: "unavailable" });
    expect(store.selections.size).toBe(0);
    await expect(authority.resolve({ actorUserId: "user_member", workspaceId, provider: "linear" }))
      .rejects.toBeInstanceOf(ConnectionUnavailableError);
    expect(plugfn.methods.disconnect).toHaveBeenCalledOnce();
  });

  it("flags an OAuth grant when upstream deletes its token without attempting remote revocation", async () => {
    const { authority, orchestrator, plugfn, workspaceId } = await fixture();
    const oauth = await authority.attach({ actorUserId: "user_owner", workspaceId,
      provider: "github", providerConnectionId: "remote_oauth", ownership: "personal", label: "GitHub" });
    await expect(orchestrator.disconnect("user_owner", oauth.id)).resolves.toMatchObject({
      connection: { status: "revoked", healthReason: "remote_revocation_unavailable" },
      provider: { remoteRevokeAttempted: false, connectionDeleted: true },
    });
    await orchestrator.disconnect("user_owner", oauth.id);
    expect(plugfn.methods.disconnect).toHaveBeenCalledTimes(1);

    const apiKey = await authority.attach({ actorUserId: "user_owner", workspaceId,
      provider: "linear", providerConnectionId: "remote_api", ownership: "personal", label: "Linear" });
    await expect(orchestrator.disconnect("user_owner", apiKey.id)).resolves.toMatchObject({
      connection: { status: "revoked", healthReason: null },
      provider: { remoteRevokeAttempted: false, connectionDeleted: true },
    });
  });

  it("does not let an older failed cleanup overwrite a successful retry", async () => {
    const { authority, orchestrator, plugfn, store, workspaceId, advance } = await fixture();
    const binding = await authority.attach({ actorUserId: "user_owner", workspaceId,
      provider: "linear", providerConnectionId: "remote_race", ownership: "personal", label: "Race" });
    let finishFirst!: (value: Awaited<ReturnType<typeof plugfn.methods.disconnect>>) => void;
    plugfn.methods.disconnect.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    const first = orchestrator.disconnect("user_owner", binding.id);
    await vi.waitFor(() => expect(plugfn.methods.disconnect).toHaveBeenCalledTimes(1));
    await orchestrator.disconnect("user_owner", binding.id);
    expect(plugfn.methods.disconnect).toHaveBeenCalledTimes(1);
    advance(60_000);
    await orchestrator.disconnect("user_owner", binding.id);
    expect(plugfn.methods.disconnect).toHaveBeenCalledTimes(1);
    advance(1);
    plugfn.methods.disconnect.mockResolvedValueOnce({ disconnected: true, remoteRevokeAttempted: true,
      remoteRevokeSucceeded: true, localDeleted: true, connectionDeleted: true });
    await orchestrator.disconnect("user_owner", binding.id);
    finishFirst({ disconnected: true, remoteRevokeAttempted: true,
      remoteRevokeSucceeded: false, localDeleted: true, connectionDeleted: true });
    await first;
    expect(store.connections.get(binding.id)).toMatchObject({ status: "revoked", healthReason: null });
    expect(plugfn.methods.disconnect).toHaveBeenCalledTimes(2);
  });

  it("persists a provider outcome after a transient finalization write failure", async () => {
    const { authority, orchestrator, plugfn, store, workspaceId } = await fixture();
    const binding = await authority.attach({ actorUserId: "user_owner", workspaceId,
      provider: "linear", providerConnectionId: "remote_transient", ownership: "workspace", label: "Transient" });
    await authority.select({ actorUserId: "user_member", workspaceId,
      provider: "linear", connectionId: binding.id });
    plugfn.methods.disconnect.mockResolvedValueOnce({ disconnected: true, remoteRevokeAttempted: true,
      remoteRevokeSucceeded: false, localDeleted: true, connectionDeleted: true });
    const finalize = store.finalizeCleanupClaim.bind(store);
    let finalizationAttempts = 0;
    vi.spyOn(store, "finalizeCleanupClaim").mockImplementation(async (input) => {
      if (++finalizationAttempts === 1) {
        throw new Error("fixture transient write failure");
      }
      return finalize(input);
    });

    await expect(orchestrator.disconnect("user_owner", binding.id)).resolves.toMatchObject({
      connection: { status: "revoked", readiness: "unavailable",
        healthReason: "remote_revocation_unavailable" },
    });
    expect(finalizationAttempts).toBe(2);
    expect(store.selections.size).toBe(0);
    expect(plugfn.methods.disconnect).toHaveBeenCalledOnce();
    await orchestrator.disconnect("user_owner", binding.id);
    expect(plugfn.methods.disconnect).toHaveBeenCalledOnce();
  });

  it("keeps the committed outcome when its first write acknowledgement is lost", async () => {
    const { authority, orchestrator, plugfn, store, workspaceId } = await fixture();
    const binding = await authority.attach({ actorUserId: "user_owner", workspaceId,
      provider: "linear", providerConnectionId: "remote_ack", ownership: "workspace", label: "Ack" });
    const finalize = store.finalizeCleanupClaim.bind(store);
    let lost = false;
    vi.spyOn(store, "finalizeCleanupClaim").mockImplementation(async (input) => {
      const result = await finalize(input);
      if (!lost) {
        lost = true;
        throw new Error("fixture acknowledgement lost after commit");
      }
      return result;
    });

    await expect(orchestrator.disconnect("user_owner", binding.id)).resolves.toMatchObject({
      connection: { status: "revoked", readiness: "unavailable", healthReason: null },
    });
    expect(lost).toBe(true);
    expect(plugfn.methods.disconnect).toHaveBeenCalledOnce();
  });

  it("surfaces persistent finalization failure while keeping local use revoked for retry", async () => {
    const { authority, orchestrator, plugfn, store, workspaceId, advance } = await fixture();
    const binding = await authority.attach({ actorUserId: "user_owner", workspaceId,
      provider: "linear", providerConnectionId: "remote_persistent", ownership: "workspace", label: "Persistent" });
    await authority.select({ actorUserId: "user_member", workspaceId,
      provider: "linear", connectionId: binding.id });
    const finalize = store.finalizeCleanupClaim.bind(store);
    let finalizationAttempts = 0;
    const spy = vi.spyOn(store, "finalizeCleanupClaim").mockImplementation(async () => {
      finalizationAttempts += 1;
      throw new Error("fixture persistent write failure");
    });

    await expect(orchestrator.disconnect("user_owner", binding.id))
      .rejects.toThrow("fixture persistent write failure");
    expect(finalizationAttempts).toBe(2);
    expect(store.connections.get(binding.id)).toMatchObject({ status: "revoked", readiness: "unavailable" });
    expect(store.connections.get(binding.id)?.healthReason).toMatch(/^provider_cleanup_pending:/);
    expect(store.selections.size).toBe(0);
    await expect(authority.resolve({ actorUserId: "user_member", workspaceId, provider: "linear" }))
      .rejects.toBeInstanceOf(ConnectionUnavailableError);
    await orchestrator.disconnect("user_owner", binding.id);
    expect(plugfn.methods.disconnect).toHaveBeenCalledOnce();
    spy.mockRestore();
    advance(60_001);
    await expect(orchestrator.disconnect("user_owner", binding.id)).resolves.toMatchObject({
      connection: { status: "revoked", healthReason: null },
    });
    expect(plugfn.methods.disconnect).toHaveBeenCalledTimes(2);
  });

  it("marks a deleted upstream connection terminal after an unresolved retry", async () => {
    const { authority, orchestrator, plugfn, workspaceId } = await fixture();
    const binding = await authority.attach({ actorUserId: "user_owner", workspaceId,
      provider: "linear", providerConnectionId: "remote_missing", ownership: "personal", label: "Missing" });
    plugfn.methods.disconnect.mockResolvedValueOnce({ disconnected: false, remoteRevokeAttempted: true,
      remoteRevokeSucceeded: false, localDeleted: false, connectionDeleted: false });
    await expect(orchestrator.disconnect("user_owner", binding.id)).resolves.toMatchObject({
      connection: { healthReason: "remote_revoke_failed" },
    });
    plugfn.methods.disconnect.mockResolvedValueOnce({ disconnected: false, remoteRevokeAttempted: false,
      remoteRevokeSucceeded: false, localDeleted: false, connectionDeleted: false });
    await expect(orchestrator.disconnect("user_owner", binding.id)).resolves.toMatchObject({
      connection: { healthReason: "provider_connection_missing" },
    });
    await orchestrator.disconnect("user_owner", binding.id);
    expect(plugfn.methods.disconnect).toHaveBeenCalledTimes(2);
  });

  it("stops local use before waiting for remote revocation and redacts its error", async () => {
    const { authority, orchestrator, plugfn, store, workspaceId } = await fixture();
    const binding = await authority.attach({ actorUserId: "user_owner", workspaceId,
      provider: "linear", providerConnectionId: "remote_interrupt", ownership: "personal", label: "Interrupt" });
    await authority.select({ actorUserId: "user_owner", workspaceId,
      provider: "linear", connectionId: binding.id });
    let failRemote!: (error: Error) => void;
    plugfn.methods.disconnect.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      failRemote = reject;
    }));
    const pending = orchestrator.disconnect("user_owner", binding.id);
    await vi.waitFor(() => expect(plugfn.methods.disconnect).toHaveBeenCalledTimes(1));
    expect(store.connections.get(binding.id)).toMatchObject({ status: "revoked", readiness: "unavailable" });
    expect(store.connections.get(binding.id)?.healthReason).toMatch(/^provider_cleanup_pending:/);
    expect(store.selections.size).toBe(0);
    await expect(authority.resolve({ actorUserId: "user_owner", workspaceId, provider: "linear" }))
      .rejects.toBeInstanceOf(ConnectionUnavailableError);
    failRemote(new Error("secret provider response"));
    const result = await pending;
    expect(result.connection).toMatchObject({ status: "revoked", healthReason: "remote_revoke_failed" });
    expect(JSON.stringify(result)).not.toContain("secret provider response");
    plugfn.methods.disconnect.mockResolvedValueOnce({
      disconnected: true, remoteRevokeAttempted: true, remoteRevokeSucceeded: true,
      localDeleted: true, connectionDeleted: true,
    });
    await expect(orchestrator.disconnect("user_owner", binding.id)).resolves.toMatchObject({
      connection: { status: "revoked", healthReason: null },
      provider: { remoteRevokeSucceeded: true },
    });
  });

  it("does not mark an expired refresh result ready", async () => {
    const { authority, orchestrator, plugfn, workspaceId } = await fixture();
    const binding = await authority.attach({ actorUserId: "user_owner", workspaceId,
      provider: "linear", providerConnectionId: "plug_expired", ownership: "personal", label: "Expired" });
    plugfn.methods.refresh.mockResolvedValueOnce(plugfn.connection({ id: "plug_expired", status: "expired" }));
    await expect(orchestrator.refresh("user_owner", binding.id)).rejects.toMatchObject({
      code: "CONNECTION_PROVIDER_FAILED", operation: "refresh",
      message: "Could not refresh this account. Reconnect it to restore access.",
    });
    await expect(authority.getAccessible("user_owner", binding.id)).resolves.toMatchObject({
      status: "needs_reauth", readiness: "unavailable", healthReason: "refresh_failed",
    });
  });
});

describe("claim-scoped provider cleanup", () => {
  for (const scenario of [
    { name: "team OAuth success after removal", actor: "user_admin", ownership: "workspace",
      provider: "github", change: "remove", remoteSucceeded: true, connectionDeleted: true, reason: null },
    { name: "team API-key failure after demotion", actor: "user_admin", ownership: "workspace",
      provider: "linear", change: "demote", remoteSucceeded: false, connectionDeleted: false,
      reason: "remote_revoke_failed" },
    { name: "team OAuth failure after removal", actor: "user_admin", ownership: "workspace",
      provider: "github", change: "remove", remoteSucceeded: false, connectionDeleted: true,
      reason: "remote_revocation_unavailable" },
    { name: "personal API-key success after removal", actor: "user_member", ownership: "personal",
      provider: "linear", change: "remove", remoteSucceeded: true, connectionDeleted: true, reason: null },
  ] as const) {
    it(`persists ${scenario.name} without disclosing the binding`, async () => {
      const { authority, orchestrator, plugfn, store, workspaceStore, workspaceId } = await fixture();
      const binding = await authority.attach({ actorUserId: scenario.actor, workspaceId,
        provider: scenario.provider, providerConnectionId: `remote_${scenario.name.replaceAll(" ", "_")}`,
        ownership: scenario.ownership, label: "Cleanup" });
      await authority.select({ actorUserId: scenario.actor, workspaceId,
        provider: scenario.provider, connectionId: binding.id });
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const paused = new Promise<void>((resolve) => { release = resolve; });
      plugfn.methods.disconnect.mockImplementationOnce(async () => {
        entered();
        await paused;
        return { disconnected: scenario.connectionDeleted, remoteRevokeAttempted: true,
          remoteRevokeSucceeded: scenario.remoteSucceeded, localDeleted: scenario.connectionDeleted,
          connectionDeleted: scenario.connectionDeleted };
      });
      const request = orchestrator.disconnect(scenario.actor, binding.id);
      let primaryError: unknown;
      try {
        await waitForRaceBarrier(started, request, `${scenario.name} provider call`);
        const pending = store.connections.get(binding.id)?.healthReason;
        expect(pending).toMatch(/^provider_cleanup_pending:/);
        expect(store.selections.size).toBe(0);
        if (scenario.change === "remove") {
          expect(workspaceStore.removeMembership(workspaceId, scenario.actor)).toBe(true);
        } else {
          const membership = [...workspaceStore.memberships.values()].find((row) =>
            row.workspaceId === workspaceId && row.userId === scenario.actor);
          expect(membership).toBeDefined();
          membership!.role = "member";
        }
        await expect(authority.revokeIf(scenario.actor, binding.id, "revoked", pending!, "stale"))
          .rejects.toBeInstanceOf(ConnectionAccessDeniedError);
        release();
        await expect(request).rejects.toBeInstanceOf(ConnectionAccessDeniedError);
        expect(store.connections.get(binding.id)).toMatchObject({ status: "revoked",
          readiness: "unavailable", healthReason: scenario.reason });
        await expect(authority.finalizeCleanupClaim(binding.id, pending!)).resolves.toBeNull();
        await expect(authority.resolve({ actorUserId: "user_owner", workspaceId,
          provider: scenario.provider, connectionId: binding.id }))
          .rejects.toBeInstanceOf(ConnectionAccessDeniedError);
        expect(store.selections.size).toBe(0);
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        release();
        await finishRaceTest(primaryError, [() => settleRaceRequest(request, `${scenario.name} disconnect`)]);
      }
    });
  }

  it("keeps a body assertion primary when released work also times out", async () => {
    const primary = new Error("sentinel body assertion");
    const closed = vi.fn(async () => undefined);
    let caught: unknown;
    try {
      try {
        throw primary;
      } catch (error) {
        throw error;
      } finally {
        await finishRaceTest(primary, [
          () => raceStep(new Promise<void>(() => undefined), "forced settle"), closed,
        ]);
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(primary);
    expect(((primary.cause as AggregateError).errors[0] as Error).message)
      .toContain("forced settle did not complete");
    expect(closed).toHaveBeenCalledOnce();
  }, 5_000);
});
