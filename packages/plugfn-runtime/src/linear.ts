import { linearProvider } from "@plugfn/providers";
import type { Action, ActionContext, ActionContract, Provider } from "plugfn";
import { z } from "zod";
import { LinearProviderDenial, linearDenial } from "@oh-my-router/tools";

const id = z.string().uuid();
const linearWorkspaceId = id.describe("Linear workspace ID from workspace.get");
const teamId = id.describe("Team ID from teams.list");
const issueId = id.describe("Issue ID from issues.list");
const title = z.string().min(1).max(255).regex(/\S/);
const issueUrl = z.string().url().startsWith("https://linear.app/");
const page = { first: z.number().int().min(1).max(50).optional(),
  after: z.string().min(1).max(500).optional() };
const issue = z.object({ id, identifier: z.string(), title: z.string(),
  description: z.string().nullable(), url: issueUrl,
  team: z.object({ id, name: z.string() }),
  state: z.object({ id, name: z.string() }).nullable() });
const change = { title: title.optional(),
  description: z.string().max(20_000).optional(), priority: z.number().int().min(0).max(4).optional() };
const updateBase = { linearWorkspaceId, issueId };
// JSON Schema must reject a no-op before the approval is stored, too.
const updateParams = z.union([
  z.object({ ...updateBase, ...change, title }).strict(),
  z.object({ ...updateBase, ...change, description: z.string().max(20_000) }).strict(),
  z.object({ ...updateBase, ...change, priority: z.number().int().min(0).max(4) }).strict(),
]);
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });

/** Build the bounded Linear action policy, including read probes for writes. */
function contract(effect: "read" | "write", resources: ActionContract["resources"] = [],
  pagination?: ActionContract["pagination"]): ActionContract {
  return { version: "1.0.0", effect, requiredScopes: effect === "read" ? ["read"] : ["read", "write"],
    resources, sensitiveKeys: ["description"], pagination: pagination ?? { kind: "none" },
    retry: effect === "read" ? "safe" : "never" };
}

type Phase = LinearProviderDenial["phase"];

/** Parse one GraphQL exchange without treating partial write data as a denial. */
async function query(context: ActionContext, source: string, variables: Record<string, unknown>, phase: Phase) {
  let response: { data: { data?: Record<string, unknown>; errors?: unknown[] }; headers?: unknown };
  try {
    response = await context.http.post(context.provider.baseUrl, { query: source, variables });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "CONNECTION_NOT_FOUND") {
      throw error;
    }
    throw linearDenial(error, phase) ??
      (phase === "write" ? error : new LinearProviderDenial(phase, "LINEAR_QUERY_REJECTED"));
  }
  const body = response?.data;
  if (Array.isArray(body?.errors) && body.errors.length) {
    // A nested field error may follow a completed mutation. Let the action
    // validate any returned outcome; incomplete results remain uncertain.
    if (phase !== "write" || !body?.data || typeof body.data !== "object") {
      throw linearDenial({ status: 400, data: body, headers: response.headers }, phase) ??
        (phase === "write" ? new Error("Linear GraphQL request failed")
          : new LinearProviderDenial(phase, "LINEAR_QUERY_REJECTED"));
    }
  }
  if (!body?.data || typeof body.data !== "object") {
    if (phase === "write") throw new Error("Linear mutation response is incomplete");
    throw new LinearProviderDenial(phase, "LINEAR_TARGET_UNAVAILABLE");
  }
  return body.data;
}

/** Verify that the token's organization matches an explicitly selected target. */
async function organization(context: ActionContext, expected?: string, phase: Phase = "read") {
  const data = await query(context, "query OmrWorkspace { organization { id name } }", {}, phase);
  const org = z.object({ id, name: z.string().min(1) }).safeParse(data.organization);
  if (!org.success) throw new LinearProviderDenial(phase, "LINEAR_TARGET_UNAVAILABLE");
  if (expected && org.data.id !== expected) {
    throw new LinearProviderDenial(phase, "LINEAR_WORKSPACE_MISMATCH");
  }
  return org.data;
}

/** Preflight a create target before sending an issue mutation. */
async function selectedTeam(context: ActionContext, workspace: string, target: string) {
  await organization(context, workspace, "preflight");
  const data = await query(context, "query OmrTeam($id: String!) { team(id: $id) { id name } }",
    { id: target }, "preflight");
  if (z.object({ id, name: z.string() }).safeParse(data.team).data?.id !== target) {
    throw new LinearProviderDenial("preflight", "LINEAR_TARGET_UNAVAILABLE");
  }
}

