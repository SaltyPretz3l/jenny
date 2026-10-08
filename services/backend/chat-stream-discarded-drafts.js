'use strict';

// Metadata-only receipt of reply drafts the sidecar's tool loop discarded
// (chat.stream_reset) during a turn. Never carries the discarded text.

const REASON_MAX = 64;

function normalizeReason(reason) {
  return String(reason || '').trim().slice(0, REASON_MAX) || 'unknown';
}

function noteDiscardedDraft(current, reason) {
  return { count: (current?.count || 0) + 1, latest_reason: normalizeReason(reason) };
}

function normalizeDiscardedDrafts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Number.isInteger(value.count) || value.count < 1) return null;
  if (typeof value.latest_reason !== 'string') return null;
  return { count: value.count, latest_reason: normalizeReason(value.latest_reason) };
}

// Terminal assistant-message fields shared by every final-message write.
function buildTerminalMessageExtras({ resumableStop, discardedDrafts } = {}) {
  const drafts = normalizeDiscardedDrafts(discardedDrafts);
  return {
    ...(resumableStop ? { resumable_stop: resumableStop } : {}),
    ...(drafts ? { discarded_drafts: drafts } : {}),
  };
}

// No text-bearing final assistant message was written (empty or reasoning-only
// trailing slice): attach the receipt to the last persisted segment that has
// text, since the receipt renders under an assistant text row.
function patchLastSegmentDiscardedDrafts(store, sessionId, segmentIds, discardedDrafts) {
  const drafts = normalizeDiscardedDrafts(discardedDrafts);
  const ids = Array.isArray(segmentIds) ? segmentIds : [];
  if (!drafts || !ids.length || typeof store?.updateMessage !== 'function') return;
  const messages = typeof store.getSessionMessages === 'function' ? store.getSessionMessages(sessionId) : null;
  const contentById = new Map((Array.isArray(messages) ? messages : []).map((message) => [message?.id, message?.content]));
  const targetId = Array.isArray(messages)
    ? [...ids].reverse().find((id) => String(contentById.get(id) || '').trim())
    : ids[ids.length - 1];
  if (targetId) store.updateMessage(sessionId, targetId, { discarded_drafts: drafts });
}

module.exports = {
  noteDiscardedDraft,
  normalizeDiscardedDrafts,
  buildTerminalMessageExtras,
  patchLastSegmentDiscardedDrafts,
};
