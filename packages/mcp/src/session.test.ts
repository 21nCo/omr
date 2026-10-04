import { describe, expect, it, vi } from "vitest";

import { authenticatedSessionFetch } from "./session.js";

describe("local MCP grant cutoff", () => {
  it.each([
    "NOTION_RECONNECT_REQUIRED", "GITHUB_RECONNECT_REQUIRED",
    "LINEAR_RECONNECT_REQUIRED", "SLACK_RECONNECT_REQUIRED",
  ])("keeps the OMR grant usable after %s", async (code) => {
    const backend = vi.fn<typeof fetch>(async (request) => String(request).endsWith("/provider")
      ? Response.json({ error: code, message: "Reconnect this provider" }, { status: 401 })
      : Response.json({ connections: ["other-provider"] }));
    const close = vi.fn(async () => undefined);
    const fetch = authenticatedSessionFetch(backend, close, vi.fn());

    const denied = await fetch("https://omr.test/provider");
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: code });
    expect((await fetch("https://omr.test/connections")).status).toBe(200);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(close).not.toHaveBeenCalled();
    expect(backend).toHaveBeenCalledTimes(2);
  });

  it.each([
    Response.json({ error: "CLIENT_CREDENTIAL_INVALID" }, { status: 401 }),
    Response.json({ error: "NOTION_RECONNECT_REQUIRED" }, { status: 403 }),
    new Response("not json", { status: 401 }),
    Response.json({ error: { code: "NOTION_RECONNECT_REQUIRED" } }, { status: 401 }),
  ])("closes on a client or malformed 401, but leaves a 403 usable", async (denial) => {
    const backend = vi.fn<typeof fetch>(async (request) => String(request).endsWith("/first")
      ? denial.clone() : Response.json({ ok: true }));
    const close = vi.fn(async () => undefined);
    const fetch = authenticatedSessionFetch(backend, close, vi.fn());
    expect((await fetch("https://omr.test/first")).status).toBe(denial.status);
    if (denial.status === 401) {
      await expect(fetch("https://omr.test/next")).rejects.toThrow(/revoked or expired/);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(close).toHaveBeenCalledOnce();
      expect(backend).toHaveBeenCalledOnce();
    } else {
      expect((await fetch("https://omr.test/next")).status).toBe(200);
      expect(close).not.toHaveBeenCalled();
    }
  });

  it("keeps a rate limit local and still fences an earlier provider response after grant revocation", async () => {
    let finishProvider!: (response: Response) => void;
    const provider = new Promise<Response>((resolve) => { finishProvider = resolve; });
    const backend = vi.fn<typeof fetch>(async (request) => {
      const path = String(request);
      if (path.endsWith("/provider")) return provider;
      if (path.endsWith("/rate")) return Response.json({ error: "NOTION_RATE_LIMITED" }, { status: 429 });
      return Response.json({ error: "CLIENT_CREDENTIAL_INVALID" }, { status: 401 });
    });
    const close = vi.fn(async () => undefined);
    const fetch = authenticatedSessionFetch(backend, close, vi.fn());
    expect((await fetch("https://omr.test/rate")).status).toBe(429);
    const pending = fetch("https://omr.test/provider");
    expect((await fetch("https://omr.test/revoked")).status).toBe(401);
    finishProvider(Response.json({ error: "NOTION_RECONNECT_REQUIRED" }, { status: 401 }));
    await expect(pending).rejects.toThrow(/revoked or expired/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(close).toHaveBeenCalledOnce();
  });

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
