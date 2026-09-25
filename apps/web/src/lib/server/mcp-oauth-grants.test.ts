import { describe, expect, it } from "vitest";

import { oauthGrantFamily, oauthGrantIdFromRedirect } from "./mcp-oauth-grants.js";

describe("MCP OAuth grant keys", () => {
  it("replaces all grants for a registered client but only the same redirect for CIMD", () => {
    const registered = { clientId: "registered-client", redirectUri: "https://client.example/one" };
    expect(oauthGrantFamily(registered)).toBe(oauthGrantFamily({
      ...registered, redirectUri: "https://client.example/two",
    }));
    expect(oauthGrantFamily({ clientId: "https://client.example", redirectUri: registered.redirectUri }))
      .toBe(oauthGrantFamily({ clientId: "https://client.example", redirectUri: "https://client.example/two" }));
    expect(oauthGrantFamily({ clientId: "http://client.example/client.json", redirectUri: registered.redirectUri }))
      .toBe(oauthGrantFamily({ clientId: "http://client.example/client.json", redirectUri: "https://client.example/two" }));
    const cimd = { clientId: "https://client.example/client.json", redirectUri: registered.redirectUri };
    expect(oauthGrantFamily(cimd)).not.toBe(oauthGrantFamily({
      ...cimd, redirectUri: "https://client.example/two",
    }));
  });

  it("extracts only the pinned provider's code grant format", () => {
    const valid = new URL("https://client.example/callback");
    valid.searchParams.set("code", `user_one:${"a".repeat(16)}:${"b".repeat(32)}`);
    expect(oauthGrantIdFromRedirect(valid.toString(), "user_one")).toBe("a".repeat(16));
    expect(oauthGrantIdFromRedirect(valid.toString(), "user_other")).toBeNull();
    valid.searchParams.set("code", "opaque-code");
    expect(oauthGrantIdFromRedirect(valid.toString(), "user_one")).toBeNull();
  });
});
