'use strict';

// new-test-file: the owner's model relay setting (row 123 slice 6-7, decisions 13 to 15) is a new desktop surface:
// `hostModelRelay` on the host controller, its sibling host-model-relay.js, the supervisor's `model_relay` message and
// the hosted team's relay link. None of the existing host test files is about it, and team-host-status is a key pin.

const assert = require('node:assert/strict');
const test = require('node:test');

const { HOST_KEY_NAME } = require('../services/team/host/host-key-store');
const { deriveTeamId, encodeBase64url, keyPairFromSeed } = require('../server/team/ids');
const { HOST_SEED } = require('./server/helpers/team-host-fixture');
const { createTestHostController, healthyHostScript } = require('./helpers/team-host-fakes');
const { createMemorySecureStore, tempProfile } = require('./helpers/team-client-host');
const { MAX_RELAY_FLOWING, createParentChannel } = require('../server/team/parent-channel');
const { MODEL_TRANSFER_LIMITS } = require('../server/team/model-manifest');
const { createModelRelayLink } = require('../server/team/model-relay-link');
const { HOST_METHODS, HOST_OPERATIONS, validatePayload } = require('../services/team/ipc-methods');
const { loadHostConfig } = require('../server/config');
const { prepareHostLayout, readSavedHostConfig } = require('../services/team/host/host-layout');
const { DEFAULT_FLOWING, createHostModelRelay } = require('../services/team/host/host-model-relay');

const DEPLOY = Object.freeze({ name: 'Studio', display_name: 'Olive Owner', label: 'Desk' });
const TEAM_ID = deriveTeamId(keyPairFromSeed(Buffer.from(HOST_SEED)).publicKey);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function seededStore() {
  const secureStore = createMemorySecureStore();
  secureStore.values.set(HOST_KEY_NAME, encodeBase64url(Buffer.from(HOST_SEED)));
  return secureStore;
}

// A healthy host that also answers the relay message the way model-relay-link.js does: { flowing, passing }.
function relayHostScript(passing = 0) {
  const base = healthyHostScript({ teamId: TEAM_ID });
  return (child, message) => {
    base(child, message);
    if (message.type === 'model_relay') setImmediate(() => child.reply({ type: 'model_relay', flowing: message.flowing, passing }));
  };
}

const configPath = (userDataPath) => prepareHostLayout(userDataPath).configPath;
const savedFlowing = (userDataPath) => readSavedHostConfig(userDataPath).team.model_relay_flowing;

// Real time: a quiet push (the relay's numbers) waits up to the supervisor's reachPushMs (1 s) after the last one.
async function until(check, label) {
  for (let i = 0; i < 300; i += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail('timed out waiting for ' + label);
}

test('hostModelRelay: the owner\'s own method, checked in main, never a host operation', () => {
  assert.equal(HOST_METHODS.includes('hostModelRelay'), true);
  assert.equal(Object.hasOwn(HOST_OPERATIONS, 'hostModelRelay'), false, 'nothing a member can send to a host');
  for (const flowing of [0, 1, 4]) assert.deepEqual(validatePayload('hostModelRelay', { flowing }), { ok: true, value: { flowing } });
  for (const payload of [{}, { flowing: -1 }, { flowing: 5 }, { flowing: 1.5 }, { flowing: '2' }, { flowing: 2, team_id: TEAM_ID }, undefined]) {
    assert.equal(validatePayload('hostModelRelay', payload).ok, false, JSON.stringify(payload));
  }
  assert.equal(MAX_RELAY_FLOWING, MODEL_TRANSFER_LIMITS.maxFlowingPerHost, 'the channel\'s bound is the relay\'s');
});

test('a stopped team: the setting is saved where server/config.js reads it, and the state says it', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-relay-');
  const secureStore = seededStore();
  const { controller, pushed, logs } = createTestHostController(t, { userDataPath, secureStore, script: relayHostScript() });
  assert.equal((await controller.handle('hostModelRelay', { flowing: 3 })).error.reason, 'team_host_not_deployed', 'nothing to set before a deploy');
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.equal((await controller.handle('hostStop', {})).ok, true);
  const before = pushed.length;
  const answer = await controller.handle('hostModelRelay', { flowing: 0 });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.host.model_relay, { flowing: 0, passing: 0, live: false });
  assert.equal(savedFlowing(userDataPath), 0);
  assert.equal(loadHostConfig(configPath(userDataPath)).team.modelRelayFlowing, 0, 'the host reads it at its next start');
  assert.ok(pushed.length > before, 'every page hears the change');
  assert.deepEqual(pushed[pushed.length - 1].model_relay, { flowing: 0, passing: 0, live: false });
  assert.equal((await controller.handle('hostModelRelay', { flowing: 7 })).error.code, 'invalid_request');
  const said = logs.find((entry) => entry.event === 'team.host.model_relay_saved');
  assert.deepEqual(said.fields, { flowing: 0, applied: false });
});

