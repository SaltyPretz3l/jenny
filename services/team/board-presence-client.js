'use strict';

// One open team board's presence on a member's Jenny (row 151 slice T4; plan PROJECT_BOARD_2026-11-13 section 8.4):
// who else is looking at the board, where their pointers are, and which note someone is typing in. Presence is
// never stored: the host keeps it in memory and announces it, and this client keeps what the page needs to draw.
//
//   viewers  the member ids viewing now, from the answer to `team.board.view` and from `team_board_viewers`;
//   cursors  other members' pointers, each dropped CURSOR_STALE_MS after its last update;
//   locks    the notes someone holds, from the view answer and from `team_board_lock`;
//   mine     the card this member holds, renewed every LOCK_RENEW_MS while held.
//
// `team.board.view` doubles as the heartbeat: it renews the viewing record, repeats every HEARTBEAT_MS and is never
// stacked (a beat that is still unanswered when the next is due is not repeated). The member's own pointer goes out
// at most once every CURSOR_MS, the newest position always: a burst sends its first position at once and its last
// after the interval. Nothing goes out offline or before the first answered view.
//
// A value from the host is checked before it is kept: a viewer or member that is not a member id, a card that is
// not a card id, a pointer without finite x and y, more than 64 selected cards or viewers all drop the value. What
// is kept is bounded (64 viewers, 32 pointers, 64 locks). Pushes to the page are `{ kind: 'presence', ...state() }`,
// coalesced to one every PUSH_MS and skipped when the state did not change.
//
// It reads and writes no file, holds no key and logs nothing. Every timer goes through the injected `timers` and is
// cleared by `close()`, which also sends one `team.board.leave` that nobody waits for.

const { isId } = require('../../server/team/ids');
const { invalidRequest } = require('./team-errors');

const HEARTBEAT_MS = 15_000;
const CURSOR_MS = 100;
const CURSOR_STALE_MS = 5_000;
const LOCK_RENEW_MS = 10_000;
const PUSH_MS = 50;
const MAX_SELECTED = 64;
const MAX_VIEWERS = 64;
const MAX_CURSORS = 32;
const MAX_LOCKS = 64;
// Answers that say nothing about the lock: the renewal is tried again at the next beat.
const NO_ANSWER = new Set(['team_not_connected', 'team_connection_stopped', 'team_unavailable', 'team_hello_required']);

const CARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const isMember = (value) => isId('member', value);
const isCard = (value) => typeof value === 'string' && CARD_ID.test(value);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const byId = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

// The list when it is at most `max` values that all pass `test`, else null.
function listOf(value, max, test) {
  return Array.isArray(value) && value.length <= max && value.every(test) ? [...value] : null;
}

