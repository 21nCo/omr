import type { ProviderStatus } from "./providers.js";

export type ToolEffect = "read" | "write" | "destructive" | "unknown";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ToolContractSource {
  version: string;
  effect: ToolEffect;
  requiredScopes: string[];
  resources: Array<{ kind: string; parameter?: string }>;
  sensitiveKeys: string[];
  pagination: {
    kind: "none" | "cursor" | "offset" | "page";
    maxPageSize?: number;
    cursorParameter?: string;
  };
  retry: "never" | "safe" | "provider-key";
  idempotencyKeyParameter?: string;
}

export interface ToolActionSource {
  name: string;
  displayName: string;
  description: string;
  parameters: unknown;
  returns: unknown;
  contract?: ToolContractSource;
}

export interface ToolProviderSource {
  name: string;
  displayName: string;
  version: string;
  description: string;
  actions: Record<string, ToolActionSource>;
}

export interface ToolCatalogSource {
  providers: { list(): ToolProviderSource[] };
}

export interface ToolManifest {
  catalogSchemaVersion: "1.0.0";
  id: string;
  provider: string;
  providerVersion: string;
  action: string;
  displayName: string;
  description: string;
  contract: ToolContractSource;
  inputSchema: JsonValue;
  outputSchema: JsonValue;
  hash: string;
}

export interface ToolDiscoveryPage {
  catalogSchemaVersion: "1.0.0";
  revision: string;
  tools: ToolManifest[];
  /** Workspace-scoped readiness, present on authenticated HTTP discovery. */
  providers?: ProviderStatus[];
  nextCursor?: string;
}

export class ToolCatalogInputError extends Error {
  readonly code = "TOOL_CATALOG_INPUT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ToolCatalogInputError";
  }
}

const PROVIDER_NAME = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const ACTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const DEFAULT_CONTRACT: ToolContractSource = {
  version: "0.0.0",
  effect: "unknown",
  requiredScopes: [],
  resources: [],
  sensitiveKeys: [],
  pagination: { kind: "none" },
  retry: "never",
};

// Cursor keys and catalog revisions must have the same order on every host.
function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class ToolCatalog {
  private constructor(
    private readonly manifests: ToolManifest[],
    readonly revision: string,
  ) {}

  static async create(
    source: ToolCatalogSource,
    toJsonSchema: (schema: unknown) => JsonValue,
    allowedProviders?: ReadonlySet<string>,
  ): Promise<ToolCatalog> {
    const manifests: ToolManifest[] = [];
    for (const provider of source.providers.list()) {
      const providerName = normalizedProviderName(provider.name);
      if (allowedProviders && !allowedProviders.has(providerName)) continue;
      for (const [actionKey, action] of Object.entries(provider.actions)) {
        const actionName = validatedActionName(action.name || actionKey);
        if (actionKey !== action.name) {
          throw new ToolCatalogInputError(
            `Action registry key ${actionKey} does not match action name ${action.name}`,
          );
        }
        const core = {
          catalogSchemaVersion: "1.0.0" as const,
          id: `${providerName}.${actionName}`,
          provider: providerName,
          providerVersion: provider.version,
          action: actionName,
          displayName: nonEmpty(action.displayName, "displayName", 500),
          description: nonEmpty(action.description, "description", 4_096),
          contract: contract(action.contract),
          inputSchema: jsonValue(toJsonSchema(action.parameters), "input schema"),
          outputSchema: jsonValue(toJsonSchema(action.returns), "output schema"),
        };
        manifests.push({ ...core, hash: await sha256(core) });
      }
    }
    manifests.sort((left, right) => compareCodePoints(left.id, right.id));
    const duplicate = manifests.find((manifest, index) => manifests[index - 1]?.id === manifest.id);
    if (duplicate) throw new ToolCatalogInputError(`Duplicate tool id ${duplicate.id}`);
    const revision = await sha256(manifests.map(({ id, hash }) => ({ id, hash })));
    return new ToolCatalog(manifests, revision);
  }

  get(toolId: string): ToolManifest | null {
    const manifest = this.manifests.find(({ id }) => id === toolId);
    return manifest ? structuredClone(manifest) : null;
  }

  list(): ToolManifest[] {
    return structuredClone(this.manifests);
  }

  discover(input: {
    query?: string;
    providers?: string[];
    effects?: ToolEffect[];
    allowedProviders?: ReadonlySet<string>;
    allowedToolIds?: ReadonlySet<string>;
    limit?: number;
    cursor?: string;
  } = {}): ToolDiscoveryPage {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ToolCatalogInputError("limit must be an integer from 1 to 100");
    }
    const providers = input.providers?.map(normalizedProviderName);
    const effects = input.effects;
    if (effects?.some((effect) => !["read", "write", "destructive", "unknown"].includes(effect))) {
      throw new ToolCatalogInputError("effects contains an unknown effect");
    }
    const query = input.query?.trim().toLowerCase();
    const filterKey = canonicalJson({
      query: query ?? null,
      providers: providers ? [...providers].sort(compareCodePoints) : null,
      effects: effects ? [...effects].sort(compareCodePoints) : null,
      allowedProviders: input.allowedProviders ? [...input.allowedProviders].sort(compareCodePoints) : null,
      allowedToolIds: input.allowedToolIds ? [...input.allowedToolIds].sort(compareCodePoints) : null,
    }, "discovery filter");
    const filtered = this.manifests.filter((manifest) =>
      (!providers || providers.includes(manifest.provider)) &&
      (!effects || effects.includes(manifest.contract.effect)) &&
      (!input.allowedProviders || input.allowedProviders.has(manifest.provider)) &&
      (!input.allowedToolIds || input.allowedToolIds.has(manifest.id)) &&
      (!query || [manifest.id, manifest.displayName, manifest.description]
        .some((value) => value.toLowerCase().includes(query)))
    );
    const offset = input.cursor ? decodeCursor(input.cursor, this.revision, filterKey) : 0;
    if (offset > filtered.length) throw new ToolCatalogInputError("cursor is out of range");
    const tools = filtered.slice(offset, offset + limit).map((manifest) => structuredClone(manifest));
    const nextOffset = offset + tools.length;
    return {
      catalogSchemaVersion: "1.0.0",
      revision: this.revision,
      tools,
      ...(nextOffset < filtered.length
        ? { nextCursor: encodeCursor(this.revision, filterKey, nextOffset) }
        : {}),
    };
  }
}

