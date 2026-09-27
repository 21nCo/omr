import type { JsonValue } from "@oh-my-router/tools";

export async function encryptJson(value: JsonValue, wrappingKey: Uint8Array<ArrayBuffer>):
Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", wrappingKey, "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { ciphertext: new Uint8Array(ciphertext), iv };
}

export async function decryptJson(ciphertext: Buffer, iv: Buffer,
  wrappingKey: Uint8Array<ArrayBuffer>): Promise<JsonValue> {
  const key = await crypto.subtle.importKey("raw", wrappingKey, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) }, key, new Uint8Array(ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext)) as JsonValue;
}
