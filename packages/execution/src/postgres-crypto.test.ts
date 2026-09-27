import { describe, expect, it } from "vitest";

import { decryptJson, encryptJson } from "./postgres-crypto.js";

const key = new Uint8Array(32).fill(7);
const approval = { kind: "approval-params" as const, workspaceId: "workspace_A", id: "approval_A" };

describe("execution ciphertext context", () => {
  it("rejects ciphertext and IV copied to another row, workspace, or record type", async () => {
    const sealed = await encryptJson({ secret: "approval-A" }, key, approval);
    const ciphertext = Buffer.from(sealed.ciphertext);
    const iv = Buffer.from(sealed.iv);
    await expect(decryptJson(ciphertext, iv, key, approval, 1))
      .resolves.toEqual({ secret: "approval-A" });
    for (const context of [
      { ...approval, id: "approval_B" },
      { ...approval, workspaceId: "workspace_B" },
      { kind: "receipt-result" as const, workspaceId: approval.workspaceId, id: approval.id },
    ]) {
      await expect(decryptJson(ciphertext, iv, key, context, 1)).rejects.toThrow();
    }
    await expect(decryptJson(ciphertext, iv, key, approval, 0)).rejects.toThrow();
  });

  it("reads legacy version-zero ciphertext without treating it as context-bound", async () => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const imported = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
    const ciphertext = Buffer.from(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, imported,
      new TextEncoder().encode(JSON.stringify({ legacy: true }))));
    await expect(decryptJson(ciphertext, Buffer.from(iv), key, approval, 0))
      .resolves.toEqual({ legacy: true });
    await expect(decryptJson(ciphertext, Buffer.from(iv), key, approval, 1)).rejects.toThrow();
    await expect(decryptJson(ciphertext, Buffer.from(iv), key, approval, 2)).rejects.toThrow(
      "Unsupported execution ciphertext version");
  });
});
