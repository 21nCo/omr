import { describe, expect, it } from "vitest";
import { createLinearActionKeys, linearApprovalNotice } from "./linear-action-keys.js";

describe("Linear browser action identity", () => {
  it("distinguishes pending approval, approved execution, and executing states", () => {
    expect(linearApprovalNotice("pending")).toContain("awaits your approval");
    expect(linearApprovalNotice("approved")).toContain("Execute it");
    expect(linearApprovalNotice("executing")).toContain("is executing");
  });
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

  it.each(["linear.issues.create", "linear.issues.update"])(
    "keeps a live %s key through replay and resets only after settlement", async (toolId) => {
      let next = 0;
      const keys = createLinearActionKeys(() => `action-${++next}`);
      const params = { linearWorkspaceId: "linear-A", issueId: "issue-A", title: "Changed" };
      const original = await keys.key(toolId, "omr-A", "connection-A", params);
      const probed: string[] = [];
      for (const status of ["pending", "approved", "executing", "uncertain"]) {
        await expect(keys.resetAfterSettlement(toolId, "omr-A", "connection-A", params,
          async (key) => { probed.push(key); return { status }; })).rejects.toThrow();
        expect(await keys.key(toolId, "omr-A", "connection-A", params)).toBe(original);
      }
      expect(probed).toEqual([original, original, original, original]);
      await keys.resetAfterSettlement(toolId, "omr-A", "connection-A", params,
        async () => ({ status: "consumed" }));
      expect(await keys.key(toolId, "omr-A", "connection-A", params)).not.toBe(original);
    });

  it("preserves the action on a failed probe, account switch, and denied storage", async () => {
    const keys = createLinearActionKeys(() => crypto.randomUUID(), () => { throw new Error("denied"); });
    const params = { linearWorkspaceId: "linear-A", teamId: "team-A", title: "Issue" };
    const key = await keys.key("linear.issues.create", "omr-A", "connection-A", params);
    await expect(keys.resetAfterSettlement("linear.issues.create", "omr-A", "connection-A", params,
      async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    await keys.resetAfterSettlement("linear.issues.create", "omr-A", "connection-A", params,
      async () => ({ status: "consumed" }), () => false);
    expect(await keys.key("linear.issues.create", "omr-A", "connection-A", params)).toBe(key);
  });

  it.each(["rejected", "failed", "expired"])("permits a new action after %s", async (status) => {
    let next = 0;
    const keys = createLinearActionKeys(() => `action-${++next}`);
    const params = { linearWorkspaceId: "linear-A", teamId: "team-A", title: "Issue" };
    const old = await keys.key("linear.issues.create", "omr-A", "connection-A", params);
    await keys.resetAfterSettlement("linear.issues.create", "omr-A", "connection-A", params,
      async () => ({ status }));
    expect(await keys.key("linear.issues.create", "omr-A", "connection-A", params)).not.toBe(old);
  });
});
