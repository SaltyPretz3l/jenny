'use strict';

// The chat outbox of one team (slice 2a-4b, TEAM_CHAT_SPEC "Resume after a
// disconnect" step 5). Unsent chat mutations (post, edit, delete) wait here in
// order, each with one request id for its whole life, and send one at a time
// after a sync. A retry reuses the entry's request id: the host's chat store
// answers a repeat from its idempotency record, so a post that committed before
// its answer was lost is never doubled. That is safe only for team.chat.*
// mutations, so nothing else can enter (OUTBOX_OPERATIONS) or be resent.
//
// Answers: success removes the entry; `team_chat_rate_limit` and `disk_pressure`
// (and any answer the host marks retryable) hold the outbox under a bounded
// backoff; a lost answer, the host shutting down (`team_unavailable`) or no
// connection hold it until the next sync (with the backoff as a fallback); any
// other refusal, including the connection's own refusals that a retry cannot
// change (a request over the 64 KiB cap, an invalid request), fails that entry,
// which stays (with its reason) until the user discards it, and the entries
// after it go on. An entry whose request would not fit the cap is refused when
// queued. An entry already sent once is failed instead of resent after 23
// hours, inside the host's 24-hour idempotency window. Every change is written
// to client.json at once; an answer is settled (and pushed) only once the write
// that removes or fails its entry succeeded, else the outbox holds and the
// retry reuses the request id.
//
// A reaction or pin raises a message's revision, so an edit queued at the older one answers
// team_chat_stale. When an edit is queued, the cached record's `edited_at` is remembered (in memory, only while the
// cached revision is the one the edit names). If that edit answers team_chat_stale, `reconcile` syncs the channel once;
// when the record is still there, not deleted, and still has that `edited_at` (so only marks moved the revision), the
// edit is sent once more with the record's current revision under a new request id, which is stored first. Anything
// else, and any edit queued before a restart, fails team_chat_stale as before: an edit is never sent over a text
// change the editor has not seen.

const crypto = require('node:crypto');

const { isMessageId, isPositive } = require('../host/team-chat-schema');
const { OUTBOX_MAX, OUTBOX_OPERATIONS, fitsRequest, isOutboxEntry } = require('./chat-shapes');
const { CODE, REASON, chatFailure, invalidRequest } = require('./team-errors');

const DEFAULT_BACKOFF = Object.freeze({ initialMs: 1000, maxMs: 60_000 });
const LATER_REASONS = new Set(['team_chat_rate_limit', 'disk_pressure']);
const CONNECTION_REASONS = new Set(['team_unavailable', 'member_revoked']);
// The connection's own refusals (services/team/http-client.js, connection-manager.js) that a retry cannot change.
const LOCAL_PERMANENT_REASONS = new Set(['team_request_too_large', 'team_request_invalid', 'team_request_id_invalid',
  'team_path_invalid', 'team_response_too_large', 'team_response_invalid']);
const RESEND_WINDOW_MS = 23 * 60 * 60 * 1000;
const PUBLIC_OPERATIONS = Object.freeze({ 'team.chat.post': 'post', 'team.chat.edit': 'edit', 'team.chat.delete': 'delete' });

const newId = (prefix) => `${prefix}${crypto.randomBytes(18).toString('base64url')}`;

// 'done', 'later' (backoff), 'connection' (until the next sync) or 'failed'.
function classify(answer) {
  if (answer && answer.ok === true) return 'done';
  const error = answer && typeof answer.error === 'object' && answer.error ? answer.error : {};
  if (error.code === 'invalid_request') return 'failed';
  if (LATER_REASONS.has(error.reason)) return 'later';
  if (LOCAL_PERMANENT_REASONS.has(error.reason)) return 'failed';
  if (CONNECTION_REASONS.has(error.reason) || (typeof error.code === 'string' && error.code.startsWith('CMP-TEAM-'))) {
    return 'connection';
  }
  return error.retryable === true ? 'later' : 'failed';
}

