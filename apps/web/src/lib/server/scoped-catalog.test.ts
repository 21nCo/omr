import { describe, expect, it, vi } from "vitest";
import { ToolCatalog, type ProviderStatus } from "@oh-my-router/tools";

import { resolveScopedCatalog } from "./scoped-catalog.js";

const providers: ProviderStatus[] = ["github", "linear"].map((provider) => ({
  provider, displayName: provider, providerVersion: "1.0.0", description: "",
  authMode: "oauth", actionCount: 1, state: "ready", available: true,
}));

async function catalog(includeScopeFree = false) {
  return ToolCatalog.create({ providers: { list: () => ["github", "linear"].map((name) => ({
    name, displayName: name, version: "1.0.0", description: "",
    actions: { read: {
      name: "read", displayName: "Read", description: "Read resource",
      parameters: {}, returns: {},
      contract: { version: "1.0.0", effect: "read" as const, requiredScopes: ["read"],
        resources: [], sensitiveKeys: [], pagination: { kind: "none" as const }, retry: "never" as const },
    }, ...(includeScopeFree ? { no_scope: {
      name: "no_scope", displayName: "No scope", description: "Read public resource",
      parameters: {}, returns: {},
      contract: { version: "1.0.0", effect: "read" as const, requiredScopes: [],
        resources: [], sensitiveKeys: [], pagination: { kind: "none" as const }, retry: "never" as const },
    } } : {}) },
  })) } }, (schema) => schema as Record<string, never>);
}

describe("workspace-scoped discovery and manifest grants", () => {
  it("hides an unknown grant while retaining another provider with a verified empty grant", async () => {
    const tools = await catalog(true);
    const resolve = async (provider: string) => ({ id: provider, providerConnectionId: provider });
    const scoped = (githubScopes: readonly string[] | undefined) => resolveScopedCatalog(tools, providers,
      resolve, async (connectionId) => connectionId === "github" ? githubScopes : [], async () => {});
    const unknown = await scoped(undefined);
    expect(tools.discover({ allowedToolIds: unknown }).tools.map(({ id }) => id))
      .toEqual(["linear.no_scope"]);
    expect(unknown.has("github.no_scope")).toBe(false);
    expect(unknown.has("linear.no_scope")).toBe(true);
    const verified = await scoped([]);
    expect(tools.discover({ allowedToolIds: verified }).tools.map(({ id }) => id))
      .toEqual(["github.no_scope", "linear.no_scope"]);
  });

  it("degrades only a deleted remote binding, preserving the other provider in discovery and manifests", async () => {
    const tools = await catalog();
    const onMissing = vi.fn(async () => {});
    const resolve = vi.fn(async (provider: string) => ({ id: `binding_${provider}`, providerConnectionId: provider }));
    const grants = vi.fn(async (id: string) => {
      if (id === "github") throw Object.assign(new Error("deleted"), { code: "CONNECTION_NOT_FOUND" });
      return ["read"];
    });
    const visible = await resolveScopedCatalog(tools, providers, resolve, grants, onMissing);
    expect(tools.discover({ allowedToolIds: visible }).tools.map(({ id }) => id)).toEqual(["linear.read"]);
    expect(visible.has(tools.get("github.read")!.id)).toBe(false);
    expect(visible.has(tools.get("linear.read")!.id)).toBe(true);
    expect(onMissing).toHaveBeenCalledExactlyOnceWith("binding_github");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("does not disguise remote authorization or transport failures as missing grants", async () => {
    const tools = await catalog();
    const onMissing = vi.fn(async () => {});
    await expect(resolveScopedCatalog(tools, providers,
      async (provider) => ({ id: provider, providerConnectionId: provider }),
      async () => { throw Object.assign(new Error("forbidden"), { code: "CONNECTION_ACCESS_DENIED" }); },
      onMissing,
    )).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(onMissing).not.toHaveBeenCalled();
  });
});
