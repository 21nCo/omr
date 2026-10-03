import {
  ConnectionSelectionRequiredError, ConnectionUnavailableError,
  isMissingRemoteConnection,
} from "@oh-my-router/connections";
import { githubHttpFailure, LinearProviderDenial, NotionProviderDenial, SlackProviderDenial, usableToolIds, type ProviderStatus, type ToolCatalog } from "@oh-my-router/tools";

/** A deleted PlugFn connection is an unavailable grant, not a failed catalog. */
export async function resolveScopedCatalog(
  catalog: ToolCatalog,
  providers: readonly ProviderStatus[],
  resolveBinding: (provider: string) => Promise<{ id: string; providerConnectionId: string }>,
  remoteScopes: (connectionId: string, provider: string) => Promise<readonly string[] | undefined>,
  onRemoteMissing: (bindingId: string) => Promise<void>,
  onReconnectRequired?: (bindingId: string, provider?: string) => Promise<void>,
  onPermanentDenial?: (bindingId: string, code: "SLACK_PERMISSION_DENIED" | "SLACK_WORKSPACE_MISMATCH") => Promise<void>,
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
      if (await providerProofUnavailable(provider, binding.id, error,
        onRemoteMissing, onReconnectRequired, onPermanentDenial)) return null;
      throw error;
    }
  });
}

/** Contain provider-local proof failures and update a revoked binding. */
async function providerProofUnavailable(provider: string, bindingId: string, error: unknown,
  onRemoteMissing: (bindingId: string) => Promise<void>,
  onReconnectRequired?: (bindingId: string, provider?: string) => Promise<void>,
  onPermanentDenial?: (bindingId: string, code: "SLACK_PERMISSION_DENIED" | "SLACK_WORKSPACE_MISMATCH") => Promise<void>): Promise<boolean> {
  if (isMissingRemoteConnection(error)) {
    await onRemoteMissing(bindingId);
    return true;
  }
  if (provider === "github") return githubProofUnavailable(error);
  if (provider === "slack") {
    if (error instanceof SlackProviderDenial) {
      if (error.code === "SLACK_RECONNECT_REQUIRED") await onReconnectRequired?.(bindingId, provider);
      if (error.code === "SLACK_PERMISSION_DENIED" || error.code === "SLACK_WORKSPACE_MISMATCH") {
        await onPermanentDenial?.(bindingId, error.code);
      }
      return true;
    }
    return githubProofUnavailable(error);
  }
  if (provider === "notion") {
    if (error instanceof NotionProviderDenial) {
      if (error.code === "NOTION_RECONNECT_REQUIRED") await onReconnectRequired?.(bindingId, provider);
      return true;
    }
    return githubProofUnavailable(error);
  }
  if (provider !== "linear") return false;
  if (error instanceof LinearProviderDenial && error.code === "LINEAR_RECONNECT_REQUIRED") {
    await onReconnectRequired?.(bindingId);
    return true;
  }
  return error instanceof LinearProviderDenial ||
    (error !== null && typeof error === "object" && "status" in error && error.status === 408) ||
    githubProofUnavailable(error);
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
