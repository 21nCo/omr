import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connectPostgresPlugFn } from "./index.js";
import { createPostgresPlugFnAdapter } from "./postgres.js";
import { createPlugFnToolCatalog } from "@oh-my-router/tools";

const connectionString = process.env.OMR_TEST_DATABASE_URL;
const integration = connectionString ? describe : describe.skip;
const { Client } = pg;

integration("PostgreSQL PlugFn runtime", () => {
  let client: InstanceType<typeof Client>;

  beforeAll(async () => {
    client = new Client({ connectionString });
    await client.connect();
  });

  afterAll(async () => {
    await client?.query("DELETE FROM omr_plugfn.records WHERE namespace = 'test-runtime'");
    await client?.query("DELETE FROM omr_plugfn.internal_records WHERE table_name = '__datafn_test'");
    await client?.query("DELETE FROM omr_plugfn.schema_versions WHERE namespace = 'test-runtime'");
    await client?.end();
  });

  it("supports namespaced CRUD, atomic upsert, transactions, and internal records", async () => {
    const adapter = createPostgresPlugFnAdapter(client);
    const created = await adapter.create<{ id: string; score: number }>({
      model: "widgets",
      namespace: "test-runtime",
      data: { id: "widget-one", score: 1, label: "first" },
    });
    expect(created).toMatchObject({ id: "widget-one", score: 1 });

    await adapter.upsert({
      model: "widgets",
      namespace: "test-runtime",
      where: [{ field: "id", operator: "eq", value: "widget-one" }],
      create: { id: "widget-one", score: 99 },
      update: { score: 2 },
    });
    expect(await adapter.findOne({
      model: "widgets",
      namespace: "test-runtime",
      where: [{ field: "id", operator: "eq", value: "widget-one" }],
    })).toMatchObject({ score: 2 });

    await expect(adapter.transaction(async (transaction) => {
      await transaction.create({
        model: "widgets",
        namespace: "test-runtime",
        data: { id: "rolled-back", score: 3 },
      });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await adapter.count({ model: "widgets", namespace: "test-runtime" })).toBe(1);

    await adapter.internal.ensureTable("__datafn_test", [{ name: "id", type: "text" }]);
    await adapter.internal.create("__datafn_test", { id: "internal-one", value: 4 });
    expect(await adapter.internal.findOne("__datafn_test", [
      { field: "id", op: "eq", value: "internal-one" },
    ])).toMatchObject({ value: 4 });

    await adapter.setSchemaVersion("test-runtime", 7);
    expect(await adapter.getSchemaVersion("test-runtime")).toBe(7);
  });

  it("persists a real linked PlugFn API-key connection", async () => {
    const runtime = await connectPostgresPlugFn({
      connectionString: connectionString!,
      baseUrl: "http://localhost:5173",
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    try {
      const connection = await runtime.plugfn.connections.connect({
        userId: "runtime-user",
        provider: "stripe",
        credentials: { type: "api-key", apiKey: "sk_test_not_real" },
        owner: { kind: "user", userId: "runtime-user", tenantId: "test-runtime" },
        actor: { userId: "runtime-user", tenantId: "test-runtime" },
      });
      expect(connection.provider).toBe("stripe");
      expect((await createPlugFnToolCatalog(runtime.plugfn)).discover({ limit: 100 }).tools.length)
        .toBeGreaterThan(50);
      expect((await runtime.plugfn.connections.get(connection.id)).id).toBe(connection.id);
      await runtime.plugfn.connections.disconnect({
        userId: "runtime-user",
        provider: "stripe",
        connectionId: connection.id,
        owner: { kind: "user", userId: "runtime-user", tenantId: "test-runtime" },
        actor: { userId: "runtime-user", tenantId: "test-runtime" },
      });
    } finally {
      await runtime.close();
    }
  });
});
