import type { JsonValue, ToolManifest } from "@oh-my-router/tools";

import type { ExecutionApproval, ExecutionReceipt } from "./execution.js";

const SECRET_NAME = /(?:secret|token|password|passphrase|credential|authorization|api[_-]?key|private[_-]?key)/i;

function parseSensitiveKey(key: string): string[] | null {
  // A wildcard consumes exactly one array index or object key. Unknown selector
  // syntax cannot safely describe what should be hidden, so fail closed.
  if (!/^[^.[\]]+(?:(?:\.[^.[\]]+)|(?:\[(?:\d+|\*)?\]))*$/.test(key)) return null;
  return key.replace(/\[(\d+|\*)?\]/g, (_match, index: string | undefined) => `.${index || "*"}`)
    .split(".").map((part) => part.toLowerCase());
}

function sensitivePath(path: string[], sensitive: string[][]): boolean {
  return sensitive.some((selector) => selector.length === path.length &&
    selector.every((part, index) => part === "*" || part === path[index]?.toLowerCase()));
}

function selectorTraversable(value: JsonValue, selector: string[], depth = 0): boolean {
  if (depth === selector.length) return true;
  if (value === null || typeof value !== "object") return false;
  const part = selector[depth]!;
  if (Array.isArray(value)) {
    if (part === "*") return value.every((item) => selectorTraversable(item, selector, depth + 1));
    if (!/^\d+$/.test(part)) return false;
    return !Object.hasOwn(value, part) || selectorTraversable(value[Number(part)]!, selector, depth + 1);
  }
  const matches = Object.entries(value).filter(([key]) => part === "*" || key.toLowerCase() === part);
  return matches.every(([, item]) => selectorTraversable(item, selector, depth + 1));
}

function redact(value: JsonValue, sensitive: string[][], path: string[] = []): JsonValue {
  // Check the value at every path, including array elements. A selector such as
  // items[*] hides the whole element, not just named fields beneath it.
  if (sensitivePath(path, sensitive)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item, index) => redact(item, sensitive, [...path, String(index)]));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const fieldPath = [...path, key];
    return [key, sensitivePath([key], sensitive) || sensitivePath(fieldPath, sensitive) || SECRET_NAME.test(key)
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
  const sensitive = manifest.contract.sensitiveKeys.map(parseSensitiveKey);
  if (sensitive.some((selector) => !selector)) return false;
  const selectors = sensitive as string[][];
  // A present value with the wrong container shape could bypass a descendant
  // selector, leaving the whole value visible in an approval preview.
  if (selectors.some((selector) => !selectorTraversable(params, selector))) return false;
  // A declared target that would be masked or is absent cannot be reviewed.
  return manifest.contract.resources.every(({ parameter }) => {
    if (!parameter) return true;
    const keys = parameter.split(".");
    let value: JsonValue | undefined = params;
    for (const [index, key] of keys.entries()) {
      if (!key || sensitivePath([key], selectors) || sensitivePath(keys.slice(0, index + 1), selectors) ||
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
  const sensitive = manifest?.contract.sensitiveKeys.map(parseSensitiveKey).filter((key): key is string[] => key !== null) ?? [];
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
