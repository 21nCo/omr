import { slackProvider } from "@plugfn/providers";
import type { Action, ActionContext, ActionContract, Provider } from "plugfn";
import { z } from "zod";
import { SlackProviderDenial, SlackProviderResponseAmbiguous, slackDenial } from "@oh-my-router/tools";

const workspaceId = z.string().regex(/^T[A-Z0-9]{8,}$/).describe("Slack workspace ID from workspace.get");
const channelId = z.string().regex(/^[CG][A-Z0-9]{8,}$/).describe("Public channel ID from channels.list");
const senderId = z.string().regex(/^[UW][A-Z0-9]{8,}$/).describe("Bot user ID from workspace.get");
const cursor = z.string().min(1).max(500).optional();
const channel = z.object({ id: channelId, name: z.string().min(1), is_member: z.literal(true),
  is_private: z.literal(false), is_archived: z.literal(false), is_shared: z.literal(false),
  is_ext_shared: z.literal(false) });
const channelInfo = channel.extend({ is_member: z.boolean().optional() });
const identity = z.object({ ok: z.literal(true), team_id: workspaceId, team: z.string().min(1),
  user_id: senderId, bot_id: z.string().min(1) });
const displayableMessage = z.object({ ts: z.string(), text: z.string(), user: z.string().optional() });

function contract(effect: "read" | "write", scopes: string[], resources: ActionContract["resources"] = [],
  paginated = false): ActionContract {
  return { version: "1.0.0", effect, requiredScopes: scopes, resources,
    sensitiveKeys: ["text"], pagination: paginated
      ? { kind: "cursor", cursorParameter: "cursor", maxPageSize: 100 } : { kind: "none" },
    retry: effect === "read" ? "safe" : "never" };
}

function scopes(headers: unknown): string[] | null {
  const value = headers instanceof Headers ? headers.get("x-oauth-scopes") :
    headers && typeof headers === "object"
      ? Object.entries(headers).find(([key]) => key.toLowerCase() === "x-oauth-scopes")?.[1] : null;
  if (typeof value !== "string") return null;
  const parsed = value.split(",").map((scope) => scope.trim());
  return parsed.filter((scope) => /^[a-z][a-z0-9_.-]*:[a-z][a-z0-9_.-]*$/.test(scope));
}

async function call(context: ActionContext, method: string, params: object,
  phase: SlackProviderDenial["phase"], post = false): Promise<{ body: unknown; headers: unknown }> {
  let response: { data: unknown; headers?: unknown };
  try {
    response = post
      ? await context.http.post(`${context.provider.baseUrl}/${method}`, params)
      : await context.http.get(`${context.provider.baseUrl}/${method}`, { params });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "CONNECTION_NOT_FOUND") throw error;
    throw slackDenial(error, phase) ?? (phase === "write" ? error
      : new SlackProviderDenial(phase, "SLACK_QUERY_REJECTED"));
  }
  const body = response?.data;
  if (!body || typeof body !== "object" || !("ok" in body)) {
    throw phase === "write" ? new SlackProviderResponseAmbiguous()
      : new SlackProviderDenial(phase, "SLACK_QUERY_REJECTED");
  }
  if (body.ok === false) {
    throw slackDenial({ data: body, headers: response.headers }, phase) ??
      new SlackProviderDenial(phase, phase === "write" ? "SLACK_POST_REJECTED" : "SLACK_QUERY_REJECTED");
  }
  if (body.ok !== true) {
    throw phase === "write" ? new SlackProviderResponseAmbiguous()
      : new SlackProviderDenial(phase, "SLACK_QUERY_REJECTED");
  }
  return { body, headers: response.headers };
}

async function selectedWorkspace(context: ActionContext, expected?: string, sender?: string,
  phase: SlackProviderDenial["phase"] = "read") {
  const response = await call(context, "auth.test", {}, phase, true);
  const parsed = identity.safeParse(response.body);
  if (!parsed.success) throw new SlackProviderDenial(phase, "SLACK_RECONNECT_REQUIRED");
  if (expected && parsed.data.team_id !== expected || sender && parsed.data.user_id !== sender) {
    throw new SlackProviderDenial(phase, "SLACK_WORKSPACE_MISMATCH");
  }
  return { id: parsed.data.team_id, name: parsed.data.team,
    sender: { type: "bot" as const, id: parsed.data.user_id, botId: parsed.data.bot_id },
    verifiedScopes: scopes(response.headers) };
}

