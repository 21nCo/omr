export type OpenRouterSettingsStatus = {
  configured: boolean;
  maskedKey?: string;
  validation?: "valid" | "invalid";
  checkedAt?: number;
};

export type OpenRouterSettingsAvailability = "loading" | "ready" | "disabled" | "unavailable";

/** Accept only the masked status shape that permits settings mutations. */
export function parseOpenRouterSettingsStatus(value: unknown): OpenRouterSettingsStatus | null {
  if (!value || typeof value !== "object") return null;
  const status = value as Record<string, unknown>;
  if (status.configured === false) return { configured: false };
  if (status.configured !== true || typeof status.maskedKey !== "string" ||
    !/^••••[A-Za-z0-9_-]{4}$/.test(status.maskedKey) ||
    (status.validation !== "valid" && status.validation !== "invalid") ||
    typeof status.checkedAt !== "number" || !Number.isFinite(status.checkedAt)) return null;
  return { configured: true, maskedKey: status.maskedKey,
    validation: status.validation, checkedAt: status.checkedAt };
}

/** Only a successful status read establishes that a write is safe to offer. */
export function openRouterSettingsCanMutate(availability: OpenRouterSettingsAvailability,
  status: OpenRouterSettingsStatus | null): boolean {
  return availability === "ready" && status !== null;
}

/** A status check or removal does not submit the user's replacement draft. */
export function openRouterSettingsDraftAfter(operation: "save" | "check" | "delete", draft: string): string {
  return operation === "save" ? "" : draft;
}

/** Keep an unknown vault distinct from an empty one. */
export function openRouterSettingsMessage(status: OpenRouterSettingsStatus | null,
  busy: "" | "save" | "check" | "delete", availability: OpenRouterSettingsAvailability): string {
  if (availability === "loading") return "Loading settings…";
  if (availability === "disabled") return "Personal OpenRouter keys are pending verification.";
  if (availability === "unavailable" || !status) return "Could not load your saved key status. Try again later.";
  if (busy === "save") return "Validating and saving key…";
  if (busy === "check") return "Checking saved key…";
  if (busy === "delete") return "Removing saved key…";
  if (!status?.configured) return "No OpenRouter key saved.";
  return status.validation === "invalid"
    ? `Saved key ${status.maskedKey ?? ""} is invalid. Replace or remove it.`
    : `Saved key ${status.maskedKey ?? ""} is valid.`;
}

/** Map only public error codes to browser copy; never render provider text. */
export function openRouterSettingsError(code: string): string {
  switch (code) {
    case "OPENROUTER_KEY_INVALID": return "OpenRouter rejected this key. Your saved key was not replaced.";
    case "OPENROUTER_VALIDATION_UNAVAILABLE": return "OpenRouter could not be checked. Try again later.";
    case "OPENROUTER_KEY_MISSING": return "No saved key remains. Reload to see the current status.";
    case "OPENROUTER_KEY_CONFLICT": return "Your key changed in another request. Reload before trying again.";
    default: return "Could not update your OpenRouter settings. Try again later.";
  }
}
