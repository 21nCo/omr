import { describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("@oh-my-router/identity/postgres", () => ({ connectPostgresIdentityRuntime: identity.connect }));

import { handleCloudflareAuth, toAuthFnRequest } from "./auth-router.js";

describe("AuthFn Worker boundary", () => {
  it("maps the public API prefix to AuthFn without changing request semantics", async () => {
    const source = new Request("https://omr.invalid/api/auth/sign-up/password?return=cli", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "existing=yes" },
      body: JSON.stringify({ email: "ada@example.com" }),
    });

    const mapped = toAuthFnRequest(source);

    expect(mapped.url).toBe("https://omr.invalid/auth/sign-up/password?return=cli");
    expect(mapped.method).toBe("POST");
    expect(mapped.headers.get("cookie")).toBe("existing=yes");
    await expect(mapped.json()).resolves.toEqual({ email: "ada@example.com" });
  });

  it("returns 503 without opening the identity runtime while primary Hyperdrive caching is unconfirmed", async () => {
    const response = await handleCloudflareAuth({
      request: new Request("https://omr.invalid/api/auth/session"),
      platform: { env: { HYPERDRIVE: { connectionString: "postgres://hyperdrive" }, DATABASE_URL: "postgres://direct" } },
    } as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "RUNTIME_UNAVAILABLE" });
    expect(identity.connect).not.toHaveBeenCalled();
  });
});
