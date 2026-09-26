import { describe, expect, it, vi } from "vitest";
import { ConnectionAuthority } from "@oh-my-router/connections";
import { MemoryConnectionBindingStore } from "@oh-my-router/connections/testing";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { publicConnections, publicConnectionsAfterMutation } from "./connection-view.js";

describe("connection HTTP projection", () => {
  it("shows each actor's selection and never exposes the upstream credential handle", async () => {
    const workspaces = new MemoryWorkspaceStore();
    const workspace = (await new WorkspaceAuthority(workspaces).createTeam({
      ownerUserId: "user_owner", name: "Team",
    })).workspace;
    const authority = new ConnectionAuthority(new MemoryConnectionBindingStore(workspaces));
    const first = await authority.attach({ actorUserId: "user_owner", workspaceId: workspace.id,
      provider: "github", providerConnectionId: "secret_remote_handle_1", ownership: "personal", label: "First" });
    const second = await authority.attach({ actorUserId: "user_owner", workspaceId: workspace.id,
      provider: "github", providerConnectionId: "secret_remote_handle_2", ownership: "personal", label: "Second" });
    await authority.select({ actorUserId: "user_owner", workspaceId: workspace.id,
      provider: "github", connectionId: second.id });
    const projected = await publicConnections(authority, "user_owner", workspace.id,
      [{ ...first, selectable: true }, { ...second, selectable: true }]);
    expect(projected.map(({ selected }) => selected)).toEqual([false, true]);
    expect((await publicConnections(authority, "user_owner", workspace.id, [second]))[0]?.selected)
      .toBe(false);
    expect(JSON.stringify(projected)).not.toContain("secret_remote_handle");
    expect(JSON.stringify(projected)).not.toContain("installedBy");
    expect((await publicConnections(authority, "user_owner", workspace.id,
      [{ ...second, selectable: false, providerState: "unconfigured" }]))[0])
      .toMatchObject({ selected: false, selectable: false, providerState: "unconfigured" });
    expect((await publicConnections(authority, "user_owner", workspace.id,
      [{ ...second, cleanupOnly: true }]))[0])
      .toMatchObject({ selected: false, cleanupOnly: true, label: "Former member github account" });
    await authority.revoke("user_owner", second.id);
    expect((await publicConnections(authority, "user_owner", workspace.id,
      await authority.listAvailable({ actorUserId: "user_owner", workspaceId: workspace.id })))
      .every(({ selected }) => !selected)).toBe(true);
  });

  it("returns a redacted committed mutation when selection storage fails, while reads still report the outage", async () => {
    const workspaces = new MemoryWorkspaceStore();
    const workspace = (await new WorkspaceAuthority(workspaces).createTeam({
      ownerUserId: "user_owner", name: "Team",
    })).workspace;
    const authority = new ConnectionAuthority(new MemoryConnectionBindingStore(workspaces));
    const callbackBinding = await authority.attach({ actorUserId: "user_owner", workspaceId: workspace.id,
      provider: "github", providerConnectionId: "secret_oauth_handle", ownership: "personal", label: "OAuth" });
    const keyBinding = await authority.attach({ actorUserId: "user_owner", workspaceId: workspace.id,
      provider: "linear", providerConnectionId: "secret_key_handle", ownership: "personal", label: "API key" });
    vi.spyOn(authority, "getSelection").mockRejectedValue(new Error("selection store unavailable"));

    await expect(publicConnections(authority, "user_owner", workspace.id, [callbackBinding]))
      .rejects.toThrow("selection store unavailable");
    const connected = await publicConnectionsAfterMutation(authority, "user_owner", workspace.id,
      [callbackBinding, keyBinding]);
    expect(connected).toMatchObject([{ status: "active", selected: false }, { status: "active", selected: false }]);
    expect(JSON.stringify(connected)).not.toMatch(/secret_(oauth|key)_handle/);

    const checked = await authority.recordHealth({ connectionId: callbackBinding.id,
      status: "needs_reauth", readiness: "unavailable", reason: "fixture_expired" });
    expect((await publicConnectionsAfterMutation(authority, "user_owner", workspace.id, [checked]))[0])
      .toMatchObject({ status: "needs_reauth", selected: false });
    const refreshed = await authority.recordHealth({ connectionId: callbackBinding.id,
      status: "active", readiness: "ready" });
    expect((await publicConnectionsAfterMutation(authority, "user_owner", workspace.id, [refreshed]))[0])
      .toMatchObject({ status: "active", selected: false });
    const revoked = await authority.revoke("user_owner", callbackBinding.id);
    expect((await publicConnectionsAfterMutation(authority, "user_owner", workspace.id, [revoked]))[0])
      .toMatchObject({ status: "revoked", selected: false });
  });
});
