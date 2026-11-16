'use strict';

// One open team board on a member's Jenny (row 151 slice T3; plan PROJECT_BOARD_2026-11-13 sections 8.3 and 8.8).
//
// The host is the truth. This client keeps three things for one (project, board):
//   confirmed  the host's document at `confirmed.rev`, built from a snapshot and then only from the host's own
//              applied batches, each replayed in rev order through the shared board model;
//   pending    this member's batches the host has not confirmed yet, oldest first (at most MAX_PENDING);
//   view       confirmed with the pending batches applied on top: what the page shows.
//
// A batch from the page is applied to the view at once and queued; one batch at a time is sent, in order. The
// host's answer never changes `confirmed`: only an applied batch does, from a `team_board_changed` event that
// carries it or from `team.board.sync`. So the host's order is the only order, and after every host batch the
// pending ones are applied again on top (one that no longer applies is left out of the view until the host
// answers for it).
//
// - A gap (an event past the next rev, or one that carries no batch) and a reconnect start a sync from
//   `confirmed.rev`; "take a snapshot" or a batch that does not replay to the host's rev reads the snapshot again.
//   A snapshot the host asked for is taken whatever its rev: an older one means the host's document went back
//   (a restored backup), and what it had accepted from here is sent again.
// - A batch the host refuses is taken out of the queue, the view is rebuilt without it and a `refused` notice
//   names the batch, the reason and the card. A call that got no answer (not connected, a reset, a timeout, an
//   answer that could not be read), a rate limit and an unavailable host are tried again later with the same
//   batch id, which the host treats as a repeat: a lost answer is never read as a refusal.
// - A board the host cannot read is read-only here: what was waiting is dropped with one `refused` notice, and
//   the snapshot is read again when the host says the board changed and when the team comes back.
// - A batch counts as this member's own only when its id is pending AND the host names this member as its actor.
//
// It reads and writes no file, holds no key and logs no board content. `send(operation, params)` is the team's
// command call, `readSnapshot()` the snapshot route, `self()` this member's id, `online()` whether a call may go
// out now. Pushes: `applied`, `refused`, `reloaded`, `gone`; a word in one is a closed word or null, and an
// applied batch is the one the model here wrote, never the host's object passed through.

const model = require('../boards/board-model');
const { invalidRequest, teamFailure } = require('./team-errors');

const MAX_PENDING = 64;
// How long an accepted batch waits for its own event before the client asks for it.
const GRACE_MS = 250;
const RETRY_MS = Object.freeze([1000, 2000, 4000, 8000, 15000]);
const SYNC_PAGES_MAX = 16;
const BATCH_KEYS = ['batch_id', 'ops'];
// Answers that say nothing about the batch: the call is made again.
const NO_ANSWER = new Set(['team_not_connected', 'team_connection_stopped', 'team_unavailable', 'team_hello_required',
  'team_connection_reset', 'team_request_timeout', 'team_response_invalid', 'team_response_too_large']);
