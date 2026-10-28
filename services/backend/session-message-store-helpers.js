'use strict';

// Pure helpers split out of ElectronSessionStore (row 59 checkpoint 4, slice S1) so the
// hot store file stays under its size ceiling: the insertMessagesBefore plan (addressed
// context rows go in just before the turn's user anchor) and the transcript preview rule
// that keeps `role:'context'` rows out of `last_message_preview`.

const { anyContextRowsEquivalent, validateAnyContextRow } = require('./session-handoff-context');
const { summarizeMessage } = require('./session-store-migrations');

// Context rows (addressed messages and discard receipts) never become the chat preview.
const previewOfMessage = (message) => (message?.role === 'context' ? '' : summarizeMessage(message));

function previewOfLast(messages) {
  for (let index = (messages?.length || 0) - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'context') return summarizeMessage(messages[index]);
  }
  return '';
}

const eventSeqOf = (message) => (Number.isInteger(message?.event_seq) && message.event_seq >= 0 ? message.event_seq : null);

// null when the request is invalid or conflicts (anchor not the last user message, a row id
// reused with different content, an invalid row); {patch:null} when every row is already
// present (idempotent); else {patch} for the session update. `normalizeRow` is the store's
// message normalizer. Inserted rows take event_seq values from the anchor's old seq upward
// and the anchor is re-stamped after them, so the row order and the seq order agree.
// A failure retry keeps its failed attempt after the anchor (preserveSupersededTurn): when every
// row after the last user anchor belongs to another turn, the rows go after that superseded tail
// at fresh seqs instead (re-stamping the anchor past it would break the seq order), so the retried
// turn reads anchor, failed attempt, mail, reply.
function planInsertBefore(session, anchorMessageId, rows, normalizeRow) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const anchorId = String(anchorMessageId || '').trim();
  const anchorIndex = messages.findIndex((message) => String(message?.id || '') === anchorId);
  const anchor = messages[anchorIndex];
  if (!anchorId || !anchor || anchor.role !== 'user') return null;
  if (messages.filter((message) => String(message?.id || '') === anchorId).length !== 1) return null;
  const tail = messages.slice(anchorIndex + 1);
  if (tail.some((message) => message?.role === 'user' || !message?.turn_id || message.turn_id === anchor.turn_id)) return null;
  if (!Array.isArray(rows) || rows.some((row) => !validateAnyContextRow(row))) return null;
  const ids = new Set();
  const fresh = [];
  for (const row of rows) {
    if (ids.has(row.id)) return null;
    ids.add(row.id);
    const matches = messages.filter((message) => String(message?.id || '') === row.id);
    if (matches.length > 1 || (matches.length === 1 && !anyContextRowsEquivalent(matches[0], row))) return null;
    if (!matches.length) fresh.push(row);
  }
  if (!fresh.length) return { patch: null };
  if (tail.length) {
    const appendSeq = Math.max(Number(session.message_seq_counter) || 0, messages.length);
    const appended = fresh.map((row, index) => normalizeRow({ ...row, event_seq: appendSeq + index }));
    if (appended.includes(null)) return null;
    const next = [...messages, ...appended];
    return { patch: { messages: next, message_count: next.length, message_seq_counter: appendSeq + appended.length } };
  }
  const startSeq = eventSeqOf(anchor) ?? messages.length - 1;
  const inserted = fresh.map((row, index) => normalizeRow({ ...row, event_seq: startSeq + index }));
  if (inserted.includes(null)) return null;
  const anchorSeq = startSeq + inserted.length;
  const next = [...messages.slice(0, -1), ...inserted, { ...anchor, event_seq: anchorSeq }];
  return {
    patch: {
      messages: next,
      message_count: next.length,
      message_seq_counter: Math.max(Number(session.message_seq_counter) || 0, anchorSeq + 1),
    },
  };
}

module.exports = { planInsertBefore, previewOfLast, previewOfMessage };
