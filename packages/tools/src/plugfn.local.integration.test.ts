import { describe, expect, it } from "vitest";
import { MemoryAdapter, mockProvider, plugFn } from "plugfn";
import { githubProvider } from "@plugfn/providers";

import { createPlugFnToolCatalog } from "./plugfn.js";

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
});
