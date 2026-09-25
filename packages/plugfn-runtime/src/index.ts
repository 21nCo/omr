import {
  clickupProvider,
  discordProvider,
  githubProvider,
  gmailProvider,
  googleCalendarProvider,
  googleDocsProvider,
  googleDriveProvider,
  googleSheetsProvider,
  icloudProvider,
  imapSmtpProvider,
  jiraProvider,
  linearProvider,
  notionProvider,
  onedriveProvider,
  outlookProvider,
  slackProvider,
  stripeProvider,
  yahooProvider,
} from "@plugfn/providers";
import pg from "pg";
import { plugFn, type IntegrationConfig, type PlugFn, type PlugFnAuthorizationOptions } from "plugfn";

import { createPostgresPlugFnAdapter } from "./postgres.js";

const { Client } = pg;

const providers = [
  clickupProvider,
  discordProvider,
  githubProvider,
  gmailProvider,
  googleCalendarProvider,
  googleDocsProvider,
  googleDriveProvider,
  googleSheetsProvider,
  icloudProvider,
  imapSmtpProvider,
  jiraProvider,
  linearProvider,
  notionProvider,
  onedriveProvider,
  outlookProvider,
  slackProvider,
  stripeProvider,
  yahooProvider,
];

export interface PostgresPlugFnRuntime {
  plugfn: PlugFn;
  close(): Promise<void>;
}

export async function connectPostgresPlugFn(input: {
  connectionString: string;
  baseUrl: string;
  encryptionKey: string;
  integrations?: Record<string, IntegrationConfig>;
  authorization?: PlugFnAuthorizationOptions;
}): Promise<PostgresPlugFnRuntime> {
  const parsed = new URL(input.connectionString);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("A PostgreSQL connection string is required");
  }
  const client = new Client({ connectionString: input.connectionString });
  await client.connect();
  try {
    const database = createPostgresPlugFnAdapter(client);
    await database.initialize();
    const runtime = plugFn({
      database,
      auth: {},
      baseUrl: input.baseUrl,
      encryptionKey: input.encryptionKey,
      integrations: input.integrations ?? {},
      retry: { enabled: true },
      cache: { enabled: false },
      rateLimit: { enabled: false },
      logger: {
        debug() {},
        info() {},
        warn(message, meta) {
          console.warn(JSON.stringify({
            service: "omr-plugfn",
            level: "warn",
            message,
            ...(meta && typeof meta === "object" && "code" in meta
              ? { code: String((meta as { code: unknown }).code) }
              : {}),
          }));
        },
        error(message, meta) {
          console.error(JSON.stringify({
            service: "omr-plugfn",
            level: "error",
            message,
            ...(meta && typeof meta === "object" && "error" in meta
              ? { error: String((meta as { error: unknown }).error) }
              : {}),
          }));
        },
      },
      ...(input.authorization ? { authorization: input.authorization } : {}),
    });
    for (const provider of providers) runtime.use(provider);
    await runtime.ready;
    return {
      plugfn: runtime,
      async close() {
        await client.end();
      },
    };
  } catch (error) {
    await client.end();
    throw error;
  }
}

export { createPostgresPlugFnAdapter } from "./postgres.js";
