import { describe, expect, it, vi } from "vitest";
import { createOAuthReviewController } from "./oauth-review.js";

const input = { workspaceId: "workspace_a", provider: "github", ownership: "personal" as const,
  label: "GitHub", origin: "https://omr.example" };

/** Capture OAuth review updates and single-use browser intent in memory. */
function fixture() {
  const items = new Map<string, string>();
  const storage = { setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key) };
  const update = vi.fn<(review: { destination: string } | null, busy: boolean) => void>();
  const readiness = vi.fn(async () => ({ available: true, authMode: "oauth" }));
  const start = vi.fn(async () => ({ authUrl: "https://provider.example/oauth?state=one&scope=read%3Auser" }));
  const controller = createOAuthReviewController({ storage: () => storage, readiness, start, update });
  return { controller, items, update, readiness, start };
}

describe("OAuth review state", () => {
  it("unlocks controls on review and cancel, clears intent, and permits another action", async () => {
    const { controller, items, update, start } = fixture();
    await controller.start(input);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({
      destination: expect.stringContaining("provider.example"),
    }), false);
    expect(items.size).toBe(1);
    controller.cancel();
    expect(items.size).toBe(0);
    expect(update).toHaveBeenLastCalledWith(null, false);
    await controller.start(input);
    expect(start).toHaveBeenCalledTimes(2);
    expect(items.size).toBe(1);
  });

  it("discards a late provider response after a workspace switch", async () => {
    const { controller, items, update, start } = fixture();
    let finish!: (value: { authUrl: string }) => void;
    start.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = controller.start(input);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const switched = controller.start({ ...input, workspaceId: "workspace_b" });
    await switched;
    expect(JSON.parse(items.get("omr.provider-oauth.one")!)).toMatchObject({ workspaceId: "workspace_b" });
    finish({ authUrl: "https://provider.example/oauth?state=stale" });
    await pending;
    expect(items.size).toBe(1);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({
      destination: expect.stringContaining("state=one"),
    }), false);
    expect(JSON.parse(items.get("omr.provider-oauth.one")!)).toMatchObject({ workspaceId: "workspace_b" });
  });
});
