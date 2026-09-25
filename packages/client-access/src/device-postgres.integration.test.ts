import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectPostgresClientAccess,
  connectPostgresDeviceLogin,
  type PostgresClientAccessRuntime,
  type PostgresDeviceLoginRuntime,
} from "./postgres.js";

const connectionString = process.env.OMR_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

describePostgres("device login/PostgreSQL integration", () => {
  let accessRuntime: PostgresClientAccessRuntime;
  let deviceRuntime: PostgresDeviceLoginRuntime;
  let workspaceId: string;

  beforeAll(async () => {
    const setup = new Client({ connectionString: connectionString! });
    await setup.connect();
    workspaceId = `workspace_team_${crypto.randomUUID()}`;
    const now = Date.now();
    await setup.query(
      `INSERT INTO omr_control.workspaces (id, kind, name, created_at, updated_at)
       VALUES ($1, 'team', 'Device Login', $2, $2)`,
      [workspaceId, now],
    );
    await setup.query(
      `INSERT INTO omr_control.workspace_memberships
         (id, workspace_id, user_id, role, created_at, updated_at)
       VALUES ($1, $2, 'user_device_owner', 'owner', $3, $3)`,
      [`membership_${crypto.randomUUID()}`, workspaceId, now],
    );
    await setup.end();

    accessRuntime = await connectPostgresClientAccess({ connectionString: connectionString! });
    deviceRuntime = await connectPostgresDeviceLogin({
      connectionString: connectionString!,
      credentialWrappingKey: new Uint8Array(32).fill(19),
      verificationUri: "https://omr.invalid/device",
    });
  });

  afterAll(async () => {
    await Promise.all([accessRuntime.close(), deviceRuntime.close()]);
  });

  it("creates client access atomically and consumes the wrapped credential", async () => {
    const started = await deviceRuntime.deviceLogin.begin({
      clientKind: "cli",
      clientName: "Postgres CLI",
      requestedCapabilities: ["tools:discover", "tools:read"],
    });
    const approved = await deviceRuntime.deviceLogin.approve({
      userCode: started.userCode,
      actorUserId: "user_device_owner",
      workspaceId,
    });

    const control = new Client({ connectionString: connectionString! });
    await control.connect();
    try {
      const stored = await control.query<{
        device_code_hash: string;
        user_code_hash: string;
        sealed_credential: string;
      }>(
        `SELECT device_code_hash, user_code_hash, sealed_credential
         FROM omr_control.device_authorizations
         WHERE client_id = $1`,
        [approved.client.id],
      );
      expect(stored.rows[0]?.device_code_hash).not.toContain(started.deviceCode);
      expect(stored.rows[0]?.user_code_hash).not.toContain(started.userCode);
      expect(stored.rows[0]?.sealed_credential).toMatch(/^v1\./);
    } finally {
      await control.end();
    }

    const completed = await deviceRuntime.deviceLogin.poll(started.deviceCode);
    await expect(
      accessRuntime.clients.authenticate(completed.credential, "tools:read"),
    ).resolves.toMatchObject({
      clientId: approved.client.id,
      workspaceId,
      userId: "user_device_owner",
    });
    await expect(deviceRuntime.deviceLogin.poll(started.deviceCode)).rejects.toMatchObject({
      code: "DEVICE_AUTHORIZATION_INVALID",
    });
  });

  it("does not create access when the approving user lacks membership", async () => {
    const started = await deviceRuntime.deviceLogin.begin({
      clientKind: "mcp_stdio",
      clientName: "Unauthorized MCP",
      requestedCapabilities: ["tools:read"],
    });
    await expect(
      deviceRuntime.deviceLogin.approve({
        userCode: started.userCode,
        actorUserId: "user_outsider",
        workspaceId,
      }),
    ).rejects.toMatchObject({ code: "DEVICE_AUTHORIZATION_INVALID" });
  });

  it("persists a remote MCP device grant", async () => {
    const started = await deviceRuntime.deviceLogin.begin({
      clientKind: "mcp_remote",
      clientName: "Postgres Remote MCP",
      requestedCapabilities: ["tools:discover", "tools:read"],
    });
    await deviceRuntime.deviceLogin.approve({
      userCode: started.userCode,
      actorUserId: "user_device_owner",
      workspaceId,
    });
    const completed = await deviceRuntime.deviceLogin.poll(started.deviceCode);
    await expect(accessRuntime.clients.authenticate(completed.credential, "tools:discover"))
      .resolves.toMatchObject({ kind: "mcp_remote", workspaceId });
  });
});