test('a running team: the setting reaches the host without a restart, and the passing count comes back', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-relay-');
  const secureStore = seededStore();
  const { controller, fake, pushed } = createTestHostController(t, { userDataPath, secureStore, script: relayHostScript(1) });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  const child = fake.last();
  await until(() => controller.snapshot().model_relay?.live === true, 'the first relay report');
  assert.deepEqual(controller.snapshot().model_relay, { flowing: 2, passing: 1, live: true });
  const answer = await controller.handle('hostModelRelay', { flowing: 4 });
  assert.equal(answer.ok, true);
  assert.deepEqual(child.posted.filter((m) => m.type === 'model_relay'), [{ type: 'model_relay', flowing: 2 }, { type: 'model_relay', flowing: 4 }],
    'the saved value once the host runs, then the new one');
  assert.equal(fake.calls.length, 1, 'no second host start');
  assert.equal(child.exited, false, 'the host keeps running');
  await until(() => pushed.some((host) => host.model_relay && host.model_relay.flowing === 4), 'the new limit pushed');
  assert.equal(savedFlowing(userDataPath), 4);
  // Off on a running host: the host ends its transfers itself (model-relay.js); the desktop only says 0.
  assert.equal((await controller.handle('hostModelRelay', { flowing: 0 })).ok, true);
  assert.deepEqual(child.posted.filter((m) => m.type === 'model_relay').map((m) => m.flowing), [2, 4, 0]);
});

// Fix list M1: the host's answer arrives as a quiet push (same state, new relay numbers); it must carry the new setting,
// not the one the reused state was built with. The LAST push is what the page shows.
test('a running team: after a change, the last pushed state says the new setting, for 4 and for 0', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-relay-');
  const { controller, pushed } = createTestHostController(t, { userDataPath, secureStore: seededStore(), script: relayHostScript(1) });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  await until(() => controller.snapshot().model_relay?.live === true, 'the first relay report');
  for (const flowing of [4, 0]) {
    const before = pushed.length;
    assert.equal((await controller.handle('hostModelRelay', { flowing })).ok, true);
    const answered = pushed.length;
    assert.ok(answered > before, 'the change itself is pushed');
    await until(() => pushed.length > answered, 'the quiet push after the host answered ' + flowing);
    assert.deepEqual(pushed[pushed.length - 1].model_relay, { flowing, passing: 1, live: true });
  }
});

// Fix list S1: the setting writes the host's config, so Force local refuses it like every other config writer, and it
// takes the host's one-operation lock (a Start, a restore or a delete cannot interleave with its write).
test('hostModelRelay is refused while Force local holds, and while another host operation runs', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-relay-');
  let held = false;
  const { controller } = createTestHostController(t, { userDataPath, secureStore: seededStore(), script: relayHostScript(), gate: { held: () => held } });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.equal((await controller.handle('hostStop', {})).ok, true);
  held = true;
  const refused = await controller.handle('hostModelRelay', { flowing: 3 });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.reason, 'team_force_local');
  assert.equal(savedFlowing(userDataPath), undefined, 'nothing written while held (the default stays unwritten)');
  held = false;
  const start = controller.handle('hostDeploy', { ...DEPLOY });
  const busy = await controller.handle('hostModelRelay', { flowing: 3 });
  assert.equal(busy.ok, false);
  assert.equal(busy.error.reason, 'team_host_busy');
  assert.equal((await start).ok, true);
  assert.equal(savedFlowing(userDataPath), undefined, 'the Start\'s config kept the saved value and nothing interleaved');
  assert.equal((await controller.handle('hostModelRelay', { flowing: 3 })).ok, true);
  assert.equal(savedFlowing(userDataPath), 3);
});

test('a launch keeps the saved setting in the config it writes afresh, and the running host is told it once', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-relay-');
  const secureStore = seededStore();
  const { controller, fake } = createTestHostController(t, { userDataPath, secureStore, script: relayHostScript() });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.equal((await controller.handle('hostStop', {})).ok, true);
  assert.equal((await controller.handle('hostModelRelay', { flowing: 1 })).ok, true);
  const start = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.equal(savedFlowing(userDataPath), 1, 'Start rewrote the config and kept the setting');
  const child = fake.last();
  await until(() => controller.snapshot().model_relay?.live === true, 'the answer from the host');
  await tick(); await tick();
  assert.deepEqual(child.posted.filter((m) => m.type === 'model_relay'), [{ type: 'model_relay', flowing: 1 }]);
  assert.deepEqual(controller.snapshot().model_relay, { flowing: 1, passing: 0, live: true });
});