const LATER = new Set(['team_board_rate_limit', 'team_rate_limit', 'team_board_unavailable', 'disk_pressure']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRev = (value) => Number.isSafeInteger(value) && value >= 0;
const WORD = /^[a-z][a-z0-9_]{0,79}$/u;
const word = (value) => (typeof value === 'string' && WORD.test(value) ? value : null);
const reasonOf = (answer) => word(answer?.error?.reason);
const undecided = (answer) => !isObject(answer) || NO_ANSWER.has(reasonOf(answer)) || LATER.has(reasonOf(answer))
  || answer.error?.retryable === true;

// A host item: { rev, batch_id, actor, at, applied } with the applied batch the model wrote.
function validItem(item) {
  return isObject(item) && isRev(item.rev) && item.rev >= 1 && typeof item.batch_id === 'string'
    && typeof item.actor === 'string' && isObject(item.applied) && item.applied.batch_id === item.batch_id
    && item.applied.actor === item.actor && Array.isArray(item.applied.ops);
}

function createBoardClient({
  projectId, boardId, send, readSnapshot, self, push = () => {}, online = () => true, onGone = () => {},
  clock = Date.now, timers = { setTimeout, clearTimeout }, log = () => {},
} = {}) {
  if (typeof send !== 'function' || typeof readSnapshot !== 'function' || typeof self !== 'function') {
    throw new TypeError('createBoardClient requires send(), readSnapshot() and self().');
  }
  let confirmed = null;
  let readOnly = null; // { reason, rev } when the host cannot load the document
  let view = null;
  const pending = []; // { batch, actor, at, stale, accepted, rev }
  let loading = null;
  let sending = false;
  let syncing = false;
  let again = false; // something arrived during a sync that the sync may not cover: one more follows
  let wanted = 0; // a rev the host is known to have
  let take = false; // the host said "take a snapshot": the next one read is taken whatever its rev
  let closed = false;
  let retries = 0;
  let retryTimer = null;
  const waits = new Set();

  const say = (level, event, fields) => { try { log(level, event, fields); } catch { /* best effort */ } };
  const tell = (payload) => { if (!closed || payload.kind === 'gone') { try { push(payload); } catch { say('WARN', 'team.board.push_failed'); } } };
  const local = (entry) => ({ batch_id: entry.batch.batch_id, board_id: boardId, actor: entry.actor, ops: entry.batch.ops });

  function later(ms, body) {
    const handle = timers.setTimeout(() => { waits.delete(handle); if (!closed) body(); }, ms);
    waits.add(handle);
    return handle;
  }

  function retryLater() {
    if (retryTimer !== null || closed) return;
    const delay = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)];
    retries += 1;
    retryTimer = later(delay, () => { retryTimer = null; catchUp(); });
  }

  // Whatever was missed: the batches after `confirmed` and the queue, or the snapshot of a board the host could not read.
  function catchUp() {
    if (!readOnly) { void sync(); void pump(); } else if (online()) void reload();
  }

  // The view: confirmed, then every pending batch that still applies.
  function rebuild() {
    let next = confirmed;
    for (const entry of pending) {
      const result = model.applyBatch(next, local(entry), { now: entry.at, authority: false });
      entry.stale = result.ok !== true;
      if (result.ok === true) next = result.board;
    }
    view = next;
  }

  // Pending batches the host's document already holds: accepted at a rev it has reached, or in its recent ring.
  function settle() {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const entry = pending[index];
      if ((entry.accepted && confirmed.rev >= entry.rev) || confirmed.recent_batches.includes(entry.batch.batch_id)) pending.splice(index, 1);
    }
  }

  function end(reason) {
    if (closed) return;
    closed = true;
    for (const handle of waits) timers.clearTimeout(handle);
    waits.clear();
    retryTimer = null;
    if (reason) { tell({ kind: 'gone', reason }); try { onGone(reason); } catch { /* best effort */ } }
  }

  function load() {
    if (loading) return loading;
    loading = (async () => {
      let answer;
      try { answer = await readSnapshot(); } catch { answer = null; }
      if (closed) return invalidRequest('team_board_closed');
      if (!isObject(answer)) return teamFailure('CONNECTION_FAILED', 'team_unavailable');
      if (answer.ok !== true) return answer;
      if (answer.read_only === true) {
        // Nothing can be sent to a board the host cannot read: what waited is dropped, and the page is told once.
        const lost = pending.splice(0);
        confirmed = null;
        view = null;
        readOnly = { reason: word(answer.reason) || 'unreadable', rev: isRev(answer.rev) ? answer.rev : 0 };
        if (lost.length > 0) {
          tell({ kind: 'refused', batch_id: lost[0].batch.batch_id, reason: 'team_board_read_only', detail: null, card_id: null,
            rev: readOnly.rev, pending: 0 });
        }
        return { ok: true };
      }
      const checked = model.normalizeBoard(answer.board);
      if (checked.ok !== true || checked.board.id !== boardId || checked.board.project_id !== projectId) {
        return teamFailure('CONNECTION_FAILED', 'team_response_invalid');
      }
      // An older snapshot than what is held (a slow read) changes nothing, unless the host asked for it.
      const older = confirmed !== null && checked.board.rev < confirmed.rev;
      if (!older || take) confirmed = checked.board;
      if (older && take) for (const entry of pending) { entry.accepted = false; entry.rev = 0; }
      take = false;
      readOnly = null;
      settle();
      rebuild();
      return { ok: true };
    })().finally(() => { loading = null; });
    return loading;
  }

  // The snapshot again after the first one: a failure that is not "try later" means the board is gone for this member.
  async function reload() {
    const was = readOnly;
    const loaded = await load();
    if (closed) return;
    if (loaded.ok === true) {
      // Still unreadable at the same rev: nothing new to show.
      if (was && readOnly && was.rev === readOnly.rev && was.reason === readOnly.reason) return;
      tell({ kind: 'reloaded', rev: confirmed ? confirmed.rev : readOnly.rev, pending: pending.length });
      if (confirmed) void pump();
      return;
    }
    if (undecided(loaded)) retryLater();
    else end(reasonOf(loaded) || 'team_board_not_found');
  }

  // One host batch onto `confirmed`. True when it is now held (or was already); false when it cannot be replayed.
  function advance(item) {
    if (!validItem(item)) return false;
    if (item.rev <= confirmed.rev) return true;
    if (item.rev !== confirmed.rev + 1) return false;
    // `replay`: the host's applied batch carries the operations it derived (a group that grew), past a sent batch's count.
    const result = model.applyBatch(confirmed, item.applied, { now: item.applied.now, authority: true, replay: true });
    if (result.ok !== true || result.duplicate === true || result.board.rev !== item.rev) return false;
    confirmed = result.board;
    const index = pending.findIndex((entry) => entry.batch.batch_id === item.batch_id && entry.actor === item.actor);
    const own = index >= 0;
    if (own) pending.splice(index, 1);
    settle();
    rebuild();
    tell({ kind: 'applied', rev: item.rev, applied: result.applied, actor: result.applied.actor, own, pending: pending.length });
    return true;
  }

  async function sync() {
    if (syncing || closed || !confirmed || !online()) return;
    syncing = true;
    again = false;
    let complete = false;
    try {
      for (let page = 0; page < SYNC_PAGES_MAX; page += 1) {
        let answer;
        try { answer = await send('team.board.sync', { project_id: projectId, board_id: boardId, after_rev: confirmed.rev }); } catch { answer = null; }
        if (closed || !confirmed) return;
        if (answer?.ok !== true) {
          if (undecided(answer)) retryLater();
          else end(reasonOf(answer) || 'team_board_not_found');
          return;
        }
        if (answer.snapshot === true || !Array.isArray(answer.batches) || !answer.batches.every(advance)) {
          if (answer.snapshot === true) take = true;
          await reload();
          return;
        }
        if (answer.more !== true) {
          // The host's head is past what it served: read the snapshot rather than trust a short page.
          if (isRev(answer.rev) && answer.rev > confirmed.rev) { await reload(); return; }
          complete = true;
          break;
        }
      }
      retries = 0;
      // Out of pages before the head: the rest in the next run.
      if (!complete) again = true;
    } finally {
      syncing = false;
      if (!closed && confirmed) {
        // A sync that reached the host's head answers every rev heard of before it began.
        if (again) later(GRACE_MS, () => { void sync(); });
        else if (complete) wanted = confirmed.rev;
      }
    }
  }

  // A rev the host has: asked for after a short wait unless its event brings it first.
  function need(rev) {
    if (!isRev(rev) || (confirmed && confirmed.rev >= rev)) return;
    wanted = Math.max(wanted, rev);
    later(GRACE_MS, () => { if (confirmed && confirmed.rev < wanted) void sync(); });
  }

  async function pump() {
    if (sending || closed || !confirmed || !online()) return;
    const entry = pending.find((candidate) => !candidate.accepted);
    if (!entry) return;
    sending = true;
    let answer;
    try { answer = await send('team.board.apply', { project_id: projectId, board_id: boardId, batch: entry.batch }); } catch { answer = null; }
    sending = false;
    if (closed || !confirmed) return; // ended, or found unreadable while the call was out (the queue went with it)
    if (!pending.includes(entry)) { void pump(); return; } // confirmed while the call was out
    if (answer?.ok === true && isRev(answer.rev)) {
      retries = 0;
      entry.accepted = true;
      entry.rev = answer.rev;
      settle();
      need(answer.rev);
      void pump();
      return;
    }
    if (undecided(answer) || answer?.ok === true) { retryLater(); return; }
    // Refused: out of the queue, the view without it, and a notice that names the card.
    pending.splice(pending.indexOf(entry), 1);
    retries = 0;
    rebuild();
    const detail = isObject(answer.board) ? answer.board : null;
    const op = entry.batch.ops[Number.isSafeInteger(detail?.index) && detail.index >= 0 ? detail.index : 0];
    const cardId = isObject(op) ? (typeof op.id === 'string' ? op.id : isObject(op.card) && typeof op.card.id === 'string' ? op.card.id : null) : null;
    say('INFO', 'team.board.batch_refused', { reason: reasonOf(answer) });
    tell({ kind: 'refused', batch_id: entry.batch.batch_id, reason: reasonOf(answer) || 'team_board_refused',
      detail: detail ? { reason: word(detail.reason), detail: word(detail.detail), limit: word(detail.limit) } : null,
      card_id: cardId, rev: confirmed.rev, pending: pending.length });
    void pump();
  }

  function state() {
    if (readOnly) return { ok: true, board: null, rev: readOnly.rev, read_only: true, reason: readOnly.reason, pending: 0 };
    return { ok: true, board: view, rev: confirmed.rev, read_only: false, pending: pending.length };
  }

  /** The board as this member sees it now; the first call reads the snapshot. */
  async function open() {
    if (closed) return invalidRequest('team_board_closed');
    if (!confirmed && !readOnly) {
      const loaded = await load();
      if (loaded.ok !== true) return loaded;
      if (confirmed && wanted > confirmed.rev) void sync();
    }
    return state();
  }

  /** A batch from the page ({ batch_id, ops }): on the view at once, then to the host in order. */
  function apply(batch) {
    if (closed) return invalidRequest('team_board_closed');
    if (readOnly) return invalidRequest('team_board_read_only');
    if (!confirmed) return invalidRequest('team_board_not_open');
    if (!isObject(batch) || !Object.keys(batch).every((key) => BATCH_KEYS.includes(key)) || !Array.isArray(batch.ops)) {
      return invalidRequest('team_board_invalid');
    }
    if (pending.length >= MAX_PENDING) return { ok: false, error: { code: 'invalid_request', reason: 'team_board_queue_full', retryable: true } };
    const actor = self();
    if (typeof actor !== 'string' || !actor) return teamFailure('CONNECTION_FAILED', 'team_not_connected');
    let at;
    try { at = new Date(clock()).toISOString(); } catch { return teamFailure('CONNECTION_FAILED', 'team_unavailable'); }
    const entry = { batch: { batch_id: batch.batch_id, ops: structuredClone(batch.ops) }, actor, at, stale: false, accepted: false, rev: 0 };
    const result = model.applyBatch(view, local(entry), { now: at, authority: false });
    if (result.ok !== true) {
      return { ok: false, error: { code: 'invalid_request', reason: 'team_board_refused' },
        board: { reason: result.reason ?? null, detail: result.detail ?? null, limit: result.limit ?? null, index: result.op_index ?? null } };
    }
    if (result.duplicate === true) return { ...state(), applied: null, duplicate: true };
    pending.push(entry);
    view = result.board;
    void pump();
    return { ...state(), applied: result.applied, duplicate: false };
  }

  function onEvent(event) {
    if (closed || !isObject(event)) return;
    if (event.event_type === 'resync_required') { again = true; catchUp(); return; }
    if (event.event_type !== 'team_board_changed' || event.project_id !== projectId || event.board_id !== boardId) return;
    const rev = event.rev;
    if (!isRev(rev) || rev < 1) return;
    if (readOnly) { catchUp(); return; }
    if (!confirmed) { wanted = Math.max(wanted, rev); return; }
    if (rev <= confirmed.rev) return;
    if (event.batch !== undefined && event.batch?.rev === rev && rev === confirmed.rev + 1 && advance(event.batch)) return;
    wanted = Math.max(wanted, rev);
    again = true;
    void sync();
  }

  return Object.freeze({
    open,
    apply,
    onEvent,
    /** The team is online again: whatever was missed is read, whatever waits is sent. */
    reconnected() { if (closed) return; retries = 0; again = true; catchUp(); },
    /** The board is no longer open here. With a reason (the team was dropped or revoked) the page is told `gone`. */
    close(reason) {
      const was = closed;
      end(null);
      if (!was && word(reason)) tell({ kind: 'gone', reason });
    },
    resources: () => ({ pending: pending.length, timers: waits.size, closed }),
  });
}

module.exports = { GRACE_MS, MAX_PENDING, RETRY_MS, createBoardClient };
