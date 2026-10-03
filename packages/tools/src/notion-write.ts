const NOTION_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;

/** Use one page identity for approval, intent fencing, and provider dispatch. */
export function canonicalNotionId(value: unknown): string | null {
  return typeof value === "string" && NOTION_ID.test(value)
    ? value.replaceAll("-", "").toLowerCase() : null;
}

/** Notion trims a submitted page title; reject an empty result before approval. */
export function canonicalNotionTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.trim();
  return title.length > 0 && title.length <= 200 ? title : null;
}

/** Reject malformed writes and return exactly the bytes used by a Notion write. */
export function canonicalNotionWriteParams(toolId: string, value: unknown):
  { parentPageId: string; title: string } | { pageId: string; title: string } | null {
  if (toolId !== "notion.pages.create" && toolId !== "notion.pages.update") return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const params = value as Record<string, unknown>;
  const title = canonicalNotionTitle(params.title);
  const key = toolId === "notion.pages.create" ? "parentPageId" : "pageId";
  const pageId = canonicalNotionId(params[key]);
  if (!title || !pageId || Object.keys(params).some((name) => name !== key && name !== "title")) return null;
  return key === "parentPageId" ? { parentPageId: pageId, title } : { pageId, title };
}