test('the supervisor drops a malformed relay report and keeps none while stopped', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-relay-');
  const secureStore = seededStore();
  const base = healthyHostScript({ teamId: TEAM_ID });
  const script = (child, message) => {
    base(child, message);
    if (message.type === 'start') {
      setImmediate(() => setImmediate(() => {
        for (const bad of [{ type: 'model_relay', flowing: 9, passing: 0 }, { type: 'model_relay', flowing: 2, passing: -1 },
          { type: 'model_relay', flowing: 2, passing: 1, name: 'x' }, { type: 'model_relay', flowing: 2 }]) child.reply(bad);
      }));
    }
  };
  const { controller } = createTestHostController(t, { userDataPath, secureStore, script });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  for (let i = 0; i < 6; i += 1) await tick();
  assert.deepEqual(controller.snapshot().model_relay, { flowing: 2, passing: 0, live: false });
  assert.equal((await controller.handle('hostStop', {})).ok, true);
  assert.deepEqual(controller.snapshot().model_relay, { flowing: 2, passing: 0, live: false });
});

test('the parent channel: model_relay in, closed both ways', () => {
  const posted = [];
  let handler = null;
  const processLike = { send: (m, cb) => { posted.push(m); cb?.(); }, on: (event, fn) => { if (event === 'message') handler = fn; }, once: () => {},
    removeListener: () => {}, connected: true };
  const channel = createParentChannel(processLike);
  const got = [];
  channel.onMessage((m) => got.push(m));
  for (const bad of [{ type: 'model_relay' }, { type: 'model_relay', flowing: 5 }, { type: 'model_relay', flowing: 2, extra: 1 }, { type: 'model_relay', flowing: '1' }]) handler(bad);
  handler({ type: 'model_relay', flowing: 3 });
  assert.deepEqual(got, [{ type: 'model_relay', flowing: 3 }]);
  assert.equal(channel.droppedCount(), 4);
  assert.equal(channel.send({ type: 'model_relay', flowing: 2, passing: 1 }), true);
  assert.equal(channel.send({ type: 'model_relay', flowing: 2 }), false, 'outbound shape is exact');
  assert.deepEqual(posted, [{ type: 'model_relay', flowing: 2, passing: 1 }]);
  channel.close();
});

test('the relay link: the setting goes to setFlowingLimit, a report on change only, one timer gone after dispose', () => {
  let limit = 2;
  let flowing = 0;
  const sharing = { setFlowingLimit: (n) => { limit = n; return { ok: true }; },
    resources: () => ({ relay: limit === 0 ? null : { flowingLimit: limit, transfers: { flowing } } }) };
  const sent = [];
  let fire = null;
  let cleared = 0;
  const timers = { setInterval: (fn) => { fire = fn; return { unref() {} }; }, clearInterval: () => { cleared += 1; } };
  const link = createModelRelayLink({ sharing, send: (m) => sent.push(m), timers });
  fire();
  assert.deepEqual(sent, [], 'nothing before the first setting from the desktop');
  link.set(2);
  assert.deepEqual(sent, [{ type: 'model_relay', flowing: 2, passing: 0 }]);
  fire();
  assert.equal(sent.length, 1, 'nothing moved, nothing sent');
  flowing = 1;
  fire();
  assert.deepEqual(sent[1], { type: 'model_relay', flowing: 2, passing: 1 });
  link.set(1);
  assert.equal(limit, 1);
  assert.deepEqual(sent[2], { type: 'model_relay', flowing: 1, passing: 1 }, 'a lowered limit leaves the flowing transfer');
  link.set(0);
  assert.deepEqual(sent[3], { type: 'model_relay', flowing: 0, passing: 0 });
  assert.deepEqual(Object.keys(sent[3]).sort(), ['flowing', 'passing', 'type'], 'counts only');
  assert.deepEqual(link.resources(), { timers: 1, disposed: false });
  link.dispose();
  assert.deepEqual(link.resources(), { timers: 0, disposed: true });
  assert.equal(cleared, 1);
  link.set(3);
  assert.equal(limit, 0, 'a disposed link changes nothing');
});

test("a team restored or deployed after another one is not sent the last team's relay setting", () => {
  let saved = { team: { name: 'Old', model_relay_flowing: 4 } };
  const listeners = [];
  const sent = [];
  createHostModelRelay({ userDataPath: '/profile', writeConfig: () => {}, hostState: () => ({}), readSaved: () => saved,
    supervisor: { onState: (listener) => listeners.push(listener), setModelRelay: (flowing) => { sent.push(flowing); return true; } } });
  const tell = (state, since) => listeners[0]({ state, since, relay: null });
  tell('running', 1);
  assert.deepEqual(sent, [4], 'the old team runs on its own saved setting');
  tell('stopped', 2);
  saved = { team: { name: 'New' } }; // a restore or a new deploy wrote another config while the host was down
  tell('starting', 3);
  tell('running', 4);
  assert.deepEqual(sent, [4, DEFAULT_FLOWING], "the new team is sent its own (default) setting, not the previous team's");
});
