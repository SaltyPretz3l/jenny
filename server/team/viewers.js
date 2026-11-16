'use strict';

// Who is viewing which conversation on the team host (TEAM_PROJECTS_SPEC,
// Approvals). A record per (conversation id, device id), held in memory only:
// set by the conversation snapshot, refreshed by the `session.view` heartbeat,
// dropped on stream close, device revocation and project removal. "Viewing"
// means a live record for that conversation on the calling device; only a
// viewing writer may answer an approval.
//
// The store takes no actor: the caller authorizes before it calls (as with
// `getProject` in the member store). It has no timer and does no I/O; expiry is
// checked lazily against the injected clock, and expired records are pruned
// whenever they are met. A malformed id is never stored and is never viewing.
// At capacity a new record first drops expired ones and, if still full, is
// refused: the caller is then not viewing (fail closed). A device holds at most 32 records (slice 3-6b
// review): a new one past that drops that device's own least recently touched record, so one device can
// never fill the store for the others.

const { isId, isSessionId } = require('./ids');

const VIEWER_LIMITS = Object.freeze({
  TTL_MS: 45_000,
  // Eight members, three devices each, with room for several open
  // conversations per device.
  CAPACITY: 512,
  PER_DEVICE: 32,
});

function validPair(sessionId, deviceId) {
  return isSessionId(sessionId) && isId('device', deviceId);
}

function monotonicMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function createViewers({ clock = monotonicMs, ttlMs = VIEWER_LIMITS.TTL_MS, capacity = VIEWER_LIMITS.CAPACITY } = {}) {
  if (typeof clock !== 'function') throw new TypeError('createViewers needs a clock function.');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError('ttlMs must be a positive integer.');
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new TypeError('capacity must be a positive integer.');

  // sessionId -> Map(deviceId -> touchedAt)
  const bySession = new Map();
  // deviceId -> how many records it holds
  const perDevice = new Map();
  // deviceId -> its member id, as the router last named it (slice 3-9: `session.view` answers member ids).
  // Held while the device holds a record; a device belongs to one member.
  const memberOf = new Map();
  let count = 0;

  function now() {
    const value = clock();
    return Number.isFinite(value) ? value : null;
  }

  // A record touched in the future (the clock moved back) is not live.
  function live(touchedAt, at) {
    return at !== null && at >= touchedAt && at - touchedAt < ttlMs;
  }

  // `add` and `remove` are the only writers of `bySession`, `perDevice` and `count`.
  function add(sessionId, deviceId, at) {
    const devices = bySession.get(sessionId);
    if (devices) devices.set(deviceId, at);
    else bySession.set(sessionId, new Map([[deviceId, at]]));
    perDevice.set(deviceId, (perDevice.get(deviceId) ?? 0) + 1);
    count += 1;
  }

  function remove(sessionId, deviceId) {
    const devices = bySession.get(sessionId);
    if (!devices || !devices.delete(deviceId)) return false;
    count -= 1;
    const held = perDevice.get(deviceId) - 1;
    if (held > 0) perDevice.set(deviceId, held);
    else {
      perDevice.delete(deviceId);
      memberOf.delete(deviceId);
    }
    if (devices.size === 0) bySession.delete(sessionId);
    return true;
  }

  // The device's least recently touched record goes (at most 512 records are scanned).
  function dropOldestOf(deviceId) {
    let oldest = null;
    for (const [sessionId, devices] of bySession) {
      const touchedAt = devices.get(deviceId);
      if (touchedAt !== undefined && (oldest === null || touchedAt < oldest.touchedAt)) oldest = { sessionId, touchedAt };
    }
    if (oldest) remove(oldest.sessionId, deviceId);
  }

  function removeWhere(test) {
    let dropped = 0;
    for (const [sessionId, devices] of [...bySession]) {
      for (const [deviceId, touchedAt] of [...devices]) {
        if (test(sessionId, deviceId, touchedAt) && remove(sessionId, deviceId)) dropped += 1;
      }
    }
    return dropped;
  }

  // `at` is always a finite time here: a record is removed only when a real
  // reading shows it is not live.
  function pruneExpired(at) {
    return removeWhere((_sessionId, _deviceId, touchedAt) => !live(touchedAt, at));
  }

  // `memberId` (optional, slice 3-9) is the caller's trusted member id; an invalid one is not kept.
  function noteMember(deviceId, memberId) {
    if (isId('member', memberId)) memberOf.set(deviceId, memberId);
  }

  function touch(sessionId, deviceId, memberId) {
    if (!validPair(sessionId, deviceId)) return false;
    const at = now();
    if (at === null) return false;
    const existing = bySession.get(sessionId);
    if (existing && existing.has(deviceId)) {
      existing.set(deviceId, at);
      noteMember(deviceId, memberId);
      return true;
    }
    if ((perDevice.get(deviceId) ?? 0) >= VIEWER_LIMITS.PER_DEVICE) dropOldestOf(deviceId);
    if (count >= capacity) pruneExpired(at);
    if (count >= capacity) return false;
    // Read the conversation's map only after the prune, which may have removed it.
    add(sessionId, deviceId, at);
    noteMember(deviceId, memberId);
    return true;
  }

  function isViewing(sessionId, deviceId) {
    if (!validPair(sessionId, deviceId)) return false;
    const touchedAt = bySession.get(sessionId)?.get(deviceId);
    if (touchedAt === undefined) return false;
    const at = now();
    if (live(touchedAt, at)) return true;
    if (at !== null) remove(sessionId, deviceId);
    return false;
  }

  function viewersOf(sessionId) {
    if (!isSessionId(sessionId)) return [];
    const devices = bySession.get(sessionId);
    if (!devices) return [];
    const at = now();
    if (at === null) return [];
    const out = [];
    for (const [deviceId, touchedAt] of [...devices]) {
      if (live(touchedAt, at)) out.push(deviceId);
      else remove(sessionId, deviceId);
    }
    return out;
  }

  // The member ids with a live record on this conversation, each once, in record order; a device whose
  // member was never named is left out.
  function membersOf(sessionId) {
    const out = [];
    for (const deviceId of viewersOf(sessionId)) {
      const memberId = memberOf.get(deviceId);
      if (memberId && !out.includes(memberId)) out.push(memberId);
    }
    return out;
  }

  function drop(sessionId, deviceId) {
    return validPair(sessionId, deviceId) && remove(sessionId, deviceId);
  }

  function dropDevice(deviceId) {
    if (!isId('device', deviceId)) return 0;
    return removeWhere((_sessionId, candidate) => candidate === deviceId);
  }

  function dropSession(sessionId) {
    if (!isSessionId(sessionId)) return 0;
    return removeWhere((candidate) => candidate === sessionId);
  }

  // The predicate sees a fresh `{ sessionId, deviceId }` per record.
  function dropWhere(predicate) {
    if (typeof predicate !== 'function') throw new TypeError('dropWhere needs a predicate.');
    return removeWhere((sessionId, deviceId) => predicate({ sessionId, deviceId }) === true);
  }

  return {
    ttlMs,
    capacity,
    touch,
    isViewing,
    viewersOf,
    membersOf,
    drop,
    dropDevice,
    dropSession,
    dropWhere,
    size: () => count,
  };
}

module.exports = { VIEWER_LIMITS, createViewers };
