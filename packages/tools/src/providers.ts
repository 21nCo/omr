export const V1_PROVIDERS = ["github", "linear", "slack", "notion"] as const;
export type V1Provider = typeof V1_PROVIDERS[number];
export type ProviderState = "unsupported" | "unconfigured" | "disconnected" | "expired" | "ready";

export interface ProviderDefinition {
  name: string;
  displayName: string;
  version?: string;
  description?: string;
  auth: { type: string };
  actions: Record<string, unknown>;
}

export interface ProviderBinding {
  status: string;
  readiness: string;
}

export interface ProviderStatus {
  provider: string;
  displayName: string;
  providerVersion: string | null;
  description: string;
  authMode: "oauth" | "api_key" | "jwt" | "basic" | "none" | "unknown";
  actionCount: number;
  state: ProviderState;
  /** Whether a new connection can be initiated; execution also requires state=ready. */
  available: boolean;
}

const NAMES: Record<V1Provider, string> = {
  github: "GitHub",
  linear: "Linear",
  slack: "Slack",
  notion: "Notion",
};

export function isV1Provider(provider: string): provider is V1Provider {
  return (V1_PROVIDERS as readonly string[]).includes(provider);
}

export function providerStatus(input: {
  provider: string;
  definition?: ProviderDefinition;
  configured: boolean;
  connections?: readonly ProviderBinding[];
}): ProviderStatus {
  const { provider, definition, configured, connections = [] } = input;
  const supported = isV1Provider(provider);
  const authMode = definition?.auth.type === "oauth2" ? "oauth"
    : definition?.auth.type === "api-key" ? "api_key"
    : definition?.auth.type === "jwt" || definition?.auth.type === "basic" || definition?.auth.type === "none"
      ? definition.auth.type : "unknown";
  const state: ProviderState = !supported || !definition || authMode === "unknown"
    ? "unsupported"
    : !configured ? "unconfigured"
    : connections.some((binding) => binding.status === "active" && binding.readiness === "ready")
      ? "ready"
      : connections.some((binding) => binding.status === "needs_reauth" || binding.status === "error" ||
        (binding.status !== "revoked" && binding.readiness !== "ready"))
        ? "expired" : "disconnected";
  return {
    provider,
    displayName: supported ? NAMES[provider] : definition?.displayName ?? provider,
    providerVersion: supported && definition ? definition.version ?? null : null,
    description: supported && definition ? definition.description ?? "" : "",
    authMode: supported ? authMode : "unknown",
    actionCount: supported && definition ? Object.keys(definition.actions).length : 0,
    state,
    available: supported && !!definition && authMode !== "unknown" && configured,
  };
}

export function v1ProviderCatalog(input: {
  get(provider: string): ProviderDefinition | undefined;
  configured(provider: string): boolean;
  connections?: ReadonlyMap<string, readonly ProviderBinding[]>;
}): ProviderStatus[] {
  return V1_PROVIDERS.map((provider) => providerStatus({
    provider,
    definition: input.get(provider),
    configured: input.configured(provider),
    connections: input.connections?.get(provider),
  }));
}
