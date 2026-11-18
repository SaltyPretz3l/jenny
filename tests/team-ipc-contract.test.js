'use strict';

// The team IPC surface (slice 1f-1): a closed descriptor list in its own domain
// module, one main handler per invoke descriptor, each method mapped to exactly
// one host operation, payloads validated in main before anything is sent, the
// trusted-sender authorizer, and no key, secret or invite string in any answer,
// pushed state, log line, error or file (the two invite-string methods aside).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { JENNY_SHELL_BRIDGE_DESCRIPTORS } = require('../services/ipc-contract');
const TEAM_DESCRIPTORS = require('../services/ipc-contract/descriptors-team');
const { BOARD_OPERATIONS, CHAT_LOCAL_METHODS, CHAT_OPERATIONS, HOST_METHODS, HOST_OPERATIONS, LOCAL_METHODS, MODEL_OPERATIONS, POOL_OPERATIONS, PROJECT_DRAFT_METHODS, PROJECT_OPERATIONS, RECONNECT_METHODS, SHARE_METHODS, validatePayload,
} = require('../services/team/ipc-methods');
const { registerTeam } = require('../services/main/team-registration');
const ATTACHMENTS = { chatUpload: 'POST /api/v1/team/chat/uploads/:channel_id', chatUploadCancel: null, chatAttachPick: null, chatAttachmentImage: 'GET /api/v1/team/chat/attachments/:channel_id/:id', chatAttachmentText: 'GET /api/v1/team/chat/attachments/:channel_id/:id', chatAttachmentCopy: 'GET /api/v1/team/chat/attachments/:channel_id/:id', chatAttachmentSave: 'GET /api/v1/team/chat/attachments/:channel_id/:id', chatAttachmentReveal: null };
const { actionForOperation, actionForRoute } = require('../server/team/operation-registry');
const { parseInvite } = require('../server/team/invites');
const { keyPairFromSeed } = require('../server/team/ids');
const { rosterView } = require('../server/team/team-views');
const { clientFilePath, loadClientFile } = require('../services/team/client-file');
const { encodeReconnectCode } = require('../services/team/reconnect-code');
const { createTeamClientHost, waitUntil } = require('./helpers/team-client-host');
const { attachTeamChat, commandAs } = require('./helpers/team-chat-hook');
const { PROJECT_METHODS } = require('./helpers/team-project-client-host'); const { BOARD_METHODS, MODEL_METHODS } = require('./helpers/team-model-methods'); // 6-5, row 151 T3

// Slice 5-6: the owner's whole-team operations (tests/team-host-delete.test.js, tests/team-host-export-restore.test.js).
const LIFECYCLE = ['hostInventory', 'hostDelete', 'hostStartNew', 'hostOldDelete', 'hostOldShow', 'hostExport', 'hostRestorePick',
  'hostRestore', 'hostAutostart', 'hostSummary', 'hostOpenFolder'];
const INVOKE_METHODS = ['join', 'status', 'leave', 'removeTeam', 'members', 'inviteCreate', 'inviteReveal',
  'inviteRevoke', 'inviteList', 'deviceInvite', 'deviceList', 'deviceRevoke', 'memberAdmit', 'memberSetRole',
  'memberRevoke', 'ownerTransfer', 'auditRead', 'rename', 'profileSet', 'hostDeploy', 'hostStop', 'hostStatus', 'hostRecover',
  // Slice 2a-4b: team chat (team.chat.sync is internal to main and has no method).
  'chatOverview', 'chatHistory', 'chatThread', 'chatPost', 'chatEdit', 'chatDelete', 'chatMarkRead', 'chatSetNotify',
  'chatFollow', 'chatDraftGet', 'chatDraftSet', 'chatOutboxDiscard',
  // Slice 2a-4c: search, typing and presence.
  'chatSearch', 'chatTyping', 'presenceSet',
  // Reactions, pins, edit history and pinned messages.
  'chatReact', 'chatPin', 'chatEdits', 'chatPins',
  // Slice 2d: open a direct conversation; slice 2c renderer: chat attachments.
  'chatDmOpen', 'chatChannelCreate', 'chatChannelUpdate', 'chatChannelArchive', 'chatChannelDelete', 'chatUpload', 'chatUploadCancel', 'chatAttachPick', 'chatAttachmentImage', 'chatAttachmentText', 'chatAttachmentCopy', 'chatAttachmentSave', 'chatAttachmentReveal',
  // Slice 5-3: the reconnect code.
  'teamReconnectCode', 'hostReconnectCode',
  // Slice 5-5b: the host's internet joining setting; slice 6-7: the host's model relay setting.
  'hostInternet', 'hostModelRelay', 'hostFileTools',
  // Slice 4e: this PC's GPU sharing, the team's GPUs, GPU use and the team model.
  'shareStatus', 'shareSet', 'sharePause', 'shareStop', 'gpuList', 'gpuUse', 'teamModelSet', ...LIFECYCLE, ...PROJECT_METHODS, 'projectFiles', 'projectFileRead', 'projectRegenerate', 'projectEditResend', 'projectBranch', 'projectAskTeammate', 'projectHandDriver', 'projectDraftGet', 'projectDraftSet', ...MODEL_METHODS, ...BOARD_METHODS];
