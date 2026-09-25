import type { ToolCatalog, ToolManifest } from "./catalog.js";
import type { ProviderStatus } from "./providers.js";

/** An absent grant is never interpreted as the provider's default OAuth scopes. */
export function hasRequiredScopes(manifest: ToolManifest, granted: readonly string[] | undefined): boolean {
  return manifest.contract.requiredScopes.every((scope) => granted?.includes(scope) === true);
}

/** Resolve the *effective* connection per provider, then filter action grants. */
export async function usableToolIds(
  catalog: ToolCatalog,
  providers: readonly Pick<ProviderStatus, "provider" | "state">[],
  scopesForProvider: (provider: string) => Promise<readonly string[] | null | undefined>,
): Promise<Set<string>> {
  const grants = new Map<string, readonly string[] | undefined>();
  for (const status of providers) {
    if (status.state !== "ready") continue;
    const scopes = await scopesForProvider(status.provider);
    if (scopes !== null) grants.set(status.provider, scopes);
  }
  return new Set(catalog.list().filter((manifest) =>
    grants.has(manifest.provider) && hasRequiredScopes(manifest, grants.get(manifest.provider))
  ).map(({ id }) => id));
}