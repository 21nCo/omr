import { notionProvider } from "@plugfn/providers";
import type { Action, ActionContext, ActionContract, Provider } from "plugfn";
import { z } from "zod";
import { canonicalNotionId, canonicalNotionWriteParams, notionIdPattern, NotionProviderDenial, NotionProviderResponseAmbiguous, notionDenial } from "@oh-my-router/tools";

const id = z.string().regex(notionIdPattern);
const title = z.string().trim().min(1).max(200);
const cursor = z.string().min(1).max(1000).optional();
const richText = z.object({ plain_text: z.string() }).passthrough();
const parent = z.object({ type: z.string(), page_id: id.optional(), database_id: id.optional() }).passthrough();
const rawPage = z.object({ object: z.literal("page"), id, url: z.string().url(),
  parent, archived: z.boolean().optional(), in_trash: z.boolean().optional(),
  properties: z.record(z.object({ type: z.string(), title: z.array(richText).optional() }).passthrough()) }).passthrough();
const rawDatabase = z.object({ object: z.literal("database"), id, url: z.string().url(),
  title: z.array(richText), archived: z.boolean().optional(), in_trash: z.boolean().optional() }).passthrough();
const rawDataSource = z.object({ object: z.literal("data_source"), id,
  title: z.array(richText), archived: z.boolean().optional(), in_trash: z.boolean().optional() }).passthrough();
const item = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page"), id, title: z.string(), url: z.string().url() }),
  z.object({ type: z.literal("database"), id, title: z.string(), url: z.string().url() }),
  z.object({ type: z.literal("data_source"), id, title: z.string() }),
]);
const page = z.object({ id, title: z.string(), url: z.string().url(), parent });
const bot = z.object({ object: z.literal("user"), id, type: z.literal("bot") });

/** Restrict the exposed adapter to bounded reads and single-attempt writes. */
function contract(effect: "read" | "write", resources: ActionContract["resources"] = [],
  paginated = false): ActionContract {
  return { version: "1.0.0", effect, requiredScopes: [], resources,
    sensitiveKeys: ["title"], pagination: paginated
      ? { kind: "cursor", cursorParameter: "cursor", maxPageSize: 100 } : { kind: "none" },
    retry: effect === "read" ? "safe" : "never" };
}

/** Read the page's actual title property, whose name varies by workspace. */
function pageTitle(properties: z.infer<typeof rawPage>["properties"]): { name: string; text: string } | null {
  const found = Object.entries(properties).find(([, value]) => value.type === "title" && Array.isArray(value.title));
  return found ? { name: found[0], text: found[1].title!.map((entry) => entry.plain_text).join("") } : null;
}

/** Exclude malformed, archived and trashed pages from read and write targets. */
function visiblePage(value: unknown): z.infer<typeof rawPage> | null {
  const parsed = rawPage.safeParse(value);
  return parsed.success && !parsed.data.archived && !parsed.data.in_trash ? parsed.data : null;
}

/** A Notion search result is visible only through the selected integration token. */
function searchItem(value: unknown): z.infer<typeof item> | null {
  const foundPage = visiblePage(value);
  if (foundPage) return { type: "page", id: foundPage.id,
    title: pageTitle(foundPage.properties)?.text || "Untitled", url: foundPage.url };
  const database = rawDatabase.safeParse(value);
  if (database.success && !database.data.archived && !database.data.in_trash) return {
    type: "database", id: database.data.id,
    title: database.data.title.map((entry) => entry.plain_text).join("") || "Untitled", url: database.data.url,
  };
  const dataSource = rawDataSource.safeParse(value);
  if (dataSource.success && !dataSource.data.archived && !dataSource.data.in_trash) return {
    type: "data_source", id: dataSource.data.id,
    title: dataSource.data.title.map((entry) => entry.plain_text).join("") || "Untitled",
  };
  return null;
}

