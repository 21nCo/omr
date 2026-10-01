import {
  ConnectionSelectionRequiredError, ConnectionUnavailableError,
  isMissingRemoteConnection,
} from "@oh-my-router/connections";
import { githubHttpFailure, LinearProviderDenial, usableToolIds, type ProviderStatus, type ToolCatalog } from "@oh-my-router/tools";

/** A deleted PlugFn connection is an unavailable grant, not a failed catalog. */
export async function resolveScopedCatalog(
  catalog: ToolCatalog,
  providers: readonly ProviderStatus[],
  resolveBinding: (provider: string) => Promise<{ id: string; providerConnectionId: string }>,
  remoteScopes: (connectionId: string, provider: string) => Promise<readonly string[] | undefined>,
  onRemoteMissing: (bindingId: string) => Promise<void>,
): Promise<Set<string>> {
  return usableToolIds(catalog, providers, async (provider) => {
    let binding: { id: string; providerConnectionId: string };
    try {
      binding = await resolveBinding(provider);
    } catch (error) {
      if (error instanceof ConnectionSelectionRequiredError || error instanceof ConnectionUnavailableError) return null;
      throw error;
    }
    try {
      return await remoteScopes(binding.providerConnectionId, provider);
    } catch (error) {
      if (isMissingRemoteConnection(error)) {
        await onRemoteMissing(binding.id);
        return null;
      }
      // GitHub profile proof is provider-local. Contain its HTTP denials and
      // identifiable outages without swallowing unrelated callback failures.
      if (provider === "github" && githubProofUnavailable(error)) return null;
      if (provider === "linear" &&
        (error instanceof LinearProviderDenial || githubProofUnavailable(error))) return null;
      throw error;
    }
  });
}

/** Whether a failed GitHub account proof identifies an unavailable provider. */
function githubProofUnavailable(error: unknown): boolean {
  if (githubHttpFailure(error)) return true;
  if (!error || typeof error !== "object") return false;
  if ("status" in error && typeof error.status === "number" &&
      error.status >= 500 && error.status <= 599) return true;
  if ("code" in error && typeof error.code === "string" &&
      /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)$/.test(error.code)) return true;
  return error instanceof TypeError && /fetch failed|network error|load failed/i.test(error.message);
}
