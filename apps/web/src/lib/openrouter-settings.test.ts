import { describe, expect, it } from "vitest";
import { openRouterSettingsCanMutate, openRouterSettingsDraftAfter,
  openRouterSettingsError, openRouterSettingsMessage, parseOpenRouterSettingsStatus } from "./openrouter-settings.js";

describe("personal OpenRouter settings states", () => {
  it("distinguishes empty, saved, invalid, pending and rollout-disabled states without a key", () => {
    expect(openRouterSettingsMessage({ configured: false }, "", "ready")).toContain("No OpenRouter key");
    expect(openRouterSettingsMessage({ configured: true, maskedKey: "••••1234", validation: "valid" }, "", "ready"))
      .toContain("••••1234 is valid");
    expect(openRouterSettingsMessage({ configured: true, maskedKey: "••••1234", validation: "invalid" }, "", "ready"))
      .toContain("Replace or remove");
    expect(openRouterSettingsMessage({ configured: false }, "check", "ready")).toContain("Checking");
    expect(openRouterSettingsMessage(null, "", "disabled")).toContain("pending verification");
    expect(openRouterSettingsMessage(null, "", "unavailable")).toContain("Could not load");
    expect(openRouterSettingsMessage(null, "", "unavailable")).not.toContain("No OpenRouter key");
    expect(openRouterSettingsCanMutate("unavailable", null)).toBe(false);
    expect(openRouterSettingsCanMutate("loading", null)).toBe(false);
    expect(openRouterSettingsCanMutate("disabled", { configured: true })).toBe(false);
    expect(openRouterSettingsCanMutate("ready", { configured: false })).toBe(true);
    expect(parseOpenRouterSettingsStatus({ configured: false })).toEqual({ configured: false });
    expect(parseOpenRouterSettingsStatus({ configured: true, maskedKey: "••••1234",
      validation: "valid", checkedAt: 1 })).toEqual({ configured: true, maskedKey: "••••1234",
      validation: "valid", checkedAt: 1 });
    expect(parseOpenRouterSettingsStatus({})).toBeNull();
    expect(parseOpenRouterSettingsStatus({ configured: true, key: "secret" })).toBeNull();
    const draft = `sk-or-v1-${"p".repeat(32)}`;
    expect(openRouterSettingsDraftAfter("check", draft)).toBe(draft);
    expect(openRouterSettingsDraftAfter("delete", draft)).toBe(draft);
    expect(openRouterSettingsDraftAfter("save", draft)).toBe("");
    expect(openRouterSettingsError("OPENROUTER_KEY_INVALID")).toContain("not replaced");
    expect(openRouterSettingsError("OPENROUTER_VALIDATION_UNAVAILABLE")).toContain("Try again");
  });
});
