import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { drizzleAdapter } from "@superfunctions/db/adapters/drizzle";
import type { AuthFnEnvironmentResolver } from "authfn";

import { authDrizzleSchema } from "./auth-schema.js";
import { PostgresWorkspaceStore } from "./postgres-store.js";
import { createOMRIdentityRuntime, type OMRIdentityRuntime } from "./runtime.js";
import { WorkspaceAuthority } from "./workspaces.js";

const { Client } = pg;

export interface ConnectPostgresIdentityRuntimeOptions {
  connectionString: string;
  environment?: AuthFnEnvironmentResolver;
}

export interface PostgresIdentityRuntime extends OMRIdentityRuntime {
  close(): Promise<void>;
}

function assertPostgresConnectionString(connectionString: string): void {
  const parsed = new URL(connectionString);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("A PostgreSQL connection string is required");
  }
}

export async function connectPostgresIdentityRuntime(
  options: ConnectPostgresIdentityRuntimeOptions,
): Promise<PostgresIdentityRuntime> {
  assertPostgresConnectionString(options.connectionString);
  const identityClient = new Client({ connectionString: options.connectionString });
  const authorityClient = new Client({ connectionString: options.connectionString });
  await Promise.all([identityClient.connect(), authorityClient.connect()]);

  try {
    await identityClient.query("SET search_path TO omr_identity");
    const database = drizzleAdapter({
      db: drizzle(identityClient, { schema: authDrizzleSchema }),
      dialect: "postgres",
    });
    const workspaces = new WorkspaceAuthority(new PostgresWorkspaceStore(authorityClient));
    const runtime = createOMRIdentityRuntime({
      database,
      workspaces,
      environment: options.environment,
    });

    return {
      ...runtime,
      async close() {
        await Promise.all([identityClient.end(), authorityClient.end()]);
      },
    };
  } catch (error) {
    await Promise.allSettled([identityClient.end(), authorityClient.end()]);
    throw error;
  }
}

export { PostgresWorkspaceStore } from "./postgres-store.js";