/** Do not turn a lost write response into a definite rejection. */
async function call(context: ActionContext, method: "get" | "post" | "patch", path: string,
  body: object | undefined, phase: NotionProviderDenial["phase"]): Promise<unknown> {
  try {
    const url = `${context.provider.baseUrl}${path}`;
    let response: { data: unknown };
    if (method === "get") response = await context.http.get(url);
    else if (method === "post") response = await context.http.post(url, body ?? {});
    else response = await context.http.patch(url, body ?? {});
    return response.data;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "CONNECTION_NOT_FOUND") {
      // The selected-page GET is complete before a mutation can be entered.
      // A missing remote connection after POST/PATCH remains uncertain.
      if (phase === "preflight") throw new NotionProviderDenial(phase, "NOTION_RECONNECT_REQUIRED",
        undefined, true);
      // PlugFn resolves the connection before entering this adapter. Once a
      // mutation was attempted, the same raw error cannot prove no effect.
      if (phase === "write") throw new NotionProviderResponseAmbiguous(true);
      throw error;
    }
    throw notionDenial(error, phase) ?? (phase === "write" ? error
      : new NotionProviderDenial(phase, "NOTION_QUERY_REJECTED"));
  }
}

/** Preflight the exact page through the selected integration's token. */
async function selectedPage(context: ActionContext, pageId: string,
  phase: NotionProviderDenial["phase"]): Promise<z.infer<typeof rawPage>> {
  const found = visiblePage(await call(context, "get", `/pages/${pageId}`, undefined, phase));
  if (!found || canonicalNotionId(found.id) !== canonicalNotionId(pageId)) {
    throw new NotionProviderDenial(phase, "NOTION_TARGET_UNAVAILABLE");
  }
  return found;
}

const search: Action = {
  name: "content.search", displayName: "Find shared Notion content",
  description: "Search one page of shared pages, databases, and browse-only data sources. Only pages are v1 write targets.",
  idempotent: true,
  parameters: z.object({ query: z.string().trim().max(100).optional(),
    limit: z.number().int().min(1).max(100).optional(), cursor }).strict(),
  returns: z.object({ items: z.array(item), nextCursor: z.string().nullable() }),
  contract: contract("read", [], true),
  execute: async (params, context) => {
    const result = await call(context, "post", "/search", {
      page_size: params.limit ?? 50, ...(params.query ? { query: params.query } : {}),
      ...(params.cursor ? { start_cursor: params.cursor } : {}),
    }, "read");
    const parsed = z.object({ results: z.array(z.unknown()).max(100), has_more: z.boolean(),
      next_cursor: z.string().nullable() }).safeParse(result);
    if (!parsed.success || parsed.data.has_more && !parsed.data.next_cursor) {
      throw new NotionProviderDenial("read", "NOTION_QUERY_REJECTED");
    }
    return { items: parsed.data.results.flatMap((value) => {
      const found = searchItem(value);
      return found ? [found] : [];
    }), nextCursor: parsed.data.has_more ? parsed.data.next_cursor : null };
  },
};

const verify: Action = {
  name: "connection.verify", displayName: "Verify Notion integration",
  description: "Verify the selected token belongs to a Notion integration bot.",
  idempotent: true, parameters: z.object({}).strict(), returns: bot,
  contract: contract("read"),
  execute: async (_params, context) => {
    const result = bot.safeParse(await call(context, "get", "/users/me", undefined, "read"));
    if (!result.success) throw new NotionProviderDenial("read", "NOTION_QUERY_REJECTED");
    return { object: result.data.object, id: result.data.id, type: result.data.type };
  },
};

const get: Action = {
  name: "pages.get", displayName: "Read shared Notion page",
  description: "Read the title and destination of one page accessible to the selected integration.",
  idempotent: true, parameters: z.object({ pageId: id }).strict(), returns: page,
  contract: contract("read", [{ kind: "page", parameter: "pageId" }]),
  execute: async (params, context) => {
    const found = await selectedPage(context, params.pageId, "read");
    return { id: found.id, title: pageTitle(found.properties)?.text || "Untitled",
      url: found.url, parent: found.parent };
  },
};

