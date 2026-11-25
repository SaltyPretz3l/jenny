'use strict';

// new-test-file: tests/team-join-flow.test.js is at its line cap (581 of 600 lines).
// Review round two (R10-F01): a join or an owner recovery whose first redeem request never reached the host, against
// a host bridge that, as the binary does, refuses a refused key again for its cooldown without asking the host. The
// fake bridge child has that cooldown (tests/server/helpers/fake-bridge/host-logic.js); both sides get a short one.
// Each case runs against this round's host bridge (its cooldown says `host_cooldown`) and an older one (it said
// `host_refused` for it).

const assert = require('node:assert/strict');
const test = require('node:test');

const { keyPairFromSeed } = require('../server/team/ids');
const { DEFAULT_LIMITS } = require('../server/team/transport/host-bridge');
const { REFUSED_COOLDOWN_MS, createRefusalWindow, createWaits } = require('../services/team/bridge-link');
const { parseInvite } = require('../server/team/invites');
const { createTeamClientHost, waitUntil } = require('./helpers/team-client-host');
const { savedTeam } = require('./helpers/team-saved');

const COOLDOWN_MS = 300;
const keyName = (teamId) => `team_device_key:${teamId}`;

const HOSTS = [['this round host bridge', false], ['a host bridge from before round two', true]];

function cooled(host, oldHost, extra = {}) {
  host.hostSpawner.options.refusedCooldownMs = COOLDOWN_MS;
  host.hostSpawner.options.oldHost = oldHost;
  return { refusedCooldownMs: COOLDOWN_MS, requestTimeoutMs: 300, ...extra };
}

// The first redeem request never reaches the store (the connection died first): no answer, nothing committed.
function loseFirstRedeem(host) {
  const { invites } = host.env.context;
  const redeem = invites.redeem;
  let calls = 0;
  invites.redeem = (input) => {
    calls += 1;
    return calls === 1 ? new Promise(() => {}) : redeem(input);
  };
  return () => calls;
}

// Every device the host holds for `memberId` that is still active has the key this PC saved.
function assertHostKeyIsOurs(host, teamId, memberId) {
  const seed = Buffer.from(host.secureStore.values.get(keyName(teamId)), 'base64url');
  const ours = keyPairFromSeed(seed).publicKey;
  const active = host.env.store.snapshot().devices.filter((device) => device.member_id === memberId && device.state === 'active');
  assert.deepEqual(active.map((device) => device.public_key), [ours], 'the host holds no device whose key this PC lacks');
}

for (const [hostKind, oldHost] of HOSTS) {
test(`a join whose first redeem never reached the host is retried and ends joined (${hostKind})`, async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const calls = loseFirstRedeem(host);
  const { invite } = await host.invite({ actor: owner.member_id });
  const teamId = parseInvite(invite).team_id;
  const service = host.createService(cooled(host, oldHost));
  const joined = await service.handle('join', { invite, display_name: 'Mika Member', label: 'Laptop' });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(calls(), 2, 'redeemed once more after the device key was refused');
  assert.equal(joined.team.member_state, 'pending');
  assertHostKeyIsOurs(host, teamId, joined.team.member_id);
});

test(`a recovery whose first redeem never reached the host keeps the new key, no sign-out (${hostKind})`, async (t) => {
  const s = await savedTeam(t);
  const service = s.host.createService(cooled(s.host, oldHost));
  await service.startExisting();
  await s.host.waitForState(s.me.teamId, 'online');
  const oldKey = s.host.secureStore.values.get(keyName(s.me.teamId));
  loseFirstRedeem(s.host);
  const { invite } = await s.host.invite({ kind: 'recovery' });
  const answer = await service.ownerRecover({ invite, display_name: 'Olive Owner', label: 'New desk' });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.notEqual(s.host.secureStore.values.get(keyName(s.me.teamId)), oldKey, 'the new key replaced the old one');
  assertHostKeyIsOurs(s.host, s.me.teamId, s.me.member_id);
  assert.ok(await waitUntil(() => s.host.lastState(s.me.teamId)?.state === 'online', { attempts: 150, interval: 20 }),
    JSON.stringify(s.host.lastState(s.me.teamId)));
});
}

