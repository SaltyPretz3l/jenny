'use strict';

// The team IPC surface (slice 1f-1): a closed descriptor list in its own domain
// module, one main handler per invoke descriptor, each method mapped to exactly
// one host operation, payloads validated in main before anything is sent, the
// trusted-sender authorizer, and no key, secret or invite string in any answer,
// pushed state, log line, error or file (the two invite-string methods aside).

const assert = require('node:assert/strict');
const test = require('node:test');

const { JENNY_SHELL_BRIDGE_DESCRIPTORS } = require('../services/ipc-contract');
const TEAM_DESCRIPTORS = require('../services/ipc-contract/descriptors-team');
const { HOST_METHODS, HOST_OPERATIONS, LOCAL_METHODS } = require('../services/team/ipc-methods');
const { registerTeam } = require('../services/main/team-registration');
const { actionForOperation, actionForRoute } = require('../server/team/operation-registry');
const { parseInvite } = require('../server/team/invites');
const { createTeamClientHost } = require('./helpers/team-client-host');

const INVOKE_METHODS = ['join', 'status', 'leave', 'removeTeam', 'members', 'inviteCreate', 'inviteReveal',
  'inviteRevoke', 'inviteList', 'deviceInvite', 'deviceList', 'deviceRevoke', 'memberAdmit', 'memberSetRole',
  'memberRevoke', 'ownerTransfer', 'auditRead', 'rename', 'hostDeploy', 'hostStop', 'hostStatus', 'hostRecover'];
// Slice 1f-2: the team host this Jenny runs, handled in main by services/team/host/.
const HOST_INVOKE_METHODS = ['hostDeploy', 'hostStop', 'hostStatus', 'hostRecover'];

function kebab(name) {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function fakeIpcMain() {
  const handlers = new Map();
  return { handlers, handle(channel, fn) { handlers.set(channel, fn); } };
}

function register(host, { authorization = {}, ipcMain = fakeIpcMain(), extra = {} } = {}) {
  const shutdown = [];
  const registered = registerTeam(ipcMain, {
    featureFlags: { team: true }, userDataPath: host.userData, getSecureStore: () => host.secureStore,
    sendBridgeEvent: (methodPath, payload) => host.states.push(JSON.parse(JSON.stringify(payload))),
    authorization, getMainLifecycle: () => ({ registerShutdownTask: (task) => shutdown.push(task) }),
    log: host.log, serviceOptions: { ...host.serviceOptions(), ...extra },
  });
  const call = (method, payload) => ipcMain.handlers.get(`team:${kebab(method)}`)({ sender: {} }, payload);
  return { ipcMain, registered, call, shutdown };
}

test('the team domain is a closed list of invoke methods and one state subscription', () => {
  const expected = {};
  for (const method of INVOKE_METHODS) expected[`team.${method}`] = { kind: 'invoke', channel: `team:${kebab(method)}` };
  expected['team.onState'] = { kind: 'subscribe', channel: 'team:state' };
  expected['team.onHostState'] = { kind: 'subscribe', channel: 'team:host-state' };
  assert.deepEqual({ ...TEAM_DESCRIPTORS }, expected);
  assert.ok(Object.isFrozen(TEAM_DESCRIPTORS));
  for (const [path, descriptor] of Object.entries(expected)) {
    assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS[path], descriptor, path);
  }
  assert.deepEqual(Object.keys(JENNY_SHELL_BRIDGE_DESCRIPTORS).filter((key) => key.startsWith('team.')).sort(),
    Object.keys(expected).sort());
  assert.equal(Object.keys(expected).some((key) => /key|secret|address/i.test(key)), false,
    'no method hands out a key or an address');
});

test('every invoke descriptor has a handler and every handler a descriptor', async (t) => {
  const host = await createTeamClientHost(t, { startBridge: false });
  const { ipcMain } = register(host);
  const expectedChannels = Object.values(TEAM_DESCRIPTORS).filter((d) => d.kind === 'invoke').map((d) => d.channel);
  assert.deepEqual([...ipcMain.handlers.keys()].sort(), expectedChannels.sort());
});

