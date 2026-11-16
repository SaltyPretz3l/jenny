'use strict';

// The host bridge's `onChange` callback against the fake bridge child: called with no argument
// when the held mapping, relay word or path counts move, only while ready; a repeated line is not a
// change; a callback that throws or returns a rejected promise is logged once and never reaches the
// child's line handling.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createHostBridge } = require('../../server/team/transport/host-bridge');
const { createFakeBridgeSpawner } = require('./helpers/fake-bridge');
const { createFakeTransport, waitFor } = require('./helpers/fake-team-transport');

const RELAY = Object.freeze({ url: 'https://relay.example.com:8443', token: 'tok-SECRET-relay.1~' });
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const FAILED = 'team.bridge.on_change_failed';

function setup(t, onChange) {
  const logs = [];
  const spawner = createFakeBridgeSpawner(createFakeTransport(), { silent: true });
  const bridge = createHostBridge({
    spawnChild: spawner, secretKey: new Uint8Array(32).fill(9), loopbackPort: 4321, bootSecret: new Uint8Array(32).fill(3),
    admit: () => 'device', relay: RELAY, onChange, log: (event, fields) => logs.push({ event, fields }),
  });
  t.after(() => bridge.stop());
  return { bridge, logs, spawner };
}

async function start(env, beforeReady = []) {
  const starting = env.bridge.start();
  const child = env.spawner.last();
  await waitFor(() => child.received.length === 1);
  for (const line of beforeReady) child.write(line);
  child.write({ t: 'ready', public_key: b64(new Uint8Array(32).fill(5)), addresses: ['127.0.0.1:40404'] });
  await starting;
  return child;
}

test('onChange: once per moved mapping, relay and path counts, only while ready; a throw is logged once', async (t) => {
  let calls = 0;
  let throwing = false;
  const onChange = (...args) => { calls += 1; assert.equal(args.length, 0); if (throwing) throw new Error('caller failed'); };
  const env = setup(t, onChange);
  const child = await start(env, [{ t: 'mapping', state: 'requesting', external: null }, { t: 'relay', state: 'connecting' }]);
  const stats = { t: 'stats', connections: 1, streams: 1, refused_streams: 0, refused_connections: 0 };
  const lines = [{ t: 'mapping', state: 'requesting', external: null }, { t: 'mapping', state: 'open' },
    { t: 'relay', state: 'connected' }, { t: 'relay', state: 'open' },
    { ...stats, direct_external_connections: 1, relayed_connections: 0 },
    { ...stats, streams: 2, direct_external_connections: 1, relayed_connections: 0 },
    { ...stats, direct_external_connections: -1, relayed_connections: 0 }, { ...stats, direct_external_connections: 1, relayed_connections: 1 }];
  for (const line of lines) child.write(line);
  await waitFor(() => env.bridge.stats().relayedConnections === 1);
  assert.equal(calls, 4, 'the first mapping after ready, the relay, and the two stats lines whose path counts moved');
  throwing = true;
  child.write({ t: 'relay', state: 'denied' });
  child.write({ t: 'relay', state: 'unreachable' });
  await waitFor(() => env.bridge.relay() === 'unreachable');
  assert.equal(calls, 6, 'the next line is still handled after a throw');
  assert.deepEqual(env.logs.filter((entry) => entry.event === FAILED), [{ event: FAILED, fields: {} }]);
});

test('onChange: a repeated mapping or relay line is not a change; a different one is', async (t) => {
  let calls = 0;
  const env = setup(t, () => { calls += 1; });
  const child = await start(env);
  const mapped = { t: 'mapping', state: 'mapped', external: '203.0.113.7:4444' };
  child.write(mapped);
  child.write({ ...mapped });
  child.write({ t: 'relay', state: 'connected' });
  child.write({ t: 'relay', state: 'connected' });
  await waitFor(() => env.bridge.relay() === 'connected');
  assert.equal(calls, 2, 'one call for the mapping, one for the relay');
  child.write({ ...mapped, external: '203.0.113.8:4444' });
  await waitFor(() => env.bridge.mapping()?.external === '203.0.113.8:4444');
  assert.equal(calls, 3, 'a new outside address is a change');
  child.write({ t: 'mapping', state: 'unavailable', external: null });
  child.write({ t: 'relay', state: 'denied' });
  await waitFor(() => env.bridge.relay() === 'denied');
  assert.equal(calls, 5, 'a new state word is a change, for each');
});

test('onChange: a returned rejected promise is logged once and is not an unhandled rejection', async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));
  let calls = 0;
  const env = setup(t, () => { calls += 1; return Promise.reject(new Error('async caller failed')); });
  const child = await start(env);
  child.write({ t: 'relay', state: 'connected' });
  child.write({ t: 'relay', state: 'denied' });
  await waitFor(() => env.bridge.relay() === 'denied');
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.equal(calls, 2);
  assert.deepEqual(env.logs.filter((entry) => entry.event === FAILED), [{ event: FAILED, fields: {} }]);
  assert.deepEqual(unhandled, []);
});

// Without a relay the first real test could never read "a member reached this PC from outside".
test('internet joining without a relay counts direct-external connections; a LAN bridge does not', async (t) => {
  const make = (internet) => {
    const spawner = createFakeBridgeSpawner(createFakeTransport(), { silent: true });
    let calls = 0;
    const bridge = createHostBridge({
      spawnChild: spawner, secretKey: new Uint8Array(32).fill(9), loopbackPort: 4321, bootSecret: new Uint8Array(32).fill(3),
      directPort: 4455, admit: () => 'device', internet, onChange: () => { calls += 1; }, log: () => {},
    });
    t.after(() => bridge.stop());
    return { bridge, spawner, logs: [], calls: () => calls };
  };
  const line = { t: 'stats', connections: 1, streams: 1, refused_streams: 0, refused_connections: 0,
    direct_external_connections: 1, relayed_connections: 0 };

  const on = make({ mapPort: true });
  const onChild = await start(on);
  assert.equal(on.bridge.stats().directExternalConnections, 0);
  onChild.write(line);
  await waitFor(() => on.bridge.stats().directExternalConnections === 1);
  assert.equal(on.calls(), 1);

  const lan = make(null);
  const lanChild = await start(lan);
  lanChild.write(line);
  await waitFor(() => lan.bridge.stats().streams === 1);
  assert.equal(lan.bridge.stats().directExternalConnections, undefined);
  assert.equal(lan.calls(), 0);
});

// A new invite waits here, so it is not made before the router's outside address is known.
test('mappingSettled: at once with no request open, on the answer, at the bound, and when the child is gone', async (t) => {
  const hold = setTimeout(() => {}, 30_000); // the wait's own timer is unref'd
  t.after(() => clearTimeout(hold));
  const env = setup(t, () => {});
  const child = await start(env);
  await env.bridge.mappingSettled(60_000);
  child.write({ t: 'mapping', state: 'requesting', external: null });
  await waitFor(() => env.bridge.mapping()?.state === 'requesting');
  let answered = false;
  const onAnswer = env.bridge.mappingSettled(60_000).then(() => { answered = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answered, false);
  child.write({ t: 'mapping', state: 'mapped', external: '203.0.113.9:5999' });
  await onAnswer;
  assert.equal(env.bridge.mapping().external, '203.0.113.9:5999');

  child.write({ t: 'mapping', state: 'requesting', external: null });
  await waitFor(() => env.bridge.mapping()?.state === 'requesting');
  await env.bridge.mappingSettled(20);
  const onGone = env.bridge.mappingSettled(60_000);
  await env.bridge.stop();
  await onGone;
});
