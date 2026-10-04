/** A Notion cursor belongs to the query that produced it, even if the input changes. */
export function notionSearchParams(editableQuery: string, submittedQuery: string,
  cursor: string | null): { query: string; cursor?: string } {
  return cursor ? { query: submittedQuery, cursor } : { query: editableQuery };
}
