import type { JsonValue } from "@oh-my-router/tools";

export type CiphertextContext = { kind: "approval-params" | "receipt-result" | "assisted-action" | "assisted-outcome";
  workspaceId: string; id: string };

function associatedData(context: CiphertextContext): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([
    "omr-execution-v1", context.kind, context.workspaceId, context.id,
  ]));
}

export async function encryptJson(value: JsonValue, wrappingKey: Uint8Array<ArrayBuffer>,
  context: CiphertextContext):
Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", wrappingKey, "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associatedData(context) },
    key, new TextEncoder().encode(JSON.stringify(value)));
  return { ciphertext: new Uint8Array(ciphertext), iv };
}

export async function decryptJson(ciphertext: Buffer, iv: Buffer,
  wrappingKey: Uint8Array<ArrayBuffer>, context: CiphertextContext,
  version: number): Promise<JsonValue> {
  if (version !== 0 && version !== 1) throw new Error("Unsupported execution ciphertext version");
  const key = await crypto.subtle.importKey("raw", wrappingKey, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv),
      ...(version === 1 ? { additionalData: associatedData(context) } : {}) },
    key, new Uint8Array(ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext)) as JsonValue;
}