// Slice 1f-2: the team host this Jenny runs, handled in main by services/team/host/.
const HOST_INVOKE_METHODS = ['hostDeploy', 'hostStop', 'hostStatus', 'hostRecover', 'hostReconnectCode', 'hostInternet', 'hostModelRelay', 'hostFileTools', ...LIFECYCLE];

function kebab(name) {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function fakeIpcMain() {
  const handlers = new Map();
  return { handlers, handle(channel, fn) { handlers.set(channel, fn); } };
}

// Every registration's shutdown task runs at the end: an online team holds an engine port (slice 4b
// member wiring), a listening socket that would otherwise keep the file's process alive.
const shutdowns = [];
test.after(() => Promise.allSettled(shutdowns.flat().map((task) => task())));

function register(host, { authorization = {}, ipcMain = fakeIpcMain(), extra = {} } = {}) {
  const shutdown = [];
  shutdowns.push(shutdown);
  const chatPushes = []; const projectPushes = []; // row 175: project pushes (the list is read at connect) are not team state
  const registered = registerTeam(ipcMain, {
    featureFlags: { team: true }, userDataPath: host.userData, getSecureStore: () => host.secureStore, readOfflineMode: () => 'disabled',
    sendBridgeEvent: (methodPath, payload) => (methodPath === 'team.onChat' ? chatPushes : methodPath === 'team.onProject' ? projectPushes : host.states)
      .push(JSON.parse(JSON.stringify(payload))),
    authorization, getMainLifecycle: () => ({ registerShutdownTask: (task) => shutdown.push(task) }),
    log: host.log, serviceOptions: { ...host.serviceOptions(), ...extra },
  });
  const call = (method, payload) => ipcMain.handlers.get(`team:${kebab(method)}`)({ sender: {} }, payload);
  return { ipcMain, registered, call, shutdown, chatPushes };
}

test('the team domain is a closed list of invoke methods and one state subscription', () => {
  const expected = {};
  for (const method of INVOKE_METHODS) expected[`team.${method}`] = { kind: 'invoke', channel: `team:${kebab(method)}` };
  expected['team.onState'] = { kind: 'subscribe', channel: 'team:state' };
  expected['team.onHostState'] = { kind: 'subscribe', channel: 'team:host-state' };
  expected['team.onChat'] = { kind: 'subscribe', channel: 'team:chat' };
  expected['team.onProject'] = { kind: 'subscribe', channel: 'team:project' }; expected['team.onModel'] = { kind: 'subscribe', channel: 'team:model' }; expected['team.onBoard'] = { kind: 'subscribe', channel: 'team:board' };
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
  const mapped = [...Object.keys(HOST_OPERATIONS), ...Object.keys(CHAT_OPERATIONS), ...Object.keys(POOL_OPERATIONS),
    ...Object.keys(PROJECT_OPERATIONS), ...Object.keys(ATTACHMENTS), ...Object.keys(MODEL_OPERATIONS), ...Object.keys(BOARD_OPERATIONS)];
  assert.deepEqual([...mapped, ...LOCAL_METHODS, ...HOST_METHODS, ...CHAT_LOCAL_METHODS, ...SHARE_METHODS, ...PROJECT_DRAFT_METHODS].sort(), [...INVOKE_METHODS].sort());
  // Slice 4e: the pool methods each mirror one host operation; the share methods are local to this Jenny.
  assert.deepEqual(POOL_OPERATIONS, { gpuList: 'team.node.list', gpuUse: 'team.pool.usage', teamModelSet: 'team.pool.model.set' });
  for (const operation of Object.values(POOL_OPERATIONS)) assert.ok(actionForOperation(operation, {}), operation);
  assert.deepEqual([...CHAT_LOCAL_METHODS].sort(), ['chatDraftGet', 'chatDraftSet', 'chatOutboxDiscard']);
  for (const route of Object.values(ATTACHMENTS).filter(Boolean)) assert.ok(actionForRoute(route), route); // 2c: the raw routes
  // A host may not know `team.chat.pins` yet; the registry check covers it once the host registry has it.
  const pendingHost = new Set(['team.chat.pins']);
  for (const [method, operation] of Object.entries(CHAT_OPERATIONS)) {
    assert.ok((operation.startsWith('team.chat.') || operation === 'team.presence.set')
      && (actionForOperation(operation, {}) || pendingHost.has(operation)), `${method} -> ${operation}`);
  }
  assert.deepEqual([CHAT_OPERATIONS.chatReact, CHAT_OPERATIONS.chatPin, CHAT_OPERATIONS.chatEdits, CHAT_OPERATIONS.chatPins],
    ['team.chat.react', 'team.chat.pin', 'team.chat.edits', 'team.chat.pins']);
  assert.equal(Object.values(CHAT_OPERATIONS).includes('team.chat.sync'), false, 'sync is internal to main');
  assert.ok(Object.isFrozen(CHAT_OPERATIONS));
  assert.deepEqual([...HOST_METHODS], HOST_INVOKE_METHODS);
  assert.deepEqual([...LOCAL_METHODS].sort(), ['join', 'removeTeam', 'status', 'teamReconnectCode']);
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
    ['join', { invite: 'x'.repeat(513), display_name: 'Olive', label: 'Desk' }],
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

// E49 (review finding R04-F05): a hostile host. Fault: a host answer passed to the renderer as sent, so an
// address and 100 kB of anything ride along, or a status team name of 10,000 characters reaches every push.
test('a hostile host\'s extra fields and over-long status name never reach the renderer', async (t) => {
  const host = await createTeamClientHost(t);
  const { store } = host.env;
  const teamName = store.teamName;
  store.teamName = () => 'x'.repeat(10_000);
  t.after(() => { store.teamName = teamName; });
  const { call } = register(host);
  const { invite } = await host.invite({ kind: 'owner_first' });
  const teamId = parseInvite(invite).team_id;
  assert.equal((await call('join', { invite, display_name: 'Olive Owner', label: 'Desk' })).ok, true);
  await host.waitForState(teamId, 'online');
  const honest = rosterView(store.snapshot(), { owner: true });
  host.env.commandHook = (command) => (command?.operation === 'team.members.list'
    ? { ok: true, ...honest, address: '192.0.2.9:1', extra: 'x'.repeat(100_000), request_id: command.request_id } : null);
  const answer = await call('members', { team_id: teamId });
  host.env.commandHook = null;
  assert.deepEqual(answer, { ok: true, ...honest });
  const row = (await call('status', undefined)).teams.find((team) => team.team_id === teamId);
  assert.equal(row.team_name, null);
  assert.equal(host.lastState(teamId).team_name, null, 'the push carries no long name');
  const text = JSON.stringify(host.states);
  assert.equal(text.includes('192.0.2.9') || text.includes('x'.repeat(41)), false);
});

// Slice 2a-4b: the chat methods. A member joined and online on a host that runs the real chat dispatcher.
async function chatMember(t) {
  const host = await createTeamClientHost(t);
  const chat = await attachTeamChat(t, host);
  const registration = register(host);
  const { invite } = await host.invite({ kind: 'owner_first' });
  const teamId = parseInvite(invite).team_id;
  assert.equal((await registration.call('join', { invite, display_name: 'Olive Owner', label: 'Desk' })).ok, true);
  await host.waitForState(teamId, 'online');
  return { host, chat, teamId, invite, ...registration };
}

const CHANNEL = 'chan_team';
const MESSAGE = 'msg_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MEMBER_A = 'member_aaaaaaaaaa';

test('every chat method refuses extra fields, wrong types and over-long values with nothing sent', async (t) => {
  const { host, teamId, call } = await chatMember(t);
  const before = host.env.commandsSeen.length;
  const longText = 'x'.repeat(16_001);
  const bad = [
    ['chatOverview', { team_id: teamId, extra: 1 }], ['chatOverview', {}], ['chatOverview', null],
    ['chatHistory', { team_id: teamId, channel_id: 'general' }],
    ['chatHistory', { team_id: teamId, channel_id: CHANNEL, limit: 101 }],
    ['chatHistory', { team_id: teamId, channel_id: CHANNEL, before_seq: 0 }],
    ['chatHistory', { team_id: teamId, channel_id: CHANNEL, before_seq: '5' }],
    ['chatHistory', { team_id: teamId, channel_id: `chan_project_${'a'.repeat(200)}` }],
    ['chatThread', { team_id: teamId, channel_id: CHANNEL }],
    ['chatThread', { team_id: teamId, channel_id: CHANNEL, root_id: 'msg_short' }],
    ['chatThread', { team_id: teamId, channel_id: CHANNEL, root_id: MESSAGE, after_seq: -1 }],
    ['chatPost', { team_id: teamId, channel_id: CHANNEL, text: '' }],
    ['chatPost', { team_id: teamId, channel_id: CHANNEL, text: longText }],
    ['chatPost', { team_id: teamId, channel_id: CHANNEL, text: 'hi', request_id: 'req_mine' }],
    ['chatPost', { team_id: teamId, channel_id: CHANNEL, text: 'hi', refs: [{ kind: 'url', url: 'x' }] }],
    ['chatPost', { team_id: teamId, channel_id: CHANNEL, text: 'hi', thread_root_id: 7 }],
    ['chatPost', { team_id: teamId, channel_id: CHANNEL, text: `a${String.fromCharCode(0)}b` }],
    ['chatEdit', { team_id: teamId, channel_id: CHANNEL, message_id: MESSAGE, text: 'x' }],
    ['chatEdit', { team_id: teamId, channel_id: CHANNEL, message_id: MESSAGE, text: 'x', expected_rev: 0 }],
    ['chatDelete', { team_id: teamId, channel_id: CHANNEL, message_id: MESSAGE, now: true }],
    ['chatDelete', { team_id: teamId, channel_id: CHANNEL }],
    ['chatDelete', { team_id: teamId, channel_id: CHANNEL, message_id: 'msg_short' }],
    ['chatDelete', { team_id: teamId, channel_id: CHANNEL, message_id: 7 }],
    ['chatDelete', { team_id: teamId, channel_id: CHANNEL, message_id: `${MESSAGE}x` }],
    ['chatMarkRead', { team_id: teamId, channel_id: CHANNEL, seq: -1 }],
    ['chatMarkRead', { team_id: teamId, channel_id: CHANNEL, seq: 1, unread: 'yes' }],
    ['chatMarkRead', { team_id: teamId, channel_id: CHANNEL, seq: 1, thread_root_id: 'msg_short' }],
    // E59: Mark unread never goes with a thread (the host refuses the pair too).
    ['chatMarkRead', { team_id: teamId, channel_id: CHANNEL, seq: 1, unread: true, thread_root_id: MESSAGE }],
    ['chatMarkRead', { team_id: teamId, channel_id: CHANNEL, seq: 1, unread: false, thread_root_id: MESSAGE }],
    ['chatMarkRead', { team_id: teamId, channel_id: CHANNEL, seq: 1, thread_root_id: 7 }],
    ['chatSetNotify', { team_id: teamId, channel_id: CHANNEL, level: 'loud' }],
    ['chatFollow', { team_id: teamId, channel_id: CHANNEL, root_id: MESSAGE, on: 1 }],
    ['chatDraftGet', { team_id: teamId }],
    ['chatDraftSet', { team_id: teamId, channel_id: CHANNEL, text: 'x'.repeat(70_000) }],
    ['chatDraftSet', { team_id: teamId, channel_id: CHANNEL, text: 5 }],
    ['chatOutboxDiscard', { team_id: teamId, entry_id: 'req_1' }],
    ['chatOutboxDiscard', { team_id: teamId, entry_id: `out_${'a'.repeat(100)}` }],
    // Slice 2a-4c.
    ['chatSearch', { team_id: teamId }],
    ['chatSearch', { team_id: teamId, query: '' }],
    ['chatSearch', { team_id: teamId, query: 'x'.repeat(201) }],
    ['chatSearch', { team_id: teamId, query: 7 }],
    ['chatSearch', { team_id: teamId, query: 'x', limit: 0 }],
    ['chatSearch', { team_id: teamId, query: 'x', limit: 51 }],
    ['chatSearch', { team_id: teamId, query: 'x', cursor: '' }],
    ['chatSearch', { team_id: teamId, query: 'x', cursor: 'not base64url!' }],
    ['chatSearch', { team_id: teamId, query: 'x', cursor: 'a'.repeat(513) }],
    ['chatSearch', { team_id: teamId, query: 'x', channel_id: 'general' }],
    ['chatSearch', { team_id: teamId, query: 'x', request_id: 'req_mine' }],
    ['chatSearch', { query: 'x' }],
    ['chatTyping', { team_id: teamId }],
    ['chatTyping', { team_id: teamId, channel_id: CHANNEL, thread_root_id: 'msg_short' }],
    ['chatTyping', { team_id: teamId, channel_id: CHANNEL, member_id: 'member_x' }],
    ['chatTyping', { channel_id: CHANNEL }],
    ['presenceSet', { team_id: teamId }],
    // Reactions, pins, edit history and pinned messages.
    ['chatReact', { team_id: teamId, channel_id: CHANNEL, message_id: MESSAGE, emoji: '\u{1F44D}' }],
    ['chatReact', { team_id: teamId, channel_id: CHANNEL, message_id: MESSAGE, emoji: 'x', on: true }],
    ['chatReact', { team_id: teamId, channel_id: CHANNEL, message_id: MESSAGE, emoji: '\u{1F984}', on: true }],
    ['chatReact', { team_id: teamId, channel_id: CHANNEL, message_id: MESSAGE, emoji: '\u{1F44D}', on: 1 }],
    ['chatReact', { team_id: teamId, channel_id: CHANNEL, message_id: 'msg_short', emoji: '\u{1F44D}', on: true }],
    ['chatReact', { team_id: teamId, channel_id: CHANNEL, message_id: MESSAGE, emoji: '\u{1F44D}', on: true, extra: 1 }],
    ['chatPin', { team_id: teamId, channel_id: CHANNEL, message_id: MESSAGE }],
    ['chatPin', { team_id: teamId, channel_id: CHANNEL, message_id: 7, on: true }],
    ['chatPin', { team_id: teamId, channel_id: CHANNEL, message_id: MESSAGE, on: true, emoji: '\u{1F44D}' }],
    ['chatEdits', { team_id: teamId, channel_id: CHANNEL }],
    ['chatEdits', { team_id: teamId, channel_id: CHANNEL, message_id: MESSAGE, extra: 1 }],
    ['chatPins', { team_id: teamId, channel_id: 'general' }],
    ['chatPins', { team_id: teamId, channel_id: CHANNEL, message_id: MESSAGE }],
    ['presenceSet', { team_id: teamId, state: 'away' }],
    ['presenceSet', { team_id: teamId, state: 'offline' }],
    ['presenceSet', { team_id: teamId, state: 'active', extra: true }],
    ['presenceSet', { state: 'idle' }],
    ['presenceSet', null],
    // Slice 2d: 1 to 7 distinct member ids, nothing else.
    ['chatDmOpen', { team_id: teamId }],
    ['chatDmOpen', { team_id: teamId, member_ids: [] }],
    ['chatDmOpen', { team_id: teamId, member_ids: 'member_x' }],
    ['chatDmOpen', { team_id: teamId, member_ids: ['not a member id'] }],
    ['chatDmOpen', { team_id: teamId, member_ids: [MEMBER_A, MEMBER_A] }],
    ['chatDmOpen', { team_id: teamId, member_ids: Array.from({ length: 8 }, (_, i) => `member_${String(i).padStart(10, 'a')}`) }],
    ['chatDmOpen', { team_id: teamId, member_ids: [MEMBER_A], channel_id: CHANNEL }],
    ['chatDmOpen', { member_ids: [MEMBER_A] }],
  ];
  for (const [method, payload] of bad) {
    const answer = await call(method, payload);
    assert.equal(answer.ok, false, `${method} ${JSON.stringify(payload).slice(0, 120)}`);
    assert.equal(answer.error.code, 'invalid_request', method);
    // The payload check itself: a queued chat mutation is also refused later by the outbox shape check, with the same code.
    assert.equal(validatePayload(method, payload).ok, false, `validatePayload ${method} ${JSON.stringify(payload).slice(0, 120)}`);
  }
  assert.deepEqual(host.env.commandsSeen.slice(before), [], 'nothing reached the host');
  assert.equal(host.lastState(teamId).state, 'online');
});

test('chat answers and pushes carry no key, token, address or replayable request id', async (t) => {
  const { host, chat, teamId, call, chatPushes, invite } = await chatMember(t);
  // Slice 2a-4c: a second member, admitted, so the list, presence and typing carry someone else.
  const ownerId = host.env.store.snapshot().members[0].member_id;
  const other = await host.env.redeemDirect({ actor: ownerId, name: 'Pia Peer' });
  assert.equal((await host.env.store.admit({ actorMemberId: ownerId, memberId: other.member_id })).ok, true);
  const answers = [];
  const record = async (method, payload) => {
    const answer = await call(method, { team_id: teamId, ...payload });
    answers.push([method, answer]);
    return answer;
  };
  assert.equal((await record('chatOverview', {})).ok, true);
  assert.equal((await record('chatHistory', { channel_id: CHANNEL })).ok, true);
  assert.equal((await record('chatPost', { channel_id: CHANNEL, text: 'hello team' })).ok, true);
  assert.ok(await waitUntil(() => chatPushes.some((push) => push.type === 'messages'
    && push.messages.some((message) => message.text === 'hello team'))), 'the message event reached the push');
  const cached = await record('chatHistory', { channel_id: CHANNEL });
  const root = cached.messages.find((message) => message.text === 'hello team');
  await record('chatThread', { channel_id: CHANNEL, root_id: root.id });
  await record('chatMarkRead', { channel_id: CHANNEL, seq: root.seq });
  await record('chatSetNotify', { channel_id: CHANNEL, level: 'all' });
  await record('chatFollow', { channel_id: CHANNEL, root_id: root.id, on: true });
  await record('chatDraftSet', { channel_id: CHANNEL, text: 'half a thought' });
  assert.equal((await record('chatDraftGet', { channel_id: CHANNEL })).text, 'half a thought');
  await record('chatEdit', { channel_id: CHANNEL, message_id: root.id, text: 'hello again', expected_rev: root.rev });
  assert.ok(await waitUntil(() => chatPushes.some((push) => push.type === 'messages'
    && push.messages.some((message) => message.text === 'hello again'))), 'the edit was applied');
  // The four mark methods through the real service, bridge and host.
  assert.equal((await record('chatReact', { channel_id: CHANNEL, message_id: root.id, emoji: '\u{1F44D}', on: true })).ok, true);
  assert.equal((await record('chatPin', { channel_id: CHANNEL, message_id: root.id, on: true })).ok, true);
  assert.equal((await record('chatEdits', { channel_id: CHANNEL, message_id: root.id })).ok, true);
  await record('chatPins', { channel_id: CHANNEL });
  // Slice 2d: a direct conversation with the other member, then a refusal naming nobody on the team.
  const dm = await record('chatDmOpen', { member_ids: [other.member_id] });
  assert.match(dm.channel_id || '', /^chan_dm_[a-f0-9]{64}$/u, JSON.stringify(dm));
  const dmRefused = await record('chatDmOpen', { member_ids: [ownerId] });
  assert.equal(dmRefused.error?.reason, 'team_chat_dm_members_invalid', JSON.stringify(dmRefused));
  await record('chatDelete', { channel_id: CHANNEL, message_id: root.id });
  await record('chatOutboxDiscard', { entry_id: 'out_AAAAAAAAAAAAAAAAAAAA' });
  // Slice 2a-4c: search, typing, presence and their pushes.
  assert.equal((await record('chatSearch', { query: 'hello' })).ok, true);
  // A refusal from the real host carries its request id; the client passes on its code and reason only.
  const refused = await record('chatSearch', { query: 'hello', cursor: 'AAAA' });
  assert.equal(refused.error?.reason, 'team_chat_cursor_invalid', JSON.stringify(refused));
  assert.equal((await record('chatTyping', { channel_id: CHANNEL })).ok, true);
  assert.equal((await record('presenceSet', { state: 'idle' })).ok, true);
  assert.equal((await commandAs(host, other, 'team.chat.typing', { channel_id: CHANNEL })).ok, true);
  chat.onMemberStream(other.member_id, other.device_id, 'open');
  assert.ok(await waitUntil(() => chatPushes.some((push) => push.type === 'typing')
    && chatPushes.some((push) => push.type === 'presence')), 'the typing and presence pushes arrived');
  assert.ok(chatPushes.some((push) => push.type === 'members'), 'the members push arrived');
  assert.ok(await waitUntil(() => chatPushes.some((push) => push.type === 'messages'
    && push.messages.some((message) => message.id === root.id && message.deleted !== null))), 'the delete was applied');

  const parsed = parseInvite(invite);
  const seed = host.secureStore.values.get(`team_device_key:${teamId}`);
  const tokens = [...host.env.context.clients.clients.values()].map((entry) => entry.token);
  const requestIds = host.env.commandsSeen.filter((seen) => seen.operation?.startsWith('team.chat.')
    || seen.operation === 'team.presence.set').map((seen) => seen.request_id);
  for (const operation of ['team.chat.search', 'team.chat.typing', 'team.presence.set']) {
    assert.ok(host.env.commandsSeen.some((seen) => seen.operation === operation), `${operation} reached the host`);
  }
  const launchSecrets = host.memberSpawner.children.map((child) => child.startLine?.launch_secret).filter(Boolean);
  assert.ok(seed && tokens.length > 0 && requestIds.length >= 8 && launchSecrets.length > 0);
  const text = JSON.stringify({ answers, chatPushes });
  for (const needle of [seed, parsed.host_public_key, host.env.bootSecret.toString('base64url'), ...tokens, ...requestIds,
    ...launchSecrets]) {
    assert.equal(text.includes(needle), false, 'a secret, token or request id reached the renderer');
  }
  // Slice 2a-4c: pushes are rebuilt from checked fields, never the event frame (its boot epoch and cursor).
  assert.equal(text.includes(host.env.core.bootEpoch), false, 'the host stream identity reached the renderer');
  for (const push of chatPushes.filter((item) => item.type === 'typing' || item.type === 'presence')) {
    assert.equal(Object.hasOwn(push, 'cursor') || Object.hasOwn(push, 'event_type'), false, 'an event frame was pushed');
  }
  assert.equal(/192\.0\.2\.7|2001:db8|127\.0\.0\.1|localhost/.test(text), false, 'no address');
  assert.equal(/request_id|client_token|cookie/i.test(text), false, 'no request id or token field');
  const logs = JSON.stringify(host.logs);
  for (const words of ['hello team', 'hello again', 'half a thought']) assert.equal(logs.includes(words), false, 'no text in a log');
});

// Slice 5-3: the payload checks of the two reconnect-code methods. Fault: a code past 512 characters,
// a control character, a missing team id or an extra field reaching the reconnect code module.
test('the reconnect-code methods check their payloads in main and are routed', () => {
  const teamId = 'team_abcDEF123';
  assert.deepEqual([...RECONNECT_METHODS], ['teamReconnectCode', 'hostReconnectCode']);
  assert.deepEqual(validatePayload('teamReconnectCode', { team_id: teamId, code: `jteamaddr1_${'A'.repeat(501)}` }).ok, true);
  for (const payload of [
    { team_id: teamId, code: `jteamaddr1_${'A'.repeat(502)}` }, { team_id: teamId, code: '' },
    { team_id: teamId, code: 'jteamaddr1_\nAAAA' }, { team_id: teamId }, { code: 'jteamaddr1_AAAA' },
    { team_id: teamId, code: 'jteamaddr1_AAAA', host: 'x' }, { team_id: 'team_../x', code: 'jteamaddr1_AAAA' }, null,
  ]) {
    assert.equal(validatePayload('teamReconnectCode', payload).ok, false, JSON.stringify(payload));
  }
  assert.deepEqual(validatePayload('hostReconnectCode', undefined), { ok: true, value: {} });
  assert.equal(validatePayload('hostReconnectCode', { team_id: teamId }).ok, false);
  assert.equal(validatePayload('join', { invite: 'x'.repeat(512), display_name: 'Olive', label: 'Desk' }).ok, true);
  assert.equal(validatePayload('join', { invite: 'x'.repeat(513), display_name: 'Olive', label: 'Desk' }).ok, false);
  assert.equal(LOCAL_METHODS.includes('teamReconnectCode'), true);
  assert.equal(HOST_METHODS.includes('hostReconnectCode'), true);
});

// Slice 5-3 fence extension (written red first). Fault: a method with no entry in HOST_OPERATIONS
// falling through to `manager.command`, so a pasted code is sent to the host as a command, and a
// code naming another host's key changing the client file.
test('teamReconnectCode never runs a host command: another host\'s code changes nothing, a valid one redials', async (t) => {
  const host = await createTeamClientHost(t);
  const { call } = register(host);
  const { invite } = await host.invite({ kind: 'owner_first' });
  const teamId = parseInvite(invite).team_id;
  assert.equal((await call('join', { invite, display_name: 'Olive Owner', label: 'Desk' })).ok, true);
  await host.waitForState(teamId, 'online');
  const before = fs.readFileSync(clientFilePath(host.userData, teamId));
  const record = loadClientFile(host.userData, teamId).record;
  const commands = host.env.commandsSeen.length;
  const other = encodeReconnectCode({ hostPublicKey: keyPairFromSeed(Buffer.alloc(32, 7)).publicKey,
    hints: ['192.0.2.9:4242'] });
  const refused = await call('teamReconnectCode', { team_id: teamId, code: other.code });
  assert.equal(refused.error?.reason, 'team_reconnect_code_other_team', JSON.stringify(refused));
  assert.deepEqual(fs.readFileSync(clientFilePath(host.userData, teamId)), before, 'nothing written');
  const code = encodeReconnectCode({ hostPublicKey: record.host_public_key, hints: record.address_hints });
  const answer = await call('teamReconnectCode', { team_id: teamId, code: code.code });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.team.team_id, teamId);
  assert.deepEqual(loadClientFile(host.userData, teamId).record.address_hints, record.address_hints);
  await host.waitForState(teamId, 'online');
  const sent = host.env.commandsSeen.slice(commands).map((seen) => seen.operation);
  assert.ok(sent.every((operation) => typeof operation === 'string' && !operation.includes('econnect')), JSON.stringify(sent));
  const lines = JSON.stringify(host.logs);
  assert.equal(lines.includes(code.code) || lines.includes(other.code), false, 'no code in a log line');
});

// Slice 5-5b: `hostInternet` is this Jenny's own host's setting. Main checks its shape (the controller
// names a bad value); it is never a host operation, so a member's Jenny cannot send it to a host and the
// member client refuses it with nothing sent.
test('hostInternet: its shape is checked in main, and it is never a command a member can send to a host', async (t) => {
  assert.equal(HOST_METHODS.includes('hostInternet'), true);
  assert.equal(Object.hasOwn(HOST_OPERATIONS, 'hostInternet'), false, 'no host operation');
  for (const operation of ['team.host.internet', 'team.internet', 'team.internet.set', 'team.host.relay']) {
    assert.ok(!actionForOperation(operation, {}), `${operation} is no host operation`);
  }
  assert.deepEqual(validatePayload('hostInternet', { enabled: false }), { ok: true, value: { enabled: false } });
  const full = { enabled: true, public_address: 'team.example.org', relay_url: 'https://relay.example.org', token: 'tok' };
  assert.deepEqual(validatePayload('hostInternet', full), { ok: true, value: full });
  assert.equal(validatePayload('hostInternet', { ...full, token: null }).ok, true);
  for (const payload of [undefined, null, {}, { enabled: 'yes' }, { enabled: true, extra: 1 }, { enabled: true, token: 7 },
    { enabled: true, public_address: 'x'.repeat(513) }, { enabled: true, relay_url: ['https://relay.example.org'] }]) {
    assert.equal(validatePayload('hostInternet', payload).ok, false, JSON.stringify(payload));
  }
  const host = await createTeamClientHost(t);
  const { registered, call } = register(host);
  const { invite } = await host.invite({ kind: 'owner_first' });
  const teamId = parseInvite(invite).team_id;
  assert.equal((await call('join', { invite, display_name: 'Olive Owner', label: 'Desk' })).ok, true);
  await host.waitForState(teamId, 'online');
  // The member client itself, as if a host method reached it: closed by default.
  const service = registered.getService();
  const before = host.env.logs.length;
  const answer = await service.handle('hostInternet', full);
  assert.deepEqual(answer, { ok: false, error: { code: 'invalid_request', reason: 'team_request_invalid' } });
  assert.deepEqual(host.env.logs.slice(before).filter((line) => line.event.startsWith('team_command')), [], 'nothing sent');
  assert.equal(JSON.stringify(host.env.logs.slice(before)).includes('tok'), false);
});

test('the GPU methods check their payloads in main: a wrong field, type or bound is refused', () => {
  const teamId = 'team_abcDEF123';
  assert.equal(validatePayload('shareSet', { team_id: teamId, on: true, confirmed: true }).ok, true);
  assert.equal(validatePayload('gpuUse', { team_id: teamId, cursor: 0, limit: 50 }).ok, true);
  assert.equal(validatePayload('teamModelSet', { team_id: teamId, model: null }).ok, true);
  assert.equal(validatePayload('teamModelSet', { team_id: teamId, model: 'qwen3.8-27b' }).ok, true);
  const bad = [
    ['shareSet', { team_id: teamId }], ['shareSet', { team_id: teamId, on: 'yes' }], ['shareSet', { team_id: teamId, on: true, confirmed: 1 }],
    ['shareSet', { team_id: teamId, on: true, now: true }], ['shareSet', { team_id: 'team_../x', on: true }], ['shareSet', null],
    ['gpuUse', { team_id: teamId, limit: 0 }], ['gpuUse', { team_id: teamId, limit: 51 }], ['gpuUse', { team_id: teamId, cursor: -1 }],
    ['gpuUse', { team_id: teamId, cursor: 1.5 }], ['gpuUse', { team_id: teamId, since: 0 }], ['gpuUse', {}],
    ['teamModelSet', { team_id: teamId }], ['teamModelSet', { team_id: teamId, model: '' }], ['teamModelSet', { team_id: teamId, model: ' x' }],
    ['teamModelSet', { team_id: teamId, model: 'x'.repeat(129) }], ['teamModelSet', { team_id: teamId, model: 7 }],
    ['teamModelSet', { team_id: teamId, model: null, extra: 1 }],
  ];
  for (const [method, payload] of bad) assert.equal(validatePayload(method, payload).ok, false, `${method} ${JSON.stringify(payload)}`);
});

test('with the Team feature off nothing is registered and no sharing or team module is loaded', () => {
  const watched = ['../services/team/node/team-sharing', '../services/team/team-service', '../services/team/node/pool-view']
    .map((path) => require.resolve(path));
  for (const path of watched) delete require.cache[path];
  const ipcMain = fakeIpcMain();
  const off = registerTeam(ipcMain, { featureFlags: { team: false }, userDataPath: 'G:/nowhere', log: () => {} });
  assert.equal(off.registered, false);
  assert.equal(ipcMain.handlers.size, 0, 'no channel: the renderer has nothing to call');
  assert.equal(off.getService(), null);
  for (const path of watched) assert.equal(Boolean(require.cache[path]), false, `${path} is not loaded`);
});
