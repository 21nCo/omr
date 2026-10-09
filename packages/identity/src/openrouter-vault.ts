/** Personal OpenRouter credentials never enter workspace or connection records. */
export interface OpenRouterKeyRow {
  userId: string;
  keyId: string;
  revision: string;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
  lastFour: string;
  validation: "valid" | "invalid";
  checkedAt: number;
}

export interface OpenRouterVaultStore {
  get(userId: string): Promise<OpenRouterKeyRow | null>;
  revision(userId: string): Promise<string | null>;
  put(row: OpenRouterKeyRow, expectedRevision: string | null): Promise<boolean>;
  markValidation(userId: string, revision: string, validation: "valid" | "invalid", checkedAt: number): Promise<void>;
  delete(userId: string): Promise<void>;
}

export class OpenRouterVaultError extends Error {
  constructor(readonly code: "OPENROUTER_KEY_INVALID" | "OPENROUTER_VALIDATION_UNAVAILABLE" |
    "OPENROUTER_KEY_MISSING" | "OPENROUTER_KEY_CONFLICT" | "OPENROUTER_VAULT_UNAVAILABLE" |
    "OPENROUTER_VAULT_DISABLED") {
    super(code);
  }
}

export interface OpenRouterKeyStatus {
  configured: boolean;
  maskedKey?: string;
  validation?: "valid" | "invalid";
  checkedAt?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KEY_PATTERN = /^sk-or-v1-[A-Za-z0-9_-]{20,502}$/;

/** Bind each ciphertext to its owner and vault purpose through AES-GCM additional data. */
function context(userId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(`omr:openrouter:personal:v1:${userId}`));
}

/** Reject malformed key rings before any vault read or write can use them. */
export function decodeOpenRouterVaultKeys(encoded: string, activeKeyId: string): {
  keys: Map<string, Uint8Array<ArrayBuffer>>; activeKeyId: string;
} {
  try {
    const values: unknown = JSON.parse(encoded);
    if (!values || typeof values !== "object" || Array.isArray(values) ||
      typeof activeKeyId !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(activeKeyId)) {
      throw new Error("Invalid vault key ring shape or active ID");
    }
    const keys = new Map<string, Uint8Array<ArrayBuffer>>();
    for (const [id, value] of Object.entries(values)) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("Invalid vault key ID or key bytes");
      }
      const bytes = new Uint8Array(new ArrayBuffer(32));
      for (let i = 0; i < 32; i += 1) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
      keys.set(id, bytes);
    }
    if (!keys.has(activeKeyId)) throw new Error("Active vault key is missing");
    return { keys, activeKeyId };
  } catch {
    throw new OpenRouterVaultError("OPENROUTER_VAULT_UNAVAILABLE");
  }
}

/** Read a small response body without exposing provider text in errors or logs. */
async function readValidationBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Provider response has no body");
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let oversized = false;
    for (;;) {
      // Sequential reads count each chunk before requesting another, preserving the 4096-byte limit.
      const { done, value } = await reader.read(); // NOSONAR (typescript:S9382)
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        oversized = true;
        break;
      }
      chunks.push(value);
    }
    if (oversized) {
      await reader.cancel();
      throw new Error("Provider response exceeds validation limit");
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } finally {
    reader.releaseLock();
  }
}

