import { describe, expect, it } from "vitest";
import { openRouterSettingsError, openRouterSettingsMessage } from "./openrouter-settings.js";

describe("personal OpenRouter settings states", () => {
  it("distinguishes empty, saved, invalid, pending and rollout-disabled states without a key", () => {
    expect(openRouterSettingsMessage({ configured: false }, "", false)).toContain("No OpenRouter key");
    expect(openRouterSettingsMessage({ configured: true, maskedKey: "••••1234", validation: "valid" }, "", false))
      .toContain("••••1234 is valid");
    expect(openRouterSettingsMessage({ configured: true, maskedKey: "••••1234", validation: "invalid" }, "", false))
      .toContain("Replace or remove");
    expect(openRouterSettingsMessage(null, "check", false)).toContain("Checking");
    expect(openRouterSettingsMessage(null, "", true)).toContain("pending verification");
    expect(openRouterSettingsError("OPENROUTER_KEY_INVALID")).toContain("not replaced");
    expect(openRouterSettingsError("OPENROUTER_VALIDATION_UNAVAILABLE")).toContain("Try again");
  });
});
