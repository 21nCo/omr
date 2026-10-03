import { describe, expect, it, vi } from "vitest";
import { createControlPlaneRequest, OMRResponseError } from "./control-plane-request.js";

describe("control plane provider reconnect", () => {
  it("keeps a revoked Notion token in the app and permits a refresh after reconnect", async () => {
    const redirect = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: "NOTION_RECONNECT_REQUIRED",
        message: "Reconnect the Notion account." }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ status: "active" }));
    const request = createControlPlaneRequest(fetchImpl, redirect);
    await expect(request("/api/tools/notion.pages.get")).rejects.toMatchObject({
      code: "NOTION_RECONNECT_REQUIRED", message: "Reconnect the Notion account.",
    } satisfies Partial<OMRResponseError>);
    expect(redirect).not.toHaveBeenCalled();
    expect(await request("/api/connections/refresh", { method: "POST" }))
      .toEqual({ status: "active" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/connections/refresh",
      { credentials: "same-origin", method: "POST" });
  });

  it("redirects only a real session 401", async () => {
    const redirect = vi.fn();
    const request = createControlPlaneRequest(vi.fn(async () =>
      Response.json({ error: "AUTHFN_UNAUTHENTICATED" }, { status: 401 })), redirect);
    await expect(request("/api/control-plane")).rejects.toThrow("Authentication required");
    expect(redirect).toHaveBeenCalledOnce();
  });
});
