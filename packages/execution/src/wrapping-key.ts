/** Decode a canonical 32-byte hex or base64url wrapping key in Node and Workers. */
export function decodeExecutionWrappingKey(value: string): Uint8Array<ArrayBuffer> {
  if (/^[a-f0-9]{64}$/i.test(value)) {
    const key = new Uint8Array(new ArrayBuffer(32));
    for (let index = 0; index < 32; index += 1) {
      key[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return key;
  }
  if (!/^[A-Za-z0-9_-]{43}=?$/.test(value)) {
    throw new Error("Execution wrapping key is invalid");
  }
  try {
    const unpadded = value.replaceAll("=", "");
    const binary = atob(unpadded.replaceAll("-", "+").replaceAll("_", "/") + "=");
    const canonical = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    if (binary.length !== 32 || canonical !== unpadded) {
      throw new Error("Noncanonical wrapping key");
    }
    const key = new Uint8Array(new ArrayBuffer(32));
    for (let index = 0; index < 32; index += 1) key[index] = binary.codePointAt(index) ?? 0;
    return key;
  } catch {
    throw new Error("Execution wrapping key is invalid");
  }
}
