import type { JsonValue, ToolManifest } from "@oh-my-router/tools";

import type { ExecutionApproval, ExecutionReceipt } from "./execution.js";

const SECRET_NAME = /(?:secret|token|password|credential|authorization|api[_-]?key)/i;

function redact(value: JsonValue, sensitive: Set<string>, path = ""): JsonValue {
  if (Array.isArray(value)) return value.map((item) => redact(item, sensitive, path));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const fieldPath = path ? `${path}.${key}` : key;
    return [key, sensitive.has(key.toLowerCase()) || sensitive.has(fieldPath.toLowerCase()) || SECRET_NAME.test(key)
      ? "[REDACTED]"
      : redact(item, sensitive, fieldPath)];
  }));
}

/** Approval parameters remain encrypted in storage; API and UI previews mask secrets. */
export function publicApproval(approval: ExecutionApproval, manifest?: ToolManifest | null) {
  const { principalKey: _principalKey, providerConnectionId: _providerConnectionId,
    idempotencyKey: _idempotencyKey, ...visible } = approval;
  const sensitive = new Set(manifest?.contract.sensitiveKeys.map((key) => key.toLowerCase()) ?? []);
  return { ...visible,
    effect: manifest?.contract.effect ?? "unknown",
    resources: manifest?.contract.resources ?? [],
    manifestCurrent: manifest?.hash === approval.manifestHash,
    params: manifest ? redact(approval.params, sensitive) : "[REDACTED]",
  };
}

/** History omits results; direct execution returns them only to the authenticated actor. */
export function publicReceipt(receipt: ExecutionReceipt, includeResult = true) {
  const { principalKey: _principalKey, providerConnectionId: _providerConnectionId,
    requestHash: _requestHash, idempotencyKey: _idempotencyKey, ...visible } = receipt;
  return includeResult ? visible : { ...visible, result: null };
}