test('each method maps to exactly one host operation from a fixed table', () => {
  const mapped = Object.keys(HOST_OPERATIONS);
  assert.deepEqual([...mapped, ...LOCAL_METHODS, ...HOST_METHODS].sort(), [...INVOKE_METHODS].sort());
  assert.deepEqual([...HOST_METHODS], HOST_INVOKE_METHODS);
  assert.deepEqual([...LOCAL_METHODS].sort(), ['join', 'removeTeam', 'status']);
  const operations = Object.values(HOST_OPERATIONS);
  assert.equal(new Set(operations).size, operations.length, 'no two methods share an operation');
  for (const [method, operation] of Object.entries(HOST_OPERATIONS)) {
    assert.ok(actionForOperation(operation, {}) || actionForRoute(operation), `${method} -> ${operation} is a host operation`);
  }
  assert.ok(Object.isFrozen(HOST_OPERATIONS));
});

test('each command method reaches the host as its mapped operation', async (t) => {
  const host = await createTeamClientHost(t);
  const { call } = register(host);
  const { invite } = await host.invite({ kind: 'owner_first' });
  const teamId = parseInvite(invite).team_id;
  assert.equal((await call('join', { invite, display_name: 'Olive Owner', label: 'Desk' })).ok, true);
  await host.waitForState(teamId, 'online');
  const pending = await host.env.redeemDirect({ actor: host.env.store.snapshot().members[0].member_id,
    name: 'Pia Pending' });
  const created = await call('inviteCreate', { team_id: teamId, role: 'member' });
  const calls = [
    ['members', {}], ['inviteList', {}], ['inviteReveal', { invite_id: created.invite_id }],
    ['inviteRevoke', { invite_id: created.invite_id }], ['deviceList', {}], ['deviceInvite', {}],
    ['memberAdmit', { member_id: pending.member_id }], ['memberSetRole', { member_id: pending.member_id, role: 'read_only' }],
    ['auditRead', { limit: 5 }], ['rename', { name: 'Calm Harbour' }], ['deviceRevoke', { device_id: pending.device_id }],
    ['memberRevoke', { member_id: pending.member_id }],
  ];
  for (const [method, params] of calls) {
    const before = host.env.logs.length;
    const answer = await call(method, { team_id: teamId, ...params });
    const seen = host.env.logs.slice(before).filter((line) => line.event === 'team_command.answered')
      .map((line) => line.fields.operation);
    assert.deepEqual(seen, [HOST_OPERATIONS[method]], `${method} -> ${JSON.stringify(answer)}`);
  }
  // The host has no schema for transfer yet (slice 1h): it is still sent as that one operation and refused there.
  const transfer = await call('ownerTransfer', { team_id: teamId, member_id: pending.member_id });
  assert.equal(transfer.ok, false);
});

test('a bad payload is refused in main with zero host requests', async (t) => {
  const host = await createTeamClientHost(t);
  const { call } = register(host);
  const { invite } = await host.invite({ kind: 'owner_first' });
  const teamId = parseInvite(invite).team_id;
  assert.equal((await call('join', { invite, display_name: 'Olive Owner', label: 'Desk' })).ok, true);
  await host.waitForState(teamId, 'online');
  const before = host.env.logs.length;
  const spawns = host.memberSpawner.spawns.length;
  const bad = [
    ['members', { team_id: teamId, extra: 1 }],
    ['members', { team_id: 'team_../x' }],
    ['members', { team_id: `team_${'a'.repeat(65)}` }],
    ['members', null],
    ['members', 'team'],
    ['members', [teamId]],
    ['rename', { team_id: teamId, name: 'x'.repeat(129) }],
    ['rename', { team_id: teamId, name: '' }],
    ['rename', { team_id: teamId }],
    ['memberSetRole', { team_id: teamId, member_id: 'member_x', role: 'owner' }],
    ['memberAdmit', { team_id: teamId, member_id: 'device_x' }],
    ['inviteCreate', { team_id: teamId, role: 'member', ttl_ms: 1 }],
    ['auditRead', { team_id: teamId, limit: 101 }],
    ['join', { invite, display_name: 'x'.repeat(65), label: 'Desk' }],
    ['join', { invite, display_name: 'Olive', label: 'Desk', team_id: teamId }],
    ['join', { invite: 'x'.repeat(300), display_name: 'Olive', label: 'Desk' }],
    ['leave', { team_id: teamId, now: true }],
    ['status', { team_id: teamId }],
    ['removeTeam', {}],
  ];
  for (const [method, payload] of bad) {
    const answer = await call(method, payload);
    assert.equal(answer.ok, false, `${method} ${JSON.stringify(payload)}`);
    assert.equal(answer.error.code, 'invalid_request');
  }
  const unknown = await call('members', { team_id: 'team_unknownTeamId123' });
  assert.equal(unknown.error.reason, 'team_not_found');
  assert.deepEqual(host.env.logs.slice(before).filter((line) => line.event.startsWith('team_command')), []);
  assert.equal(host.memberSpawner.spawns.length, spawns);
  assert.equal(host.lastState(teamId).state, 'online');
});

