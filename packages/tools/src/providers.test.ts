import { describe, expect, it } from "vitest";

import { providerStatus, v1ProviderCatalog, V1_PROVIDERS } from "./providers.js";

const definitions = new Map(V1_PROVIDERS.map((provider) => [provider, {
  name: provider,
  displayName: provider,
  version: "1.0.0",
  auth: { type: "oauth2" },
  actions: { get: {} },
}]));

function catalog(configured: ReadonlySet<string>, connections = new Map()) {
  return v1ProviderCatalog({
    get: (provider) => definitions.get(provider as typeof V1_PROVIDERS[number]),
    configured: (provider) => configured.has(provider),
    connections,
  });
}

describe("v1 provider readiness contract", () => {
  it("returns exactly four named providers in a stable order without leaking other registered adapters", () => {
    const providers = catalog(new Set(["github", "linear", "slack", "notion"]));
    expect(providers.map(({ provider }) => provider)).toEqual(["github", "linear", "slack", "notion"]);
    expect(providers.map(({ displayName }) => displayName)).toEqual(["GitHub", "Linear", "Slack", "Notion"]);
    expect(providerStatus({
      provider: "stripe",
      definition: { name: "stripe", displayName: "Stripe", auth: { type: "api-key" }, actions: { charge: {} } },
      configured: true,
      connections: [{ status: "active", readiness: "ready" }],
    })).toMatchObject({ state: "unsupported", available: false, actionCount: 0 });
  });

  it("moves from unconfigured to disconnected to expired to ready, and back on revoke", () => {
    const connection = new Map([["linear", [{ status: "needs_reauth", readiness: "unavailable" }]]]);
    expect(catalog(new Set(), connection).find((item) => item.provider === "linear")?.state).toBe("unconfigured");
    expect(catalog(new Set(["linear"])).find((item) => item.provider === "linear")?.state).toBe("disconnected");
    expect(catalog(new Set(["linear"]), connection).find((item) => item.provider === "linear")?.state).toBe("expired");
    connection.set("linear", [{ status: "active", readiness: "ready" }]);
    expect(catalog(new Set(["linear"]), connection).find((item) => item.provider === "linear")?.state).toBe("ready");
    connection.set("linear", [{ status: "revoked", readiness: "unavailable" }]);
    expect(catalog(new Set(["linear"]), connection).find((item) => item.provider === "linear")?.state).toBe("disconnected");
  });

  it("fails closed when the v1 adapter is absent, even with configuration and a ready binding", () => {
    expect(providerStatus({ provider: "notion", configured: true,
      connections: [{ status: "active", readiness: "ready" }],
    })).toMatchObject({ state: "unsupported", available: false });
  });
});
