import { describe, expect, it } from "vitest";

import { createProviderIntegrationConfig } from "./cloudflare-runtime.js";

describe("Worker provider OAuth configuration", () => {
  it("allowlists the browser callback for configured providers", () => {
    const config = createProviderIntegrationConfig({
      PLUGFN_GITHUB_CLIENT_ID: "sandbox-client",
      PLUGFN_GITHUB_CLIENT_SECRET: "sandbox-secret",
    }, "https://omr-web-staging.example");
    expect(config.github).toEqual({
      type: "oauth2",
      clientId: "sandbox-client",
      clientSecret: "sandbox-secret",
      redirectUris: ["https://omr-web-staging.example/app/oauth/callback"],
    });
    expect(config.linear).toBeUndefined();
  });

  it("does not expose a provider with only one client credential", () => {
    expect(createProviderIntegrationConfig({
      PLUGFN_GITHUB_CLIENT_ID: "sandbox-client",
    }, "https://omr-web-staging.example").github).toBeUndefined();
  });
});
