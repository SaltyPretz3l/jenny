'use strict';

// The bounded copy stored tool-result metadata goes through (tool review,
// 2026-10-19): an arbitrary sidecar key cannot carry megabytes, hundreds of
// keys or a deep object into the session message and the live event.

// Keys the structured normalizers own (re-added in their bounded shape).
const STRUCTURED_STORAGE_KEYS = new Set([
  'execution', 'calendar', 'calendar_receipt', 'diff', 'diffs', 'patch', 'files',
  'subagent_report', 'subagent_batch_report', 'workspace_change_set', 'scripted_change_review',
]);
// Prototype-polluting keys; the Electron tool bridge drops the same set.
const FORBIDDEN_STORAGE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_STORAGE_METADATA_DEPTH = 8;
const MAX_STORAGE_METADATA_ITEMS = 100;
const MAX_STORAGE_METADATA_STRING_CHARS = 64 * 1024;
// Copied first, so a result with more keys than the cap never drops the ones
// the renderer and the failure taxonomy read.
const PRIORITY_STORAGE_KEYS = [
  'effects', 'failure_class', 'error_code', 'error_details', 'result_kind', 'trace_id', 'monitor',
];

// Depth, item count and string length are capped; `undefined` means "drop".
function boundedStorageMetadataValue(value, depth) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    return value.length > MAX_STORAGE_METADATA_STRING_CHARS
      ? value.slice(0, MAX_STORAGE_METADATA_STRING_CHARS)
      : value;
  }
  if (typeof value !== 'object') return undefined;
  if (depth >= MAX_STORAGE_METADATA_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_STORAGE_METADATA_ITEMS)
      .map((entry) => boundedStorageMetadataValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  const copy = {};
  let count = 0;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_STORAGE_KEYS.has(key)) continue;
    if (count >= MAX_STORAGE_METADATA_ITEMS) break;
    const bounded = boundedStorageMetadataValue(value[key], depth + 1);
    if (bounded === undefined) continue;
    copy[key] = bounded;
    count += 1;
  }
  return copy;
}

// The untyped remainder of `source`: structured and prototype keys skipped,
// every kept value bounded, at most MAX_STORAGE_METADATA_ITEMS keys.
function boundedUntypedStorageMetadata(source) {
  const result = {};
  let count = 0;
  const ordered = [
    ...PRIORITY_STORAGE_KEYS.filter((key) => Object.hasOwn(source, key)),
    ...Object.keys(source).filter((key) => !PRIORITY_STORAGE_KEYS.includes(key)),
  ];
  for (const key of ordered) {
    if (STRUCTURED_STORAGE_KEYS.has(key) || FORBIDDEN_STORAGE_KEYS.has(key)) continue;
    if (count >= MAX_STORAGE_METADATA_ITEMS) break;
    const bounded = boundedStorageMetadataValue(source[key], 1);
    if (bounded === undefined) continue;
    result[key] = bounded;
    count += 1;
  }
  return result;
}

module.exports = {
  FORBIDDEN_STORAGE_KEYS,
  MAX_STORAGE_METADATA_DEPTH,
  boundedStorageMetadataValue,
  boundedUntypedStorageMetadata,
};
