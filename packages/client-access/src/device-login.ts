import {
  assertClientAccessId,
  assertClientKind,
  createClientCredential,
  hashClientCredential,
  normalizeClientCapabilities,
  normalizeClientName,
  type ClientCapability,
  type ClientGrantRecord,
  type ClientKind,
  type ClientRecord,
} from "./client-access.js";

export type DeviceClientKind = Extract<ClientKind, "cli" | "mcp_remote" | "mcp_stdio">;
export type DeviceAuthorizationStatus = "pending" | "approved" | "consumed";

export interface DeviceAuthorizationRecord {
  id: string;
  deviceCodeHash: string;
  userCodeHash: string;
  clientKind: DeviceClientKind;
  clientName: string;
  requestedCapabilities: ClientCapability[];
  status: DeviceAuthorizationStatus;
  workspaceId: string | null;
  userId: string | null;
  clientId: string | null;
  grantId: string | null;
  sealedCredential: string | null;
  expiresAt: number;
  pollIntervalMs: number;
  createdAt: number;
  updatedAt: number;
}

export interface ApproveDeviceAuthorizationInput {
  authorizationId: string;
  userCodeHash: string;
  actorUserId: string;
  workspaceId: string;
  clientId: string;
  grantId: string;
  credentialHash: string;
  sealedCredential: string;
  grantExpiresAt: number;
  now: number;
}

export interface ConsumeDeviceAuthorizationInput {
  authorizationId: string;
  deviceCodeHash: string;
  now: number;
}

export interface DeviceAuthorizationStore {
  create(record: DeviceAuthorizationRecord): Promise<DeviceAuthorizationRecord>;
  findByUserCodeHash(userCodeHash: string): Promise<DeviceAuthorizationRecord | null>;
  findByDeviceCodeHash(deviceCodeHash: string): Promise<DeviceAuthorizationRecord | null>;
  approve(
    input: ApproveDeviceAuthorizationInput,
  ): Promise<{ client: ClientRecord; grant: ClientGrantRecord }>;
  consume(input: ConsumeDeviceAuthorizationInput): Promise<void>;
}

export interface DeviceCredentialCipher {
  seal(plaintext: string): Promise<string>;
  open(sealed: string): Promise<string>;
}

export class DeviceAuthorizationError extends Error {
  readonly code:
    | "DEVICE_AUTHORIZATION_INVALID"
    | "DEVICE_AUTHORIZATION_EXPIRED"
    | "DEVICE_AUTHORIZATION_PENDING";
  readonly retryAfterMs?: number;

  constructor(
    code: DeviceAuthorizationError["code"],
    options: { retryAfterMs?: number } = {},
  ) {
    super(
      code === "DEVICE_AUTHORIZATION_PENDING"
        ? "Device authorization is pending"
        : code === "DEVICE_AUTHORIZATION_EXPIRED"
          ? "Device authorization expired"
          : "Device authorization is not valid",
    );
    this.name = "DeviceAuthorizationError";
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytesLength: number): string {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createUserCode(): { display: string; normalized: string } {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const normalized = Array.from(
    bytes,
    (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length],
  ).join("");
  return { display: `${normalized.slice(0, 4)}-${normalized.slice(4)}`, normalized };
}

function normalizeUserCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.length !== 8) throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_INVALID");
  return normalized;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_INVALID");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (bytesToBase64Url(bytes) !== value) {
    throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_INVALID");
  }
  return bytes;
}

export async function createAesGcmDeviceCredentialCipher(
  wrappingKey: Uint8Array,
): Promise<DeviceCredentialCipher> {
  if (wrappingKey.byteLength !== 32) {
    throw new Error("Device credential wrapping key must contain exactly 32 bytes");
  }
  const keyMaterial = new Uint8Array(wrappingKey).buffer;
  const key = await crypto.subtle.importKey("raw", keyMaterial, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);

  return {
    async seal(plaintext) {
      const iv = new Uint8Array(12);
      crypto.getRandomValues(iv);
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(plaintext),
      );
      return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
    },
    async open(sealed) {
      const [version, encodedIv, encodedCiphertext] = sealed.split(".");
      if (version !== "v1" || !encodedIv || !encodedCiphertext) {
        throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_INVALID");
      }
      try {
        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: base64UrlToBytes(encodedIv) },
          key,
          base64UrlToBytes(encodedCiphertext),
        );
        return new TextDecoder().decode(decrypted);
      } catch {
        throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_INVALID");
      }
    },
  };
}

export class DeviceLoginAuthority {
  private readonly verificationUri: string;

