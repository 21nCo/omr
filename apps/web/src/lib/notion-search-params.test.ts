import { describe, expect, it } from "vitest";
import { notionSearchParams } from "./notion-search-params.js";

describe("Notion search pagination", () => {
  it("keeps a cursor bound to its submitted query after the editable field changes", () => {
    expect(notionSearchParams("new search", "old search", "old-cursor"))
      .toEqual({ query: "old search", cursor: "old-cursor" });
    expect(notionSearchParams("new search", "old search", null))
      .toEqual({ query: "new search" });
  });
});