const create: Action = {
  name: "pages.create", displayName: "Create Notion child page",
  description: "Create one titled page beneath an explicitly selected shared page after OMR approval.",
  parameters: z.object({ parentPageId: id, title }).strict(), returns: page,
  contract: contract("write", [{ kind: "parent_page", parameter: "parentPageId" }]),
  execute: async (params, context) => {
    const canonical = canonicalNotionWriteParams("notion.pages.create", params);
    if (!canonical || !("parentPageId" in canonical)) {
      throw new NotionProviderDenial("preflight", "NOTION_INVALID_CHANGE");
    }
    await selectedPage(context, canonical.parentPageId, "preflight");
    const result = await call(context, "post", "/pages", {
      parent: { type: "page_id", page_id: canonical.parentPageId },
      properties: { title: { type: "title", title: [{ type: "text", text: { content: canonical.title } }] } },
    }, "write");
    const found = visiblePage(result);
    if (!found || canonicalNotionId(found.parent.page_id) !== canonical.parentPageId) {
      throw new NotionProviderResponseAmbiguous();
    }
    const actualTitle = pageTitle(found.properties)?.text;
    if (actualTitle !== canonical.title) throw new NotionProviderResponseAmbiguous();
    return { id: found.id, title: actualTitle,
      url: found.url, parent: found.parent };
  },
};

const update: Action = {
  name: "pages.update", displayName: "Rename Notion page",
  description: "Rename one explicitly selected shared page after OMR approval.",
  parameters: z.object({ pageId: id, title }).strict(), returns: page,
  contract: contract("write", [{ kind: "page", parameter: "pageId" }]),
  execute: async (params, context) => {
    const canonical = canonicalNotionWriteParams("notion.pages.update", params);
    if (!canonical || !("pageId" in canonical)) {
      throw new NotionProviderDenial("preflight", "NOTION_INVALID_CHANGE");
    }
    const before = await selectedPage(context, canonical.pageId, "preflight");
    const property = pageTitle(before.properties);
    if (!property) throw new NotionProviderDenial("preflight", "NOTION_TARGET_UNAVAILABLE");
    const result = await call(context, "patch", `/pages/${canonical.pageId}`, {
      properties: { [property.name]: { type: "title", title: [{ type: "text", text: { content: canonical.title } }] } },
    }, "write");
    const found = visiblePage(result);
    if (!found || canonicalNotionId(found.id) !== canonical.pageId) throw new NotionProviderResponseAmbiguous();
    const actualTitle = pageTitle(found.properties)?.text;
    if (actualTitle !== canonical.title) throw new NotionProviderResponseAmbiguous();
    return { id: found.id, title: actualTitle,
      url: found.url, parent: found.parent };
  },
};

/** Hide the broad upstream Notion surface. */
export const omrNotionProvider: Provider = {
  ...notionProvider,
  headers: { ...notionProvider.headers, "Notion-Version": "2025-09-03" },
  description: "OMR Notion v1 shared content discovery and approved page changes",
  actions: { "connection.verify": verify, "content.search": search, "pages.get": get,
    "pages.create": create, "pages.update": update },
  triggers: {},
};

/** The API's page picker controls visibility; Notion OAuth has no per-action scopes. */
export async function verifiedNotionScopes(runtime: {
  action(provider: string, action: string, options: {
    userId: string; connectionId: string; params: Record<string, never>;
    actor: { userId: string; tenantId: string; organizationId: string };
    retry: { maxAttempts: number; backoff: "exponential" }; cache: boolean;
  }): Promise<unknown>;
}, input: { userId: string; workspaceId: string; connectionId: string }): Promise<readonly string[] | undefined> {
  const result = await runtime.action("notion", "connection.verify", {
    userId: input.userId, connectionId: input.connectionId, params: {},
    actor: { userId: input.userId, tenantId: input.workspaceId, organizationId: input.workspaceId },
    retry: { maxAttempts: 1, backoff: "exponential" }, cache: false,
  });
  if (!bot.safeParse(result).success) {
    throw new NotionProviderDenial("read", "NOTION_QUERY_REJECTED");
  }
  return [];
}
