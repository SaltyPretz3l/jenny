'use strict';

// Off-turn transcript append (agentic memory v2, row 58 W2). Background work
// (a reflection receipt) adds messages to the canonical store outside any live
// turn. Unlike appendMessage(), it does not clear the composer draft or bump
// the chat's recency (a note is not activity), and it never interleaves with
// a live turn's own messages.

const { normalizeMessage } = require('./electron-session-store');

function appendOffTurnMessages(store, sessionId, messages) {
  const session = store?.getSession?.(sessionId);
  if (!session) return { ok: false, reason: 'session_missing', appended: 0 };
  if (session.active_turn) return { ok: false, reason: 'turn_active', appended: 0 };
  const ids = new Set(session.messages.map(message => String(message?.id || '')));
  // The same ordering anchor appendMessage() assigns (see its comment).
  let seq = Math.max(Number(session.message_seq_counter) || 0, session.messages.length);
  const appended = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const id = String(message?.id || '').trim();
    if (!id || ids.has(id)) continue;
    const normalized = normalizeMessage({ ...message, event_seq: seq }, session.last_model_used || '');
    if (!normalized) continue;
    ids.add(id);
    appended.push(normalized);
    seq += 1;
  }
  if (!appended.length) return { ok: true, appended: 0 };
  const next = [...session.messages, ...appended];
  // The store's own non-bumping mutation path (as setCompactionSnapshot uses).
  const summary = store._updateSessionRecord(sessionId, {
    messages: next,
    message_count: next.length,
    message_seq_counter: seq,
  }, { bumpUpdatedAt: false });
  return summary ? { ok: true, appended: appended.length } : { ok: false, reason: 'write_refused', appended: 0 };
}

module.exports = { appendOffTurnMessages };
