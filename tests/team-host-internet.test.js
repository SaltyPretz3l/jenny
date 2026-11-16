'use strict';

// The owner's internet joining setting on the desktop side (slice 5-5b): the host controller reads the
// owner's relay token before the fork and sends it only in `start`; `hostInternet` checks every field
// before anything is written, saves the token and the setting in that order, restarts a running host
// once and leaves a stopped one stopped; a pushed state that only carries a new verdict reads no file.
// No token and no address reaches an answer, a pushed state, a log line or a file.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { HOST_RELAY_TOKEN_NAME } = require('../services/team/host/host-key-store');
const { loadHostConfig } = require('../server/config');
const { BOUNDS, createFakeFork, createTestHostController, healthyHostScript } = require('./helpers/team-host-fakes');
const { createMemorySecureStore, readTree, tempProfile } = require('./helpers/team-client-host');

const DEPLOY = Object.freeze({ name: 'Studio', display_name: 'Olive Owner', label: 'Desk' });
const RELAY_URL = 'https://relay.example.org';
const TOKEN = 'tok-relay-owner-5b';
const ADDRESS = 'team.example.org';
const PORT = 45123;
const OTHER_PORT = 45999;
// Port probes a test can fail or hold: `fail` probes answer false, then `free`; `hold()` holds every probe until its
// release. The first pick is Deploy's; a later one would move the port.
function portControl() {
  const control = { fail: 0, free: true, picks: 0, held: null };
  control.probeDirectPort = async () => {
    if (control.held) await control.held;
    if (control.fail > 0) { control.fail -= 1; return false; }
    return control.free;
  };
  control.pickDirectPort = async () => { control.picks += 1; return control.picks === 1 ? PORT : OTHER_PORT; };
  control.hold = () => {
    let release;
    control.held = new Promise((resolve) => { release = resolve; });
    return () => { control.held = null; release(); };
  };
  return control;
}
const tick = (ms = 20) => new Promise((resolve) => { setTimeout(resolve, ms); });

const configFile = (userDataPath) => path.join(userDataPath, 'team-host', 'host-config.json');
const readConfig = (userDataPath) => JSON.parse(fs.readFileSync(configFile(userDataPath), 'utf8'));

function writeInternet(userDataPath, internet) {
  const config = readConfig(userDataPath);
  config.team.internet = internet;
  fs.writeFileSync(configFile(userDataPath), JSON.stringify(config));
}

