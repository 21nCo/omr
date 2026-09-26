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

export function isProviderConfigured(
  definition: ProviderDefinition | undefined,
  provider: string,
  integrations: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return !!definition && (definition.auth.type !== "oauth2" || !!integrations?.[provider]);
}

function providerAuthMode(definition?: ProviderDefinition): ProviderStatus["authMode"] {
  switch (definition?.auth.type) {
    case "oauth2": return "oauth";
    case "api-key": return "api_key";
    case "jwt":
    case "basic":
    case "none": return definition.auth.type;
    default: return "unknown";
  }
}

function bindingState(connections: readonly ProviderBinding[]): ProviderState {
  if (connections.some(({ status, readiness }) => status === "active" && readiness === "ready")) return "ready";
  if (connections.some(({ status, readiness }) => status === "needs_reauth" || status === "error" ||
    (status !== "revoked" && readiness !== "ready"))) return "expired";
  return "disconnected";
}

export function providerStatus(input: {
  provider: string;
  definition?: ProviderDefinition;
  configured: boolean;
  connections?: readonly ProviderBinding[];
}): ProviderStatus {
  const { provider, definition, configured, connections = [] } = input;
  const supported = isV1Provider(provider);
  const authMode = providerAuthMode(definition);
  let state: ProviderState;
  if (!supported || !definition || authMode === "unknown") state = "unsupported";
  else if (!configured) state = "unconfigured";
  else state = bindingState(connections);
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
