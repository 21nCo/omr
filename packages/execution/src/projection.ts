import type { JsonValue, ToolManifest } from "@oh-my-router/tools";

import type { ExecutionApproval, ExecutionReceipt } from "./execution.js";

const SECRET_NAME = /secret|token|password|passphrase|credential|authorization|api[_-]?key|private[_-]?key/i;

type SelectorSegment = { part: string; next: number };

function canonicalSelectorIndex(part: string): boolean {
  if (!/^\d+$/.test(part)) return true;
  // Readiness and redaction must agree on the same array property.
  return /^(0|[1-9]\d*)$/.test(part) && Number(part) <= 4_294_967_294;
}

function bracketSegment(key: string, cursor: number): SelectorSegment | null {
  const end = key.indexOf("]", cursor + 1);
  if (end < 0) return null;
  const index = key.slice(cursor + 1, end);
  if (index && index !== "*" && !/^\d+$/.test(index)) return null;
  const next = end + 1;
  if (next < key.length && key[next] !== "." && key[next] !== "[") return null;
  return { part: index || "*", next };
}

function nameSegment(key: string, cursor: number): SelectorSegment | null {
  const start = key[cursor] === "." ? cursor + 1 : cursor;
  if (start !== cursor && (cursor === 0 || key[start] === "[")) return null;
  let next = start;
  while (next < key.length && key[next] !== "." && key[next] !== "[" && key[next] !== "]") next += 1;
  if (next === start || key[next] === "]") return null;
  return { part: key.slice(start, next).toLowerCase(), next };
}

function parseSensitiveKey(key: string): string[] | null {
  // A wildcard consumes exactly one array index or object key. Unknown selector
  // syntax cannot safely describe what should be hidden, so fail closed.
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < key.length) {
    const segment = key[cursor] === "["
      ? (parts.length ? bracketSegment(key, cursor) : null)
      : nameSegment(key, cursor);
    if (!segment || !canonicalSelectorIndex(segment.part)) return null;
    parts.push(segment.part);
    cursor = segment.next;
  }
  return key.endsWith(".") || parts.length === 0 ? null : parts;
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
    if (!/^(0|[1-9]\d*)$/.test(part)) return false;
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

function opaqueUnknownApproval(manifest: ToolManifest): boolean {
  // An uncontracted action may still be approved as an unknown effect. No
  // argument value can be shown without redaction metadata, so the entire
  // argument object is hidden. A declared target needs a visible preview.
  return manifest.contract.effect === "unknown" && manifest.contract.retry === "never" &&
    manifest.contract.sensitiveKeys.length === 0 && manifest.contract.resources.length === 0;
}

/** Only a current manifest can produce a redacted or opaque approval preview. */
export function approvalPreviewReady(
  manifest: ToolManifest | null | undefined,
  manifestHash: string,
  params: JsonValue,
): boolean {
  if (manifest?.hash !== manifestHash ||
      params === null || typeof params !== "object" || Array.isArray(params)) return false;
  if (opaqueUnknownApproval(manifest)) return true;
  if (manifest.contract.version === "0.0.0" || manifest.contract.sensitiveKeys.length === 0 ||
      manifest.contract.sensitiveKeys.some((key) => !key.trim())) return false;
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
  // With no declared secret fields, the catalog cannot tell us which values
  // are safe to show. Only unknown actions without targets use an opaque path.
  const previewReady = approvalPreviewReady(manifest, approval.manifestHash, approval.params);
  const opaque = manifestCurrent && manifest && opaqueUnknownApproval(manifest);
  return { ...visible,
    action: manifestCurrent && manifest ? manifest.displayName : approval.toolId,
    effect: manifestCurrent && manifest ? manifest.contract.effect : "unknown",
    resources: manifestCurrent && manifest ? manifest.contract.resources : [],
    manifestCurrent,
    previewReady,
    previewMode: previewMode(previewReady, Boolean(opaque)),
    params: previewReady && !opaque ? redact(approval.params, sensitive) : "[REDACTED]",
  };
}

function previewMode(ready: boolean, opaque: boolean): "opaque" | "redacted" | "unavailable" {
  if (!ready) return "unavailable";
  return opaque ? "opaque" : "redacted";
}

/** History omits results; direct execution returns them only to the authenticated actor. */
export function publicReceipt(receipt: ExecutionReceipt, includeResult = true) {
  const { principalKey: _principalKey, providerConnectionId: _providerConnectionId,
    requestHash: _requestHash, idempotencyKey: _idempotencyKey,
    approvalId: _approvalId, ...visible } = receipt;
  return includeResult ? visible : { ...visible, result: null };
}
