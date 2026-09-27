import { describe, expect, it } from "vitest";
import { decodeExecutionWrappingKey } from "./wrapping-key.js";

describe("execution wrapping key", () => {
  const bytes = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const encoded = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=$/, "");

  it("accepts canonical hex and base64url with or without its single pad", () => {
    for (const value of [hex, encoded, `${encoded}=`]) {
      expect(decodeExecutionWrappingKey(value)).toEqual(bytes);
    }
  });

  it("rejects noncanonical 32-byte decodings before database access", () => {
    for (const value of [`${encoded}!`, `${encoded}==`, encoded.slice(0, -1) + "9",
      btoa(String.fromCharCode(...new Uint8Array(32).fill(255))),
      "a".repeat(42), "a".repeat(45)]) {
      expect(() => decodeExecutionWrappingKey(value)).toThrow("Execution wrapping key is invalid");
    }
  });
});
