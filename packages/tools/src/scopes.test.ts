import { describe, expect, it } from "vitest";
import { ToolCatalog } from "./catalog.js";
import { hasRequiredScopes, usableToolIds } from "./scopes.js";

describe("verified connection grants", () => {
  it("distinguishes a verified empty grant from unknown scope data", async () => {
    const catalog = await ToolCatalog.create({ providers: { list: () => [{
      name: "linear", displayName: "Linear", version: "1.0.0", description: "",
      actions: {
        no_scope: { name: "no_scope", displayName: "No scope", description: "Read public data",
          parameters: {}, returns: {}, contract: { version: "1.0.0", effect: "read" as const,
            requiredScopes: [], resources: [], sensitiveKeys: [], pagination: { kind: "none" as const }, retry: "safe" as const } },
        scoped: { name: "scoped", displayName: "Scoped", description: "Read private data",
          parameters: {}, returns: {}, contract: { version: "1.0.0", effect: "read" as const,
            requiredScopes: ["read"], resources: [], sensitiveKeys: [], pagination: { kind: "none" as const }, retry: "safe" as const } },
      },
    }] } }, (value) => value as never);
    const noScope = catalog.get("linear.no_scope")!;
    expect(hasRequiredScopes(noScope, undefined)).toBe(false);
    expect(hasRequiredScopes(noScope, [])).toBe(true);
    const visible = (scopes: readonly string[] | null | undefined) => usableToolIds(catalog,
      [{ provider: "linear", state: "ready" }], async () => scopes);
    expect(await visible(undefined)).toEqual(new Set());
    expect(await visible(null)).toEqual(new Set());
    expect(await visible([])).toEqual(new Set(["linear.no_scope"]));
    expect(await visible(["read"])).toEqual(new Set(["linear.no_scope", "linear.scoped"]));
  });
});
