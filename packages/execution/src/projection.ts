import type { JsonValue, ToolManifest } from "@oh-my-router/tools";

import type { ExecutionApproval, ExecutionReceipt } from "./execution.js";

const SECRET_NAME = /(?:secret|token|password|passphrase|credential|authorization|api[_-]?key|private[_-]?key)/i;

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
  const sensitive = new Set(manifest.contract.sensitiveKeys.map((key) => key.toLowerCase()));
  // A declared target that would be masked or is absent cannot be reviewed.
  return manifest.contract.resources.every(({ parameter }) => {
    if (!parameter) return true;
    const keys = parameter.split(".");
    const last = keys.at(-1)!;
    if (sensitive.has(last.toLowerCase()) || sensitive.has(parameter.toLowerCase()) || SECRET_NAME.test(last)) {
      return false;
    }
    let value: JsonValue | undefined = params;
    for (const key of keys) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      value = value[key];
    }
    return value !== undefined && value !== null && typeof value !== "object";
  });
}

/** Approval parameters remain encrypted in storage; API and UI previews mask secrets. */
export function publicApproval(approval: ExecutionApproval, manifest?: ToolManifest | null) {
  const { principalKey: _principalKey, providerConnectionId: _providerConnectionId,
    idempotencyKey: _idempotencyKey, requestHash: _requestHash, ...visible } = approval;
  const manifestCurrent = manifest?.hash === approval.manifestHash;
  const sensitive = new Set(manifest?.contract.sensitiveKeys.map((key) => key.toLowerCase()) ?? []);
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