test('the app quitting while a recovery waits out the cooldown still keeps the key the host accepted', async (t) => {
  const s = await savedTeam(t);
  // Both sides keep the binary's full minute; the quit below cuts the member's wait. An older host bridge says
  // `host_refused` for its cooldown, so the member waits it out (this round's `host_cooldown` is waited out too, H11).
  s.host.hostSpawner.options.oldHost = true;
  const service = s.host.createService({ requestTimeoutMs: 300 });
  const oldKey = s.host.secureStore.values.get(keyName(s.me.teamId));
  const calls = loseFirstRedeem(s.host);
  const { invite } = await s.host.invite({ kind: 'recovery' });
  const recovering = service.ownerRecover({ invite, display_name: 'Olive Owner', label: 'New desk' });
  assert.ok(await waitUntil(() => calls() === 2, { attempts: 250, interval: 20 }), 'the second redeem was sent');
  await new Promise((resolve) => { setTimeout(resolve, 600); });
  const started = Date.now();
  await service.stopAll();
  const answer = await recovering;
  assert.ok(Date.now() - started < 5000, 'the quit cut the wait');
  assert.equal(answer.error?.reason, 'team_connection_stopped', JSON.stringify(answer));
  assert.notEqual(s.host.secureStore.values.get(keyName(s.me.teamId)), oldKey, 'the accepted key was saved');
  assertHostKeyIsOurs(s.host, s.me.teamId, s.me.member_id);
});

test('the refusal window: a first refusal retries, one inside the cooldown waits it out, one past it counts', () => {
  let clock = 1000;
  const refusals = createRefusalWindow({ now: () => clock, cooldownMs: 300 });
  assert.equal(refusals.note(), null);
  clock += 100;
  const wait = refusals.note();
  assert.equal(wait, refusals.windowMs - 100);
  clock += wait;
  assert.equal(refusals.note(), 0);
  refusals.reset();
  assert.equal(refusals.note(), null, 'an admitted key starts over');
  assert.equal(REFUSED_COOLDOWN_MS, DEFAULT_LIMITS.refusedCooldownMs, "the member's bound is the host bridge's cooldown");
  assert.ok(createRefusalWindow().windowMs > DEFAULT_LIMITS.refusedCooldownMs);
});

// Review sweeps, second run (X1b-F01). Fault: the join flow's own `team.join.finished` / `team.recover.finished` line
// logs the host's refusal reason as sent (up to the 1 MiB answer cap of host-chosen text) while the IPC answer is
// rebuilt to one word. A host that does not run Jenny's own reason gate is played by rewriting one refusal envelope
// on the wire; the host-side redeem answers with a marker word only this test uses.
const HOSTILE = `line one\n{"level":"ERROR","event":"forged.line"} 203.0.113.9:4433 jteam2_${'A'.repeat(60)} ${'x'.repeat(100_000)}`;
const MARKER = 'review_hostile_reason_marker';

function hostileRedeemRefusal(t, host) {
  const { hostFailure } = require('../server/api-contract');
  host.env.context.invites.redeem = async () => hostFailure('limit', MARKER);
  const original = JSON.stringify;
  JSON.stringify = function rewritten(value, ...rest) {
    if (value && value.ok === false && value.error && value.error.reason === MARKER) {
      return original.call(JSON, { ...value, error: { ...value.error, reason: HOSTILE } }, ...rest);
    }
    return original.call(JSON, value, ...rest);
  };
  const restore = () => { JSON.stringify = original; };
  t.after(restore);
  return restore;
}

function assertBoundedFinish(host, event, teamId) {
  const finished = host.logs.filter((entry) => entry.event === event);
  assert.equal(finished.length, 1, event);
  assert.deepEqual(finished[0].fields, { team_id: teamId, ok: false, reason: 'team_unavailable' }, event);
  assert.equal(JSON.stringify(host.logs).includes('forged.line'), false, 'no host text in any log line');
}

