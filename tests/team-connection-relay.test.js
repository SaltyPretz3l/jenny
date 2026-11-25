'use strict';

// The saved relay on the member's dial (TEAM_INTERNET_SPEC "5-5c as built"): the connection manager reads the
// saved `relay_url` and its token for every dial and passes `{ url, token }` to the member bridge's start line; a
// relay the bridge reports as `relay_denied` is not asked again by that manager, which goes on to the remaining
// address sets (the direct hints) without it in the same attempt; a token store that cannot answer dials nothing. Against the real host and the fake bridge
// child, with a bridge stub that reports a relay reason in place of a dial.

const assert = require('node:assert/strict');
const test = require('node:test');

const { TEAM_ERROR_CODES } = require('../services/backend/error-codes');
const { loadClientFile, saveClientFile } = require('../services/team/client-file');
const { createConnectionManager } = require('../services/team/connection-manager');
const { createDeviceKeyStore } = require('../services/team/device-key-store');
const { TeamError } = require('../services/team/team-errors');
const { createMemberBridge } = require('../services/team/transport/member-bridge');
const { waitUntil } = require('./helpers/team-client-host');
const { countingTimers, startLines } = require('./helpers/team-dial-helpers');
const { savedTeam } = require('./helpers/team-saved');

const RELAY = 'https://relay.example.net';
const RELAY_TOKEN = 'tok_Secret-123';

// A joined member, stopped, whose record names a relay (`relayUrl`, null for none) and whose token is saved (or not).
async function relayMember(t, { relayUrl = RELAY, token = null, schema3 = true, twoSets = false } = {}) {
  const { host, me } = await savedTeam(t, { member: true });
  const deviceKeys = createDeviceKeyStore({ getSecureStore: () => host.secureStore });
  if (token) deviceKeys.saveRelayToken(me.teamId, token);
  const saved = loadClientFile(host.userData, me.teamId).record;
  const record = { ...saved, ...(schema3 ? { schema_version: 3, host_name: null, relay_url: relayUrl } : {}),
    ...(twoSets ? { last_addresses: ['198.51.100.2:4242'] } : {}) };
  assert.equal(saveClientFile(host.userData, record).ok, true);
  return { host, me, record, deviceKeys };
}

// A manager over the real fake bridge. `replies[n]` is the reason the n-th dial's bridge reports instead of
// dialling ('relay_denied', 'relay_unreachable', 'host_unreachable'); a dial with none dials for real. `dials` records
// what each dial was given and the state the manager showed as it began.
function relayManager(t, { host, record, deviceKeys }, { replies = [], store = deviceKeys, timers, onDial = () => {}, wrap = (bridge) => bridge } = {}) {
  const dials = [];
  const holder = {};
  const createBridge = (options) => {
    const shown = holder.manager ? holder.manager.snapshot() : null;
    dials.push({ relay: options.relay ? { ...options.relay } : null, addresses: [...options.addresses],
      shown: shown && [shown.state, shown.reason] });
    onDial(dials.length);
    const reason = replies[dials.length - 1];
    if (!reason) return wrap(createMemberBridge(options));
    return { start: async () => ({ state: 'offline', reason }), port: () => null, stop: async () => {} };
  };
  const manager = createConnectionManager({
    record, deviceKeys: store, saveRecord: (next) => saveClientFile(host.userData, next), spawnChild: host.memberSpawner,
    appVersion: '1.6.1', backoff: { initialMs: 20, maxMs: 80 }, createBridge, log: host.log, ...(timers ? { timers } : {}),
  });
  holder.manager = manager;
  t.after(() => manager.stop());
  return { manager, dials };
}

// A token store that counts its reads of the team's relay token.
function countingStore(deviceKeys) {
  const store = { ...deviceKeys, reads: 0, loadRelayToken: (...args) => { store.reads += 1; return deviceKeys.loadRelayToken(...args); } };
  return store;
}

