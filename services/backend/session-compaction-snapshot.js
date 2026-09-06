'use strict';

const { createHash } = require('node:crypto');
const { estimateMessagesTokens } = require('./context-budget-trimmer');

// Electron-owned compaction snapshot (JCA-003).
//
// A successful Settings "Compact now" run (sidecar chat.compact) returns the
// compacted replacement history. Electron persists it on the session record as
// `compaction_snapshot` — a versioned, self-invalidating substitute for the
// canonical-history PREFIX it summarized:
//
//   {
//     version: 2,
//     origin: 'manual' | 'automatic',
//     created_at: ISO timestamp,
//     strategy: 'full' | 'micro',
//     tokens_before / tokens_after: sidecar-estimated token counts,
//     replacement_tokens: deterministic estimate of replacement messages only,
//     boundary_message_id: id of the LAST canonical message the compaction saw,
//     boundary_message_count: how many canonical messages it saw,
//     messages: [{ role, content }, ...] replacement for that prefix,
//   }
//
// Consumption contract (applyCompactionSnapshotToHistory): on chat.send, the
// canonical prefix [0, boundary_message_count) is replaced by the snapshot's
// messages; canonical messages appended after the compaction pass ride along
// unchanged. The snapshot is valid only while that prefix is untouched —
// checked by (count, last-id) — so truncate/edit/branch flows that rewrite
// history fail the check and the send falls back to full canonical history.
// The store additionally invalidates eagerly on those mutations (see
// electron-session-store.js) so a stale snapshot never lingers on disk.

const COMPACTION_SNAPSHOT_VERSION = 2;
const COMPACTION_SNAPSHOT_STRATEGIES = new Set(['full', 'micro']);
const COMPACTION_MESSAGE_ROLES = new Set(['system', 'user', 'assistant']);
const COMPACTION_SNAPSHOT_ORIGINS = new Set(['manual', 'automatic']);
const COMPACTION_SNAPSHOT_MAX_MESSAGES = 64;
const COMPACTION_SNAPSHOT_MAX_BYTES = 512 * 1024;
// The sidecar caps the summary BODY at 64 KiB and the persisted row adds a ~120-byte heading, so 64 KiB here silently dropped maximal summaries.
const COMPACTION_SNAPSHOT_MESSAGE_MAX_BYTES = 65 * 1024;
const COMPACTION_SUMMARY_HEADING = '## Compacted Conversation Summary';
const COMPACTION_CREATED_AT_MAX_CHARS = 64;

function normalizeCompactionSnapshotMessage(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const role = String(entry.role || '').trim();
  if (!COMPACTION_MESSAGE_ROLES.has(role)) {
    return null;
  }
  const content = String(entry.content || '');
  if (Buffer.byteLength(content, 'utf8') > COMPACTION_SNAPSHOT_MESSAGE_MAX_BYTES) {
    return null;
  }
  return { role, content };
}

function isCompactionSummaryMessage(message) {
  return message?.role === 'system'
    && String(message?.content || '').trim().startsWith(COMPACTION_SUMMARY_HEADING);
}

function normalizeNonNegativeInt(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

// Fail-closed: anything malformed — wrong version, unknown strategy, empty or
// non-message replacement list, missing boundary — normalizes to null, which
// downstream reads as "no snapshot" (full canonical history). A future-version
// snapshot from a newer build is dropped rather than misread.
function normalizeCompactionSnapshot(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!source) {
    return null;
  }
  const sourceVersion = Number(source.version);
  if (sourceVersion !== 1 && sourceVersion !== COMPACTION_SNAPSHOT_VERSION) {
    return null;
  }
  const origin = sourceVersion === 1
    ? 'manual'
    : String(source.origin || '').trim().toLowerCase();
  if (!COMPACTION_SNAPSHOT_ORIGINS.has(origin)) {
    return null;
  }
  const strategy = String(source.strategy || '').trim();
  if (!COMPACTION_SNAPSHOT_STRATEGIES.has(strategy)) {
    return null;
  }
  const boundaryMessageId = String(source.boundary_message_id || '').trim();
  const boundaryMessageCount = normalizeNonNegativeInt(source.boundary_message_count);
  if (!boundaryMessageId || !boundaryMessageCount) {
    return null;
  }
  const messages = Array.isArray(source.messages)
    ? source.messages.map(normalizeCompactionSnapshotMessage).filter(Boolean)
    : [];
  if (
    !messages.length
    || messages.length > COMPACTION_SNAPSHOT_MAX_MESSAGES
    || messages.length !== source.messages.length
    || !messages.some((message) => message.content.trim())
    || messages.reduce((total, message) => total + Buffer.byteLength(message.content, 'utf8'), 0)
      > COMPACTION_SNAPSHOT_MAX_BYTES
  ) {
    return null;
  }
  const summaryMessageCount = messages.filter(isCompactionSummaryMessage).length;
  if (summaryMessageCount > 1) {
    return null;
  }
  if (origin === 'automatic' && (
    strategy !== 'full'
    || (messages.length !== 1 && messages.length !== 2)
    || !isCompactionSummaryMessage(messages[0])
    || (messages.length === 2 && messages[1].role !== 'user')
  )) {
    return null;
  }
  return {
    version: COMPACTION_SNAPSHOT_VERSION,
    origin,
    created_at: String(source.created_at || '').trim().slice(0, COMPACTION_CREATED_AT_MAX_CHARS),
    strategy,
    tokens_before: normalizeNonNegativeInt(source.tokens_before) ?? 0,
    tokens_after: normalizeNonNegativeInt(source.tokens_after) ?? 0,
    replacement_tokens: estimateMessagesTokens(messages),
    boundary_message_id: boundaryMessageId,
    boundary_message_count: boundaryMessageCount,
    messages,
  };
}

