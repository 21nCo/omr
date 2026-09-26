import { describe, expect, it, vi } from "vitest";

import { ConnectionUnavailableError, type ConnectionAuthority } from "./connections.js";
import { markMissingRemoteConnection } from "./remote.js";

describe("missing remote health transition", () => {
  it("signals a failed write safely and retries the same transition", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failedWrite = new Error("secret connection string");
      failedWrite.name = "secret credential";
      const recordHealth = vi.fn()
        .mockRejectedValueOnce(failedWrite)
        .mockResolvedValueOnce(undefined);
      const authority = { recordHealth } as unknown as ConnectionAuthority;
      await markMissingRemoteConnection(authority, "binding_1");
      expect(warn).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
        service: "omr-connections", level: "warn", event: "missing_remote_health_write_failed",
        bindingId: "binding_1", errorType: "Error",
      }));
      expect(warn.mock.calls[0]?.[0]).not.toContain("secret connection string");
      expect(warn.mock.calls[0]?.[0]).not.toContain("secret credential");
      await markMissingRemoteConnection(authority, "binding_1");
      expect(recordHealth).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("classifies a terminal binding without leaking an error message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const authority = {
        recordHealth: vi.fn().mockRejectedValue(new ConnectionUnavailableError()),
      } as unknown as ConnectionAuthority;
      await markMissingRemoteConnection(authority, "binding_revoked");
      expect(warn).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
        service: "omr-connections", level: "warn", event: "missing_remote_health_binding_unavailable",
        bindingId: "binding_revoked", errorType: "ConnectionUnavailableError",
      }));
    } finally {
      warn.mockRestore();
    }
  });
});
