import type { JsonValue, ToolManifest } from "@oh-my-router/tools";

import type { ExecutionApproval, ExecutionReceipt } from "./execution.js";

const SECRET_NAME = /(?:secret|token|password|passphrase|credential|authorization|api[_-]?key|private[_-]?key)/i;

function normalizeSensitiveKey(key: string): string {
  return key.replace(/\[(\d+)\]/g, ".$1").replace(/\[\]/g, "")
    .split(".").filter((part) => part !== "*").join(".").toLowerCase();
}

function sensitivePath(path: string[], sensitive: Set<string>): boolean {
  const full = path.join(".").toLowerCase();
  const withoutIndexes = path.filter((part) => !/^\d+$/.test(part)).join(".").toLowerCase();
  return sensitive.has(full) || sensitive.has(withoutIndexes);
}

function redact(value: JsonValue, sensitive: Set<string>, path: string[] = []): JsonValue {
  if (Array.isArray(value)) return value.map((item, index) => redact(item, sensitive, [...path, String(index)]));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const fieldPath = [...path, key];
    return [key, sensitive.has(key.toLowerCase()) || sensitivePath(fieldPath, sensitive) || SECRET_NAME.test(key)
      ? "[REDACTED]"
      : redact(item, sensitive, fieldPath)];
  }));
}

/** Missing or stale redaction metadata cannot produce a reviewable approval. */
export function approvalPreviewReady(
  manifest: ToolManifest | null | undefined,
  manifestHash: string,
  params: JsonValue,
): boolean {
  if (!manifest || manifest.hash !== manifestHash || manifest.contract.version === "0.0.0" ||
      manifest.contract.sensitiveKeys.length === 0 ||
      manifest.contract.sensitiveKeys.some((key) => !key.trim()) ||
      params === null || typeof params !== "object" || Array.isArray(params)) return false;
  const sensitive = new Set(manifest.contract.sensitiveKeys.map(normalizeSensitiveKey));
  // A declared target that would be masked or is absent cannot be reviewed.
  return manifest.contract.resources.every(({ parameter }) => {
    if (!parameter) return true;
    const keys = parameter.split(".");
    let value: JsonValue | undefined = params;
    for (const [index, key] of keys.entries()) {
      if (!key || sensitive.has(key.toLowerCase()) || sensitivePath(keys.slice(0, index + 1), sensitive) ||
          SECRET_NAME.test(key) || value === null || typeof value !== "object" ||
          !Object.hasOwn(value, key)) return false;
      value = (value as Record<string, JsonValue>)[key];
    }
    return value !== undefined && value !== null && typeof value !== "object";
  });
}

/** Approval parameters remain encrypted in storage; API and UI previews mask secrets. */
export function publicApproval(approval: ExecutionApproval, manifest?: ToolManifest | null) {
  const { principalKey: _principalKey, providerConnectionId: _providerConnectionId,
    idempotencyKey: _idempotencyKey, requestHash: _requestHash, ...visible } = approval;
  const manifestCurrent = manifest?.hash === approval.manifestHash;
  const sensitive = new Set(manifest?.contract.sensitiveKeys.map(normalizeSensitiveKey) ?? []);
  // With no declared secret fields, the catalog cannot tell us which values are safe to show.
  // An approval whose arguments cannot be reviewed must not be actionable.
  const previewReady = approvalPreviewReady(manifest, approval.manifestHash, approval.params);
  return { ...visible,
    action: manifestCurrent && manifest ? manifest.displayName : approval.toolId,
    effect: manifestCurrent && manifest ? manifest.contract.effect : "unknown",
    resources: manifestCurrent && manifest ? manifest.contract.resources : [],
    manifestCurrent,
    previewReady,
    params: previewReady ? redact(approval.params, sensitive) : "[REDACTED]",
  };
}

/** History omits results; direct execution returns them only to the authenticated actor. */
export function publicReceipt(receipt: ExecutionReceipt, includeResult = true) {
  const { principalKey: _principalKey, providerConnectionId: _providerConnectionId,
    requestHash: _requestHash, idempotencyKey: _idempotencyKey, ...visible } = receipt;
  return includeResult ? visible : { ...visible, result: null };
}
