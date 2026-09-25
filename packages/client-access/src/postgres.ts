import pg from "pg";

import { ClientAccessAuthority } from "./client-access.js";
import { PostgresDeviceAuthorizationStore } from "./device-postgres-store.js";
import {
  createAesGcmDeviceCredentialCipher,
  DeviceLoginAuthority,
} from "./device-login.js";
import { PostgresClientAccessStore } from "./postgres-store.js";
import { PostgresOAuthMcpGrants } from "./oauth-postgres-store.js";

const { Client } = pg;

export interface PostgresClientAccessRuntime {
  clients: ClientAccessAuthority;
  oauthGrants: PostgresOAuthMcpGrants;
  close(): Promise<void>;
}

export interface PostgresDeviceLoginRuntime {
  deviceLogin: DeviceLoginAuthority;
  close(): Promise<void>;
}

export async function connectPostgresClientAccess(input: {
  connectionString: string;
}): Promise<PostgresClientAccessRuntime> {
  const parsed = new URL(input.connectionString);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("A PostgreSQL connection string is required");
  }

  const client = new Client({ connectionString: input.connectionString });
  await client.connect();
  return {
    clients: new ClientAccessAuthority(new PostgresClientAccessStore(client)),
    oauthGrants: new PostgresOAuthMcpGrants(client),
    async close() {
      await client.end();
    },
  };
}

export async function connectPostgresDeviceLogin(input: {
  connectionString: string;
  credentialWrappingKey: Uint8Array;
  verificationUri: string;
}): Promise<PostgresDeviceLoginRuntime> {
  const parsed = new URL(input.connectionString);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("A PostgreSQL connection string is required");
  }
  const cipher = await createAesGcmDeviceCredentialCipher(input.credentialWrappingKey);
  const client = new Client({ connectionString: input.connectionString });
  await client.connect();
  return {
    deviceLogin: new DeviceLoginAuthority(
      new PostgresDeviceAuthorizationStore(client),
      cipher,
      input.verificationUri,
    ),
    async close() {
      await client.end();
    },
  };
}

export { PostgresClientAccessStore } from "./postgres-store.js";
export { PostgresOAuthMcpGrants } from "./oauth-postgres-store.js";
export { PostgresDeviceAuthorizationStore } from "./device-postgres-store.js";
