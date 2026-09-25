import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connectPostgresDataRuntime, type PostgresDataRuntime } from "./postgres.js";

const connectionString = process.env.OMR_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

function request(
  path: string,
  workspaceId: string,
  body: Record<string, unknown>,
): Request {
  return new Request(`https://omr.invalid${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-workspace": workspaceId,
      "x-test-actor": `actor:${workspaceId}`,
    },
    body: JSON.stringify(body),
  });
}

describePostgres("OMR PostgreSQL/DataFn integration", () => {
  let runtime: PostgresDataRuntime;

  beforeAll(async () => {
    runtime = await connectPostgresDataRuntime({
      connectionString: connectionString!,
      resolvePrincipal: (incomingRequest) => ({
        workspaceId: incomingRequest.headers.get("x-test-workspace") ?? "",
        actorId: incomingRequest.headers.get("x-test-actor") ?? "",
      }),
      authorize: () => true,
    });
  });

  afterAll(async () => {
    await runtime.close();
  });

  it("isolates real PostgreSQL records by workspace namespace", async () => {
    const suffix = crypto.randomUUID();
    for (const workspaceId of ["alpha", "beta"]) {
      const response = await runtime.server.router.handle(
        request("/datafn/push", workspaceId, {
          clientId: `client:${workspaceId}`,
          mutations: [
            {
              resource: "workspace_profiles",
              version: 1,
              operation: "insert",
              id: `profile:${workspaceId}:${suffix}`,
              clientId: `client:${workspaceId}`,
              mutationId: `mutation:${workspaceId}:${suffix}`,
              record: { displayName: workspaceId.toUpperCase() },
            },
          ],
        }),
      );
      expect(response.status).toBe(200);
    }

    const response = await runtime.server.router.handle(
      request("/datafn/query", "alpha", {
        resource: "workspace_profiles",
        version: 1,
        select: ["id", "displayName"],
        filters: { id: { eq: `profile:alpha:${suffix}` } },
      }),
    );
    const body = (await response.json()) as {
      result: { data: Array<{ id: string; displayName: string }> };
    };

    expect(response.status).toBe(200);
    expect(body.result.data).toEqual([
      { id: `profile:alpha:${suffix}`, displayName: "ALPHA" },
    ]);
  });

  it("rolls back earlier steps when a PostgreSQL transaction fails", async () => {
    const suffix = crypto.randomUUID();
    const id = `profile:rollback:${suffix}`;
    const response = await runtime.server.router.handle(
      request("/datafn/transact", "alpha", {
        steps: [
          {
            resource: "workspace_profiles",
            version: 1,
            operation: "insert",
            id,
            clientId: "client:alpha",
            mutationId: `mutation:rollback:${suffix}:1`,
            record: { displayName: "Must roll back" },
          },
          {
            resource: "workspace_profiles",
            version: 1,
            operation: "unsupported_operation",
            id: `profile:invalid:${suffix}`,
            clientId: "client:alpha",
            mutationId: `mutation:rollback:${suffix}:2`,
          },
        ],
      }),
    );
    const body = (await response.json()) as {
      result: { ok: boolean; results: Array<{ ok: boolean; rolledBack?: boolean }> };
    };

    expect(body.result.ok).toBe(false);
    expect(body.result.results[0]).toMatchObject({ ok: false, rolledBack: true });

    const queryResponse = await runtime.server.router.handle(
      request("/datafn/query", "alpha", {
        resource: "workspace_profiles",
        version: 1,
        select: ["id"],
        filters: { id: { eq: id } },
      }),
    );
    const queryBody = (await queryResponse.json()) as { result: { data: unknown[] } };
    expect(queryBody.result.data).toEqual([]);
  });

  it("places DataFn internal tables in omr_app and not the public schema", async () => {
    const client = new Client({ connectionString: connectionString! });
    await client.connect();
    try {
      const result = await client.query<{ table_schema: string; table_name: string }>(
        `SELECT table_schema, table_name
         FROM information_schema.tables
         WHERE table_name LIKE '__datafn_%'
         ORDER BY table_schema, table_name`,
      );

      expect(result.rows.length).toBeGreaterThan(0);
      expect(new Set(result.rows.map(({ table_schema }) => table_schema))).toEqual(
        new Set(["omr_app"]),
      );
    } finally {
      await client.end();
    }
  });
});
