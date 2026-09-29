import { describe, expect, it, vi } from "vitest";

import { authenticatedSessionFetch } from "./session.js";

describe("local MCP grant cutoff", () => {
  it("blocks sibling requests and an in-flight success after the first 401", async () => {
    let finishRead!: (response: Response) => void;
    const read = new Promise<Response>((resolve) => { finishRead = resolve; });
    const backend = vi.fn<typeof fetch>(async (request) =>
      String(request).includes("slow") ? read : Response.json({}, { status: 401 }));
    const close = vi.fn(async () => undefined);
    const fetch = authenticatedSessionFetch(backend, close, vi.fn());

    const pending = fetch("https://omr.test/slow");
    expect((await fetch("https://omr.test/revoked")).status).toBe(401);
    for (const path of ["tools", "connections", "approvals", "refresh"]) {
      await expect(fetch(`https://omr.test/${path}`)).rejects.toThrow(/revoked or expired/);
    }
    finishRead(Response.json({ ok: true }));
    await expect(pending).rejects.toThrow(/revoked or expired/);
    expect(backend).toHaveBeenCalledTimes(2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("uses a terminal fallback when closing the transport fails", async () => {
    const backend = vi.fn<typeof fetch>(async () => Response.json({}, { status: 401 }));
    const terminate = vi.fn();
    const fetch = authenticatedSessionFetch(backend,
      async () => { throw new Error("close failed"); }, terminate);
    expect((await fetch("https://omr.test/revoked")).status).toBe(401);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminate).toHaveBeenCalledTimes(1);
    await expect(fetch("https://omr.test/again")).rejects.toThrow(/revoked or expired/);
    expect(backend).toHaveBeenCalledTimes(1);
  });
});