// Fault: the saved relay never reaching the bridge's start line (a member who can only be reached through the
// owner's relay is never connected), or the token logged, put in the snapshot or pushed.
test('a saved relay URL with its token reaches the start line as { url, token }, and the token is nowhere else', async (t) => {
  const member = await relayMember(t, { token: RELAY_TOKEN });
  const before = member.host.memberSpawner.children.length;
  const { manager, dials } = relayManager(t, member);
  manager.start();
  assert.ok(await waitUntil(() => manager.snapshot().state === 'online'));
  assert.deepEqual(dials[0].relay, { url: RELAY, token: RELAY_TOKEN });
  assert.deepEqual(startLines(member.host, before)[0].relay, { url: RELAY, token: RELAY_TOKEN });
  const exposed = JSON.stringify([member.host.logs, manager.snapshot(), member.host.states]);
  assert.equal(exposed.includes(RELAY_TOKEN), false, 'no token in a log, a snapshot or a push');
  assert.equal(exposed.includes(RELAY), false, 'and no relay URL');
  assert.equal(JSON.stringify(loadClientFile(member.host.userData, member.me.teamId).record).includes(RELAY_TOKEN), false);
});

test('a saved relay URL with no saved token reaches the start line as { url, token: null }', async (t) => {
  const member = await relayMember(t);
  const before = member.host.memberSpawner.children.length;
  const { manager } = relayManager(t, member);
  manager.start();
  assert.ok(await waitUntil(() => manager.snapshot().state === 'online'));
  assert.deepEqual(startLines(member.host, before)[0].relay, { url: RELAY, token: null });
});

// Fault: a stored token with no URL presented to a host that has no relay, or the token store read for nothing.
test('a null URL and a schema 2 record send no relay key and never read the token store', async (t) => {
  for (const options of [{ relayUrl: null, token: RELAY_TOKEN }, { schema3: false, token: RELAY_TOKEN }]) {
    const member = await relayMember(t, options);
    const store = countingStore(member.deviceKeys);
    const before = member.host.memberSpawner.children.length;
    const { manager } = relayManager(t, member, { store });
    manager.start();
    assert.ok(await waitUntil(() => manager.snapshot().state === 'online'));
    assert.equal(Object.hasOwn(startLines(member.host, before)[0], 'relay'), false, JSON.stringify(options));
    assert.equal(store.reads, 0, 'the token was not read');
    await manager.stop();
  }
});

// Fault: the token read once at start, so a token saved after a reconnect is never used without a restart.
test('a token saved between two dials is on the second start line', async (t) => {
  const member = await relayMember(t);
  const before = member.host.memberSpawner.children.length;
  // The first dial fails; the token is saved as that dial's bridge is made, after the dial read the empty store.
  const { manager, dials } = relayManager(t, member, { replies: ['host_unreachable'],
    onDial: (count) => { if (count === 1) member.deviceKeys.saveRelayToken(member.me.teamId, RELAY_TOKEN); } });
  manager.start();
  assert.ok(await waitUntil(() => manager.snapshot().state === 'online'));
  assert.deepEqual(dials[0].relay, { url: RELAY, token: null });
  assert.deepEqual(dials[1].relay, { url: RELAY, token: RELAY_TOKEN });
  assert.deepEqual(startLines(member.host, before)[0].relay, { url: RELAY, token: RELAY_TOKEN });
});

// Fault: a dial without the relay when the token store cannot answer (half a relay, or no check at all).
test('a token store that throws dials nothing, is offline with the key store failure\'s code, and is retried', async (t) => {
  const member = await relayMember(t, { token: RELAY_TOKEN });
  let reads = 0;
  const store = { ...member.deviceKeys, loadRelayToken: () => {
    reads += 1;
    throw new TeamError('DEVICE_KEY_UNAVAILABLE', 'team_relay_token_unavailable');
  } };
  const { manager, dials } = relayManager(t, member, { store });
  manager.start();
  assert.ok(await waitUntil(() => reads >= 2), 'tried again');
  assert.equal(dials.length, 0, 'no bridge was created');
  const state = manager.snapshot();
  assert.deepEqual([state.state, state.reason, state.code],
    ['offline', 'team_relay_token_unavailable', TEAM_ERROR_CODES.DEVICE_KEY_UNAVAILABLE]);
  assert.equal(JSON.stringify([member.host.logs, state]).includes(RELAY_TOKEN), false);
});

