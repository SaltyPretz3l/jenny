'use strict';

// new-test-file: tests/server/team-bridge-supervisor.test.js is at its line cap (590 of 600 lines).
// Team review fixes (row 201): the host bridge supervisor's known keys (C3) and its drop with no open connection
// (H11), and the control channel's error listener (Part III transport). The fault each test catches is named in its
// comment.

const assert = require('node:assert/strict');
const test = require('node:test');

const { MAX_KNOWN_KEYS, createHostBridge } = require('../../server/team/transport/host-bridge');
const { attachControl } = require('../../server/team/transport/control-channel');
const { FakeChildProcess } = require('./helpers/fake-bridge/fake-child');
const { createFakeBridgeSpawner } = require('./helpers/fake-bridge');
const { createFakeTransport, waitFor } = require('./helpers/fake-team-transport');

const bootSecret = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const hostSecret = new Uint8Array(32).fill(9);
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const key = (fill) => new Uint8Array(32).fill(fill);
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function makeHost(t, spawnerOptions = {}) {
  const spawner = createFakeBridgeSpawner(createFakeTransport(), spawnerOptions);
  const bridge = createHostBridge({
    spawnChild: spawner, secretKey: hostSecret, loopbackPort: 4321, bootSecret, admit: () => 'device', log: () => {},
  });
  t.after(() => bridge.stop());
  return { spawner, bridge };
}

// A host bridge whose child answers `start` with this `ready` line (a silent fake child, written by hand).
async function readyWith(t, ready, before = () => {}) {
  const env = makeHost(t, { silent: true });
  before(env.bridge);
  const starting = env.bridge.start();
  const child = env.spawner.last();
  await waitFor(() => child.received.length === 1);
  child.write({ t: 'ready', public_key: b64(key(5)), addresses: ['127.0.0.1:40404'], bulk: 1, ...ready });
  await starting;
  return { ...env, child };
}

const knownLines = (child) => child.received.filter((line) => line.t === 'known_keys');

// C3. Fault: no known keys reach the bridge, so a full relayed table refuses a member; or a set sent piecemeal.
test('known keys reach a bridge that reads them: held until ready, then the whole set on each change', async (t) => {
  const env = await readyWith(t, { known_keys: 1 }, (bridge) => bridge.setKnownKeys([key(1), key(2), key(1)]));
  await waitFor(() => knownLines(env.child).length === 1);
  assert.deepEqual(knownLines(env.child), [{ t: 'known_keys', keys: [b64(key(1)), b64(key(2))] }], 'once each');
  env.bridge.setKnownKeys([key(3)]);
  await waitFor(() => knownLines(env.child).length === 2);
  assert.deepEqual(knownLines(env.child)[1], { t: 'known_keys', keys: [b64(key(3))] }, 'replaced wholesale');
  env.bridge.setKnownKeys([key(3)]);
  await pause(30);
  assert.equal(knownLines(env.child).length, 2, 'an unchanged set is not sent again');
});

// C3. Fault: a bridge from before known keys gets a line it reads as protocol_invalid and exits.
test('a bridge that does not say known_keys: 1 in ready is never sent one', async (t) => {
  for (const value of [undefined, true, '1', 2, 0, null]) {
    const env = await readyWith(t, value === undefined ? {} : { known_keys: value }, (bridge) => bridge.setKnownKeys([key(1)]));
    env.bridge.setKnownKeys([key(2)]);
    await pause(20);
    assert.deepEqual(knownLines(env.child), [], String(value));
  }
});

// C3. Fault: an unbounded set, or a malformed key sent on to the bridge.
test('the known set is capped at MAX_KNOWN_KEYS and every key must be 32 bytes', async (t) => {
  assert.equal(MAX_KNOWN_KEYS, 128);
  const env = await readyWith(t, { known_keys: 1 });
  env.bridge.setKnownKeys(Array.from({ length: 200 }, (_, index) => {
    const bytes = new Uint8Array(32);
    bytes[0] = index;
    bytes[1] = index >> 8;
    return bytes;
  }));
  await waitFor(() => knownLines(env.child).length === 1);
  assert.equal(knownLines(env.child)[0].keys.length, MAX_KNOWN_KEYS);
  assert.throws(() => env.bridge.setKnownKeys([new Uint8Array(31)]), TypeError);
  assert.throws(() => env.bridge.setKnownKeys('not a list'), TypeError);
});

// H11. Fault: a drop for a key with no open connection is skipped, so the bridge's cooldown of that key is never
// cleared (the binary's `drop` clears it, connections or not).
test('a drop for a key with no open connection still reaches the bridge', async (t) => {
  const env = await readyWith(t, {});
  assert.equal(env.bridge.drop(key(9)), 0, 'it had no connections');
  await waitFor(() => env.child.received.some((line) => line.t === 'drop'));
  assert.deepEqual(env.child.received.filter((line) => line.t === 'drop'), [{ t: 'drop', key: b64(key(9)) }]);
});

// Part III transport. Fault: `child.once('error')` leaves no listener after the first error, so a second one (a
// failed kill, a pipe error) is an uncaught exception that takes the process down.
test('the control channel keeps an error listener for the child\'s whole life', async () => {
  const child = new FakeChildProcess();
  const exits = [];
  attachControl(child, { onMessage: () => {}, onExit: (info) => exits.push(info) });
  child.emit('error', new Error('first'));
  assert.doesNotThrow(() => child.emit('error', new Error('second')));
  await waitFor(() => exits.length === 1);
  await pause(20);
  assert.equal(exits.length, 1, 'onExit still fires once');
});
