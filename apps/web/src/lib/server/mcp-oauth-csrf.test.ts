import { describe, expect, it } from "vitest";

import { createOAuthCsrfToken, validOAuthCsrf } from "./mcp-oauth-csrf.js";

describe("OAuth consent CSRF", () => {
  it("requires a matching single host cookie and form token", () => {
    const token = createOAuthCsrfToken();
    const request = new Request("https://omr.example/oauth/authorize", {
      headers: { cookie: `__Host-omr-oauth-consent=${token}` },
    });
    expect(validOAuthCsrf(request, "__Host-omr-oauth-consent", token)).toBe(true);
    expect(validOAuthCsrf(request, "__Host-omr-oauth-consent", "a".repeat(64))).toBe(false);
    expect(validOAuthCsrf(request, "__Host-omr-oauth-consent", null)).toBe(false);
    const duplicate = new Request(request, {
      headers: { cookie: `__Host-omr-oauth-consent=${token}; __Host-omr-oauth-consent=${token}` },
    });
    expect(validOAuthCsrf(duplicate, "__Host-omr-oauth-consent", token)).toBe(false);
  });
});