// Fault (review Part III): a denied relay token ending the attempt before the direct address hints were tried, or
// presented again on the next set or the next retry.
test('relay_denied goes on to the remaining address sets without the relay and never reads the token again', async (t) => {
  const member = await relayMember(t, { token: RELAY_TOKEN, twoSets: true });
  const store = countingStore(member.deviceKeys);
  const before = member.host.memberSpawner.children.length;
  const timers = countingTimers();
  const { manager, dials } = relayManager(t, member, { store, timers, replies: ['relay_denied'] });
  manager.start();
  assert.ok(await waitUntil(() => manager.snapshot().state === 'online', { attempts: 200 }));
  assert.equal(dials.length, 2, 'the second set was dialled in the same attempt');
  assert.deepEqual(dials[0].relay, { url: RELAY, token: RELAY_TOKEN });
  assert.notDeepEqual(dials[1].addresses, dials[0].addresses, 'the next dial is the next address set');
  assert.equal(dials[1].relay, null, 'no relay after the refusal');
  assert.equal(store.reads, 1, 'the token was read once and not again');
  assert.equal(Object.hasOwn(startLines(member.host, before)[0], 'relay'), false, 'the direct dial that connected had no relay');
  assert.deepEqual(timers.delays.filter((ms) => ms <= 80), [], 'no backoff wait between the sets');
  assert.equal(JSON.stringify([member.host.logs, manager.snapshot()]).includes(RELAY_TOKEN), false);
});

test('a relay_denied attempt whose remaining sets fail says relay_denied, and the retry passes no relay', async (t) => {
  const member = await relayMember(t, { token: RELAY_TOKEN, twoSets: true });
  const store = countingStore(member.deviceKeys);
  const timers = countingTimers();
  const { manager, dials } = relayManager(t, member, { store, timers,
    replies: ['relay_denied', 'host_unreachable', 'host_unreachable'] });
  manager.start();
  assert.ok(await waitUntil(() => manager.snapshot().state === 'online', { attempts: 200 }));
  assert.deepEqual(dials[1].shown, ['connecting', null], 'the second set followed in the same attempt');
  assert.deepEqual(dials[2].shown, ['offline', 'relay_denied'], 'the failed attempt says why');
  assert.ok(dials.slice(1).every((dial) => dial.relay === null), 'no relay after the refusal');
  assert.equal(store.reads, 1);
  assert.ok(timers.delays[0] <= 20 && timers.delays[0] >= 16, `the normal backoff: ${timers.delays}`);
});

test('relay_denied is reported as offline with CMP-TEAM-0001, and a second manager asks the relay again', async (t) => {
  const member = await relayMember(t, { token: RELAY_TOKEN });
  const first = relayManager(t, member, { replies: ['relay_denied', 'host_unreachable'] });
  first.manager.start();
  assert.ok(await waitUntil(() => first.dials.length >= 2));
  const state = first.manager.snapshot();
  assert.deepEqual([state.state, state.reason, state.code], ['offline', 'relay_denied', TEAM_ERROR_CODES.CONNECTION_FAILED]);
  await first.manager.stop();
  const second = relayManager(t, member);
  second.manager.start();
  assert.ok(await waitUntil(() => second.manager.snapshot().state === 'online'));
  assert.deepEqual(second.dials[0].relay, { url: RELAY, token: RELAY_TOKEN }, 'a new manager passes the relay again');
});

test('relay_unreachable is offline, and retried with the relay on the next attempt', async (t) => {
  const member = await relayMember(t, { token: RELAY_TOKEN });
  const { manager, dials } = relayManager(t, member, { replies: ['relay_unreachable'] });
  manager.start();
  assert.ok(await waitUntil(() => manager.snapshot().state === 'online'));
  assert.deepEqual(dials[0].relay, { url: RELAY, token: RELAY_TOKEN });
  assert.deepEqual(dials[1].relay, { url: RELAY, token: RELAY_TOKEN }, 'asked again');
  assert.deepEqual(dials[1].shown, ['offline', 'relay_unreachable']);
});

// Fault (slice 5-6): the member row's Connection line has nothing to say how this Jenny reaches the host, or it
// says a path while offline.
test('the snapshot carries the live bridge path while online and null otherwise', async (t) => {
  const member = await relayMember(t, { token: RELAY_TOKEN });
  const { manager } = relayManager(t, member, { wrap: (bridge) => ({ ...bridge, path: () => (bridge.port() ? 'relay' : null) }) });
  assert.equal(manager.snapshot().path, null);
  manager.start();
  assert.ok(await waitUntil(() => manager.snapshot().state === 'online'));
  assert.equal(manager.snapshot().path, 'relay');
  await manager.stop();
  assert.equal(manager.snapshot().path, null);
});
