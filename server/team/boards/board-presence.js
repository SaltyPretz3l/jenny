'use strict';

// Team boards T4 (row 151, plan PROJECT_BOARD_2026-11-13 sections 8.3 and 8.4): who is looking at a board and which
// note someone is typing in, held in memory on the team host. Nothing here is stored: a restart forgets it all.
//
// The store records, per tracked board, the project it belongs to, the devices viewing it (through a second
// `createViewers()` instance, the same lazy-expiry store that tracks who views a conversation), the member list it
// last reported, and the note leases. It has no timer and does no I/O; expiry is checked against the injected clock
// whenever a record is met, and `expire()` is the sweep the host calls from its own timer.
//
// The caller has authorized the member for the project before it calls: the store reads no role. It never trusts
// an id it was not given by the host: every id is re-checked for shape, a board belongs to the first project that
// views it, and a lease is held by one device of one member.
//
// Viewer keys. `viewers.js` accepts only conversation ids (`sess_...`, ids.js `isSessionId`); a board id
// (`board_<uuid>`) does not pass that check. The store therefore keys its viewer instance by the board id behind a
// fixed `sess_` prefix, and nothing outside this file ever sees that key.
//
// Announcing. The viewer store drops a device's oldest record without a word when a 33rd starts, and prunes
// expired records lazily, so the store cannot assume it saw every removal. For each tracked board it keeps the
// member list it last reported; `settle` compares the live list with it, and a change is reported by `drop*`,
// `leave` and `expire` as { projectId, boardId, viewers, unlocked }. A lease is live only while its device is still
// viewing the board and `LOCK_MS` has not passed since its last renewal. A lease that is met dead is pruned and its
// card is owed to the next report, so a release nobody saw is still announced.
//
// Bounds: BOARDS tracked boards, LOCKS_PER_BOARD live leases a board, one lease a device a board, at most
// LOCKS_PER_BOARD owed releases a board, BOARDS owed sweep reports and the viewer store's own capacity. A board with no live viewer is
// forgotten. Nothing throws for bad input.

const { isBoardId } = require('../../../services/boards/board-ids');
const { isId } = require('../ids');
const { isProjectId } = require('../member-schema');
const { createViewers } = require('../viewers');

const PRESENCE_LIMITS = Object.freeze({ LOCK_MS: 30_000, LOCKS_PER_BOARD: 64, BOARDS: 256 });

const CARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const VIEWER_KEY_PREFIX = 'sess_';

const isProject = isProjectId;
const isBoard = isBoardId;
const isCard = (value) => typeof value === 'string' && CARD_ID.test(value);
const keyOf = (boardId) => `${VIEWER_KEY_PREFIX}${boardId}`;
const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

function monotonicMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

