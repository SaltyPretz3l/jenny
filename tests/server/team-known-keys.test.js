'use strict';

// new-test-file: server/team/transport/known-keys.js is a new surface (team review fixes, row 201, C3/H11).
// The host's known-keys feed for the transport bridge: which keys, when they are pushed, and that the feed ends.

const assert = require('node:assert/strict');
const test = require('node:test');

const { MAX_KNOWN_KEYS } = require('../../server/team/transport/host-bridge');
const { createKnownKeysFeed, knownKeysOf } = require('../../server/team/transport/known-keys');

const keyText = (index) => {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt16BE(index, 0);
  return bytes.toString('base64url');
};

// A store stand-in: a document, a directory that admits what `admitted` holds, events and a revision.
function fakeStore({ devices = [], invites = [], admitted = null } = {}) {
  const listeners = { membership: new Set(), invites: new Set() };
  const store = {
    doc: { devices, invites },
    revision: 1,
    admitted: admitted ?? new Set([...devices.map((d) => d.public_key), ...invites.map((i) => i.invite_public_key)]),
    snapshot: () => JSON.parse(JSON.stringify(store.doc)),
    rev: () => store.revision,
    directory: { admitKind: (text) => (store.admitted.has(text) ? 'device' : null) },
    onMembershipChange: (fn) => { listeners.membership.add(fn); return () => listeners.membership.delete(fn); },
    onInviteKeysEnded: (fn) => { listeners.invites.add(fn); return () => listeners.invites.delete(fn); },
    emitMembership: () => { for (const fn of listeners.membership) fn({ kind: 'admitted' }); },
    emitInvitesEnded: () => { for (const fn of listeners.invites) fn([]); },
    listeners,
  };
  return store;
}

function recordingBridge() {
  const sets = [];
  return { sets, setKnownKeys: (keys) => sets.push(keys.map((key) => Buffer.from(key).toString('base64url'))) };
}

// A timer seam the test drives by hand.
function manualTimers() {
  const timers = { ticks: [], setInterval: (fn) => { timers.ticks.push(fn); return { unref() {} }; }, clearInterval: () => { timers.ticks = []; } };
  return timers;
}

// Fault: a revoked device, a spent invite or a stranger named as known; no bound; invites ahead of devices.
test('the known keys are what the directory admits now, devices first, each once, at most MAX_KNOWN_KEYS', () => {
  const store = fakeStore({
    devices: [{ public_key: keyText(1) }, { public_key: keyText(2) }, { public_key: keyText(1) }],
    invites: [{ invite_public_key: keyText(3) }, { invite_public_key: keyText(4) }],
    admitted: new Set([keyText(1), keyText(3), keyText(4)]),
  });
  assert.deepEqual(knownKeysOf(store), [keyText(1), keyText(3), keyText(4)]);
  const many = fakeStore({ devices: Array.from({ length: 200 }, (_, index) => ({ public_key: keyText(index) })) });
  assert.equal(knownKeysOf(many).length, MAX_KNOWN_KEYS);
  assert.deepEqual(knownKeysOf({ ...store, snapshot: () => null }), [], 'a store that is not open names none');
});

// Fault: the set pushed only at start, so a redeemed device key stays unknown (and cooled) until a restart.
test('the feed pushes at start, on membership and invite events, on refresh and on a revision the poll sees', () => {
  const store = fakeStore({ devices: [{ public_key: keyText(1) }] });
  const bridge = recordingBridge();
  const timers = manualTimers();
  const feed = createKnownKeysFeed({ store, bridge: () => bridge, timers });
  feed.start();
  assert.deepEqual(bridge.sets, [[keyText(1)]]);
  feed.refresh();
  store.emitMembership();
  assert.equal(bridge.sets.length, 1, 'an unchanged set is not pushed again');

  store.doc.devices.push({ public_key: keyText(2) });
  store.admitted.add(keyText(2));
  feed.refresh();
  assert.deepEqual(bridge.sets.at(-1), [keyText(1), keyText(2)], 'the redeem notice pushes the new device key');

  store.admitted.delete(keyText(1));
  store.emitMembership();
  assert.deepEqual(bridge.sets.at(-1), [keyText(2)], 'a revoke takes the key out');

  store.doc.invites.push({ invite_public_key: keyText(9) });
  store.admitted.add(keyText(9));
  timers.ticks[0]();
  assert.equal(bridge.sets.length, 3, 'the poll waits for the revision to move');
  store.revision += 1;
  timers.ticks[0]();
  assert.deepEqual(bridge.sets.at(-1), [keyText(2), keyText(9)], 'a new invite reaches the bridge');

  store.admitted.delete(keyText(9));
  store.emitInvitesEnded();
  assert.deepEqual(bridge.sets.at(-1), [keyText(2)], 'an ended invite leaves the set');
});

// Fault: a feed that keeps polling or listening after the host stopped, or that throws into a store event.
test('dispose ends the poll and the subscriptions; no bridge yet and a broken store push nothing and throw nothing', () => {
  const store = fakeStore({ devices: [{ public_key: keyText(1) }] });
  let bridge = null;
  const timers = manualTimers();
  const feed = createKnownKeysFeed({ store, bridge: () => bridge, timers });
  feed.start();
  bridge = recordingBridge();
  feed.refresh();
  assert.equal(bridge.sets.length, 1);
  store.snapshot = () => { throw new Error('broken'); };
  assert.doesNotThrow(() => store.emitMembership());
  feed.dispose();
  assert.equal(store.listeners.membership.size, 0);
  assert.equal(store.listeners.invites.size, 0);
  assert.deepEqual(timers.ticks, []);
});
