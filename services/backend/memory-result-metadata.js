'use strict';

// Canonical persistence allowlist for the sidecar `memory` tool's result
// metadata (row 58). Only these keys survive; the memory text itself never
// does, except the bounded `text_preview` the chat chip shows.
const MEMORY_ACTIONS = new Set(['remember', 'update', 'forget', 'recall', 'list']);
const MEMORY_STATUSES = new Set(['saved', 'pending_approval', 'conflict', 'refused', 'ok']);
const MEMORY_SCOPES = new Set(['project', 'global', 'chat']);
// Who wrote the row: only a background reflection receipt names its origin (W2).
const MEMORY_ORIGINS = new Set(['reflection']);
const MEMORY_KINDS = new Set([
  'preference', 'fact', 'decision', 'convention', 'person', 'routine', 'lesson',
]);
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const REASON_PATTERN = /^[a-z_]{1,64}$/;
const MAX_TEXT_PREVIEW_CHARS = 80;
const MAX_MEMORY_ID = Number.MAX_SAFE_INTEGER;
const { isPlainObject } = require('../value-utils');

function positiveInteger(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_MEMORY_ID ? value : null;
}

function normalizeMemoryResultMetadata(source) {
  try {
    if (!isPlainObject(source) || source.result_kind !== 'memory') return null;
    if (!MEMORY_ACTIONS.has(source.action) || !MEMORY_STATUSES.has(source.status)) return null;
    const normalized = { result_kind: 'memory', action: source.action, status: source.status };
    const memoryId = positiveInteger(source.memory_id);
    const revision = positiveInteger(source.revision);
    if (memoryId !== null) normalized.memory_id = memoryId;
    if (revision !== null) normalized.revision = revision;
    if (typeof source.operation_id === 'string' && OPERATION_ID_PATTERN.test(source.operation_id)) {
      normalized.operation_id = source.operation_id;
    }
    if (MEMORY_SCOPES.has(source.scope)) normalized.scope = source.scope;
    if (MEMORY_KINDS.has(source.kind)) normalized.kind = source.kind;
    if (MEMORY_ORIGINS.has(source.origin)) normalized.origin = source.origin;
    if (typeof source.duplicate === 'boolean') normalized.duplicate = source.duplicate;
    if (typeof source.undoable === 'boolean') normalized.undoable = source.undoable;
    if (typeof source.reason === 'string' && REASON_PATTERN.test(source.reason)) {
      normalized.reason = source.reason;
    }
    if (typeof source.text_preview === 'string' && source.text_preview.trim()) {
      normalized.text_preview = Array.from(source.text_preview.trim())
        .slice(0, MAX_TEXT_PREVIEW_CHARS).join('');
    }
    return normalized;
  } catch (_error) {
    return null;
  }
}

module.exports = { normalizeMemoryResultMetadata };