function normalizedProviderName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!PROVIDER_NAME.test(normalized)) throw new ToolCatalogInputError("Invalid provider name");
  return normalized;
}

function validatedActionName(value: string): string {
  const normalized = value.trim();
  if (!ACTION_NAME.test(normalized) || normalized.includes("..")) {
    throw new ToolCatalogInputError("Invalid action name");
  }
  return normalized;
}

function nonEmpty(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new ToolCatalogInputError(`${label} must contain 1 to ${maxLength} characters`);
  }
  return normalized;
}

function contract(value?: ToolContractSource): ToolContractSource {
  if (!value) return structuredClone(DEFAULT_CONTRACT);
  if (!SEMVER.test(value.version)) throw new ToolCatalogInputError("Invalid action contract version");
  if (value.effect === "unknown" && value.retry !== "never") {
    throw new ToolCatalogInputError("Unknown-effect tools cannot opt into retries");
  }
  if (value.retry === "provider-key" && !value.idempotencyKeyParameter) {
    throw new ToolCatalogInputError("Provider-key retries require an idempotency key parameter");
  }
  return structuredClone(value);
}

function jsonValue(value: unknown, label: string): JsonValue {
  canonicalJson(value, label);
  return structuredClone(value) as JsonValue;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value, "manifest"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256-${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function canonicalJson(value: unknown, label: string, depth = 0): string {
  if (depth > 128) throw new ToolCatalogInputError(`${label} exceeds the nesting limit`);
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, label, depth + 1)).join(",")}]`;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort(compareCodePoints)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(
        (value as Record<string, unknown>)[key],
        label,
        depth + 1,
      )}`)
      .join(",")}}`;
  }
  throw new ToolCatalogInputError(`${label} must be JSON-compatible`);
}

function encodeCursor(revision: string, filterKey: string, offset: number): string {
  return btoa(JSON.stringify({ revision, filterKey, offset }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeCursor(cursor: string, revision: string, filterKey: string): number {
  let value: { revision?: unknown; filterKey?: unknown; offset?: unknown };
  try {
    const base64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    value = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
  } catch {
    throw new ToolCatalogInputError("cursor is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolCatalogInputError("cursor is invalid");
  }
  if (value.revision !== revision) throw new ToolCatalogInputError("cursor belongs to another catalog revision");
  if (value.filterKey !== filterKey) throw new ToolCatalogInputError("catalog filters or grants changed; restart discovery");
  if (!Number.isInteger(value.offset) || Number(value.offset) < 0) throw new ToolCatalogInputError("cursor is invalid");
  return Number(value.offset);
}
