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
        healthReason: "remote_revoke_failed",
      },
      provider: { remoteRevokeSucceeded: false },
    });
    expect(plugfn.methods.disconnect).toHaveBeenCalledWith(expect.objectContaining({
      actor: expect.objectContaining({ organizationId: workspaceId, roles: ["org:admin"] }),
    }));
  });
});
