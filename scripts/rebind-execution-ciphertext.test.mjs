import { describe, expect, it, vi } from "vitest";
import { rebindCiphertext } from "./rebind-execution-ciphertext.mjs";
import { encryptJson } from "../packages/execution/dist/postgres-crypto.js";

function stalledClient(stalledSql, row) {
  const calls = [];
  const destroy = vi.fn();
  return {
    calls,
    connection: { stream: { destroy } },
    connect: vi.fn(async () => undefined),
    query: vi.fn(async (sql) => {
      calls.push(sql);
      if (sql === stalledSql || (stalledSql === "row" && sql.startsWith("UPDATE "))) {
        return new Promise(() => undefined);
      }
      if (sql.startsWith("SELECT id, workspace_id")) {
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    }),
    end: vi.fn(async () => undefined),
    destroy,
  };
}

describe("ciphertext rebind deadline", () => {
  it("bounds connection establishment before BEGIN", async () => {
    const client = stalledClient("BEGIN");
    client.connect.mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    await expect(rebindCiphertext({ client, key: new Uint8Array(32),
      deadlineAt: started + 30, output: { write() {} } })).rejects.toThrow("deadline exceeded");
    expect(Date.now() - started).toBeLessThan(300);
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(client.calls).toEqual([]);
  });

  for (const rollback of [false, true]) {
    it(`disconnects a stalled BEGIN during ${rollback ? "rollback" : "forward"} rebind`, async () => {
      const client = stalledClient("BEGIN");
      const started = Date.now();
      await expect(rebindCiphertext({ client, key: new Uint8Array(32), rollback,
        deadlineAt: started + 30, output: { write() {} } })).rejects.toThrow("deadline exceeded");
      expect(Date.now() - started).toBeLessThan(300);
      expect(client.destroy).toHaveBeenCalledOnce();
      expect(client.calls).toEqual(["BEGIN"]);
    });

    it(`aborts a stalled row update and leaves no commit during ${rollback ? "rollback" : "forward"}`, async () => {
      const key = new Uint8Array(32).fill(7);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const context = { kind: "approval-params", workspaceId: "workspace_1", id: "row_1" };
      const sealed = rollback
        ? await encryptJson({ secret: "test" }, key, context)
        : { iv, ciphertext: new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv },
          await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]),
          new TextEncoder().encode(JSON.stringify({ secret: "test" })))) };
      const client = stalledClient("row", { id: "row_1", workspace_id: "workspace_1",
        ciphertext: Buffer.from(sealed.ciphertext), iv: Buffer.from(sealed.iv) });
      const started = Date.now();
      await expect(rebindCiphertext({ client, key, rollback, deadlineAt: started + 50,
        output: { write() {} } })).rejects.toThrow("deadline exceeded");
      expect(Date.now() - started).toBeLessThan(300);
      expect(client.destroy).toHaveBeenCalledOnce();
      expect(client.calls.some((sql) => sql.startsWith("UPDATE "))).toBe(true);
      expect(client.calls).not.toContain("COMMIT");
    });
  }
});
