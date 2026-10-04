export type OpenRouterSettingsStatus = {
  configured: boolean;
  maskedKey?: string;
  validation?: "valid" | "invalid";
  checkedAt?: number;
};

export function openRouterSettingsMessage(status: OpenRouterSettingsStatus | null,
  busy: "" | "save" | "check" | "delete", disabled: boolean): string {
  if (disabled) return "Personal OpenRouter keys are pending verification.";
  if (busy === "save") return "Validating and saving key…";
  if (busy === "check") return "Checking saved key…";
  if (busy === "delete") return "Removing saved key…";
  if (!status?.configured) return "No OpenRouter key saved.";
  return status.validation === "invalid"
    ? `Saved key ${status.maskedKey ?? ""} is invalid. Replace or remove it.`
    : `Saved key ${status.maskedKey ?? ""} is valid.`;
}

export function openRouterSettingsError(code: string): string {
  switch (code) {
    case "OPENROUTER_KEY_INVALID": return "OpenRouter rejected this key. Your saved key was not replaced.";
    case "OPENROUTER_VALIDATION_UNAVAILABLE": return "OpenRouter could not be checked. Try again later.";
    case "OPENROUTER_KEY_MISSING": return "No saved key remains. Reload to see the current status.";
    case "OPENROUTER_KEY_CONFLICT": return "Your key changed in another request. Reload before trying again.";
    default: return "Could not update your OpenRouter settings. Try again later.";
  }
}
