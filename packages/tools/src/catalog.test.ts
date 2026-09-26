import { describe, expect, it, vi } from "vitest";

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

  it("excludes unsupported and unconfigured adapters from manifest IDs and revision", async () => {
    const linear = source().providers.list()[0]!;
    const stripe = { ...linear, name: "stripe", displayName: "Stripe" };
    const configured = await ToolCatalog.create({ providers: { list: () => [stripe, linear] } },
      jsonSchema, new Set(["linear"]));
    const baseline = await ToolCatalog.create(source(), jsonSchema, new Set(["linear"]));
    expect(configured.revision).toBe(baseline.revision);
    expect(configured.get("stripe.get_issue")).toBeNull();
    expect(configured.discover().tools.map(({ id, hash }) => ({ id, hash })))
      .toEqual(baseline.discover().tools.map(({ id, hash }) => ({ id, hash })));

    const changed = source();
    changed.providers.list()[0]!.actions.get_issue!.parameters = {
      type: "object", properties: { issueId: { type: "integer" } },
    };
    const changedCatalog = await ToolCatalog.create(changed, jsonSchema, new Set(["linear"]));
    expect(changedCatalog.get("linear.get_issue")?.hash).not.toBe(baseline.get("linear.get_issue")?.hash);
    expect(changedCatalog.revision).not.toBe(baseline.revision);
  });

  it("invalidates a cursor when the ready provider set changes", async () => {
    const catalog = await ToolCatalog.create(source(), jsonSchema);
    const cursor = catalog.discover({ limit: 1, allowedProviders: new Set(["linear"]) }).nextCursor;
    expect(() => catalog.discover({ limit: 1, cursor, allowedProviders: new Set() }))
      .toThrow(ToolCatalogInputError);
  });

  it("filters granted action IDs without changing manifest hashes and rejects stale grant cursors", async () => {
    const catalog = await ToolCatalog.create(source(), jsonSchema);
    const all = new Set(catalog.list().map(({ id }) => id));
    const first = catalog.discover({ allowedToolIds: all, limit: 1 });
    const restricted = new Set(["linear.get_issue"]);
    expect(catalog.discover({ allowedToolIds: restricted }).tools).toEqual([catalog.get("linear.get_issue")]);
    expect(catalog.revision).toBe(first.revision);
    expect(() => catalog.discover({ allowedToolIds: restricted, cursor: first.nextCursor }))
      .toThrow(/filters or grants changed/);
    expect(catalog.discover({ allowedToolIds: new Set([...all].reverse()), limit: 1 }).nextCursor)
      .toBe(first.nextCursor);
  });

  it("continues a mixed-case grant cursor across runtime locales and filter insertion orders", async () => {
    const option = (reverse = false) => ({
      providers: reverse ? ["linear", "github"] : ["github", "linear"],
      effects: reverse ? ["write", "read"] as ("read" | "write")[] : ["read", "write"] as ("read" | "write")[],
      allowedProviders: new Set(reverse ? ["linear", "github"] : ["github", "linear"]),
      allowedToolIds: new Set(reverse
        ? ["linear.m", "linear.i", "linear.I"]
        : ["linear.I", "linear.i", "linear.m"]),
      limit: 1,
    });
    const localeCompare = vi.spyOn(String.prototype, "localeCompare");
    try {
      const english = new Intl.Collator("en");
      localeCompare.mockImplementation(function (other) { return english.compare(String(this), other); });
      const englishCatalog = await ToolCatalog.create(source(["I", "i", "m"]), jsonSchema);
      const first = englishCatalog.discover(option());
      expect(first.tools.map(({ id }) => id)).toEqual(["linear.I"]);
      const turkish = new Intl.Collator("tr");
      localeCompare.mockImplementation(function (other) { return turkish.compare(String(this), other); });
      const turkishCatalog = await ToolCatalog.create(source(["m", "i", "I"]), jsonSchema);
      expect(turkishCatalog.revision).toBe(englishCatalog.revision);
      expect(turkishCatalog.list().map(({ id, hash }) => ({ id, hash })))
        .toEqual(englishCatalog.list().map(({ id, hash }) => ({ id, hash })));
      expect(turkishCatalog.discover(option(true)).nextCursor).toBe(first.nextCursor);
      const second = turkishCatalog.discover({ ...option(true), cursor: first.nextCursor });
      expect(second.tools.map(({ id }) => id)).toEqual(["linear.i"]);
      expect(() => turkishCatalog.discover({
        ...option(true), allowedToolIds: new Set(["linear.I", "linear.m"]), cursor: first.nextCursor,
      })).toThrow(/filters or grants changed/);
    } finally {
      localeCompare.mockRestore();
    }
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
    expect(() => catalog.discover({ cursor: btoa("null") }))
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
