import { describe, expect, it } from "vitest";

import { toAuthFnRequest } from "./auth-router.js";

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
});
