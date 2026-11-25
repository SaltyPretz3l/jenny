'use strict';

// The host's known keys for the transport bridge (team review fixes, row 201, C3). The bridge gives a relayed dial
// that claims one of these keys a path strangers cannot fill (host-bridge.js `setKnownKeys`); a key it newly hears
// has its cooldown cleared, which is how a redeem ends the cooldown of the device key it admitted (H11). The set is
// the public keys the directory would admit now, devices first, then live invites, at most MAX_KNOWN_KEYS: the
// directory's own `admitKind` decides, exactly as the bridge's `admit` question is answered, so this holds no
// membership logic. Final admission stays with `admit`.
//
// Pushed whole when the feed starts, on every membership change, on every invite a commit ended, on the redeem
// route's notice, and when a light poll sees the store's revision move (an invite made commits no event this side
// hears). Public keys only: nothing here is a secret or reaches a log.

const { PUBLIC_KEY_BYTES, decodeBase64url } = require('../ids');
const { MAX_KNOWN_KEYS } = require('./host-bridge');

// How often the store's revision is looked at between events.
const REFRESH_MS = 2000;

/** The keys the directory admits now, as base64url: devices, then live invites, each once, at most MAX_KNOWN_KEYS. */
function knownKeysOf(store) {
  const doc = store.snapshot();
  if (!doc) return [];
  const keys = [];
  const add = (text) => {
    if (keys.length < MAX_KNOWN_KEYS && !keys.includes(text) && store.directory.admitKind(text) !== null) keys.push(text);
  };
  for (const device of doc.devices) add(device.public_key);
  for (const invite of doc.invites) add(invite.invite_public_key);
  return keys;
}

/**
 * `bridge()` answers the host bridge or null (it does not exist yet, or is gone). `start()` pushes the set and
 * subscribes; `refresh()` pushes it when it moved; `dispose()` ends the poll and the subscriptions.
 */
function createKnownKeysFeed({ store, bridge, intervalMs = REFRESH_MS, timers = globalThis }) {
  let sent = null;
  let seenRev = null;
  let timer = null;
  const unsubscribes = [];

  function refresh() {
    const target = bridge();
    if (!target || typeof target.setKnownKeys !== 'function') return;
    seenRev = store.rev();
    const keys = knownKeysOf(store);
    const text = keys.join(',');
    if (text === sent) return;
    target.setKnownKeys(keys.map((key) => decodeBase64url(key, PUBLIC_KEY_BYTES)).filter(Boolean));
    sent = text;
  }

  // A refresh that throws (a store gone broken) leaves the last set standing; the bridge's `admit` still decides.
  function safeRefresh() {
    try { refresh(); } catch { /* the next event or poll tries again */ }
  }

  function start() {
    if (timer !== null) return;
    unsubscribes.push(store.onMembershipChange(safeRefresh), store.onInviteKeysEnded(safeRefresh));
    timer = timers.setInterval(() => { if (store.rev() !== seenRev) safeRefresh(); }, intervalMs);
    timer?.unref?.();
    safeRefresh();
  }

  function dispose() {
    if (timer !== null) timers.clearInterval(timer);
    timer = null;
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  }

  return { start, refresh: safeRefresh, dispose };
}

module.exports = { REFRESH_MS, createKnownKeysFeed, knownKeysOf };
