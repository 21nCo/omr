/** Derive a domain-separated HMAC key without reusing the AES wrapping key directly. */
export async function deriveExecutionFingerprintKey(
  wrappingKey: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (wrappingKey.byteLength !== 32) throw new Error("Execution wrapping key must be 32 bytes");
  const key = await crypto.subtle.importKey("raw", wrappingKey, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: new TextEncoder().encode("oh-my-router/execution/v1"),
    info: new TextEncoder().encode("request-fingerprint/hmac-sha256"),
  }, key, 256);
  return new Uint8Array(bits);
}