/** Validate with OpenRouter's current-key endpoint, never reading provider error bodies. */
export async function validateOpenRouterKey(key: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (!KEY_PATTERN.test(key)) throw new OpenRouterVaultError("OPENROUTER_KEY_INVALID");
  let response: Response;
  try {
    response = await fetcher("https://openrouter.ai/api/v1/key", {
      method: "GET",
      headers: { authorization: `Bearer ${key}` },
      // Workers reject redirect: "error"; a manual 3xx is not ok and is never followed.
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new OpenRouterVaultError("OPENROUTER_VALIDATION_UNAVAILABLE");
  }
  if (response.status === 401 || response.status === 403) throw new OpenRouterVaultError("OPENROUTER_KEY_INVALID");
  if (!response.ok) throw new OpenRouterVaultError("OPENROUTER_VALIDATION_UNAVAILABLE");
  try {
    const body = await readValidationBody(response) as { data?: { is_management_key?: unknown; is_provisioning_key?: unknown } };
    if (!body?.data || typeof body.data.is_management_key !== "boolean") {
      throw new Error("Provider response has no key classification");
    }
    if (body.data.is_management_key || body.data.is_provisioning_key === true) {
      throw new OpenRouterVaultError("OPENROUTER_KEY_INVALID");
    }
  } catch (error) {
    if (error instanceof OpenRouterVaultError) throw error;
    throw new OpenRouterVaultError("OPENROUTER_VALIDATION_UNAVAILABLE");
  }
}

export class OpenRouterVault {
  constructor(
    private readonly store: OpenRouterVaultStore,
    private readonly ring: ReturnType<typeof decodeOpenRouterVaultKeys>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** Return only masked metadata for the authenticated personal owner. */
  async status(userId: string): Promise<OpenRouterKeyStatus> {
    const row = await this.store.get(userId);
    return row ? { configured: true, maskedKey: `••••${row.lastFour}`,
      validation: row.validation, checkedAt: row.checkedAt } : { configured: false };
  }

  /** Validate, encrypt and compare revisions so an interrupted save cannot undo removal. */
  async save(userId: string, key: string): Promise<OpenRouterKeyStatus> {
    const expectedRevision = await this.store.revision(userId);
    await validateOpenRouterKey(key, this.fetcher);
    const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
    const wrapping = await crypto.subtle.importKey("raw", this.ring.keys.get(this.ring.activeKeyId)!, "AES-GCM", false, ["encrypt"]);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: context(userId) }, wrapping, encoder.encode(key),
    ));
    const saved = await this.store.put({ userId, keyId: this.ring.activeKeyId, revision: crypto.randomUUID(),
      iv, ciphertext, lastFour: key.slice(-4), validation: "valid", checkedAt: Date.now() }, expectedRevision);
    if (!saved) throw new OpenRouterVaultError("OPENROUTER_KEY_CONFLICT");
    return this.status(userId);
  }

  /** Apply a provider result only to the revision that was checked. */
  async check(userId: string): Promise<OpenRouterKeyStatus> {
    const row = await this.store.get(userId);
    if (!row) throw new OpenRouterVaultError("OPENROUTER_KEY_MISSING");
    const key = await this.decrypt(row, userId);
    let validation: "valid" | "invalid" = "valid";
    try {
      await validateOpenRouterKey(key, this.fetcher);
    } catch (error) {
      if (!(error instanceof OpenRouterVaultError) || error.code !== "OPENROUTER_KEY_INVALID") throw error;
      validation = "invalid";
    }
    await this.store.markValidation(userId, row.revision, validation, Date.now());
    return this.status(userId);
  }

  /** Replace the row with a tombstone to fence in-flight saves and checks. */
  async delete(userId: string): Promise<OpenRouterKeyStatus> {
    await this.store.delete(userId);
    return { configured: false };
  }

  /** Future playground callers must authenticate their user on each invocation. */
  async withKey<T>(userId: string, call: (key: string) => Promise<T>): Promise<T> {
    const row = await this.store.get(userId);
    if (row?.validation !== "valid") throw new OpenRouterVaultError("OPENROUTER_KEY_MISSING");
    return call(await this.decrypt(row, userId));
  }

  /** Authenticate ciphertext against the personal owner before releasing plaintext. */
  private async decrypt(row: OpenRouterKeyRow, userId: string): Promise<string> {
    const bytes = this.ring.keys.get(row.keyId);
    if (!bytes) throw new OpenRouterVaultError("OPENROUTER_VAULT_UNAVAILABLE");
    try {
      const wrapping = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["decrypt"]);
      return decoder.decode(await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: row.iv, additionalData: context(userId) }, wrapping, row.ciphertext,
      ));
    } catch {
      throw new OpenRouterVaultError("OPENROUTER_VAULT_UNAVAILABLE");
    }
  }
}