  constructor(
    private readonly store: DeviceAuthorizationStore,
    private readonly cipher: DeviceCredentialCipher,
    verificationUri: string,
    private readonly now: () => number = Date.now,
  ) {
    const parsed = new URL(verificationUri);
    const localHttp =
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]");
    if (parsed.protocol !== "https:" && !localHttp) {
      throw new Error("Device verification URI must use HTTPS or localhost HTTP");
    }
    this.verificationUri = parsed.toString();
  }

  async begin(input: {
    clientKind: DeviceClientKind;
    clientName: string;
    requestedCapabilities: readonly ClientCapability[];
  }): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresInSeconds: number;
    pollIntervalSeconds: number;
  }> {
    assertClientKind(input.clientKind);
    if (input.clientKind !== "cli" && input.clientKind !== "mcp_remote" &&
      input.clientKind !== "mcp_stdio") {
      throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_INVALID");
    }
    const deviceCode = `omr_device_${randomHex(32)}`;
    const userCode = createUserCode();
    const timestamp = this.now();
    const expiresInMs = 10 * 60 * 1000;
    const pollIntervalMs = 5_000;
    await this.store.create({
      id: `device_authorization_${crypto.randomUUID()}`,
      deviceCodeHash: await sha256(deviceCode),
      userCodeHash: await sha256(userCode.normalized),
      clientKind: input.clientKind,
      clientName: normalizeClientName(input.clientName),
      requestedCapabilities: normalizeClientCapabilities(input.requestedCapabilities),
      status: "pending",
      workspaceId: null,
      userId: null,
      clientId: null,
      grantId: null,
      sealedCredential: null,
      expiresAt: timestamp + expiresInMs,
      pollIntervalMs,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const verificationUriComplete = new URL(this.verificationUri);
    verificationUriComplete.searchParams.set("user_code", userCode.display);
    return {
      deviceCode,
      userCode: userCode.display,
      verificationUri: this.verificationUri,
      verificationUriComplete: verificationUriComplete.toString(),
      expiresInSeconds: expiresInMs / 1000,
      pollIntervalSeconds: pollIntervalMs / 1000,
    };
  }

  async approve(input: {
    userCode: string;
    actorUserId: string;
    workspaceId: string;
  }): Promise<{ client: ClientRecord; grant: ClientGrantRecord }> {
    assertClientAccessId(input.actorUserId);
    assertClientAccessId(input.workspaceId);
    const userCodeHash = await sha256(normalizeUserCode(input.userCode));
    const authorization = await this.store.findByUserCodeHash(userCodeHash);
    const timestamp = this.now();
    this.assertApprovable(authorization, timestamp);

    const credential = createClientCredential();
    return this.store.approve({
      authorizationId: authorization.id,
      userCodeHash,
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      clientId: `client_${crypto.randomUUID()}`,
      grantId: `grant_${crypto.randomUUID()}`,
      credentialHash: await hashClientCredential(credential),
      sealedCredential: await this.cipher.seal(credential),
      grantExpiresAt: timestamp + 30 * 24 * 60 * 60 * 1000,
      now: timestamp,
    });
  }

  async poll(deviceCode: string): Promise<{
    credential: string;
    clientId: string;
    grantId: string;
    workspaceId: string;
  }> {
    if (!/^omr_device_[a-f0-9]{64}$/.test(deviceCode)) {
      throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_INVALID");
    }
    const deviceCodeHash = await sha256(deviceCode);
    const authorization = await this.store.findByDeviceCodeHash(deviceCodeHash);
    const timestamp = this.now();
    if (!authorization) throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_INVALID");
    if (authorization.expiresAt <= timestamp) {
      throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_EXPIRED");
    }
    if (authorization.status === "pending") {
      throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_PENDING", {
        retryAfterMs: authorization.pollIntervalMs,
      });
    }
    if (
      authorization.status !== "approved" ||
      !authorization.sealedCredential ||
      !authorization.clientId ||
      !authorization.grantId ||
      !authorization.workspaceId
    ) {
      throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_INVALID");
    }

    const credential = await this.cipher.open(authorization.sealedCredential);
    await this.store.consume({
      authorizationId: authorization.id,
      deviceCodeHash,
      now: timestamp,
    });
    return {
      credential,
      clientId: authorization.clientId,
      grantId: authorization.grantId,
      workspaceId: authorization.workspaceId,
    };
  }

  private assertApprovable(
    authorization: DeviceAuthorizationRecord | null,
    now: number,
  ): asserts authorization is DeviceAuthorizationRecord {
    if (!authorization || authorization.status !== "pending") {
      throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_INVALID");
    }
    if (authorization.expiresAt <= now) {
      throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_EXPIRED");
    }
  }
}
