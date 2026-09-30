import { githubProvider } from "@plugfn/providers";
import type { Action, ActionContract, Provider } from "plugfn";
import { z } from "zod";

// OMR v1 deliberately publishes a small journey rather than the upstream action catalog.
// A new upstream action cannot become executable merely by being registered there.
const upstream = githubProvider.actions as Record<string, Action>;
const repository = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/)
  .refine((value) => value !== "." && value !== "..", "Repository name must not be a path segment");
const owner = z.string().min(1).max(39).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/);
const target = { owner, repo: repository };

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
    avatar_url: z.string().optional(), name: z.string().nullable().optional() }).passthrough(),
  contract: contract("read", ["read:user"]),
  execute: async (_params, context) => (await context.http.get(`${context.provider.baseUrl}/user`)).data,
};

const listPublic: Action = {
  ...upstream["repos.list"]!, name: "repos.listPublic", displayName: "List public repositories",
  description: "Discover public repositories visible to the selected GitHub account.",
  parameters: z.object({ startPage: z.number().int().min(1).optional().default(1),
    maxPages: z.number().int().min(1).max(5).optional().default(1) }).strict(),
  contract: contract("read", ["read:user"]),
  execute: (params, context) => upstream["repos.list"]!.execute({ ...params, visibility: "public" }, context),
};

const listPrivate: Action = {
  ...listPublic, name: "repos.listPrivate", displayName: "List private repositories",
  description: "Discover private repositories available to the selected account; requires the broad GitHub repo grant.",
  contract: contract("read", ["repo"]),
  execute: (params, context) => upstream["repos.list"]!.execute({ ...params, visibility: "private" }, context),
};

const getRepository: Action = {
  ...upstream["repos.get"]!, name: "repos.get", displayName: "Get repository",
  description: "Read one public repository. Private repositories require a repo-scoped connection.",
  parameters: z.object(target).strict(),
  contract: contract("read", ["read:user"], [{ kind: "repository", parameter: "repo" }]),
};

const createPublicComment: Action = {
  ...upstream["issues.createComment"]!, name: "issues.commentPublic", displayName: "Comment on public issue",
  description: "Post one comment to an issue in a public repository after OMR approval. Requires public_repo.",
  parameters: z.object({ ...target, issueNumber: z.number().int().positive(),
    body: z.string().min(1).max(65_536) }).strict(),
  contract: contract("write", ["public_repo"], [{ kind: "repository", parameter: "repo" },
    { kind: "issue", parameter: "issueNumber" }]),
  execute: async (params, context) => {
    const repository = await context.http.get(`${context.provider.baseUrl}/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`);
    if (repository.data?.private !== false) {
      throw new Error("Public issue comments require a verified public repository");
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
