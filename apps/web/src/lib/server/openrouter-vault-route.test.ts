import { describe, expect, it } from "vitest";
import { OpenRouterVault, OpenRouterVaultError, decodeOpenRouterVaultKeys,
  type OpenRouterKeyRow, type OpenRouterVaultStore } from "@oh-my-router/identity";
import type { connectPostgresOpenRouterVault } from "@oh-my-router/identity/postgres";
import { createOMRRouter, type OpenRouterVaultRouteServices } from "./router.js";
import { createOpenRouterVaultRouteServices } from "./cloudflare-runtime.js";

const secret = `sk-or-v1-${"s".repeat(32)}`;

describe("personal OpenRouter HTTP contract", () => {
  it("enforces rollout, web identity, same origin, personal isolation and cleanup", async () => {
    const rows = new Map<string, OpenRouterKeyRow>();
    const revisions = new Map<string, string>();
    const store: OpenRouterVaultStore = {
      get: async (userId) => rows.get(userId) ?? null,
      revision: async (userId) => revisions.get(userId) ?? null,
      put: async (row, expectedRevision) => {
        if ((revisions.get(row.userId) ?? null) !== expectedRevision) return false;
        rows.set(row.userId, row); revisions.set(row.userId, row.revision); return true;
      },
      markValidation: async () => {},
      delete: async (userId) => { rows.delete(userId); revisions.set(userId, crypto.randomUUID()); },
    };
    const vault = new OpenRouterVault(store,
      decodeOpenRouterVaultKeys(JSON.stringify({ v1: "55".repeat(32) }), "v1"),
      (async () => new Response(JSON.stringify({ data: { is_management_key: false } }))) as typeof fetch);
    let enabled = false;
    let opened = 0;
    let closed = 0;
    const services = createOpenRouterVaultRouteServices({
      enabled: () => enabled,
      requireUser: async (request) => {
        const actor = request.headers.get("x-fixture-user");
        if (!actor) throw Object.assign(new Error("Unauthenticated"), { code: "AUTHFN_UNAUTHENTICATED" });
        return actor;
      },
      open: async () => {
        opened += 1;
        return { vault, close: async () => { closed += 1; } } as
          Awaited<ReturnType<typeof connectPostgresOpenRouterVault>>;
      },
    });
    const router = createOMRRouter(undefined, undefined, undefined, undefined, undefined, services);
    const request = (method: string, user?: string, origin?: string, body?: object) =>
      new Request("https://omr.invalid/api/settings/openrouter", { method,
        headers: { ...(user ? { "x-fixture-user": user } : {}), ...(origin ? { origin } : {}),
          ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    expect((await router.handle(request("GET", "alice"))).status).toBe(503);
    enabled = true;
    expect((await router.handle(request("GET"))).status).toBe(401);
    expect((await router.handle(request("PUT", "alice", "https://other.invalid", { key: secret }))).status).toBe(403);
    expect(opened).toBe(0);
    const saved = await router.handle(request("PUT", "alice", "https://omr.invalid", { key: secret }));
    expect(saved.status).toBe(200);
    expect(JSON.stringify(await saved.json())).not.toContain(secret);
    expect(await (await router.handle(request("GET", "bob"))).json()).toEqual({ configured: false });
    expect((await router.handle(request("DELETE", "alice", "https://omr.invalid"))).status).toBe(200);
    expect(await (await router.handle(request("GET", "alice"))).json()).toEqual({ configured: false });
    expect(closed).toBe(opened);
  });

  it("offers a masked, non-cacheable lifecycle without a workspace parameter", async () => {
    const calls: string[] = [];
    const status = { configured: true, maskedKey: "••••ssss", validation: "valid" as const, checkedAt: 1 };
    const services: OpenRouterVaultRouteServices = {
      async status() { calls.push("status"); return status; },
      async save(_request, key) { calls.push(`saved:${key === secret}`); return status; },
      async check() { calls.push("check"); return status; },
      async delete() { calls.push("delete"); return { configured: false }; },
    };
    const router = createOMRRouter(undefined, undefined, undefined, undefined, undefined, services);
    const request = (path: string, method: string, body?: object) => new Request(`https://omr.invalid${path}`,
      { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const responses = [
      await router.handle(request("/api/settings/openrouter?workspaceId=another-team", "GET")),
      await router.handle(request("/api/settings/openrouter", "PUT", { key: secret })),
      await router.handle(request("/api/settings/openrouter/check", "POST")),
      await router.handle(request("/api/settings/openrouter", "DELETE")),
    ];
    expect(calls).toEqual(["status", "saved:true", "check", "delete"]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(JSON.stringify(await response.json())).not.toContain(secret);
    }
  });

  it("does not return provider text or secret material on invalid and unavailable responses", async () => {
    const services: OpenRouterVaultRouteServices = {
      status: async () => { throw new OpenRouterVaultError("OPENROUTER_VAULT_UNAVAILABLE"); },
      save: async () => { throw new OpenRouterVaultError("OPENROUTER_KEY_INVALID"); },
      check: async () => { throw new OpenRouterVaultError("OPENROUTER_VALIDATION_UNAVAILABLE"); },
      delete: async () => ({ configured: false }),
    };
    const router = createOMRRouter(undefined, undefined, undefined, undefined, undefined, services);
    const response = await router.handle(new Request("https://omr.invalid/api/settings/openrouter", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: secret }),
    }));
    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).toEqual('{"error":"OPENROUTER_KEY_INVALID"}');
    const unavailable = await router.handle(new Request("https://omr.invalid/api/settings/openrouter"));
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(await unavailable.json())).not.toContain(secret);
  });
});