/** Preflight an update target before sending an issue mutation. */
async function selectedIssue(context: ActionContext, workspace: string, target: string) {
  await organization(context, workspace, "preflight");
  const data = await query(context, "query OmrIssueTarget($id: String!) { issue(id: $id) { id team { id } } }",
    { id: target }, "preflight");
  if (z.object({ id, team: z.object({ id }) }).safeParse(data.issue).data?.id !== target) {
    throw new LinearProviderDenial("preflight", "LINEAR_TARGET_UNAVAILABLE");
  }
}

const workspaceGet: Action = {
  name: "workspace.get", displayName: "Get Linear workspace",
  description: "Identify the Linear workspace of the selected account before choosing a team or issue.",
  idempotent: true, parameters: z.object({}).strict(),
  returns: z.object({ id, name: z.string() }), contract: contract("read"),
  execute: (_params, context) => organization(context),
};

const teamsList: Action = {
  name: "teams.list", displayName: "List Linear teams",
  description: "Discover up to 50 teams in the selected Linear workspace.",
  idempotent: true, parameters: z.object({ linearWorkspaceId, ...page }).strict(),
  returns: z.object({ nodes: z.array(z.object({ id, name: z.string(), key: z.string() })), pageInfo }),
  contract: contract("read", [{ kind: "linear_workspace", parameter: "linearWorkspaceId" }],
    { kind: "cursor", cursorParameter: "after", maxPageSize: 50 }),
  execute: async (params, context) => {
    await organization(context, params.linearWorkspaceId);
    const data = await query(context,
      "query OmrTeams($first: Int!, $after: String) { teams(first: $first, after: $after) { nodes { id name key } pageInfo { hasNextPage endCursor } } }",
      { first: params.first ?? 50, after: params.after }, "read");
    const teams = teamsList.returns.safeParse(data.teams);
    if (!teams.success) throw new LinearProviderDenial("read", "LINEAR_TARGET_UNAVAILABLE");
    return teams.data;
  },
};

const issuesList: Action = {
  name: "issues.list", displayName: "List team issues",
  description: "Discover up to 50 issues in one explicitly selected Linear team.",
  idempotent: true, parameters: z.object({ linearWorkspaceId, teamId, ...page }).strict(),
  returns: z.object({ team: z.object({ id, name: z.string() }), nodes: z.array(issue), pageInfo }),
  contract: contract("read", [{ kind: "linear_workspace", parameter: "linearWorkspaceId" },
    { kind: "team", parameter: "teamId" }], { kind: "cursor", cursorParameter: "after", maxPageSize: 50 }),
  execute: async (params, context) => {
    await organization(context, params.linearWorkspaceId);
    const data = await query(context,
      "query OmrIssues($id: String!, $first: Int!, $after: String) { team(id: $id) { id name issues(first: $first, after: $after) { nodes { id identifier title description url team { id name } state { id name } } pageInfo { hasNextPage endCursor } } } }",
      { id: params.teamId, first: params.first ?? 50, after: params.after }, "read");
    const team = z.object({ id, name: z.string(), issues: z.object({ nodes: z.array(issue), pageInfo }) })
      .safeParse(data.team);
    if (!team.success || team.data.id !== params.teamId ||
      team.data.issues.nodes.some((entry) => entry.team.id !== params.teamId)) {
      throw new LinearProviderDenial("read", "LINEAR_TARGET_UNAVAILABLE");
    }
    return { team: { id: team.data.id, name: team.data.name },
      nodes: team.data.issues.nodes, pageInfo: team.data.issues.pageInfo };
  },
};

const issuesGet: Action = {
  name: "issues.get", displayName: "Get Linear issue",
  description: "Read one issue by ID from the explicitly selected Linear workspace.",
  idempotent: true, parameters: z.object({ linearWorkspaceId, issueId }).strict(), returns: issue,
  contract: contract("read", [{ kind: "linear_workspace", parameter: "linearWorkspaceId" },
    { kind: "issue", parameter: "issueId" }]),
  execute: async (params, context) => {
    await organization(context, params.linearWorkspaceId);
    const data = await query(context,
      "query OmrIssue($id: String!) { issue(id: $id) { id identifier title description url team { id name } state { id name } } }",
      { id: params.issueId }, "read");
    const found = issue.safeParse(data.issue);
    if (!found.success || found.data.id !== params.issueId) {
      throw new LinearProviderDenial("read", "LINEAR_TARGET_UNAVAILABLE");
    }
    return found.data;
  },
};