// A pointer { x, y, selected } from the page or the host, or null.
function pointerOf(value) {
  if (!isObject(value) || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
  const selected = listOf(value.selected ?? [], MAX_SELECTED, isCard);
  return selected ? { x: value.x, y: value.y, selected } : null;
}

const reasonOf = (answer) => (typeof answer?.error?.reason === 'string' ? answer.error.reason : null);
const refused = (answer) => isObject(answer) && answer.ok === false && isObject(answer.error)
  && !NO_ANSWER.has(reasonOf(answer)) && answer.error.retryable !== true;

function createBoardPresenceClient({
  projectId, boardId, send, self, push = () => {}, online = () => true, clock = Date.now,
  timers = { setTimeout, clearTimeout },
} = {}) {
  if (typeof send !== 'function' || typeof self !== 'function') throw new TypeError('createBoardPresenceClient requires send() and self().');
  let viewers = [];
  const cursors = new Map(); // member id -> { x, y, selected, timer }
  const locks = new Map(); // card id -> member id
  let mine = null;
  let started = false;
  let viewed = false; // the host has answered a view since start or the last reconnect
  let closed = false;
  let beating = false;
  let beatAgain = false;
  let relock = false;
  let renewing = false;
  let heartbeatTimer = null;
  let renewTimer = null;
  let pushTimer = null;
  let cursorTimer = null;
  let lastCursorAt = Number.NEGATIVE_INFINITY;
  let pendingCursor = null;
  let lastPushed = null;
  const params = (extra = {}) => ({ project_id: projectId, board_id: boardId, ...extra });

  const state = () => ({
    viewers: [...viewers].sort(),
    cursors: [...cursors].map(([memberId, c]) => ({ member_id: memberId, x: c.x, y: c.y, selected: [...c.selected] }))
      .sort(byId('member_id')),
    locks: [...locks].map(([cardId, memberId]) => ({ card_id: cardId, member_id: memberId })).sort(byId('card_id')),
    mine,
  });
  lastPushed = JSON.stringify(state());

  // A call that never throws: the host's answer, or null for no answer.
  async function call(operation, body) {
    try { return await send(operation, body); } catch { return null; }
  }

  function setTimer(ms, body) {
    return timers.setTimeout(body, ms);
  }
  function stop(handle) {
    if (handle !== null) { try { timers.clearTimeout(handle); } catch { /* best effort */ } }
  }

  // ---------------------------------------------------------------- what the page is told

  function flush() {
    pushTimer = null;
    if (closed) return;
    const next = JSON.stringify(state());
    if (next === lastPushed) return;
    lastPushed = next;
    try { push({ kind: 'presence', ...state() }); } catch { /* the page is gone; the next change tries again */ }
  }

  function changed() {
    if (closed || pushTimer !== null) return;
    pushTimer = setTimer(PUSH_MS, flush);
  }

  // ---------------------------------------------------------------- viewing

  function takeView(answer) {
    const listed = listOf(answer.viewers, MAX_VIEWERS, isMember);
    if (listed) viewers = listed;
    if (Array.isArray(answer.locks)) {
      locks.clear();
      for (const lock of answer.locks.slice(0, MAX_LOCKS)) {
        if (isObject(lock) && isCard(lock.card_id) && isMember(lock.member_id)) locks.set(lock.card_id, lock.member_id);
      }
    }
    if (mine !== null && locks.get(mine) !== undefined && locks.get(mine) !== self()) dropMine();
    changed();
  }

  async function beat() {
    if (closed || !online() || beating) return;
    beating = true;
    try {
      const answer = await call('team.board.view', params());
      if (closed) return;
      if (isObject(answer) && answer.ok === true) {
        viewed = true;
        takeView(answer);
        if (relock && mine !== null) { relock = false; await renew(); }
        relock = false;
      }
    } finally {
      beating = false;
      if (beatAgain && !closed) { beatAgain = false; void beat(); }
      beatAgain = false;
    }
  }

  function armHeartbeat() {
    stop(heartbeatTimer);
    heartbeatTimer = setTimer(HEARTBEAT_MS, () => {
      heartbeatTimer = null;
      if (closed) return;
      armHeartbeat();
      void beat();
    });
  }

  // ---------------------------------------------------------------- the pointer

  async function sendCursor() {
    cursorTimer = null;
    const position = pendingCursor;
    pendingCursor = null;
    if (closed || !position || !viewed || !online()) return;
    lastCursorAt = clock();
    const answer = await call('team.board.cursor', params(position));
    if (!closed && refused(answer) && reasonOf(answer) === 'team_board_not_viewing') void beat();
  }

  function cursor(input) {
    if (closed) return;
    const position = pointerOf(input);
    if (!position || !viewed || !online()) return;
    pendingCursor = position;
    if (cursorTimer !== null) return;
    const wait = CURSOR_MS - (clock() - lastCursorAt);
    if (wait <= 0) { void sendCursor(); return; }
    cursorTimer = setTimer(wait, () => { void sendCursor(); });
  }

  // ---------------------------------------------------------------- the note lock

  function dropMine() {
    if (mine === null) return;
    if (locks.get(mine) === self()) locks.delete(mine);
    mine = null;
    stop(renewTimer);
    renewTimer = null;
    changed();
  }

  function armRenewal() {
    stop(renewTimer);
    renewTimer = setTimer(LOCK_RENEW_MS, () => {
      renewTimer = null;
      if (closed || mine === null) return;
      armRenewal();
      void renew();
    });
  }

  // The lock's calls go out one at a time, renewals and releases included: a release sent while a renewal is on
  // its way could reach the host first, and the renewal would then hold the card for another lock time.
  let queue = Promise.resolve();
  function inTurn(work) {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  }

  // Asks the host to keep (or take again) the held lock; a refusal drops it here. The card is read when its turn
  // comes: a lock released or replaced while this waited is not renewed.
  function renew() {
    if (closed || mine === null || renewing) return Promise.resolve();
    renewing = true;
    return inTurn(async () => {
      const card = mine;
      try {
        if (closed || card === null) return;
        const answer = await call('team.board.lock', params({ card_id: card }));
        if (!closed && mine === card && refused(answer)) dropMine();
      } finally {
        renewing = false;
      }
    });
  }

  const lock = (cardId) => inTurn(() => takeLock(cardId));

  async function takeLock(cardId) {
    if (closed) return invalidRequest('team_board_presence_closed');
    if (!isCard(cardId)) return invalidRequest('team_board_card_invalid');
    const answer = await call('team.board.lock', params({ card_id: cardId }));
    if (isObject(answer) && answer.ok === true) {
      if (closed) return { ok: true };
      // The host released the card this one replaces.
      if (mine !== null && mine !== cardId && locks.get(mine) === self()) locks.delete(mine);
      mine = cardId;
      locks.set(cardId, self());
      armRenewal();
      changed();
      return { ok: true };
    }
    if (isObject(answer) && answer.ok === false && isObject(answer.error)) {
      return { ok: false, error: answer.error, held_by: isMember(answer.held_by) ? answer.held_by : null };
    }
    return invalidRequest('team_board_presence_unanswered');
  }

  function unlock() {
    const card = mine;
    if (closed || card === null) return Promise.resolve({ ok: true });
    dropMine();
    return inTurn(() => call('team.board.unlock', params({ card_id: card })).then(() => ({ ok: true })));
  }

  // ---------------------------------------------------------------- the host's events

  function onCursor(event) {
    const pointer = pointerOf(event);
    if (!pointer || !isMember(event.member_id) || event.member_id === self()) return;
    const memberId = event.member_id;
    const known = cursors.get(memberId);
    if (known) stop(known.timer);
    else if (cursors.size >= MAX_CURSORS) return;
    const timer = setTimer(CURSOR_STALE_MS, () => {
      if (closed || cursors.get(memberId)?.timer !== timer) return;
      cursors.delete(memberId);
      changed();
    });
    cursors.set(memberId, { ...pointer, timer });
    changed();
  }

  function onViewers(event) {
    const listed = listOf(event.viewers, MAX_VIEWERS, isMember);
    if (!listed) return;
    viewers = listed;
    for (const [memberId, c] of [...cursors]) {
      if (listed.includes(memberId)) continue;
      stop(c.timer);
      cursors.delete(memberId);
    }
    changed();
  }

  function onLock(event) {
    if (!isCard(event.card_id) || (event.member_id !== null && !isMember(event.member_id))) return;
    if (event.member_id === null) locks.delete(event.card_id);
    else if (locks.has(event.card_id) || locks.size < MAX_LOCKS) locks.set(event.card_id, event.member_id);
    else return;
    if (event.card_id === mine && event.member_id !== null && event.member_id !== self()) dropMine();
    changed();
  }

  function onEvent(event) {
    if (closed || !isObject(event) || event.project_id !== projectId || event.board_id !== boardId) return;
    if (event.event_type === 'team_board_cursor') onCursor(event);
    else if (event.event_type === 'team_board_viewers') onViewers(event);
    else if (event.event_type === 'team_board_lock') onLock(event);
  }

  // ---------------------------------------------------------------- lifecycle

  function start() {
    if (closed || started) return Promise.resolve();
    started = true;
    armHeartbeat();
    return beat();
  }

  function reconnected() {
    if (closed || !started) return;
    viewed = false;
    relock = true;
    // A view already in flight may predate the reconnect: one more follows it.
    if (beating) beatAgain = true;
    else void beat();
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const handle of [heartbeatTimer, renewTimer, pushTimer, cursorTimer]) stop(handle);
    heartbeatTimer = renewTimer = pushTimer = cursorTimer = null;
    for (const c of cursors.values()) stop(c.timer);
    cursors.clear();
    pendingCursor = null;
    if (started) void call('team.board.leave', params());
  }

  const resources = () => ({
    timers: [heartbeatTimer, renewTimer, pushTimer, cursorTimer].filter((handle) => handle !== null).length + cursors.size,
    cursors: cursors.size,
    locks: locks.size,
  });

  return Object.freeze({
    start, cursor, lock, unlock, onEvent, reconnected, state, close, resources,
  });
}

module.exports = { CURSOR_MS, CURSOR_STALE_MS, HEARTBEAT_MS, LOCK_RENEW_MS, PUSH_MS, createBoardPresenceClient };
