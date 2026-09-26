import { describe, expect, it } from "vitest";
import { ConnectionAuthority } from "@oh-my-router/connections";
import { MemoryConnectionBindingStore } from "@oh-my-router/connections/testing";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { publicConnections } from "./connection-view.js";

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
    const projected = await publicConnections(authority, "user_owner", workspace.id, [first, second]);
    expect(projected.map(({ selected }) => selected)).toEqual([false, true]);
    expect(JSON.stringify(projected)).not.toContain("secret_remote_handle");
    await authority.revoke("user_owner", second.id);
    expect((await publicConnections(authority, "user_owner", workspace.id,
      await authority.listAvailable({ actorUserId: "user_owner", workspaceId: workspace.id })))
      .every(({ selected }) => !selected)).toBe(true);
  });
});
