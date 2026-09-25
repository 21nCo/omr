import { describe, expect, it } from "vitest";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { WorkspaceAuthority } from "@oh-my-router/identity";

import { ClientAccessAuthority } from "./client-access.js";
import {
  createAesGcmDeviceCredentialCipher,
  DeviceAuthorizationError,
  DeviceLoginAuthority,
} from "./device-login.js";
import {
  MemoryClientAccessStore,
  MemoryDeviceAuthorizationStore,
} from "./testing.js";

async function createFixture() {
  let now = 1_700_000_000_000;
  const workspaceStore = new MemoryWorkspaceStore();
  const workspaces = new WorkspaceAuthority(workspaceStore, () => now);
  const clientStore = new MemoryClientAccessStore(workspaceStore);
  const clients = new ClientAccessAuthority(clientStore, () => now);
  const deviceStore = new MemoryDeviceAuthorizationStore(workspaceStore, clientStore);
  const cipher = await createAesGcmDeviceCredentialCipher(new Uint8Array(32).fill(7));
  const deviceLogin = new DeviceLoginAuthority(
    deviceStore,
    cipher,
    "https://omr.invalid/device",
    () => now,
  );
  const team = await workspaces.createTeam({ ownerUserId: "user_owner", name: "Device Team" });
  return {
    clients,
    deviceLogin,
    deviceStore,
    workspaceId: team.workspace.id,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

describe("device login authority", () => {
  it("approves a CLI device and releases its encrypted credential exactly once", async () => {
    const { clients, deviceLogin, deviceStore, workspaceId } = await createFixture();
    const started = await deviceLogin.begin({
      clientKind: "cli",
      clientName: "Ada's Terminal",
      requestedCapabilities: ["tools:discover", "tools:read"],
    });

    expect(started.deviceCode).toMatch(/^omr_device_[a-f0-9]{64}$/);
    expect(started.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(started.verificationUriComplete).toBe(
      `https://omr.invalid/device?user_code=${started.userCode}`,
    );
    expect(JSON.stringify([...deviceStore.authorizations.values()])).not.toContain(
      started.deviceCode,
    );
    await expect(deviceLogin.poll(started.deviceCode)).rejects.toMatchObject({
      code: "DEVICE_AUTHORIZATION_PENDING",
      retryAfterMs: 5_000,
    });

    const approved = await deviceLogin.approve({
      userCode: started.userCode.toLowerCase(),
      actorUserId: "user_owner",
      workspaceId,
    });
    const storedBeforePoll = [...deviceStore.authorizations.values()][0]!;
    expect(storedBeforePoll.sealedCredential).toMatch(/^v1\./);

    const completed = await deviceLogin.poll(started.deviceCode);
    expect(completed).toMatchObject({
      clientId: approved.client.id,
      grantId: approved.grant.id,
      workspaceId,
    });
    await expect(
      clients.authenticate(completed.credential, "tools:read"),
    ).resolves.toMatchObject({
      clientId: approved.client.id,
      grantId: approved.grant.id,
      workspaceId,
      kind: "cli",
    });
    expect([...deviceStore.authorizations.values()][0]).toMatchObject({
      status: "consumed",
      sealedCredential: null,
    });
    await expect(deviceLogin.poll(started.deviceCode)).rejects.toBeInstanceOf(
      DeviceAuthorizationError,
    );
  });

  it("requires approval by a member of the selected workspace", async () => {
    const { deviceLogin, workspaceId } = await createFixture();
    const started = await deviceLogin.begin({
      clientKind: "mcp_stdio",
      clientName: "Local MCP",
      requestedCapabilities: ["tools:read"],
    });
    await expect(
      deviceLogin.approve({
        userCode: started.userCode,
        actorUserId: "user_outsider",
        workspaceId,
      }),
    ).rejects.toMatchObject({ code: "DEVICE_AUTHORIZATION_INVALID" });
  });

  it("issues a remote MCP grant through the device approval flow", async () => {
    const { clients, deviceLogin, workspaceId } = await createFixture();
    const started = await deviceLogin.begin({
      clientKind: "mcp_remote",
      clientName: "Remote MCP Host",
      requestedCapabilities: ["tools:discover", "tools:read"],
    });
    await deviceLogin.approve({
      userCode: started.userCode,
      actorUserId: "user_owner",
      workspaceId,
    });
    const completed = await deviceLogin.poll(started.deviceCode);
    await expect(clients.authenticate(completed.credential, "tools:discover"))
      .resolves.toMatchObject({ kind: "mcp_remote", workspaceId });
    await expect(clients.authenticate(completed.credential, "tools:write"))
      .rejects.toMatchObject({ code: "CLIENT_CAPABILITY_DENIED" });
  });

  it("expires pending authorizations without creating client access", async () => {
    const { deviceLogin, workspaceId, advance } = await createFixture();
    const started = await deviceLogin.begin({
      clientKind: "cli",
      clientName: "Expired CLI",
      requestedCapabilities: ["tools:read"],
    });
    advance(10 * 60 * 1000);

    await expect(deviceLogin.poll(started.deviceCode)).rejects.toMatchObject({
      code: "DEVICE_AUTHORIZATION_EXPIRED",
    });
    await expect(
      deviceLogin.approve({
        userCode: started.userCode,
        actorUserId: "user_owner",
        workspaceId,
      }),
    ).rejects.toMatchObject({ code: "DEVICE_AUTHORIZATION_EXPIRED" });
  });

  it("rejects ciphertext tampering", async () => {
    const cipher = await createAesGcmDeviceCredentialCipher(new Uint8Array(32).fill(11));
    const sealed = await cipher.seal("omr_secret");
    const tampered = `${sealed.slice(0, -1)}${sealed.endsWith("A") ? "B" : "A"}`;
    await expect(cipher.open(tampered)).rejects.toMatchObject({
      code: "DEVICE_AUTHORIZATION_INVALID",
    });
  });

  it("permits loopback HTTP verification only for local development", async () => {
    const workspaceStore = new MemoryWorkspaceStore();
    const clientStore = new MemoryClientAccessStore(workspaceStore);
    const deviceStore = new MemoryDeviceAuthorizationStore(workspaceStore, clientStore);
    const cipher = await createAesGcmDeviceCredentialCipher(new Uint8Array(32).fill(13));

    expect(
      () => new DeviceLoginAuthority(deviceStore, cipher, "http://127.0.0.1:8789/device"),
    ).not.toThrow();
    expect(
      () => new DeviceLoginAuthority(deviceStore, cipher, "http://example.com/device"),
    ).toThrow("Device verification URI must use HTTPS or localhost HTTP");
  });
});
