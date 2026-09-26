import { describe, expect, it } from "vitest";

import {
  oauthCallbackUri,
  readPendingOAuthConnection,
  savePendingOAuthConnection,
} from "./oauth-connection.js";

const origin = "https://omr.example";
const pending = {
  provider: "github",
  workspaceId: "workspace_team_123",
  ownership: "workspace" as const,
  label: "Engineering GitHub",
  redirectUri: oauthCallbackUri(origin),
  createdAt: 1_000,
};

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("browser provider OAuth handoff", () => {
  it("stores only a bounded HTTPS authorization state and restores its exact intent", () => {
    const session = storage();
    expect(savePendingOAuthConnection(session, "https://github.com/login/oauth/authorize?state=abc_123", pending))
      .toContain("state=abc_123");
    expect(readPendingOAuthConnection(session, "abc_123", origin, 1_001)).toEqual(pending);
    expect(readPendingOAuthConnection(session, "abc_123", origin, 1_001)).toBeNull();
  });

  it("rejects stale, cross-origin and malformed intents", () => {
    const session = storage();
    expect(() => savePendingOAuthConnection(session, "http://github.com/?state=abc", pending)).toThrow();
    savePendingOAuthConnection(session, "https://github.com/?state=abc", pending);
    expect(readPendingOAuthConnection(session, "abc", "https://other.example", 1_001)).toBeNull();
    expect(readPendingOAuthConnection(session, "abc", origin, 1_001)).toBeNull();
    savePendingOAuthConnection(session, "https://github.com/?state=fresh-expiry", pending);
    expect(readPendingOAuthConnection(session, "fresh-expiry", origin, 1_000 + 10 * 60 * 1000 + 1)).toBeNull();
  });
});