test('an untrusted sender is refused before the service exists', async (t) => {
  const host = await createTeamClientHost(t, { startBridge: false });
  const { call, registered } = register(host, {
    authorization: { authorize: () => false, unauthorizedResult: () => ({ ok: false, code: 'ipc_sender_unauthorized' }) },
  });
  assert.deepEqual(await call('status', undefined), { ok: false, code: 'ipc_sender_unauthorized' });
  assert.deepEqual(await call('join', { invite: 'jteam1_x', display_name: 'A', label: 'B' }),
    { ok: false, code: 'ipc_sender_unauthorized' });
  assert.equal(registered.getService(), null);
  for (const method of HOST_INVOKE_METHODS) {
    assert.deepEqual(await call(method, method === 'hostDeploy' ? { name: 'S', display_name: 'A', label: 'B' } : undefined),
      { ok: false, code: 'ipc_sender_unauthorized' }, method);
  }
  assert.equal(registered.getHost(), null, 'no host controller exists for an untrusted sender');
});

test('no seed, invite secret, launch secret or invite string in answers, pushed state, logs, errors or files', async (t) => {
  const host = await createTeamClientHost(t);
  const { call } = register(host);
  const { invite } = await host.invite({ kind: 'owner_first' });
  const parsed = parseInvite(invite);
  const answers = [];
  const record = async (method, payload) => { const answer = await call(method, payload); answers.push([method, answer]); return answer; };
  await record('join', { invite, display_name: 'Olive Owner', label: 'Desk' });
  await host.waitForState(parsed.team_id, 'online');
  await record('status', undefined);
  await record('members', { team_id: parsed.team_id });
  const created = await record('inviteCreate', { team_id: parsed.team_id, role: 'member' });
  const revealed = await record('inviteReveal', { team_id: parsed.team_id, invite_id: created.invite_id });
  const deviceInvite = await record('deviceInvite', { team_id: parsed.team_id });
  assert.equal(typeof revealed.invite, 'string');
  assert.equal(typeof deviceInvite.invite, 'string');
  const failed = await record('join', { invite: invite.slice(0, -2), display_name: 'Olive Owner', label: 'Desk' });
  assert.equal(failed.ok, false);

  const seed = host.secureStore.values.get(`team_device_key:${parsed.team_id}`);
  const launchSecrets = host.memberSpawner.children.map((child) => child.startLine?.launch_secret).filter(Boolean);
  const needles = [seed, parsed.invite_secret_key, invite, ...launchSecrets];
  assert.ok(seed && launchSecrets.length > 0);
  // The client file holds the host's public key and addresses; nothing the renderer or a log sees does
  // (an invite string begins with the host key by design, so the two invite answers are left out here).
  const plainAnswers = answers.filter(([method]) => method !== 'inviteReveal' && method !== 'deviceInvite');
  for (const text of [JSON.stringify(plainAnswers), JSON.stringify(host.states), JSON.stringify(host.logs)]) {
    assert.equal(text.includes(parsed.host_public_key), false, 'no host key outside main');
  }
  const inviteNeedles = [revealed.invite, deviceInvite.invite];
  const haystacks = {
    answers: JSON.stringify(plainAnswers),
    states: JSON.stringify(host.states),
    logs: JSON.stringify(host.logs),
    files: JSON.stringify(host.files()),
  };
  for (const [where, text] of Object.entries(haystacks)) {
    for (const needle of needles) assert.equal(text.includes(needle), false, `${where} carries a secret`);
    for (const needle of inviteNeedles) assert.equal(text.includes(needle), false, `${where} carries an invite string`);
    assert.equal(/192\.0\.2\.7|2001:db8/.test(where === 'files' ? '' : text), false, `${where} carries an address`);
  }
});