test('a join or recovery the host refuses with free text logs one bounded word, as its answer does', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const { invite } = await host.invite({ actor: owner.member_id });
  const teamId = parseInvite(invite).team_id;
  const restore = hostileRedeemRefusal(t, host);
  const joined = await host.createService().handle('join', { invite, display_name: 'Mika Member', label: 'Laptop' });
  restore();
  assert.equal(joined.ok, false);
  assert.equal(joined.error.reason, 'team_unavailable', 'the answer is rebuilt');
  assertBoundedFinish(host, 'team.join.finished', teamId);

  const s = await savedTeam(t);
  const service = s.host.createService();
  const recovery = await s.host.invite({ kind: 'recovery' });
  const restoreRecovery = hostileRedeemRefusal(t, s.host);
  const recovered = await service.ownerRecover({ invite: recovery.invite, display_name: 'Olive Owner', label: 'New desk' });
  restoreRecovery();
  assert.equal(recovered.ok, false);
  assert.equal(recovered.error.reason, 'team_unavailable');
  assertBoundedFinish(s.host, 'team.recover.finished', s.me.teamId);
});

// Owner decision E79: a join whose name is taken is refused with that reason and leaves nothing on this PC; the
// invite stays live, so the same string joins under another name (no host or bridge cooldown in the way).
test('E79: a taken name is refused as itself, nothing is kept, and the same invite string then joins under another name', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const { invite, inviteId } = await host.invite({ actor: owner.member_id });
  const teamId = parseInvite(invite).team_id;
  const service = host.createService();
  const taken = await service.handle('join', { invite, display_name: 'olive owner', label: 'Laptop' });
  assert.deepEqual([taken.ok, taken.error?.reason], [false, 'team_display_name_taken'], JSON.stringify(taken));
  assert.equal(host.secureStore.values.size, 0, 'no device key left');
  assert.equal(host.env.store.isInviteLive(inviteId), true, 'the invite is still live');
  const finished = host.logs.filter((entry) => entry.event === 'team.join.finished');
  assert.deepEqual(finished.map((entry) => entry.fields), [{ team_id: teamId, ok: false, reason: 'team_display_name_taken' }]);
  assert.equal(JSON.stringify(host.logs).includes(invite), false, 'the invite string is in no log line');
  const joined = await service.handle('join', { invite, display_name: 'Mika Member', label: 'Laptop' });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(joined.team.member_state, 'pending');
});

test('a wait ends at its time or at wakeAll, and leaves no timer behind', async () => {
  const waits = createWaits();
  const started = Date.now();
  const long = waits.wait(60_000);
  assert.equal(waits.pending(), 1);
  waits.wakeAll();
  await long;
  assert.ok(Date.now() - started < 1000);
  await waits.wait(5);
  assert.equal(waits.pending(), 0);
});

// Review H11. Fault: the device key's check after the second redeem meets the bridge's own cooldown of the key's
// first refusal (`host_cooldown`) and reads it as unreachable: no wait, the join ends on the redeem answer alone
// (no team name) and the new member's key sits out the cooldown. It is waited out once, as a refusal is (R10-F01).
test('after a lost redeem, a host_cooldown on the device key check is waited out once and the check succeeds', async (t) => {
  const { createJoin } = require('../services/team/join-flow');
  const { createDeviceKeyStore } = require('../services/team/device-key-store');
  const { saveClientFile } = require('../services/team/client-file');
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const calls = loseFirstRedeem(host);
  host.hostSpawner.options.refusedCooldownMs = COOLDOWN_MS;
  const { invite } = await host.invite({ actor: owner.member_id });
  const flow = createJoin({ deviceKeys: createDeviceKeyStore({ getSecureStore: () => host.secureStore }),
    userDataPath: host.userData, spawnChild: host.memberSpawner, appVersion: '1.6.1', requestTimeoutMs: 300,
    refusedCooldownMs: COOLDOWN_MS });
  const result = await flow.join({ invite, displayName: 'Mika Member', label: 'Laptop' },
    { admit: () => null, writeRecord: (record) => saveClientFile(host.userData, record) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls(), 2, 'redeemed once more after the device key was refused');
  assert.equal(result.team_name, host.env.store.teamName(), 'the device key was checked: the status named the team');
});