// A deployed profile: Deploy, then (by default) Stop.
async function deployed(t, { stop = true, script = healthyHostScript({ teamId: 'team_x' }), events = [], ...options } = {}) {
  const userDataPath = tempProfile(t, 'jenny-host-internet-');
  const secureStore = options.secureStore ?? createMemorySecureStore();
  const fake = createFakeFork({ script });
  const fork = (...args) => { events.push('fork'); return fake.fork(...args); };
  const made = createTestHostController(t, { userDataPath, secureStore, fork, ...options });
  assert.equal((await made.controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  if (stop) assert.equal((await made.controller.handle('hostStop', {})).ok, true);
  return { ...made, fake, events, userDataPath, secureStore };
}

test('the relay token is read before the fork and travels only in start', async (t) => {
  const secureStore = createMemorySecureStore();
  const events = [];
  const tokens = { load: () => { events.push('load'); return secureStore.values.get(HOST_RELAY_TOKEN_NAME) || null; },
    save: () => {}, remove: () => {} };
  const host = await deployed(t, { secureStore, relayTokens: tokens, events });
  events.length = 0;
  writeInternet(host.userDataPath, { map_port: true, public_address: null, relay_url: RELAY_URL });
  secureStore.values.set(HOST_RELAY_TOKEN_NAME, TOKEN);
  const answer = await host.controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(events, ['load', 'fork'], 'read once, before the one fork');
  const call = host.fake.calls.at(-1);
  assert.equal(call.child.posted[0].relay_token, TOKEN, 'in start');
  assert.deepEqual(Object.keys(call.child.posted[0]), ['type', 'host_key', 'relay_token']);
  const elsewhere = [JSON.stringify(call.args), JSON.stringify(call.options), JSON.stringify(host.logs),
    JSON.stringify(host.pushed), JSON.stringify(answer), ...readTree(host.userDataPath).map((file) => file.text)];
  for (const text of elsewhere) assert.equal(text.includes(TOKEN), false);
  assert.deepEqual(call.child.posted.slice(1).filter((message) => message.relay_token), [], 'and only in start');
});

test('a token store that cannot answer refuses the start with its reason and forks nothing', async (t) => {
  const host = await deployed(t);
  writeInternet(host.userDataPath, { map_port: true, public_address: null, relay_url: RELAY_URL });
  host.secureStore.values.set(HOST_RELAY_TOKEN_NAME, 'not a token');
  const before = fs.readFileSync(configFile(host.userDataPath));
  const forks = host.fake.calls.length;
  const answer = await host.controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(answer.ok, false);
  assert.equal(answer.error.reason, 'team_relay_token_unavailable');
  assert.equal(host.fake.calls.length, forks, 'nothing forked');
  assert.equal(Buffer.compare(fs.readFileSync(configFile(host.userDataPath)), before), 0, 'nothing written');
});

test('a push that only carries a new verdict reads no file', async (t) => {
  const host = await deployed(t, { stop: false });
  // A re-read would now find no config: no port and not deployed.
  fs.rmSync(configFile(host.userDataPath));
  const before = host.pushed.length;
  host.fake.calls.at(-1).child.reply({ type: 'reach', result: 'relay', reason: 'relay_connected' });
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  const pushed = host.pushed.slice(before);
  assert.equal(pushed.length, 1, 'one push');
  assert.deepEqual(pushed[0].reach, { result: 'relay', reason: 'relay_connected' });
  assert.equal(pushed[0].direct_port, 45123, 'the port the host started with, not the file read again');
  assert.equal(pushed[0].deployed, true);
});

test('hostInternet refuses each invalid field before any write', async (t) => {
  const host = await deployed(t);
  host.secureStore.values.set(HOST_RELAY_TOKEN_NAME, TOKEN);
  writeInternet(host.userDataPath, { map_port: true, public_address: null, relay_url: RELAY_URL });
  const before = fs.readFileSync(configFile(host.userDataPath));
  const sets = host.secureStore.sets.length;
  const deletes = host.secureStore.deletes.length;
  const cases = [
    [{ enabled: true, public_address: 'not an address' }, 'team_public_address_invalid'],
    [{ enabled: true, public_address: '127.0.0.1' }, 'team_public_address_invalid'],
    [{ enabled: true, public_address: '' }, 'team_public_address_invalid'],
    [{ enabled: true, relay_url: 'http://relay.example.org' }, 'team_relay_url_invalid'],
    [{ enabled: true, relay_url: 'https://relay.example.org/path' }, 'team_relay_url_invalid'],
    [{ enabled: true, relay_url: RELAY_URL, token: 'has space' }, 'team_relay_token_invalid'],
    [{ enabled: true, relay_url: RELAY_URL, token: 'x'.repeat(49) }, 'team_relay_token_invalid'],
    [{ enabled: true, token: TOKEN }, 'team_relay_token_invalid'],
    [{ enabled: false, relay_url: RELAY_URL }, 'team_request_invalid'],
  ];
  for (const [payload, reason] of cases) {
    const answer = await host.controller.handle('hostInternet', payload);
    assert.equal(answer.ok, false, JSON.stringify(payload));
    assert.deepEqual(answer.error, { code: 'invalid_request', reason }, JSON.stringify(payload));
  }
  assert.equal(Buffer.compare(fs.readFileSync(configFile(host.userDataPath)), before), 0, 'the config is as it was');
  assert.equal(host.secureStore.sets.length, sets, 'no token saved');
  assert.equal(host.secureStore.deletes.length, deletes, 'no token removed');
  assert.equal(host.secureStore.values.get(HOST_RELAY_TOKEN_NAME), TOKEN);
});

test('hostInternet on then off: the setting and the token are saved, then nothing of either is left', async (t) => {
  const host = await deployed(t);
  const on = await host.controller.handle('hostInternet', { enabled: true, public_address: ADDRESS,
    relay_url: 'https://Relay.Example.org:443', token: TOKEN });
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.equal(on.restarted, false, 'a stopped host stays stopped');
  assert.deepEqual(readConfig(host.userDataPath).team.internet, { map_port: true, public_address: ADDRESS, relay_url: RELAY_URL },
    'the relay URL in its canonical form');
  assert.equal(host.secureStore.values.get(HOST_RELAY_TOKEN_NAME), TOKEN);
  assert.equal(loadHostConfig(configFile(host.userDataPath)).team.internet.relayUrl, RELAY_URL, 'the host loader takes it');
  const off = await host.controller.handle('hostInternet', { enabled: false });
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.equal(Object.hasOwn(readConfig(host.userDataPath).team, 'internet'), false);
  assert.equal(host.secureStore.values.has(HOST_RELAY_TOKEN_NAME), false, 'the token is removed');
  assert.deepEqual(host.fake.calls.length, 1, 'neither call started the host');
});

test('a running host is restarted once on the new setting; nothing but start carries the token or the address', async (t) => {
  const host = await deployed(t, { stop: false });
  const forks = host.fake.calls.length;
  const answer = await host.controller.handle('hostInternet', { enabled: true, public_address: ADDRESS, relay_url: RELAY_URL,
    token: TOKEN });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.restarted, true);
  assert.equal(answer.host.state, 'running');
  assert.equal(host.fake.calls.length, forks + 1, 'one restart');
  const restart = host.fake.calls.at(-1);
  assert.equal(restart.args.includes('--team-init') || restart.args.includes('--team-recover'), false, 'no owner flag');
  assert.equal(restart.child.posted[0].relay_token, TOKEN);
  const off = await host.controller.handle('hostInternet', { enabled: false });
  assert.equal(off.restarted, true);
  const next = host.fake.calls.at(-1);
  assert.equal(Object.hasOwn(next.child.posted[0], 'relay_token'), false, 'nothing of the setting in the next start');
  assert.equal(Object.hasOwn(loadHostConfig(configFile(host.userDataPath)).team, 'internet'), false);
  // The config file holds the relay URL by design. Slice 5-6 amends the redaction rule: the owner's own host state
  // (answers and pushes) shows the owner's typed address and relay address, never the token; nothing else holds them.
  const outside = JSON.stringify([host.logs, host.fake.calls.map((call) => [call.args, call.options])]);
  for (const secret of [TOKEN, ADDRESS, 'relay.example.org']) assert.equal(outside.includes(secret), false, secret);
  for (const text of [JSON.stringify(answer), JSON.stringify(off), JSON.stringify(host.pushed)]) assert.equal(text.includes(TOKEN), false);
  assert.deepEqual(answer.host.internet, { public_address: ADDRESS, relay_url: RELAY_URL, has_token: true });
  assert.equal(off.host.internet, null);
  assert.deepEqual(host.logs.filter((entry) => entry.event === 'team.host.internet_saved').map((entry) => entry.fields),
    [{ enabled: true, relay: true, restart: true }, { enabled: false, relay: false, restart: true }]);
  for (const file of readTree(host.userDataPath)) assert.equal(file.text.includes(TOKEN), false, file.path);
});

test('a stored token that fails its check is still replaced or cleared; a rollback removes it and names the token', async (t) => {
  let failWrites = false;
  const writeConfig = (layout, config) => {
    if (failWrites) throw new Error('disk full');
    require('../services/team/host/host-layout').writeHostConfig(layout, config);
  };
  const host = await deployed(t, { writeConfig });
  writeInternet(host.userDataPath, { map_port: true, public_address: null, relay_url: RELAY_URL });
  host.secureStore.values.set(HOST_RELAY_TOKEN_NAME, 'not a token');
  const off = await host.controller.handle('hostInternet', { enabled: false });
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.equal(host.secureStore.values.has(HOST_RELAY_TOKEN_NAME), false, 'the unreadable token is gone');
  host.secureStore.values.set(HOST_RELAY_TOKEN_NAME, 'not a token');
  const on = await host.controller.handle('hostInternet', { enabled: true, relay_url: RELAY_URL, token: TOKEN });
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.equal(host.secureStore.values.get(HOST_RELAY_TOKEN_NAME), TOKEN, 'replaced by the new one');
  host.secureStore.values.set(HOST_RELAY_TOKEN_NAME, 'not a token');
  failWrites = true;
  const failed = await host.controller.handle('hostInternet', { enabled: true, relay_url: RELAY_URL, token: 'tok-newer' });
  assert.equal(failed.error.reason, 'team_host_config_write_failed');
  assert.deepEqual(failed.changed, ['token'], 'the old token is unknown, so it is not as it was');
  assert.equal(host.secureStore.values.has(HOST_RELAY_TOKEN_NAME), false, 'the rollback removes the new one');
  assert.equal(host.logs.filter((entry) => entry.event === 'team.host.relay_token_unreadable').length, 3);
});

test('a restart keeps the saved port: a probe that fails once is retried, one that keeps failing answers what changed', async (t) => {
  const ports = portControl();
  const host = await deployed(t, { stop: false, probeDirectPort: ports.probeDirectPort, pickDirectPort: ports.pickDirectPort,
    bounds: { ...BOUNDS, portRetryMs: 1 } });
  ports.fail = 1;
  const kept = await host.controller.handle('hostInternet', { enabled: true, relay_url: RELAY_URL, token: TOKEN });
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.equal(readConfig(host.userDataPath).team.direct_port, PORT, 'the same port');
  assert.equal(ports.picks, 1, 'no new port picked');
  const forks = host.fake.calls.length;
  ports.free = false;
  const busy = await host.controller.handle('hostInternet', { enabled: true, relay_url: RELAY_URL, token: 'tok-second' });
  assert.equal(busy.error.reason, 'team_host_port_busy');
  assert.deepEqual(busy.changed, ['token', 'setting']);
  assert.equal(readConfig(host.userDataPath).team.direct_port, PORT, 'the config keeps its port');
  assert.equal(ports.picks, 1);
  assert.equal(host.fake.calls.length, forks, 'nothing started');
  ports.free = true;
  assert.equal((await host.controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  ports.free = false;
  const settingOnly = await host.controller.handle('hostInternet', { enabled: true, public_address: ADDRESS, relay_url: RELAY_URL });
  assert.equal(settingOnly.error.reason, 'team_host_port_busy');
  assert.deepEqual(settingOnly.changed, ['setting'], 'the token was kept');
  assert.equal(readConfig(host.userDataPath).team.internet.public_address, ADDRESS, 'the setting is saved');
});

test('while hostInternet restarts, a second hostInternet, a Deploy and a Recover are busy; a hostInternet during a Deploy too', async (t) => {
  const ports = portControl();
  const host = await deployed(t, { stop: false, probeDirectPort: ports.probeDirectPort, pickDirectPort: ports.pickDirectPort });
  const release = ports.hold();
  const first = host.controller.handle('hostInternet', { enabled: true, relay_url: RELAY_URL, token: TOKEN });
  await tick();
  const config = fs.readFileSync(configFile(host.userDataPath));
  const sets = host.secureStore.sets.length;
  for (const [method, payload] of [['hostInternet', { enabled: false }], ['hostDeploy', { ...DEPLOY }],
    ['hostRecover', { display_name: 'Olive Owner', label: 'Desk' }]]) {
    const answer = await host.controller.handle(method, payload);
    assert.deepEqual(answer.error, { code: 'invalid_request', reason: 'team_host_busy' }, method);
  }
  assert.equal(Buffer.compare(fs.readFileSync(configFile(host.userDataPath)), config), 0, 'nothing written');
  assert.equal(host.secureStore.sets.length, sets);
  release();
  assert.equal((await first).ok, true);
  assert.equal((await host.controller.handle('hostStop', {})).ok, true);
  const releaseDeploy = ports.hold();
  const deploying = host.controller.handle('hostDeploy', { ...DEPLOY });
  await tick();
  const during = fs.readFileSync(configFile(host.userDataPath));
  const busy = await host.controller.handle('hostInternet', { enabled: false });
  assert.deepEqual(busy.error, { code: 'invalid_request', reason: 'team_host_busy' });
  assert.equal(Buffer.compare(fs.readFileSync(configFile(host.userDataPath)), during), 0);
  assert.equal(host.secureStore.values.get(HOST_RELAY_TOKEN_NAME), TOKEN, 'the token is untouched');
  releaseDeploy();
  assert.equal((await deploying).ok, true);
});

test('a Stop during the restart wins: nothing is started again and the answer names what was saved', async (t) => {
  const ports = portControl();
  const host = await deployed(t, { stop: false, probeDirectPort: ports.probeDirectPort, pickDirectPort: ports.pickDirectPort });
  const forks = host.fake.calls.length;
  const release = ports.hold();
  const answering = host.controller.handle('hostInternet', { enabled: true, public_address: ADDRESS });
  await tick();
  assert.equal((await host.controller.handle('hostStop', {})).ok, true);
  release();
  const answer = await answering;
  assert.equal(answer.error.reason, 'team_host_stopped');
  assert.deepEqual(answer.changed, ['setting']);
  assert.equal(host.fake.calls.length, forks, 'no new start');
  assert.equal(host.controller.snapshot().state, 'stopped');
});

test('the token is kept only for the same relay with no token named; another relay or token null removes it', async (t) => {
  const host = await deployed(t);
  assert.equal((await host.controller.handle('hostInternet', { enabled: true, relay_url: RELAY_URL, token: TOKEN })).ok, true);
  assert.equal((await host.controller.handle('hostInternet', { enabled: true, relay_url: RELAY_URL, public_address: ADDRESS })).ok, true);
  assert.equal(host.secureStore.values.get(HOST_RELAY_TOKEN_NAME), TOKEN, 'same relay, no token named: kept');
  assert.equal((await host.controller.handle('hostInternet', { enabled: true, relay_url: 'https://other.example.org' })).ok, true);
  assert.equal(host.secureStore.values.has(HOST_RELAY_TOKEN_NAME), false, 'another relay: removed');
  assert.equal((await host.controller.handle('hostInternet', { enabled: true, relay_url: RELAY_URL, token: TOKEN })).ok, true);
  assert.equal((await host.controller.handle('hostInternet', { enabled: true, relay_url: RELAY_URL, token: null })).ok, true);
  assert.equal(host.secureStore.values.has(HOST_RELAY_TOKEN_NAME), false, 'token null: removed');
});

test('a setting that cannot be written puts the token back; when that fails too the answer names the token', async (t) => {
  let failWrites = false;
  const writeConfig = (layout, config) => {
    if (failWrites) throw new Error('disk full');
    require('../services/team/host/host-layout').writeHostConfig(layout, config);
  };
  const host = await deployed(t, { writeConfig });
  assert.equal((await host.controller.handle('hostInternet', { enabled: true, relay_url: RELAY_URL, token: TOKEN })).ok, true);
  const before = fs.readFileSync(configFile(host.userDataPath));
  failWrites = true;
  const restored = await host.controller.handle('hostInternet', { enabled: true, relay_url: RELAY_URL, token: 'tok-new-value' });
  assert.deepEqual(restored, { ok: false, error: { code: restored.error.code, reason: 'team_host_config_write_failed' }, changed: [] });
  assert.equal(host.secureStore.values.get(HOST_RELAY_TOKEN_NAME), TOKEN, 'the old token is back');
  assert.equal(Buffer.compare(fs.readFileSync(configFile(host.userDataPath)), before), 0);
  const off = { enabled: false };
  host.secureStore.refuseSet = true;
  const half = await host.controller.handle('hostInternet', off);
  assert.equal(half.error.reason, 'team_host_config_write_failed');
  assert.deepEqual(half.changed, ['token'], 'the token was removed and could not be put back');
  assert.equal(JSON.stringify(half).includes(TOKEN), false);
});

test('hostInternet on a profile that never deployed is refused and writes nothing', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-internet-');
  const secureStore = createMemorySecureStore();
  const { controller } = createTestHostController(t, { userDataPath, secureStore, script: healthyHostScript({ teamId: 'team_x' }) });
  const answer = await controller.handle('hostInternet', { enabled: true, relay_url: RELAY_URL, token: TOKEN });
  assert.equal(answer.error.reason, 'team_host_not_deployed');
  assert.deepEqual(fs.readdirSync(userDataPath), []);
  assert.deepEqual(secureStore.sets, []);
});