// Renderer-safe projection used by SessionSummary. It deliberately omits the
// replacement messages and boundary id: the composer meter needs only bounded
// token/boundary metadata to estimate compacted history after a reload.
function summarizeCompactionSnapshot(value) {
  const snapshot = normalizeCompactionSnapshot(value);
  if (!snapshot) return null;
  return {
    version: snapshot.version,
    origin: snapshot.origin,
    created_at: snapshot.created_at,
    strategy: snapshot.strategy,
    tokens_before: snapshot.tokens_before,
    tokens_after: snapshot.tokens_after,
    replacement_tokens: snapshot.replacement_tokens,
    boundary_message_count: snapshot.boundary_message_count,
  };
}

// Builds the persistable snapshot from a chat.compact ok-result plus the
// boundary captured from the canonical history that was sent to the sidecar.
// Returns null when the result does not carry a usable compaction.
function buildCompactionSnapshotFromResult(result, {
  boundaryMessageId,
  boundaryMessageCount,
  createdAt = new Date().toISOString(),
} = {}) {
  if (String(result?.status || '') !== 'ok' || result?.compacted !== true) {
    return null;
  }
  return normalizeCompactionSnapshot({
    version: COMPACTION_SNAPSHOT_VERSION,
    origin: 'manual',
    created_at: createdAt,
    strategy: result.strategy,
    tokens_before: result.tokens_before,
    tokens_after: result.tokens_after,
    boundary_message_id: boundaryMessageId,
    boundary_message_count: boundaryMessageCount,
    messages: result.messages,
  });
}

function buildAutomaticCompactionSnapshot({
  summaryMessage,
  taskMessage = null,
  tokensBefore,
  tokensAfter,
  boundaryMessageId,
  boundaryMessageCount,
  createdAt = new Date().toISOString(),
} = {}) {
  return normalizeCompactionSnapshot({
    version: COMPACTION_SNAPSHOT_VERSION,
    origin: 'automatic',
    created_at: createdAt,
    strategy: 'full',
    tokens_before: tokensBefore,
    tokens_after: tokensAfter,
    boundary_message_id: boundaryMessageId,
    boundary_message_count: boundaryMessageCount,
    messages: taskMessage == null ? [summaryMessage] : [summaryMessage, taskMessage],
  });
}

// The (count, last-id) boundary check cannot see an in-place edit that
// preserves ids and count. Callers fingerprint the exact prefix content handed
// to chat.compact and compare after the RPC returns, refusing to persist a
// summary of history that changed while summarization ran.
function fingerprintCompactionPrefix(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const semanticRows = list.map((message) => ({
    id: String(message?.id || ''),
    role: String(message?.role || ''),
    kind: String(message?.kind || ''),
    content: message?.content ?? '',
    tool_call: message?.tool_call ?? null,
    tool_result: message?.tool_result ?? null,
    interactive_batch: message?.interactive_batch ?? null,
    interactive_round_recap: message?.interactive_round_recap ?? null,
  }));
  return createHash('sha256').update(JSON.stringify(semanticRows), 'utf8').digest('hex');
}

