import { describe, expect, it } from "vitest";

import { ToolCatalog, ToolCatalogInputError, type ToolCatalogSource } from "./catalog.js";

function source(actionOrder = ["create_issue", "get_issue"]): ToolCatalogSource {
  const actions = Object.fromEntries(actionOrder.map((name) => [name, {
    name,
    displayName: name === "get_issue" ? "Get issue" : "Create issue",
    description: name === "get_issue" ? "Read a Linear issue" : "Create a Linear issue",
    parameters: { type: "object", properties: { id: { type: "string" } } },
    returns: { type: "object" },
    contract: {
      version: "1.0.0",
      effect: name === "get_issue" ? "read" as const : "write" as const,
      requiredScopes: ["issues:read"],
      resources: [{ kind: "issue", parameter: "id" }],
      sensitiveKeys: [],
      pagination: { kind: "none" as const },
      retry: name === "get_issue" ? "safe" as const : "never" as const,
    },
  }]));
  return {
    providers: {
      list: () => [{
        name: "linear",
        displayName: "Linear",
        version: "2.1.0",
        description: "Linear",
        actions,
      }],
    },
  };
}

const jsonSchema = (value: unknown) => value as never;

describe("tool catalog", () => {
  it("creates stable namespaced manifests independent of registry insertion order", async () => {
    const left = await ToolCatalog.create(source(), jsonSchema);
    const right = await ToolCatalog.create(source(["get_issue", "create_issue"]), jsonSchema);

    expect(left.revision).toBe(right.revision);
    expect(left.discover().tools.map(({ id }) => id)).toEqual([
      "linear.create_issue",
      "linear.get_issue",
    ]);
    expect(left.get("linear.get_issue")).toMatchObject({
      providerVersion: "2.1.0",
      contract: { version: "1.0.0", effect: "read" },
      hash: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
    });
  });

  it("filters by query, provider, effect, and allowed provider set", async () => {
    const catalog = await ToolCatalog.create(source(), jsonSchema);
    expect(catalog.discover({ query: "read", effects: ["read"] }).tools)
      .toHaveLength(1);
    expect(catalog.discover({ providers: ["linear"], allowedProviders: new Set(["github"]) }).tools)
      .toEqual([]);
  });

  it("paginates against one catalog revision and rejects stale or malformed cursors", async () => {
    const catalog = await ToolCatalog.create(source(), jsonSchema);
    const first = catalog.discover({ limit: 1 });
    expect(first.tools).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    expect(catalog.discover({ limit: 1, cursor: first.nextCursor }).tools[0]?.id)
      .toBe("linear.get_issue");

    const changed = await ToolCatalog.create({
      providers: { list: () => [] },
    }, jsonSchema);
    expect(() => changed.discover({ cursor: first.nextCursor }))
      .toThrow(ToolCatalogInputError);
    expect(() => catalog.discover({ cursor: "not-a-cursor" }))
      .toThrow(ToolCatalogInputError);
    expect(() => catalog.discover({ query: "different", cursor: first.nextCursor }))
      .toThrow(ToolCatalogInputError);
  });

  it("defaults missing effect contracts to fail-closed unknown semantics", async () => {
    const value = source();
    delete value.providers.list()[0]!.actions.get_issue!.contract;
    const catalog = await ToolCatalog.create(value, jsonSchema);
    expect(catalog.get("linear.get_issue")?.contract).toEqual({
      version: "0.0.0",
      effect: "unknown",
      requiredScopes: [],
      resources: [],
      sensitiveKeys: [],
      pagination: { kind: "none" },
      retry: "never",
    });
  });

  it("rejects mismatched registry names and unsafe unknown-effect retry metadata", async () => {
    const mismatched = source();
    mismatched.providers.list()[0]!.actions.get_issue!.name = "other";
    await expect(ToolCatalog.create(mismatched, jsonSchema)).rejects.toBeInstanceOf(
      ToolCatalogInputError,
    );

    const unsafe = source();
    unsafe.providers.list()[0]!.actions.get_issue!.contract = {
      ...unsafe.providers.list()[0]!.actions.get_issue!.contract!,
      effect: "unknown",
      retry: "safe",
    };
    await expect(ToolCatalog.create(unsafe, jsonSchema)).rejects.toBeInstanceOf(
      ToolCatalogInputError,
    );
  });
});
