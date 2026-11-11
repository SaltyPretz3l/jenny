'use strict';

// Team presence on the host (row 123 slice 2a-3b, TEAM_CHAT_SPEC "Unread,
// receipts and presence"). In memory only; nothing is persisted.
//
//   online   the member has at least one authenticated event stream and at
//            least one streaming device has not reported idle
//   away     every streaming device reported idle (`team.presence.set`)
//   offline  30 s after the member's last stream closed
//
// Each change publishes the ephemeral `team_presence { member_id, state,
// last_seen_at }` to the active members; it is never stored or replayed. The
// state is bounded by the member table: only active members are tracked, at
// most 64, each with at most 16 streaming devices. One injected timer facility
// (unref'd timeouts) holds the offline delays; `dispose()` clears every one and
// later calls do nothing. Logs carry nothing: presence has no failure to log.

const { LIMITS } = require('./team-chat-schema');

const OFFLINE_DELAY_MS = 30_000;
const MEMBERS_MAX = LIMITS.MEMBERS_MAX;
const DEVICES_MAX = 16;

function createTeamPresence({
  activeMemberIds, publish = null, clock = Date.now, timers = { setTimeout, clearTimeout },
  offlineDelayMs = OFFLINE_DELAY_MS,
} = {}) {
  if (typeof activeMemberIds !== 'function') throw new TypeError('Team presence needs the active member list.');
  if (!timers || typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
    throw new TypeError('Team presence needs a timer facility.');
  }
  // member id -> { devices: Map<device id, { streams, idle }>, state, last_seen_at, timer }
  const members = new Map();
  // The last time an offline member was seen, bounded like the table.
  const offlineSeen = new Map();
  let disposed = false;

  const iso = () => new Date(clock()).toISOString();

  function activeSet() {
    try {
      const ids = activeMemberIds();
      return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);
    } catch (_error) {
      return new Set();
    }
  }

  function announce(memberId, entry, audience) {
    if (typeof publish !== 'function') return;
    try {
      publish('team_presence', { member_id: memberId, state: entry.state, last_seen_at: entry.last_seen_at },
        { audience, ephemeral: true });
    } catch (_error) { /* transport is best effort */ }
  }

  function clearTimer(entry) {
    if (entry.timer) timers.clearTimeout(entry.timer);
    entry.timer = null;
  }

  // Members no longer active leave the table silently (they receive nothing either).
  function forgetInactive(active) {
    for (const [memberId, entry] of members) {
      if (active.has(memberId)) continue;
      clearTimer(entry);
      members.delete(memberId);
    }
  }

  function liveState(entry) {
    const streaming = [...entry.devices.values()].filter((device) => device.streams > 0);
    if (streaming.length === 0) return null;
    return streaming.every((device) => device.idle) ? 'away' : 'online';
  }

  // Recomputes one member's state and publishes a change. With no stream left
  // the state holds until the offline timer fires.
  function settle(memberId, entry, active) {
    const next = liveState(entry);
    if (next === null) {
      if (!entry.timer && entry.state !== 'offline') {
        entry.timer = timers.setTimeout(() => goOffline(memberId), offlineDelayMs);
        entry.timer?.unref?.();
      }
      return;
    }
    clearTimer(entry);
    if (next !== entry.state) {
      entry.state = next;
      announce(memberId, entry, active);
    }
  }

  function goOffline(memberId) {
    const entry = members.get(memberId);
    if (disposed || !entry) return;
    entry.timer = null;
    const active = activeSet();
    forgetInactive(active);
    if (!members.has(memberId) || liveState(entry) !== null) return;
    entry.state = 'offline';
    announce(memberId, entry, active);
    members.delete(memberId); // offline needs no entry: stateOf answers offline with no last_seen_at
    offlineSeen.set(memberId, entry.last_seen_at);
    while (offlineSeen.size > MEMBERS_MAX) offlineSeen.delete(offlineSeen.keys().next().value);
  }

  function entryFor(memberId, active) {
    let entry = members.get(memberId);
    if (entry) return entry;
    if (!active.has(memberId) || members.size >= MEMBERS_MAX) return null;
    entry = { devices: new Map(), state: 'offline', last_seen_at: offlineSeen.get(memberId) ?? null, timer: null };
    members.set(memberId, entry);
    return entry;
  }

  // From the team HTTP layer: an authenticated stream opened or closed.
  function streamChanged(memberId, deviceId, change) {
    if (disposed || typeof memberId !== 'string' || typeof deviceId !== 'string') return;
    const active = activeSet();
    forgetInactive(active);
    const entry = change === 'open' ? entryFor(memberId, active) : members.get(memberId);
    if (!entry) return;
    const device = entry.devices.get(deviceId);
    if (change === 'open') {
      if (device) device.streams += 1;
      else if (entry.devices.size < DEVICES_MAX) entry.devices.set(deviceId, { streams: 1, idle: false });
      else return;
    } else if (change === 'close') {
      if (!device) return;
      device.streams -= 1;
      if (device.streams <= 0) entry.devices.delete(deviceId);
    } else {
      return;
    }
    entry.last_seen_at = iso();
    settle(memberId, entry, active);
  }

  // True when `setIdle` with these arguments would change something: a
  // streaming device reporting the other state. The command layer spends a
  // rate-limit token only then.
  function wouldChange(memberId, deviceId, idle) {
    const device = disposed ? undefined : members.get(memberId)?.devices.get(deviceId);
    return Boolean(device) && device.idle !== (idle === true);
  }

  // From `team.presence.set`: a streaming device reports idle or active. A
  // device with no stream has no state to change.
  function setIdle(memberId, deviceId, idle) {
    if (disposed) return;
    const active = activeSet();
    forgetInactive(active);
    if (!wouldChange(memberId, deviceId, idle)) return;
    const device = members.get(memberId).devices.get(deviceId);
    device.idle = idle === true;
    const entry = members.get(memberId);
    entry.last_seen_at = iso();
    settle(memberId, entry, active);
  }

  // `{ state, last_seen_at }` for one member: offline when untracked.
  function stateOf(memberId) {
    const entry = members.get(memberId);
    if (entry) return { state: entry.state, last_seen_at: entry.last_seen_at };
    return { state: 'offline', last_seen_at: offlineSeen.get(memberId) ?? null };
  }

  function dispose() {
    disposed = true;
    for (const entry of members.values()) clearTimer(entry);
    members.clear();
    offlineSeen.clear();
  }

  return Object.freeze({
    streamChanged, setIdle, stateOf, wouldChange, dispose,
    // Test-only: how much state is held. No production caller.
    size: () => ({ members: members.size, timers: [...members.values()].filter((entry) => entry.timer).length,
      offline: offlineSeen.size }),
  });
}

module.exports = { createTeamPresence };