// True while the canonical prefix the snapshot summarized is untouched: the
// history still has at least boundary_message_count messages and the message
// AT the boundary is still the one the compaction saw. New messages appended
// after the boundary keep the snapshot valid; truncation, edit-and-resend,
// wholesale replacement, and branching (which remints ids) all break it.
function isCompactionSnapshotCompatible(snapshot, messages) {
  const normalized = normalizeCompactionSnapshot(snapshot);
  if (!normalized || !Array.isArray(messages)) {
    return false;
  }
  if (messages.length < normalized.boundary_message_count) {
    return false;
  }
  const boundaryMessage = messages[normalized.boundary_message_count - 1];
  return String(boundaryMessage?.id || '') === normalized.boundary_message_id;
}

// Store-mutation helper: the snapshot value a messages rewrite should persist —
// the snapshot itself while the prefix survives the rewrite, null otherwise.
function retainCompactionSnapshotForMessages(snapshot, nextMessages) {
  const normalized = normalizeCompactionSnapshot(snapshot);
  if (!normalized) {
    return null;
  }
  return isCompactionSnapshotCompatible(normalized, nextMessages) ? normalized : null;
}

// Substitutes the snapshot for the canonical prefix it covers. Never throws;
// on any mismatch returns the input history untouched with applied=false so
// the send degrades to full canonical history.
function applyCompactionSnapshotToHistory(snapshot, messages) {
  const history = Array.isArray(messages) ? messages : [];
  const normalized = normalizeCompactionSnapshot(snapshot);
  if (!normalized) {
    return { applied: false, reason: 'no_snapshot', messages: history };
  }
  if (!isCompactionSnapshotCompatible(normalized, history)) {
    return { applied: false, reason: 'boundary_mismatch', messages: history };
  }
  return {
    applied: true,
    reason: '',
    replacedCount: normalized.boundary_message_count,
    messages: [
      ...normalized.messages.map((message) => ({ ...message })),
      ...history.slice(normalized.boundary_message_count),
    ],
  };
}

// chat.send seam (managed-sidecar-chat.js): resolves the session's persisted
// snapshot, applies it to the prompt history, and lazily clears a snapshot the
// prefix check proves stale (defense-in-depth behind the store's eager
// invalidation). Manual and automatic snapshots retain independent internal
// rollback switches, so disabling either producer also disables its persisted
// output without invalidating the other contract.
function applyCompactionSnapshotForChatSend(service, sessionId, canonicalMessages) {
  const history = Array.isArray(canonicalMessages) ? canonicalMessages : [];
  try {
    const session = service?.sessionStore?.peekSession?.(sessionId);
    const snapshot = normalizeCompactionSnapshot(session?.compaction_snapshot);
    if (!snapshot) {
      return { applied: false, messages: history };
    }
    const enabled = snapshot.origin === 'automatic'
      ? service?.featureFlags?.context_compaction === true
      : service?.featureFlags?.compaction_manual === true;
    if (!enabled) {
      return { applied: false, messages: history };
    }
    const result = applyCompactionSnapshotToHistory(snapshot, history);
    if (!result.applied) {
      service.sessionStore?.setCompactionSnapshot?.(sessionId, null);
      service._emitServiceLog?.('WARN', 'chat.compaction_snapshot_invalidated', {
        sessionId: String(sessionId || ''),
        reason: result.reason,
      });
      return { applied: false, messages: history };
    }
    service._emitServiceLog?.('INFO', 'chat.compaction_snapshot_applied', {
      sessionId: String(sessionId || ''),
      strategy: snapshot.strategy,
      origin: snapshot.origin,
      replaced_message_count: result.replacedCount,
      snapshot_message_count: snapshot.messages.length,
      trailing_message_count: history.length - result.replacedCount,
    });
    return { applied: true, messages: result.messages };
  } catch (_error) {
    try {
      service?._emitServiceLog?.('WARN', 'chat.compaction_snapshot_apply_failed', {
        sessionId: String(sessionId || ''),
        reason: 'apply_exception',
      });
    } catch (_logError) {
      // Snapshot failures remain fail-open even if diagnostics are unavailable.
    }
    return { applied: false, messages: history };
  }
}

module.exports = {
  applyCompactionSnapshotForChatSend,
  applyCompactionSnapshotToHistory,
  buildAutomaticCompactionSnapshot,
  buildCompactionSnapshotFromResult,
  fingerprintCompactionPrefix,
  normalizeCompactionSnapshot,
  retainCompactionSnapshotForMessages,
  summarizeCompactionSnapshot,
};
