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
const { validatePayload } = require('../services/team/ipc-methods');

const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

function recordingSharing(order) {
  const calls = [];
  let chosen = null;
  return {
    calls,
    attach() {},
    snapshot: () => null,
    connectionChanged: (teamId) => calls.push(['changed', teamId]),
    drop: (teamId) => calls.push(['drop', teamId]),
    stopAll: async () => { order.push('sharing'); calls.push(['stopAll']); },
    set: async () => ({ ok: true, sharing: null }),
    // Row 201 OD-4: the sharer's Ollama share set (team-sharing.js setOllamaModels / ollamaModels).
    setOllamaModels: (teamId, names) => { calls.push(['setOllamaModels', teamId, names]); chosen = names; return { ok: true, ollama_models: names }; },
    ollamaModels: (teamId) => { calls.push(['ollamaModels', teamId]); return chosen; },
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

test('OD-4: shareOllamaModels reads the saved share set, sets it, and null returns to the default; every other shape is refused in main', async (t) => {
  const s = await joined(t);
  const { teamId } = s;
  assert.deepEqual(await s.call('shareOllamaModels', { team_id: teamId }), { ok: true, ollama_models: null }, 'a read: the default');
  assert.deepEqual(await s.call('shareOllamaModels', { team_id: teamId, names: ['qwen3:8b', 'llama3.2:latest'] }),
    { ok: true, ollama_models: ['qwen3:8b', 'llama3.2:latest'] });
  assert.deepEqual(await s.call('shareOllamaModels', { team_id: teamId }), { ok: true, ollama_models: ['qwen3:8b', 'llama3.2:latest'] });
  assert.deepEqual(await s.call('shareOllamaModels', { team_id: teamId, names: null }), { ok: true, ollama_models: null });
  assert.deepEqual(s.sharing.calls.filter(([kind]) => kind.endsWith('OllamaModels') || kind === 'ollamaModels').map(([kind, id, names]) => [kind, id, names]),
    [['ollamaModels', teamId, undefined], ['setOllamaModels', teamId, ['qwen3:8b', 'llama3.2:latest']], ['ollamaModels', teamId, undefined],
      ['setOllamaModels', teamId, null]]);
  const refused = s.sharing.calls.length;
  for (const names of [[], 'qwen3:8b', [1], ['a', 'a'], [''], ['bad\u0007name'], ['x'.repeat(129)], Array.from({ length: 65 }, (_v, i) => `m${i}`), {}, undefined]) {
    const payload = names === undefined ? { team_id: teamId, names: undefined } : { team_id: teamId, names };
    assert.equal(validatePayload('shareOllamaModels', payload).ok, false, JSON.stringify(names));
    assert.equal((await s.call('shareOllamaModels', payload)).ok, false, JSON.stringify(names));
  }
  assert.equal(validatePayload('shareOllamaModels', { team_id: teamId, names: Array.from({ length: 64 }, (_v, i) => `m${i}`) }).ok, true, "the share set's own bound");
  assert.equal(validatePayload('shareOllamaModels', { team_id: teamId, names: ['qwen3:8b'], on: true }).ok, false, 'no other field');
  assert.equal(validatePayload('shareOllamaModels', { names: ['qwen3:8b'] }).ok, false, 'a team is named');
  assert.equal(s.sharing.calls.length, refused, 'a refused shape never reaches sharing');
});
