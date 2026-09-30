import { githubProvider } from "@plugfn/providers";
import type { Action, ActionContract, Provider } from "plugfn";
import { z } from "zod";
import { ProviderPreflightError } from "@oh-my-router/tools";

// OMR v1 deliberately publishes a small journey rather than the upstream action catalog.
// A new upstream action cannot become executable merely by being registered there.
const upstream = githubProvider.actions as Record<string, Action>;
// Keep the entire constraint in the regular expression: the published JSON Schema
// must reject the same path segments as Zod before an approval can be created.
const repository = z.string().min(1).max(100).regex(/^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/);
const owner = z.string().min(1).max(39).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/);
const target = { owner, repo: repository };

/** GitHub reports the token's effective grants on authenticated API responses. */
function grantedScopes(headers: unknown): string[] | null {
  let value: unknown;
  if (headers instanceof Headers) value = headers.get("x-oauth-scopes");
  else if (headers && typeof headers === "object") {
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === "x-oauth-scopes");
    value = entry?.[1];
  }
  if (typeof value !== "string") return null;
  const scopes = value.split(",").map((scope) => scope.trim());
  return scopes.length === 1 && scopes[0] === "" ? []
    : scopes.every((scope) => /^[A-Za-z0-9:_-]+$/.test(scope)) ? scopes : null;
}

/** Never use PlugFn's requested-scope fallback as proof of a GitHub grant. */
export async function verifiedGithubScopes(runtime: {
  action(provider: string, action: string, options: {
    userId: string; connectionId: string; params: Record<string, never>;
    actor: { userId: string; tenantId: string; organizationId: string };
    retry: { maxAttempts: number; backoff: "exponential" }; cache: boolean;
  }): Promise<unknown>;
}, input: { userId: string; workspaceId: string; connectionId: string }): Promise<readonly string[] | undefined> {
  const result = await runtime.action("github", "account.get", {
    userId: input.userId,
    connectionId: input.connectionId,
    params: {},
    actor: { userId: input.userId, tenantId: input.workspaceId, organizationId: input.workspaceId },
    retry: { maxAttempts: 1, backoff: "exponential" },
    cache: false,
  });
  if (!result || typeof result !== "object" || !("verifiedScopes" in result)) return undefined;
  const scopes = result.verifiedScopes;
  return Array.isArray(scopes) && scopes.every((scope) => typeof scope === "string") ? scopes : undefined;
}

// PlugFn retries 429 using Retry-After, even when that delay exceeds OMR's
// invocation deadline, and replaces the final error without its headers.
// Keep definite GitHub read limits outside that retry path so the caller can
// settle its receipt and return GitHub's timing guidance immediately.
class GitHubReadRateLimit extends Error {
  readonly code = "GITHUB_READ_RATE_LIMIT";
  readonly headers: unknown;

  constructor(error: object) {
    super("GitHub read rate limited");
    this.headers = "headers" in error ? error.headers : undefined;
  }
}

async function githubRead<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 429) {
      throw new GitHubReadRateLimit(error);
    }
    throw error;
  }
}

function contract(effect: "read" | "write", scopes: string[], resources: ActionContract["resources"] = []): ActionContract {
  return {
    version: "1.0.0", effect, requiredScopes: scopes, resources,
    sensitiveKeys: ["body"], pagination: { kind: "none" },
    retry: effect === "read" ? "safe" : "never",
  };
}

const account: Action = {
  name: "account.get", displayName: "Get GitHub account",
  description: "Identify the selected GitHub account and verify its token can read the profile.",
  idempotent: true,
  parameters: z.object({}).strict(),
  returns: z.object({ id: z.number(), login: z.string(), html_url: z.string(),
    avatar_url: z.string().optional(), name: z.string().nullable().optional(),
    verifiedScopes: z.array(z.string()).nullable() }).passthrough(),
  contract: contract("read", ["read:user"]),
  execute: async (_params, context) => githubRead(async () => {
    const response = await context.http.get(`${context.provider.baseUrl}/user`);
    return { ...response.data, verifiedScopes: grantedScopes(response.headers) };
  }),
};

const listPublic: Action = {
  ...upstream["repos.list"]!, name: "repos.listPublic", displayName: "List public repositories",
  description: "Discover public repositories visible to the selected GitHub account.",
  parameters: z.object({ startPage: z.number().int().min(1).optional().default(1),
    maxPages: z.number().int().min(1).max(5).optional().default(1) }).strict(),
  contract: contract("read", ["read:user"]),
  execute: (params, context) => githubRead(() =>
    upstream["repos.list"]!.execute({ ...params, visibility: "public" }, context)),
};

const listPrivate: Action = {
  ...listPublic, name: "repos.listPrivate", displayName: "List private repositories",
  description: "Discover private repositories available to the selected account; requires the broad GitHub repo grant.",
  contract: contract("read", ["repo"]),
  execute: (params, context) => githubRead(() =>
    upstream["repos.list"]!.execute({ ...params, visibility: "private" }, context)),
};

const getRepository: Action = {
  ...upstream["repos.get"]!, name: "repos.get", displayName: "Get repository",
  description: "Read one public repository. Private repositories require a repo-scoped connection.",
  parameters: z.object(target).strict(),
  contract: contract("read", ["read:user"], [{ kind: "repository", parameter: "repo" }]),
  execute: (params, context) => githubRead(() => upstream["repos.get"]!.execute(params, context)),
};

const createPublicComment: Action = {
  ...upstream["issues.createComment"]!, name: "issues.commentPublic", displayName: "Comment on public issue",
  description: "Post one comment to an issue in a public repository after OMR approval. Requires public_repo.",
  parameters: z.object({ ...target, issueNumber: z.number().int().positive(),
    body: z.string().min(1).max(65_536) }).strict(),
  contract: contract("write", ["public_repo"], [{ kind: "repository", parameter: "repo" },
    { kind: "issue", parameter: "issueNumber" }]),
  execute: async (params, context) => {
    let repository;
    try {
      repository = await context.http.get(`${context.provider.baseUrl}/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`);
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error &&
        typeof error.status === "number" ? error.status : null;
      throw new ProviderPreflightError("repository_lookup_failed", status);
    }
    if (repository?.data?.private !== false) {
      throw new ProviderPreflightError("unverified_public_repository");
    }
    return upstream["issues.createComment"]!.execute(params, context);
  },
};

export const omrGithubProvider: Provider = {
  ...githubProvider,
  description: "OMR GitHub v1 account, repository discovery, and approved public issue comments",
  actions: {
    "account.get": account,
    "repos.listPublic": listPublic,
    "repos.listPrivate": listPrivate,
    "repos.get": getRepository,
    "issues.commentPublic": createPublicComment,
  },
};
