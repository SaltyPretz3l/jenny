'use strict';

// Legacy normalization for `failure_retry_reasoning_snapshots` (session schema
// v22). The capture that wrote this field and its `failure_retry_reasoning_carry`
// flag were deleted (owner, 2026-10-05) because the replay half was never built.
// Nothing writes or reads the field any more; sessions saved while the flag was
// on keep their bounded, normalized map so they load and round-trip unchanged.
const FAILURE_RETRY_REASONING_SNAPSHOT_VERSION = 1;
const MAX_FAILURE_RETRY_REASONING_SNAPSHOTS = 4;

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveReasoningCap(thinkingBudgetChars) {
  return require('./chat-stream-reasoning-delta')
    .resolvePersistedReasoningCap(thinkingBudgetChars);
}

function normalizeTimestamp(value) {
  const timestamp = normalizeId(value);
  if (!timestamp) return '';
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function normalizeReasoningEntry(value) {
  if (!isRecord(value)) return null;
  const text = typeof value.text === 'string' ? value.text : '';
  const timestamp = normalizeTimestamp(value.timestamp);
  if (!text.trim() || !timestamp) return null;
  return {
    id: normalizeId(value.id),
    text,
    thinking_id: normalizeId(value.thinking_id || value.thinkingId),
    timestamp,
  };
}

function mergeReasoningEntriesLatestById(entries) {
  const merged = [];
  const indexById = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = normalizeId(entry?.id);
    if (id && indexById.has(id)) {
      merged[indexById.get(id)] = entry;
      continue;
    }
    if (id) indexById.set(id, merged.length);
    merged.push(entry);
  }
  return merged;
}

function capReasoningEntriesNewestTail(entries, capChars) {
  const cap = Number(capChars);
  const retained = (Array.isArray(entries) ? entries : []).map((entry) => ({ ...entry }));
  let charCount = retained.reduce((sum, entry) => sum + String(entry?.text || '').length, 0);
  let truncated = false;
  while (
    charCount > cap
    && retained.length > 1
    && charCount - retained[0].text.length >= cap
  ) {
    charCount -= retained.shift().text.length;
    truncated = true;
  }
  if (charCount > cap && retained.length) {
    retained[0].text = retained[0].text.slice(charCount - cap);
    charCount = cap;
    truncated = true;
  }
  return { entries: retained, charCount, truncated };
}

function normalizeFailureRetryReasoningSnapshot(mapKey, value) {
  if (!isRecord(value)) return null;
  const userMessageId = normalizeId(value.user_message_id);
  const sourceAssistantMessageId = normalizeId(value.source_assistant_message_id);
  const sourceTurnId = normalizeId(value.source_turn_id);
  const capturedAt = normalizeTimestamp(value.captured_at);
  const capChars = value.cap_chars;
  if (
    value.version !== FAILURE_RETRY_REASONING_SNAPSHOT_VERSION
    || !normalizeId(mapKey)
    || userMessageId !== normalizeId(mapKey)
    || !sourceAssistantMessageId
    || !sourceTurnId
    || !capturedAt
    || !Number.isSafeInteger(capChars)
    || capChars <= 0
    || capChars > resolveReasoningCap(131_072)
    || !Array.isArray(value.reasoning_entries)
    || value.reasoning_entries.length === 0
  ) return null;

  const entries = [];
  for (const entry of value.reasoning_entries) {
    const normalized = normalizeReasoningEntry(entry);
    if (!normalized) return null;
    entries.push(normalized);
  }
  const merged = mergeReasoningEntriesLatestById(entries);
  const bounded = capReasoningEntriesNewestTail(merged, capChars);
  // Reapply entry admission after tail capping so whitespace-only tails drop idempotently.
  const retainedEntries = bounded.entries
    .map((entry) => normalizeReasoningEntry(entry))
    .filter(Boolean);
  const charCount = retainedEntries.reduce((sum, entry) => sum + entry.text.length, 0);
  if (!retainedEntries.length || charCount <= 0) return null;
  return {
    version: FAILURE_RETRY_REASONING_SNAPSHOT_VERSION,
    user_message_id: userMessageId,
    source_assistant_message_id: sourceAssistantMessageId,
    source_turn_id: sourceTurnId,
    captured_at: capturedAt,
    cap_chars: capChars,
    char_count: charCount,
    truncated: value.truncated === true || bounded.truncated,
    reasoning_entries: retainedEntries,
  };
}

function compareSnapshotAge([leftKey, left], [rightKey, right]) {
  return left.captured_at.localeCompare(right.captured_at)
    || left.source_turn_id.localeCompare(right.source_turn_id)
    || leftKey.localeCompare(rightKey);
}

function normalizeFailureRetryReasoningSnapshots(value) {
  const source = isRecord(value) ? value : {};
  const valid = Object.entries(source)
    .map(([key, record]) => [normalizeId(key), normalizeFailureRetryReasoningSnapshot(key, record)])
    .filter(([key, record]) => Boolean(key && record));
  const evictedKeys = new Set(
    [...valid]
      .sort(compareSnapshotAge)
      .slice(0, Math.max(valid.length - MAX_FAILURE_RETRY_REASONING_SNAPSHOTS, 0))
      .map(([key]) => key)
  );
  return Object.fromEntries(valid.filter(([key]) => !evictedKeys.has(key)));
}

module.exports = {
  normalizeFailureRetryReasoningSnapshots,
};