/** Require a current, joined, local public channel before reading or posting. */
async function selectedChannel(context: ActionContext, target: string, botUserId: string,
  phase: SlackProviderDenial["phase"]) {
  const { body } = await call(context, "conversations.info", { channel: target }, phase);
  const parsed = z.object({ channel: channelInfo }).safeParse(body);
  if (!parsed.success || parsed.data.channel.id !== target || parsed.data.channel.is_member === false) {
    throw new SlackProviderDenial(phase, "SLACK_CHANNEL_UNAVAILABLE");
  }
  if (parsed.data.channel.is_member === undefined) {
    // Slack can omit is_member from conversations.info. Search a bounded number
    // of current member pages before allowing a read or an approved post.
    const seen = new Set<string>();
    let next: string | undefined;
    let joined = false;
    for (let page = 0; page < 20; page += 1) {
      const { body: membersBody } = await call(context, "conversations.members",
        { channel: target, limit: 200, ...(next ? { cursor: next } : {}) }, phase);
      const members = z.object({ members: z.array(z.string()),
        response_metadata: z.object({ next_cursor: z.string().optional() }).optional() })
        .safeParse(membersBody);
      if (!members.success) throw new SlackProviderDenial(phase, "SLACK_CHANNEL_UNAVAILABLE");
      if (members.data.members.includes(botUserId)) { joined = true; break; }
      next = members.data.response_metadata?.next_cursor || undefined;
      if (!next) break;
      if (next.length > 500 || seen.has(next)) break;
      seen.add(next);
    }
    if (!joined) throw new SlackProviderDenial(phase, "SLACK_CHANNEL_UNAVAILABLE");
  }
  return { ...parsed.data.channel, is_member: true as const };
}

const workspaceGet: Action = {
  name: "workspace.get", displayName: "Get Slack workspace and bot sender",
  description: "Identify the selected Slack workspace and bot sender before choosing a channel.",
  idempotent: true, parameters: z.object({}).strict(),
  returns: z.object({ id: workspaceId, name: z.string(),
    sender: z.object({ type: z.literal("bot"), id: senderId, botId: z.string() }),
    verifiedScopes: z.array(z.string()).nullable() }),
  contract: contract("read", []),
  execute: (_params, context) => selectedWorkspace(context),
};

const channelsList: Action = {
  name: "channels.list", displayName: "List available Slack channels",
  description: "List joined, local public channels in the selected Slack workspace, one page at a time.",
  idempotent: true,
  parameters: z.object({ workspaceId, limit: z.number().int().min(1).max(100).optional(), cursor }).strict(),
  returns: z.object({ channels: z.array(channel), nextCursor: z.string().nullable() }),
  contract: contract("read", ["channels:read"], [{ kind: "slack_workspace", parameter: "workspaceId" }], true),
  execute: async (params, context) => {
    await selectedWorkspace(context, params.workspaceId);
    const { body } = await call(context, "conversations.list",
      { types: "public_channel", exclude_archived: true, limit: params.limit ?? 100,
        ...(params.cursor ? { cursor: params.cursor } : {}) }, "read");
    const parsed = z.object({ channels: z.array(z.unknown()),
      response_metadata: z.object({ next_cursor: z.string().optional() }).optional() }).safeParse(body);
    if (!parsed.success) throw new SlackProviderDenial("read", "SLACK_QUERY_REJECTED");
    return { channels: parsed.data.channels.flatMap((entry) => {
      const allowed = channel.safeParse(entry);
      return allowed.success ? [allowed.data] : [];
    }), nextCursor: parsed.data.response_metadata?.next_cursor || null };
  },
};