const created = z.object({ success: z.literal(true), issue: z.object({ id, identifier: z.string(),
  title: z.string(), url: issueUrl, team: z.object({ id }) }) });
const issuesCreate: Action = {
  name: "issues.create", displayName: "Create Linear issue",
  description: "Create one issue in an explicitly selected team after OMR approval.",
  parameters: z.object({ linearWorkspaceId, teamId, title,
    description: z.string().max(20_000).optional(), priority: change.priority }).strict(),
  returns: created, contract: contract("write", [
    { kind: "linear_workspace", parameter: "linearWorkspaceId" }, { kind: "team", parameter: "teamId" }]),
  execute: async (params, context) => {
    await selectedTeam(context, params.linearWorkspaceId, params.teamId);
    const data = await query(context,
      "mutation OmrCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url team { id } } } }",
      { input: { teamId: params.teamId, title: params.title,
        ...(params.description !== undefined ? { description: params.description } : {}),
        ...(params.priority !== undefined ? { priority: params.priority } : {}) } }, "write");
    const result = created.safeParse(data.issueCreate);
    if (data.issueCreate && typeof data.issueCreate === "object" &&
      "success" in data.issueCreate && data.issueCreate.success === false) {
      throw new LinearProviderDenial("write", "LINEAR_INVALID_CHANGE");
    }
    if (!result.success || result.data.issue.team.id !== params.teamId) throw new Error("Linear create outcome is unverified");
    return result.data;
  },
};

const updated = z.object({ success: z.literal(true), issue: z.object({ id, identifier: z.string(),
  title: z.string(), team: z.object({ id }) }) });
const issuesUpdate: Action = {
  name: "issues.update", displayName: "Update Linear issue",
  description: "Change title, description, or priority on one selected issue after OMR approval.",
  parameters: updateParams,
  returns: updated, contract: contract("write", [
    { kind: "linear_workspace", parameter: "linearWorkspaceId" }, { kind: "issue", parameter: "issueId" }]),
  execute: async (params, context) => {
    await selectedIssue(context, params.linearWorkspaceId, params.issueId);
    const data = await query(context,
      "mutation OmrUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier title team { id } } } }",
      { id: params.issueId, input: {
        ...(params.title !== undefined ? { title: params.title } : {}),
        ...(params.description !== undefined ? { description: params.description } : {}),
        ...(params.priority !== undefined ? { priority: params.priority } : {}),
      } }, "write");
    const result = updated.safeParse(data.issueUpdate);
    if (data.issueUpdate && typeof data.issueUpdate === "object" &&
      "success" in data.issueUpdate && data.issueUpdate.success === false) {
      throw new LinearProviderDenial("write", "LINEAR_INVALID_CHANGE");
    }
    if (!result.success || result.data.issue.id !== params.issueId) throw new Error("Linear update outcome is unverified");
    return result.data;
  },
};

/** Publish only the issue journey, not PlugFn's general Linear administration actions. */
export const omrLinearProvider: Provider = {
  ...linearProvider,
  description: "OMR Linear v1 workspace, team and issue discovery with approved issue changes",
  actions: { "workspace.get": workspaceGet, "teams.list": teamsList,
    "issues.list": issuesList, "issues.get": issuesGet,
    "issues.create": issuesCreate, "issues.update": issuesUpdate },
  triggers: {},
};

/** Check the selected token against Linear before using its recorded OAuth grant. */
export async function verifiedLinearScopes(runtime: {
  action(provider: string, action: string, options: {
    userId: string; connectionId: string; params: Record<string, never>;
    actor: { userId: string; tenantId: string; organizationId: string };
    retry: { maxAttempts: number; backoff: "exponential" }; cache: boolean;
  }): Promise<unknown>;
  connections: { get(connectionId: string): Promise<{ scopes?: string[] }> };
}, input: { userId: string; workspaceId: string; connectionId: string }): Promise<readonly string[] | undefined> {
  const result = await runtime.action("linear", "workspace.get", {
    userId: input.userId, connectionId: input.connectionId, params: {},
    actor: { userId: input.userId, tenantId: input.workspaceId, organizationId: input.workspaceId },
    retry: { maxAttempts: 1, backoff: "exponential" }, cache: false,
  });
  if (!z.object({ id, name: z.string() }).safeParse(result).success) return undefined;
  const scopes = (await runtime.connections.get(input.connectionId)).scopes;
  return Array.isArray(scopes) && scopes.every((scope) => typeof scope === "string") ? scopes : undefined;
}
