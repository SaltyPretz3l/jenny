'use strict';

const {
  isTerminalMessageStatus,
} = require('./active-turn-terminal-evidence');
const FAILURE_RETRY_REASONING_SNAPSHOT_VERSION = 1;
const MAX_FAILURE_RETRY_REASONING_SNAPSHOTS = 4;
const FAILURE_RETRY_REASONING_CAP_CHARS = 48_000;
const FAILED_ASSISTANT_STATUSES = new Set([
  'cancelled',
  'denied',
  'error',
  'errored',
  'failed',
  'interrupted',
  'preempted',
  'runtime_error',
  'timeout',
]);

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

function normalizeReasoningEntry(value, {
  fallbackThinkingId = '',
  fallbackTimestamp = '',
} = {}) {
  if (!isRecord(value)) return null;
  const text = typeof value.text === 'string' ? value.text : '';
  const timestamp = normalizeTimestamp(value.timestamp || fallbackTimestamp);
  if (!text.trim() || !timestamp) return null;
  return {
    id: normalizeId(value.id),
    text,
    thinking_id: normalizeId(value.thinking_id || value.thinkingId || fallbackThinkingId),
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

function isFailedAssistant(message) {
  if (!isRecord(message) || normalizeId(message.role) !== 'assistant') return false;
  const status = normalizeId(message.terminal_status || message.status).toLowerCase();
  return isTerminalMessageStatus(status)
    && (FAILED_ASSISTANT_STATUSES.has(status) || message.retryable === true);
}

function findLatestFailedAssistant(session, userMessageId) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const anchorIndex = messages.findIndex((message) => (
    normalizeId(message?.id) === userMessageId && normalizeId(message?.role) === 'user'
  ));
  if (anchorIndex < 0) return null;
  let latest = null;
  for (let index = anchorIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (normalizeId(message?.role) === 'user') break;
    if (isFailedAssistant(message)) latest = message;
  }
  return latest;
}

function normalizeExtractedEntries(values, optionsForEntry) {
  const normalized = [];
  for (const value of Array.isArray(values) ? values : []) {
    const options = typeof optionsForEntry === 'function' ? optionsForEntry(value) : {};
    const entry = normalizeReasoningEntry(value, options);
    if (entry) normalized.push(entry);
  }
  return mergeReasoningEntriesLatestById(normalized);
}

function extractFailureRetryReasoning(session, userMessageId) {
  const normalizedUserMessageId = normalizeId(userMessageId);
  const assistant = findLatestFailedAssistant(session, normalizedUserMessageId);
  if (!assistant) return { ok: false, reason: 'failed_assistant_missing' };
  const sourceAssistantMessageId = normalizeId(assistant.id);
  const sourceTurnId = normalizeId(
    assistant.parent_stream_id || assistant.stream_id || assistant.turn_id
  ) || sourceAssistantMessageId.replace(/^assistant_/, '');
  if (!sourceAssistantMessageId || !sourceTurnId) {
    return { ok: false, reason: 'failed_assistant_identity_missing' };
  }

  const eventEntries = [];
  for (const event of Array.isArray(session?.turn_events) ? session.turn_events : []) {
    if (
      normalizeId(event?.kind) !== 'reasoning_phase'
      || normalizeId(event?.primary_message_id) !== sourceAssistantMessageId
    ) continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    for (const entry of Array.isArray(payload.entries) ? payload.entries : []) {
      const normalized = normalizeReasoningEntry(entry, {
        fallbackThinkingId: payload.thinking_id,
        fallbackTimestamp: event.completed_at || event.started_at,
      });
      if (normalized) eventEntries.push(normalized);
    }
  }
  const mergedEventEntries = mergeReasoningEntriesLatestById(eventEntries);
  const messageEntries = mergedEventEntries.length ? [] : normalizeExtractedEntries(
    assistant.reasoning?.entries,
    () => ({ fallbackTimestamp: assistant.timestamp })
  );
  return {
    ok: true,
    userMessageId: normalizedUserMessageId,
    sourceAssistantMessageId,
    sourceTurnId,
    entries: mergedEventEntries.length ? mergedEventEntries : messageEntries,
    source: mergedEventEntries.length ? 'events' : 'message',
  };
}

function persistSnapshotMap(store, sessionId, snapshots) {
  const updated = store._updateSessionRecord(sessionId, {
    failure_retry_reasoning_snapshots: snapshots,
  }, { bumpUpdatedAt: false });
  if (!updated) return { ok: false, reason: 'snapshot_write_refused' };
  if (store.flushSession(sessionId) !== true) {
    return { ok: false, reason: 'snapshot_flush_refused' };
  }
  return { ok: true };
}

function captureFailureRetryReasoning(store, sessionId, userMessageId) {
  const normalizedSessionId = normalizeId(sessionId);
  const normalizedUserMessageId = normalizeId(userMessageId);
  const session = store.getSession(normalizedSessionId);
  if (!session || !normalizedUserMessageId) {
    return { ok: false, reason: 'snapshot_target_missing' };
  }
  const current = normalizeFailureRetryReasoningSnapshots(
    session.failure_retry_reasoning_snapshots
  );
  const extracted = extractFailureRetryReasoning(session, normalizedUserMessageId);
  if (!extracted.ok) return extracted;
  if (!extracted.entries.length) {
    if (!Object.hasOwn(current, normalizedUserMessageId)) {
      return { ok: true, captured: false, removed: false, entryCount: 0,
        charCount: 0, truncated: false, evictionCount: 0 };
    }
    const next = { ...current };
    delete next[normalizedUserMessageId];
    const persisted = persistSnapshotMap(store, normalizedSessionId, next);
    return persisted.ok
      ? { ok: true, captured: false, removed: true, entryCount: 0,
          charCount: 0, truncated: false, evictionCount: 0 }
      : persisted;
  }

  const capChars = resolveReasoningCap();
  const bounded = capReasoningEntriesNewestTail(extracted.entries, capChars);
  const candidate = {
    ...current,
    [normalizedUserMessageId]: {
      version: FAILURE_RETRY_REASONING_SNAPSHOT_VERSION,
      user_message_id: normalizedUserMessageId,
      source_assistant_message_id: extracted.sourceAssistantMessageId,
      source_turn_id: extracted.sourceTurnId,
      captured_at: new Date().toISOString(),
      cap_chars: capChars,
      char_count: bounded.charCount,
      truncated: bounded.truncated,
      reasoning_entries: bounded.entries,
    },
  };
  const next = normalizeFailureRetryReasoningSnapshots(candidate);
  const evictionCount = Math.max(Object.keys(candidate).length - Object.keys(next).length, 0);
  const snapshot = next[normalizedUserMessageId];
  if (!snapshot) return { ok: false, reason: 'snapshot_normalization_failed' };
  const persisted = persistSnapshotMap(store, normalizedSessionId, next);
  if (!persisted.ok) return persisted;
  return {
    ok: true,
    captured: true,
    removed: false,
    entryCount: snapshot.reasoning_entries.length,
    charCount: snapshot.char_count,
    truncated: snapshot.truncated,
    evictionCount,
  };
}

function captureFailureRetryReasoningAtReservation({
  store,
  identity,
  userMessageId,
  log,
} = {}) {
  let result;
  try {
    result = store.captureFailureRetryReasoning(identity.sessionId, userMessageId);
  } catch (_error) {
    result = { ok: false, reason: 'snapshot_capture_exception' };
  }
  if (!result?.ok) {
    if (['failed_assistant_missing', 'failed_assistant_identity_missing'].includes(result?.reason)) {
      return result;
    }
    const reason = ['snapshot_write_refused', 'snapshot_flush_refused',
      'snapshot_normalization_failed', 'snapshot_capture_exception'].includes(result?.reason)
      ? result.reason : 'snapshot_capture_failed';
    log?.('WARN', 'chat.failure_retry_reasoning_snapshot_failed', {
      sessionId: identity.sessionId,
      streamId: identity.streamId,
      userMessageId,
      reason,
    });
  } else if (result.captured || result.removed) {
    log?.('INFO', 'chat.failure_retry_reasoning_snapshot_captured', {
      sessionId: identity.sessionId,
      streamId: identity.streamId,
      userMessageId,
      entryCount: result.entryCount,
      charCount: result.charCount,
      truncated: result.truncated === true,
      evictionCount: result.evictionCount,
    });
  }
  return result;
}

module.exports = {
  FAILURE_RETRY_REASONING_CAP_CHARS,
  FAILURE_RETRY_REASONING_SNAPSHOT_VERSION,
  MAX_FAILURE_RETRY_REASONING_SNAPSHOTS,
  capReasoningEntriesNewestTail,
  captureFailureRetryReasoning,
  captureFailureRetryReasoningAtReservation,
  extractFailureRetryReasoning,
  mergeReasoningEntriesLatestById,
  normalizeFailureRetryReasoningSnapshot,
  normalizeFailureRetryReasoningSnapshots,
};