const messagesList: Action = {
  name: "messages.list", displayName: "Read Slack channel messages",
  description: "Read one bounded page from a joined, local public channel.",
  idempotent: true,
  parameters: z.object({ workspaceId, channelId, limit: z.number().int().min(1).max(100).optional(), cursor }).strict(),
  returns: z.object({ channel: channel, messages: z.array(z.object({ ts: z.string(), text: z.string(),
    user: z.string().optional() })), nextCursor: z.string().nullable() }),
  contract: contract("read", ["channels:read", "channels:history"], [
    { kind: "slack_workspace", parameter: "workspaceId" }, { kind: "channel", parameter: "channelId" }], true),
  execute: async (params, context) => {
    const workspace = await selectedWorkspace(context, params.workspaceId);
    const selected = await selectedChannel(context, params.channelId, workspace.sender.id, "read");
    const { body } = await call(context, "conversations.history",
      { channel: params.channelId, limit: params.limit ?? 100,
        ...(params.cursor ? { cursor: params.cursor } : {}) }, "read");
    const parsed = z.object({ messages: z.array(z.unknown()),
      response_metadata: z.object({ next_cursor: z.string().optional() }).optional() })
      .safeParse(body);
    if (!parsed.success) throw new SlackProviderDenial("read", "SLACK_QUERY_REJECTED");
    return { channel: selected, messages: parsed.data.messages.flatMap((entry) => {
      const message = displayableMessage.safeParse(entry);
      return message.success ? [message.data] : [];
    }),
      nextCursor: parsed.data.response_metadata?.next_cursor || null };
  },
};

const messagesPost: Action = {
  name: "messages.post", displayName: "Post Slack message",
  description: "Post one plain text message as the selected bot to a joined, local public channel after OMR approval.",
  parameters: z.object({ workspaceId, channelId, senderId,
    text: z.string().min(1).max(4_000).regex(/\S/) }).strict(),
  returns: z.object({ channel: channel, ts: z.string(), senderId }),
  contract: contract("write", ["channels:read", "chat:write"], [
    { kind: "slack_workspace", parameter: "workspaceId" },
    { kind: "channel", parameter: "channelId" }, { kind: "sender", parameter: "senderId" }]),
  execute: async (params, context) => {
    const workspace = await selectedWorkspace(context, params.workspaceId, params.senderId, "preflight");
    const selected = await selectedChannel(context, params.channelId, workspace.sender.id, "preflight");
    const { body } = await call(context, "chat.postMessage",
      { channel: params.channelId, text: params.text, mrkdwn: false, parse: "none", link_names: false,
        unfurl_links: false, unfurl_media: false }, "write", true);
    const parsed = z.object({ channel: channelId, ts: z.string().min(1),
      message: z.object({ user: senderId.optional(), bot_id: z.string().optional() }) }).safeParse(body);
    if (!parsed.success || parsed.data.channel !== params.channelId) throw new SlackProviderResponseAmbiguous();
    const { user, bot_id: botId } = parsed.data.message;
    if ((!user && !botId) || (user && user !== params.senderId) ||
        (botId && botId !== workspace.sender.botId)) throw new SlackProviderResponseAmbiguous();
    return { channel: selected, ts: parsed.data.ts, senderId: workspace.sender.id };
  },
};

/** Do not inherit broad upstream Slack actions or webhook triggers. */
export const omrSlackProvider: Provider = {
  ...slackProvider,
  description: "OMR Slack v1 bot workspace, channel and message journey",
  actions: { "workspace.get": workspaceGet, "channels.list": channelsList,
    "messages.list": messagesList, "messages.post": messagesPost },
  triggers: {},
};

/** Trust only a live token scope header, intersected with the recorded OAuth grant. */
export async function verifiedSlackScopes(runtime: {
  action(provider: string, action: string, options: {
    userId: string; connectionId: string; params: Record<string, never>;
    actor: { userId: string; tenantId: string; organizationId: string };
    retry: { maxAttempts: number; backoff: "exponential" }; cache: boolean;
  }): Promise<unknown>;
  connections: { get(connectionId: string): Promise<{ scopes?: string[] }> };
}, input: { userId: string; workspaceId: string; connectionId: string }): Promise<readonly string[] | undefined> {
  const result = await runtime.action("slack", "workspace.get", {
    userId: input.userId, connectionId: input.connectionId, params: {},
    actor: { userId: input.userId, tenantId: input.workspaceId, organizationId: input.workspaceId },
    retry: { maxAttempts: 1, backoff: "exponential" }, cache: false,
  });
  if (!workspaceGet.returns.safeParse(result).success || !result || typeof result !== "object" ||
      !("verifiedScopes" in result) || !Array.isArray(result.verifiedScopes)) return undefined;
  const recorded = (await runtime.connections.get(input.connectionId)).scopes;
  if (!Array.isArray(recorded)) return undefined;
  return result.verifiedScopes.filter((scope): scope is string =>
    typeof scope === "string" && recorded.includes(scope));
}