// `limits` may only lower PRESENCE_LIMITS (tests).
function resolveLimits(limits) {
  const resolved = { ...PRESENCE_LIMITS };
  for (const [key, value] of Object.entries(limits ?? {})) {
    if (!Object.hasOwn(PRESENCE_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > PRESENCE_LIMITS[key]) {
      throw new RangeError('invalid_board_presence_limit');
    }
    resolved[key] = value;
  }
  return resolved;
}

function mergeChange(a, b) {
  return { projectId: a.projectId, boardId: a.boardId, viewers: a.viewers || b.viewers,
    unlocked: [...new Set([...a.unlocked, ...b.unlocked])].sort() };
}

/**
 * clock: monotonic milliseconds. viewers: a viewer store (default: a new one on `clock`). limits: may only lower
 * PRESENCE_LIMITS. Answers the frozen store described by the functions below.
 */
function createBoardPresence({ clock = monotonicMs, viewers = null, limits = {} } = {}) {
  if (typeof clock !== 'function') throw new TypeError('createBoardPresence needs a clock function.');
  const { LOCK_MS, LOCKS_PER_BOARD, BOARDS } = resolveLimits(limits);
  const store = viewers ?? createViewers({ clock });
  // board id -> { projectId, boardId, key, reported: [member ids], devices: Map(device -> member),
  //               locks: Map(card -> { deviceId, memberId, since }), owed: Set(card) }
  const tracked = new Map();
  // board id -> the change a sweep for room made that the next `expire()` still owes the host.
  const carry = new Map();

  function now() {
    let at;
    try { at = clock(); } catch { at = Number.NaN; }
    return Number.isFinite(at) ? at : null;
  }

  function leaseLive(entry, lease, at) {
    return at !== null && at >= lease.since && at - lease.since < LOCK_MS && store.isViewing(entry.key, lease.deviceId);
  }

  function owe(entry, cardId) {
    entry.owed.add(cardId);
    while (entry.owed.size > LOCKS_PER_BOARD) entry.owed.delete(entry.owed.values().next().value);
  }

  // Removes every lease that is no longer live; their cards are owed to the next report.
  function reap(entry, at) {
    for (const [cardId, lease] of [...entry.locks]) {
      if (leaseLive(entry, lease, at)) continue;
      entry.locks.delete(cardId);
      owe(entry, cardId);
    }
  }

  // The devices that still hold a live viewing record, with the member each was seen for.
  function refresh(entry) {
    const devices = new Map();
    for (const deviceId of store.viewersOf(entry.key)) {
      const memberId = entry.devices.get(deviceId);
      if (memberId) devices.set(deviceId, memberId);
    }
    entry.devices = devices;
  }

  const membersOf = (entry) => [...new Set(entry.devices.values())].sort();

  // Brings one board up to date and reports what changed since the last report; a board nobody views is forgotten.
  function settle(boardId, entry) {
    refresh(entry);
    reap(entry, now());
    const members = membersOf(entry);
    const viewersChanged = !sameList(members, entry.reported);
    entry.reported = members;
    const unlocked = [...entry.owed].sort();
    entry.owed.clear();
    if (members.length === 0) tracked.delete(boardId);
    return { projectId: entry.projectId, boardId, viewers: viewersChanged, unlocked };
  }

  const changed = (change) => change.viewers || change.unlocked.length > 0;

  // Boards whose last viewer is gone make room; what they would have announced waits in `carry`.
  function sweepForRoom() {
    for (const [boardId, entry] of [...tracked]) {
      const change = settle(boardId, entry);
      if (!changed(change)) continue;
      carry.set(boardId, carry.has(boardId) ? mergeChange(carry.get(boardId), change) : change);
      // Bounded like the boards themselves: past it the oldest owed announcement is lost (clients learn at their next view).
      while (carry.size > BOARDS) carry.delete(carry.keys().next().value);
    }
  }

  function view(args) {
    const { projectId, boardId, deviceId, memberId } = args ?? {};
    if (!isProject(projectId) || !isBoard(boardId) || !isId('device', deviceId) || !isId('member', memberId)) return { ok: false };
    let entry = tracked.get(boardId);
    if (entry && entry.projectId !== projectId) return { ok: false };
    if (!entry && tracked.size >= BOARDS) sweepForRoom();
    if (!entry && tracked.size >= BOARDS) return { ok: false };
    if (!store.touch(keyOf(boardId), deviceId, memberId)) return { ok: false };
    if (!entry) {
      entry = { projectId, boardId, key: keyOf(boardId), reported: [], devices: new Map(), locks: new Map(), owed: new Set() };
      tracked.set(boardId, entry);
    }
    entry.devices.set(deviceId, memberId);
    refresh(entry);
    const members = membersOf(entry);
    const differs = !sameList(members, entry.reported);
    entry.reported = members;
    return { ok: true, changed: differs };
  }

  function leave(args) {
    const { boardId, deviceId } = args ?? {};
    const entry = isBoard(boardId) ? tracked.get(boardId) : undefined;
    if (!entry || !isId('device', deviceId)) return { changed: false, projectId: null, unlocked: [] };
    store.drop(entry.key, deviceId);
    const change = settle(boardId, entry);
    return { changed: change.viewers, projectId: change.projectId, unlocked: change.unlocked };
  }

  function isViewing(boardId, deviceId) {
    return isBoard(boardId) && tracked.has(boardId) && store.isViewing(keyOf(boardId), deviceId);
  }

  function viewersOf(boardId) {
    const entry = isBoard(boardId) ? tracked.get(boardId) : undefined;
    if (!entry) return [];
    refresh(entry);
    return membersOf(entry);
  }

  function projectOf(boardId) {
    return isBoard(boardId) ? tracked.get(boardId)?.projectId ?? null : null;
  }

  function lock(args) {
    const { boardId, cardId, deviceId, memberId } = args ?? {};
    if (!isBoard(boardId) || !isCard(cardId) || !isId('device', deviceId) || !isId('member', memberId)) {
      return { ok: false, reason: 'invalid', held_by: null };
    }
    const entry = tracked.get(boardId);
    const at = now();
    if (!entry || at === null || !store.isViewing(entry.key, deviceId)) return { ok: false, reason: 'not_viewing', held_by: null };
    reap(entry, at);
    const current = entry.locks.get(cardId);
    if (current && current.memberId !== memberId) return { ok: false, reason: 'held', held_by: current.memberId };
    // One lock a device a board: the one it holds on another card is the one this call releases.
    let released = null;
    for (const [heldCard, lease] of entry.locks) if (lease.deviceId === deviceId && heldCard !== cardId) released = heldCard;
    if (!current && entry.locks.size - (released === null ? 0 : 1) >= LOCKS_PER_BOARD) return { ok: false, reason: 'limit', held_by: null };
    if (released !== null) entry.locks.delete(released);
    entry.owed.delete(cardId);
    entry.locks.set(cardId, { deviceId, memberId, since: at });
    return { ok: true, changed: !current, released };
  }

  function unlock(args) {
    const { boardId, cardId, deviceId } = args ?? {};
    const entry = isBoard(boardId) ? tracked.get(boardId) : undefined;
    if (!entry || !isCard(cardId)) return { changed: false };
    reap(entry, now());
    if (entry.locks.get(cardId)?.deviceId !== deviceId) return { changed: false };
    entry.locks.delete(cardId);
    return { changed: true };
  }

  function lockHolder(boardId, cardId) {
    const entry = isBoard(boardId) ? tracked.get(boardId) : undefined;
    const lease = entry?.locks.get(cardId);
    if (!lease) return null;
    if (leaseLive(entry, lease, now())) return lease.memberId;
    entry.locks.delete(cardId);
    owe(entry, cardId);
    return null;
  }

  function locksOf(boardId) {
    const entry = isBoard(boardId) ? tracked.get(boardId) : undefined;
    if (!entry) return [];
    reap(entry, now());
    return [...entry.locks].map(([cardId, lease]) => ({ card_id: cardId, member_id: lease.memberId }))
      .sort((a, b) => (a.card_id < b.card_id ? -1 : 1));
  }

  // Ends the viewing records `pick(entry)` names (it returns how many it ended) and settles the boards it touched.
  function dropFrom(pick) {
    const out = [];
    for (const [boardId, entry] of [...tracked]) {
      if (!pick(entry)) continue;
      const change = settle(boardId, entry);
      if (changed(change)) out.push(change);
    }
    return out;
  }

  function dropDevice(deviceId) {
    if (!isId('device', deviceId)) return [];
    return dropFrom((entry) => store.drop(entry.key, deviceId));
  }

  function dropBoard(boardId) {
    const entry = isBoard(boardId) ? tracked.get(boardId) : undefined;
    if (!entry) return [];
    store.dropSession(entry.key);
    const change = settle(boardId, entry);
    return changed(change) ? [change] : [];
  }

  function dropProject(projectId) {
    if (!isProject(projectId)) return [];
    return dropFrom((entry) => entry.projectId === projectId && (store.dropSession(entry.key), true));
  }

  function picks(predicate, entry, deviceId, memberId) {
    try { return predicate({ projectId: entry.projectId, boardId: entry.boardId, deviceId, memberId }) === true; } catch { return false; }
  }

  function dropWhere(predicate) {
    if (typeof predicate !== 'function') return [];
    return dropFrom((entry) => {
      refresh(entry);
      let dropped = 0;
      for (const [deviceId, memberId] of [...entry.devices]) {
        if (picks(predicate, entry, deviceId, memberId) && store.drop(entry.key, deviceId)) dropped += 1;
      }
      return dropped;
    });
  }

  function expire() {
    const merged = new Map();
    for (const [boardId, entry] of [...tracked]) {
      const change = settle(boardId, entry);
      if (changed(change)) merged.set(boardId, change);
    }
    for (const [boardId, change] of carry) merged.set(boardId, merged.has(boardId) ? mergeChange(change, merged.get(boardId)) : change);
    carry.clear();
    return [...merged.values()];
  }

  function resources() {
    let viewing = 0;
    let leases = 0;
    for (const entry of tracked.values()) { viewing += entry.devices.size; leases += entry.locks.size; }
    return { boards: tracked.size, viewers: viewing, locks: leases };
  }

  return Object.freeze({
    view, leave, isViewing, viewersOf, projectOf, lock, unlock, lockHolder, locksOf,
    dropDevice, dropBoard, dropProject, dropWhere, expire, resources,
  });
}

module.exports = { PRESENCE_LIMITS, createBoardPresence };