/** The renderer's view of an entry: never the request id. */
function publicEntry(entry) {
  return {
    entry_id: entry.entry_id, operation: PUBLIC_OPERATIONS[entry.operation], channel_id: entry.params.channel_id,
    thread_root_id: entry.params.thread_root_id || null, message_id: entry.params.message_id || null,
    text: typeof entry.params.text === 'string' ? entry.params.text : null, created_at: entry.created_at,
    state: entry.failed ? 'failed' : 'queued', error: entry.failed ? { ...entry.failed } : null,
  };
}

function createChatOutbox({
  store, send, onChange = () => {}, onWake = () => {}, timers = { setTimeout, clearTimeout }, now = Date.now,
  randomId = newId, backoff = DEFAULT_BACKOFF, recordOf = () => null, reconcile = null,
}) {
  let entries = store.outbox();
  let holdUntil = 0;
  let holdKind = null;
  let retries = 0;
  let timer = null;
  let sending = null;
  let stopped = false;
  // entry id -> the `edited_at` the cached record had when the edit was queued; dropped once the entry leaves the queue
  const staleMemo = new Map();

  const list = () => entries.map(publicEntry);
  const changed = (settled = []) => { try { onChange(list(), settled); } catch { /* the push is best effort */ } };

  function persist(next) {
    const saved = store.saveOutbox(next);
    if (saved.ok) {
      entries = next;
      for (const entryId of staleMemo.keys()) if (!next.some((item) => item.entry_id === entryId && item.failed === null)) staleMemo.delete(entryId);
    }
    return saved;
  }

  function cancelTimer() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  }

  function hold(kind) {
    const initial = Math.max(1, backoff.initialMs);
    const delay = Math.min(backoff.maxMs, initial * (2 ** Math.min(retries, 30)));
    retries += 1;
    holdKind = kind;
    holdUntil = now() + delay;
    cancelTimer();
    timer = timers.setTimeout(() => { timer = null; holdUntil = 0; holdKind = null; onWake(); }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function next() {
    return entries.find((entry) => entry.failed === null) || null;
  }

  // Marks an entry failed and reports it: 'failed', or 'held' when the write failed (nothing is reported then).
  // Only { code, reason } is kept: client.json refuses any other field, and a refused write would resend the entry.
  function fail(entry, answered) {
    const error = typeof answered?.code === 'string' && CODE.test(answered.code)
      && typeof answered.reason === 'string' && REASON.test(answered.reason)
      ? { code: answered.code, reason: answered.reason } : invalidRequest('team_chat_answer_invalid').error;
    const updated = entries.map((item) => (item.entry_id === entry.entry_id ? { ...item, failed: error } : item));
    if (!persist(updated).ok) { hold('later'); return 'held'; }
    changed([{ entry_id: entry.entry_id, ok: false, error }]);
    return 'failed';
  }

  // The settlement of a committed entry: only a valid message id and counts are passed on.
  function settlement(entryId, answer) {
    const result = { entry_id: entryId, ok: true };
    if (isMessageId(answer.message_id)) result.message_id = answer.message_id;
    for (const field of ['seq', 'rev']) if (isPositive(answer[field])) result[field] = answer[field];
    return result;
  }

  // The answer to an edit made stale only by marks, or null: sync once, then send once more at the current revision.
  async function retryStale(entry, answer) {
    if (entry.operation !== 'team.chat.edit' || answer?.error?.reason !== 'team_chat_stale' || !reconcile
      || !staleMemo.has(entry.entry_id)) return null;
    const editedAt = staleMemo.get(entry.entry_id);
    staleMemo.delete(entry.entry_id);
    let record;
    try { record = await reconcile(entry.params.channel_id, entry.params.message_id); } catch { record = null; }
    if (stopped || !record || record.deleted !== null || record.edited_at !== editedAt || !isPositive(record.rev)) return null;
    // Built from the entry as stored now (already marked attempted), so the resend-window check still applies.
    const stored = entries.find((item) => item.entry_id === entry.entry_id);
    if (!stored) return null;
    const retried = { ...stored, request_id: randomId('chat_'), params: { ...stored.params, expected_rev: record.rev } };
    if (!isOutboxEntry(retried) || !persist(entries.map((item) => (item.entry_id === entry.entry_id ? retried : item))).ok) return null;
    return send(retried.operation, retried.params, retried.request_id);
  }

  // Sends the first unsent entry: 'sent', 'failed', 'held' or 'idle'.
  async function sendNext() {
    if (stopped || sending) return 'idle';
    if (holdUntil > now()) return 'held';
    const entry = next();
    if (!entry) return 'idle';
    if (entry.attempted && now() - Date.parse(entry.created_at) > RESEND_WINDOW_MS) {
      return fail(entry, invalidRequest('team_chat_outbox_expired').error);
    }
    if (!entry.attempted) {
      const marked = entries.map((item) => (item.entry_id === entry.entry_id ? { ...item, attempted: true } : item));
      if (!persist(marked).ok) { hold('later'); return 'held'; }
    }
    sending = entry.entry_id;
    let answer;
    try {
      answer = await send(entry.operation, entry.params, entry.request_id);
      answer = (await retryStale(entry, answer)) || answer;
    } catch {
      answer = null;
    } finally {
      sending = null;
    }
    if (stopped) return 'idle';
    const outcome = classify(answer);
    if (outcome === 'done') {
      // Still on disk: the retry reuses the request id and the host answers it from its idempotency record.
      if (!persist(entries.filter((item) => item.entry_id !== entry.entry_id)).ok) { hold('later'); return 'held'; }
      retries = 0;
      changed([settlement(entry.entry_id, answer)]);
      return 'sent';
    }
    if (outcome === 'failed') return fail(entry, chatFailure(answer).error);
    hold(outcome);
    return 'held';
  }

  return {
    sendNext,

    /** Queues one chat mutation: { ok: true, entry_id } or a failure; nothing but OUTBOX_OPERATIONS enters. */
    enqueue(operation, params) {
      if (stopped || !OUTBOX_OPERATIONS.includes(operation)) return invalidRequest('team_request_invalid');
      if (!fitsRequest(params)) return invalidRequest('team_chat_request_too_large');
      if (entries.length >= OUTBOX_MAX) return invalidRequest('team_chat_outbox_full');
      const entry = { entry_id: randomId('out_'), request_id: randomId('chat_'), operation, params: { ...params },
        created_at: new Date(now()).toISOString(), attempted: false, failed: null };
      if (!isOutboxEntry(entry)) return invalidRequest('team_request_invalid');
      const saved = persist([...entries, entry]);
      if (!saved.ok) return invalidRequest(saved.reason);
      const cached = operation === 'team.chat.edit' ? recordOf(params.channel_id, params.message_id) : null;
      if (cached && cached.deleted === null && cached.rev === params.expected_rev) staleMemo.set(entry.entry_id, cached.edited_at);
      changed();
      return { ok: true, entry_id: entry.entry_id };
    },

    /** Removes an entry the user gave up on; one being sent right now cannot be discarded. */
    discard(entryId) {
      if (sending === entryId) return invalidRequest('team_chat_outbox_busy');
      if (!entries.some((entry) => entry.entry_id === entryId)) return invalidRequest('team_chat_outbox_unknown');
      const saved = persist(entries.filter((entry) => entry.entry_id !== entryId));
      if (!saved.ok) return invalidRequest(saved.reason);
      changed();
      return { ok: true };
    },

    /** A sync completed: an outbox held for the connection may send again (a rate-limit hold stays). */
    connectionResumed() {
      if (holdKind !== 'connection') return;
      cancelTimer();
      holdUntil = 0;
      holdKind = null;
    },

    list,
    size: () => entries.length,
    stop() { stopped = true; cancelTimer(); },
  };
}

module.exports = { classify, createChatOutbox, publicEntry };
