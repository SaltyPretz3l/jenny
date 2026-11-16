'use strict';

// Row 123 slice 4e: how the real team service and the real registration wire "Share this PC's GPU".
// The service hands every connection change to sharing and drops sharing when a team is left,
// removed or its manager stopped (stopHeld, here through a pasted reconnect code); at quit sharing
// stops first, while the connections can still carry its unregister, within its own bound. The
// registration's own-work check is the backend's active-stream rule. A real team host over loopback
// (tests/helpers/team-client-host.js); sharing is a recording stand-in. No model, no GPU, no window.

const assert = require('node:assert/strict');
const test = require('node:test');

const { registerTeam, sharingIsBusy } = require('../services/main/team-registration');
const { parseInvite } = require('../server/team/invites');
const { loadClientFile } = require('../services/team/client-file');
const { encodeReconnectCode } = require('../services/team/reconnect-code');
const { createTeamClientHost } = require('./helpers/team-client-host');

const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

function recordingSharing(order) {
  const calls = [];
  return {
    calls,
    attach() {},
    snapshot: () => null,
    connectionChanged: (teamId) => calls.push(['changed', teamId]),
    drop: (teamId) => calls.push(['drop', teamId]),
    stopAll: async () => { order.push('sharing'); calls.push(['stopAll']); },
    set: async () => ({ ok: true, sharing: null }),
  };
}

async function joined(t, { member = false } = {}) {
  const host = await createTeamClientHost(t);
  const handlers = new Map();
  const order = [];
  const sharing = recordingSharing(order);
  const registered = registerTeam({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    featureFlags: { team: true }, userDataPath: host.userData, getSecureStore: () => host.secureStore,
    readOfflineMode: () => 'disabled', // Force local off (E64: no reader wired counts as on)
    sendBridgeEvent: (path, payload) => { if (path === 'team.onState') host.states.push(JSON.parse(JSON.stringify(payload))); },
    getMainLifecycle: () => ({ registerShutdownTask: () => {} }), log: host.log,
    serviceOptions: { ...host.serviceOptions(), teamSharing: sharing },
  });
  t.after(() => registered.getService()?.stopAll());
  const call = (method, payload) => handlers.get(`team:${kebab(method)}`)({ sender: {} }, payload);
  const owner = member ? await host.ownerDirect() : null;
  const { invite } = await host.invite(member ? { actor: owner.member_id } : { kind: 'owner_first' });
  const teamId = parseInvite(invite).team_id;
  const answer = await call('join', { invite, display_name: 'Mika', label: 'Desk' });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  if (member) assert.equal((await host.env.store.admit({ actorMemberId: owner.member_id, memberId: answer.team.member_id })).ok, true);
  await host.waitForState(teamId, 'online');
  return { host, call, teamId, sharing, order, service: registered.getService() };
}

const drops = (s) => s.sharing.calls.filter(([kind, id]) => kind === 'drop' && id === s.teamId).length;

test('every connection change reaches sharing; leaving the team drops it', async (t) => {
  const s = await joined(t, { member: true });
  assert.ok(s.sharing.calls.some(([kind, id]) => kind === 'changed' && id === s.teamId));
  assert.equal(drops(s), 0);
  const left = await s.call('leave', { team_id: s.teamId });
  assert.equal(left.ok, true, JSON.stringify(left));
  assert.ok(drops(s) >= 1, 'left: sharing dropped');
});

test('removing the team drops sharing', async (t) => {
  const s = await joined(t);
  assert.equal((await s.call('removeTeam', { team_id: s.teamId })).ok, true);
  assert.ok(drops(s) >= 1);
});

test('a manager stopped for a pasted reconnect code (stopHeld) drops sharing, and the new one reaches it again', async (t) => {
  const s = await joined(t);
  const record = loadClientFile(s.host.userData, s.teamId).record;
  const code = encodeReconnectCode({ hostPublicKey: record.host_public_key, hints: record.address_hints });
  const changes = s.sharing.calls.length;
  assert.equal((await s.call('teamReconnectCode', { team_id: s.teamId, code: code.code })).ok, true);
  await s.host.waitForState(s.teamId, 'online');
  assert.ok(drops(s) >= 1, 'the held manager let go of sharing');
  assert.ok(s.sharing.calls.slice(changes).some(([kind, id]) => kind === 'changed' && id === s.teamId));
});

test('at quit sharing stops first, while the connections are still held', async (t) => {
  const s = await joined(t);
  let heldAtStop = -1;
  s.sharing.stopAll = async () => { heldAtStop = s.service.resources().managers; s.order.push('sharing'); };
  await s.service.stopAll();
  assert.equal(heldAtStop, 1, 'the team connection was still held when sharing stopped');
  assert.deepEqual(s.order, ['sharing']);
  assert.equal(s.service.resources().managers, 0);
});

test('the registration’s own-work check is the backend’s active-stream rule', () => {
  const backend = { activeStreams: new Map() };
  const isBusy = sharingIsBusy(backend);
  assert.equal(isBusy(), false);
  backend.activeStreams.set('s1', {});
  assert.equal(isBusy(), true);
  assert.equal(sharingIsBusy(null)(), false, 'no backend: nothing of the member’s runs');
});
