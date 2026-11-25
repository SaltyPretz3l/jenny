'use strict';

// new-test-file: tests/team-connection-manager.test.js and tests/team-connection-lifecycle.test.js are both at the
// 600-line cap, so these cases (review H9 and Part III) for the connection manager's ending calls and its command
// retry live here. Through the real team host and bridge supervisors with the fake bridge child.

const assert = require('node:assert/strict');
const test = require('node:test');

const { TEAM_ERROR_CODES } = require('../services/backend/error-codes');
const { createConnectionManager } = require('../services/team/connection-manager');
const { createDeviceKeyStore } = require('../services/team/device-key-store');
const { loadClientFile, saveClientFile } = require('../services/team/client-file');
const { waitUntil } = require('./helpers/team-client-host');
const { countingTimers } = require('./helpers/team-dial-helpers');
const { savedTeam } = require('./helpers/team-saved');

// The host bridge (the fake child) refuses a refused key again for its cooldown; the member's own window is the
// same cooldown plus a margin, so a confirming second dial would wait this long. Long enough to tell from a race.
const WINDOW_COOLDOWN_MS = 5000;

// A member who left (or whose device was revoked): the host commits the change, drops the key, and the answer is
// never sent, so the member's request is reset by the refusal of a key the host had already greeted.
async function endedByRefusal(t, { operation }) {
  const { host, me } = await savedTeam(t, { member: true });
  const { store } = host.env;
  const real = store[operation].bind(store);
  store[operation] = async (input) => { await real(input); return new Promise(() => {}); };
  host.hostSpawner.options.refusedCooldownMs = 300;
  const timers = countingTimers();
  const service = host.createService({ requestTimeoutMs: 20_000, refusedCooldownMs: WINDOW_COOLDOWN_MS, timers });
  await service.startExisting();
  await host.waitForState(me.teamId, 'online');
  return { host, me, service, timers };
}

for (const [method, operation, payload] of [['leave', 'leave', () => ({})],
  ['deviceRevoke', 'revokeDevice', (me) => ({ device_id: me.device_id })]]) {
  test(`${method} finishes at once when the host refused the key it had already greeted`, async (t) => {
    const { me, service, timers } = await endedByRefusal(t, { operation });
    const started = Date.now();
    const answer = await service.handle(method, { team_id: me.teamId, ...payload(me) });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.ok(Date.now() - started < WINDOW_COOLDOWN_MS - 1000, `no wait for a second refusal: ${Date.now() - started} ms`);
    assert.ok(timers.delays.every((ms) => ms < WINDOW_COOLDOWN_MS), `no cooldown-long wait: ${timers.delays}`);
  });
}

test('a retry after a refused client finds the client gone and answers not connected instead of throwing', async (t) => {
  const { host, me } = await savedTeam(t, { member: true });
  const record = loadClientFile(host.userData, me.teamId).record;
  const manager = createConnectionManager({
    record, deviceKeys: createDeviceKeyStore({ getSecureStore: () => host.secureStore }),
    saveRecord: (next) => saveClientFile(host.userData, next), spawnChild: host.memberSpawner, appVersion: '1.6.1',
    backoff: { initialMs: 20, maxMs: 80 },
  });
  t.after(() => manager.stop());
  manager.start();
  assert.ok(await waitUntil(() => manager.snapshot().state === 'online'));
  const { link } = manager.borrow();
  // The first command is refused at identity; a concurrent call then drops the client the retry just registered.
  let hidden = false;
  let held = link.client;
  Object.defineProperty(link, 'client', { configurable: true, get: () => (hidden ? null : held), set: (value) => { held = value; } });
  const command = link.session.command.bind(link.session);
  link.session.command = async (operation, params, options) => {
    if (hidden) return command(operation, params, options);
    hidden = true;
    return { ok: false, error: { code: TEAM_ERROR_CODES.CONNECTION_FAILED, reason: 'client_unauthorized' } };
  };
  const answer = await manager.command('team.members.list', {});
  assert.equal(answer.ok, false);
  assert.equal(answer.error.reason, 'team_not_connected');
});

// ---------------------------------------------------------------- command-send.js (the command and its one client retry)

const { sendCommand } = require('../services/team/command-send');

const REFUSED = { ok: false, error: { code: TEAM_ERROR_CODES.CONNECTION_FAILED, reason: 'boot_epoch_mismatch' } };

// A target whose session answers from `answers` in order; `ensureClient` registers `{ id: n }` when none is set.
function fakeTarget(answers, { registerClient = true } = {}) {
  const calls = [];
  const target = { client: { id: 0, bootEpoch: 'b0' }, session: { command: async (operation, params, options) => {
    calls.push(options.client.id);
    return answers.shift();
  } } };
  let registered = 0;
  const ensureClient = async (link) => {
    if (link.client) return null;
    if (!registerClient) return null;
    registered += 1;
    link.client = { id: registered, bootEpoch: `b${registered}` };
    return null;
  };
  return { target, calls, ensureClient };
}

test('sendCommand sends once, and again with a new client after the host refused the old one', async () => {
  const forgotten = [];
  const first = fakeTarget([{ ok: true, value: 1 }]);
  assert.deepEqual(await sendCommand({ target: first.target, operation: 'x', params: {}, ensureClient: first.ensureClient,
    forgetClient: (used) => forgotten.push(used) }), { ok: true, value: 1 });
  assert.deepEqual(first.calls, [0]);
  const second = fakeTarget([REFUSED, { ok: true, value: 2 }]);
  assert.deepEqual(await sendCommand({ target: second.target, operation: 'x', params: {}, ensureClient: second.ensureClient,
    forgetClient: (used) => forgotten.push(used) }), { ok: true, value: 2 });
  assert.deepEqual(second.calls, [0, 1], 'the retry used the new client');
  assert.deepEqual(forgotten.map((used) => used.id), [0]);
});

test('sendCommand answers not connected when no client is left for the retry, and does not retry a second refusal', async () => {
  const gone = fakeTarget([REFUSED], { registerClient: false });
  const answer = await sendCommand({ target: gone.target, operation: 'x', params: {}, ensureClient: gone.ensureClient,
    forgetClient: () => {} });
  assert.equal(answer.error.reason, 'team_not_connected');
  const twice = fakeTarget([REFUSED, REFUSED, { ok: true }]);
  const last = await sendCommand({ target: twice.target, operation: 'x', params: {}, ensureClient: twice.ensureClient,
    forgetClient: () => {} });
  assert.deepEqual(last, REFUSED, 'the second refusal is the answer');
  assert.deepEqual(twice.calls, [0, 1]);
});
