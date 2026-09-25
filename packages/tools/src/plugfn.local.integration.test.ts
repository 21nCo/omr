import { describe, expect, it } from "vitest";
import { MemoryAdapter, mockProvider, plugFn } from "plugfn";
import { githubProvider, linearProvider, notionProvider, slackProvider, stripeProvider } from "@plugfn/providers";

import { createPlugFnToolCatalog } from "./plugfn.js";
import { v1ProviderCatalog } from "./providers.js";

describe("local PlugFn catalog integration", () => {
  it("converts linked PlugFn action schemas into versioned manifests", async () => {
    const runtime = plugFn({
      database: new MemoryAdapter(),
      auth: { getUserId: async () => null },
      baseUrl: "https://omr.local",
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      integrations: {},
    }).use(mockProvider("linear", { get_issue: { data: { id: "issue_1" } } }));
    await runtime.ready;

    const catalog = await createPlugFnToolCatalog(runtime);
    expect(catalog.get("linear.get_issue")).toMatchObject({
      catalogSchemaVersion: "1.0.0",
      provider: "linear",
      contract: { effect: "unknown", retry: "never" },
      inputSchema: expect.objectContaining({ $schema: expect.any(String) }),
    });
  });

  it("preserves first-party hierarchical action keys", async () => {
    const runtime = plugFn({
      database: new MemoryAdapter(),
      auth: {},
      baseUrl: "https://omr.local",
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      integrations: {},
    }).use(githubProvider);
    await runtime.ready;

    const catalog = await createPlugFnToolCatalog(runtime);
    expect(catalog.get("github.issues.createComment")).toMatchObject({
      provider: "github",
      action: "issues.createComment",
    });
  });

  it("uses the four real provider definitions and hides registered experimental tools", async () => {
    const runtime = plugFn({
      database: new MemoryAdapter(),
      auth: {},
      baseUrl: "https://omr.local",
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      integrations: {},
    });
    for (const provider of [githubProvider, linearProvider, slackProvider, notionProvider, stripeProvider]) {
      runtime.use(provider);
    }
    await runtime.ready;
    const providers = v1ProviderCatalog({
      get: (provider) => runtime.providers.get(provider),
      configured: () => false,
    });
    expect(providers.map(({ provider, state }) => [provider, state])).toEqual([
      ["github", "unconfigured"], ["linear", "unconfigured"],
      ["slack", "unconfigured"], ["notion", "unconfigured"],
    ]);
    const catalog = await createPlugFnToolCatalog(runtime);
    expect(catalog.discover({ limit: 100 }).tools.every(({ provider }) =>
      ["github", "linear", "slack", "notion"].includes(provider))).toBe(true);
    expect(catalog.get("stripe.charges.create")).toBeNull();
    expect(catalog.discover({ allowedProviders: new Set() }).tools).toEqual([]);
    expect(catalog.get("github.issues.createComment")?.hash).toMatch(/^sha256-[a-f0-9]{64}$/);
  });
});
