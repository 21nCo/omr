import { describe, expect, it } from "vitest";
import { createLinearActionKeys } from "./linear-action-keys.js";

describe("Linear browser action identity", () => {
  it("reuses one key after reload and reserves a new one only for an explicit action", async () => {
    let next = 0;
    const values = new Map<string, string>();
    const storage = () => ({ getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); } });
    const make = () => createLinearActionKeys(() => `action-${++next}`, storage);
    const params = { linearWorkspaceId: "workspace-A", teamId: "team-A", title: "Issue" };
    const first = await make().key("linear.issues.create", "omr-A", "connection-A", params);
    const reloaded = make();
    expect(await reloaded.key("linear.issues.create", "omr-A", "connection-A", { ...params })).toBe(first);
    expect([...values.keys()][0]).not.toContain("Issue");
    expect(await reloaded.key("linear.issues.create", "omr-A", "connection-B", params)).not.toBe(first);
    expect(await reloaded.key("linear.issues.create", "omr-B", "connection-A", params)).not.toBe(first);
    expect(await reloaded.key("linear.issues.update", "omr-A", "connection-A", params)).not.toBe(first);
    await reloaded.reset("linear.issues.create", "omr-A", "connection-A", params);
    expect(await reloaded.key("linear.issues.create", "omr-A", "connection-A", params)).not.toBe(first);
  });
});
