'use strict';

// The host's admin answers on the member side (owner decision E49, TEAM_MEMBERSHIP_SPEC "E49 as built"):
// every non-chat host answer is rebuilt from its checked, documented fields before it reaches the
// renderer, a failure keeps a checked code and reason only, and the three status facts a manager keeps
// pass the host's rules. Unit cases on services/team/admin-answers.js and team-errors.js, then cases
// through the real in-process host (tests/helpers/team-client-host.js, its `commandHook`).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { ADMIN_OPERATIONS, adminAnswer, checkedTeam } = require('../services/team/admin-answers');
const { loadClientFile } = require('../services/team/client-file');
const { createDeviceFingerprints } = require('../services/team/device-fingerprint');
const { deviceKeyName } = require('../services/team/device-key-store');
const connectionManager = require('../services/team/connection-manager');
const { HOST_OPERATIONS } = require('../services/team/ipc-methods');
const joinFlow = require('../services/team/join-flow');
const { encodeReconnectCode } = require('../services/team/reconnect-code');
const { chatFailure, failureAnswer } = require('../services/team/team-errors');
const { AUDIT_LIMITS } = require('../server/team/audit-log');
const { keyPairFromSeed } = require('../server/team/ids');
const { parseInvite } = require('../server/team/invites');
const { LIMITS } = require('../server/team/member-schema');
const { deviceListView, fingerprintOf, inviteListView, rosterView } = require('../server/team/team-views');
const { createMemorySecureStore, createTeamClientHost, joinAs, tempProfile } = require('./helpers/team-client-host');

const INVALID = { ok: false, error: { code: 'invalid_request', reason: 'team_answer_invalid' } };

// Seams for a hostile host, set before team-service.js loads (it takes both functions at load): while
// `seams.joinAnswer` is set, a join or recovery answers it once the team is admitted (a held answer
// first, as the flow does); while `seams.facts` is set, every manager's snapshot reports those facts.
assert.equal(require.cache[require.resolve('../services/team/team-service')], undefined, 'team-service not loaded yet');
const seams = { joinAnswer: null, facts: null };
const { createJoin } = joinFlow;
joinFlow.createJoin = (deps) => {
  const flow = createJoin(deps);
  const answered = (run) => async (input, hooks) => {
    if (!seams.joinAnswer) return run(input, hooks);
    return (hooks.admit && hooks.admit(parseInvite(input.invite).team_id)) || seams.joinAnswer;
  };
  return { ...flow, join: answered(flow.join), recover: answered(flow.recover) };
};
const { createConnectionManager } = connectionManager;
connectionManager.createConnectionManager = (options) => {
  const manager = createConnectionManager(options);
  const { snapshot } = manager;
  manager.snapshot = () => (seams.facts ? { ...snapshot(), ...seams.facts } : snapshot());
  return manager;
};

// ---------------------------------------------------------------- the table and the failure rebuild

test('the operation table is exactly the host operations of HOST_OPERATIONS; anything else is refused', () => {
  assert.deepEqual([...ADMIN_OPERATIONS].sort(), Object.values(HOST_OPERATIONS).sort());
  for (const operation of ['team.chat.post', 'team.unknown', '', null, 'constructor', '__proto__']) {
    assert.deepEqual(adminAnswer(operation, { ok: true }), INVALID, String(operation));
    assert.deepEqual(adminAnswer(operation, { ok: false, error: { code: 'CMP-HOST-0001', reason: 'x' } }), INVALID);
  }
});

test('a failure keeps a checked code and reason only; chat failures keep their meaning', () => {
  const error = { code: 'CMP-HOST-0003', reason: 'team_member_state_invalid', request_id: 'req_1', limit_bytes: 9,
    actual_bytes: 10, extra: 'x' };
  assert.deepEqual(failureAnswer({ ok: false, error }), { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_member_state_invalid' } });
  assert.deepEqual(failureAnswer({ ok: false, error: { code: 'nope', reason: 'Not a reason!', retryable: 'yes' } }),
    { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_unavailable' } });
  assert.deepEqual(failureAnswer({ ok: false, error: { code: 'invalid_request', reason: 'r', retryable: true } }),
    { ok: false, error: { code: 'invalid_request', reason: 'r', retryable: true } });
  assert.deepEqual(failureAnswer(null), { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_unavailable' } });
  assert.deepEqual(chatFailure({ ok: false, error: { code: 'CMP-HOST-0007', reason: 'team_chat_rate_limit', retryable: true, request_id: 'r' } }),
    { ok: false, error: { code: 'CMP-TEAM-0007', reason: 'team_chat_rate_limit', retryable: true } });
  assert.deepEqual(chatFailure({ ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_chat_pin_limit', retryable: true } }),
    { ok: false, error: { code: 'CMP-TEAM-0009', reason: 'team_chat_pin_limit' } });
  assert.deepEqual(chatFailure({ ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_chat_stale', request_id: 'r' } }),
    { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_chat_stale' } });
});

test('hostile types: an own __proto__ key is dropped, a non-string code or reason is no code or reason', () => {
  const answer = adminAnswer('team.rename', JSON.parse('{"ok":true,"__proto__":{"polluted":true},"x":1}'));
  assert.deepEqual(answer, { ok: true });
  assert.equal(Object.hasOwn(answer, '__proto__'), false);
  assert.equal(Object.getPrototypeOf(answer), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(adminAnswer('team.rename', { ok: false, error: { code: ['CMP-HOST-0001'], reason: 42 } }),
    { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_unavailable' } });
  assert.deepEqual(adminAnswer('team.rename', { ok: false, error: { code: 7, reason: ['team_x'], retryable: 1 } }),
    { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_unavailable' } });
});

test('status facts outside the host rules are null; every other key is the manager\'s own', () => {
  const row = { team_id: 'team_x', team_name: 'x'.repeat(41), state: 'online', reason: null, code: null, since: 1,
    member_id: 'member_x', device_id: 'device_x', display_name: 'Mika', role: 'boss', member_state: 'weird' };
  assert.deepEqual(checkedTeam(row), { ...row, team_name: null, role: null, member_state: null, device_fingerprint: null });
  assert.deepEqual(checkedTeam({ ...row, team_name: 42 }).team_name, null);
  const fine = { ...row, team_name: 'Studio', role: 'read_only', member_state: 'pending', device_fingerprint: 'fe812c12f3' };
  assert.deepEqual(checkedTeam(fine), fine);
  for (const bad of ['FE812C12F3', 'fe812c12f', 'fe812c12f30', 'fe812c12fz', 42, null, undefined, ['fe812c12f3']]) {
    assert.equal(checkedTeam({ ...fine, device_fingerprint: bad }).device_fingerprint, null, String(bad));
  }
});

// Two-PC findings, item A. One fixed vector: the seed of 32 bytes of 7, its public key and the host's fingerprint.
const VECTOR = Object.freeze({ publicKey: '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw', fingerprint: 'fe812c12f3' });
const vectorSeed = () => Buffer.alloc(32, 7);

test('the device fingerprint is the host rule over the public key; the seed is zeroed; an unreadable key is null', () => {
  assert.equal(keyPairFromSeed(vectorSeed()).publicKey, VECTOR.publicKey);
  assert.equal(fingerprintOf(VECTOR.publicKey), VECTOR.fingerprint, 'the host side (server/team/team-views.js)');
  const sha = crypto.createHash('sha256').update(Buffer.from(VECTOR.publicKey, 'base64url')).digest('hex').slice(0, 10);
  assert.equal(sha, VECTOR.fingerprint, 'first ten hex of SHA-256 over the raw key');
  const handed = [];
  const keys = { mode: 'seed', loads: 0,
    load: () => { keys.loads += 1; if (keys.mode === 'throw') throw new Error('store not ready'); if (keys.mode === 'none') return null;
      const seed = vectorSeed(); handed.push(seed); return seed; } };
  const fingerprints = createDeviceFingerprints({ deviceKeys: keys });
  assert.equal(fingerprints.of('team_a'), VECTOR.fingerprint, 'the member side');
  assert.equal(handed.every((seed) => seed.every((byte) => byte === 0)), true, 'every seed loaded is zeroed');
  assert.equal(fingerprints.of('team_a'), VECTOR.fingerprint);
  assert.equal(keys.loads, 1, 'computed once per team');
  for (const mode of ['none', 'throw']) {
    keys.mode = mode;
    fingerprints.forget('team_a');
    const before = keys.loads;
    assert.equal(fingerprints.of('team_a'), null, mode);
    assert.equal(fingerprints.of('team_a'), null, mode);
    assert.equal(keys.loads, before + 2, `${mode}: a null is asked again, not kept`);
  }
});

test('a pending member’s row carries the fingerprint the owner sees for its device, and no seed or public key', async (t) => {
  const { host, me, call, service } = await ownerHost(t);
  const memberStore = createMemorySecureStore();
  const pushes = [];
  const member = host.createService({ userDataPath: tempProfile(t, 'jenny-team-fingerprint-'), getSecureStore: () => memberStore,
    sendState: (snapshot) => pushes.push(JSON.parse(JSON.stringify(snapshot))) });
  const joined = await joinAs(host, member, { owner: me, admit: false, name: 'Nia Newcomer' });
  const status = await member.handle('status');
  const row = status.teams.find((team) => team.team_id === me.teamId);
  assert.equal(row.member_state, 'pending');
  const seed = Buffer.from(memberStore.values.get(deviceKeyName(me.teamId)), 'base64url');
  const { publicKey } = keyPairFromSeed(seed);
  assert.equal(row.device_fingerprint, fingerprintOf(publicKey));
  const roster = await call('members');
  const seen = roster.members.find((entry) => entry.member_id === joined.member_id);
  assert.equal(row.device_fingerprint, seen.devices[0].fingerprint, 'the same characters on the owner’s screen');
  assert.equal(joined.device_fingerprint, row.device_fingerprint, 'the join answer carries it too');
  const bytes = JSON.stringify([joined, status, pushes]);
  for (const secret of [seed.toString('base64url'), publicKey, seed.toString('hex'), Buffer.from(publicKey, 'base64url').toString('hex')]) {
    assert.equal(bytes.includes(secret), false, 'no seed or public key in an answer or a push');
  }
  assert.equal(JSON.stringify(host.logs).includes(publicKey), false, 'nor in a log');
  const ownRow = (await service.handle('status')).teams.find((team) => team.team_id === me.teamId);
  assert.deepEqual([ownRow.member_state, ownRow.device_fingerprint], ['active', null], 'an active team reads no key');
  // A re-join makes a new device key: the row shows its fingerprint, not the one kept for the old key.
  assert.equal((await member.handle('leave', { team_id: me.teamId })).ok, true);
  await joinAs(host, member, { owner: me, admit: false, name: 'Nia Again' });
  const newSeed = Buffer.from(memberStore.values.get(deviceKeyName(me.teamId)), 'base64url');
  assert.notEqual(newSeed.toString('hex'), seed.toString('hex'));
  const rejoined = (await member.handle('status')).teams.find((team) => team.team_id === me.teamId);
  assert.equal(rejoined.device_fingerprint, fingerprintOf(keyPairFromSeed(newSeed).publicKey));
  assert.notEqual(rejoined.device_fingerprint, row.device_fingerprint);
  await member.stopAll();
});

// ---------------------------------------------------------------- through the real host

// The first owner online with a pending member, a live invite, a second device invite and a renamed team.
async function ownerHost(t) {
  const host = await createTeamClientHost(t);
  const service = host.createService();
  const me = await joinAs(host, service, { name: 'Olive Owner' });
  await host.waitForState(me.teamId, 'online');
  const call = (method, payload = {}) => service.handle(method, { team_id: me.teamId, ...payload });
  const pending = await host.env.redeemDirect({ actor: me.member_id, name: 'Pia Pending' });
  return { host, service, me, call, pending, doc: () => host.env.store.snapshot() };
}

// Answers the next command of `operation` with `make(command)`; every other command goes to the host.
function hookOnce(host, operation, make) {
  host.env.commandHook = (command) => {
    if (command?.operation !== operation) return null;
    host.env.commandHook = null;
    return make(command);
  };
}

test('each admin answer of an honest host comes back equal to the host\'s own view in every field', async (t) => {
  const { host, me, call, pending, doc } = await ownerHost(t);
  // A reveal is one-shot: what the host's own reveal handed its handler is recorded here.
  const { invites } = host.env.context;
  const reveal = invites.reveal;
  const revealed = [];
  invites.reveal = (inviteId) => { const answer = reveal(inviteId); revealed.push(answer.invite); return answer; };
  t.after(() => { invites.reveal = reveal; });
  assert.deepEqual(await call('members'), { ok: true, ...rosterView(doc(), { owner: true }) });
  const created = await call('inviteCreate', { role: 'member' });
  const stored = doc().invites.find((invite) => invite.invite_id === created.invite_id);
  assert.deepEqual(created, { ok: true, invite_id: stored.invite_id, expires_at: stored.expires_at });
  assert.deepEqual(await call('inviteReveal', { invite_id: created.invite_id }), { ok: true, invite: revealed.at(-1) });
  assert.deepEqual(await call('inviteList'), { ok: true, invites: inviteListView(doc(), host.clock()) });
  const device = await call('deviceInvite');
  const deviceStored = doc().invites.find((invite) => invite.invite_id === device.invite_id);
  assert.deepEqual(device, { ok: true, invite_id: deviceStored.invite_id, expires_at: deviceStored.expires_at,
    invite: revealed.at(-1) });
  assert.equal(typeof revealed.at(-1), 'string');
  assert.deepEqual(await call('deviceList'), { ok: true, devices: deviceListView(doc(), { memberId: me.member_id, owner: true }) });
  assert.deepEqual(await call('inviteRevoke', { invite_id: created.invite_id }), { ok: true });
  assert.deepEqual(await call('memberAdmit', { member_id: pending.member_id }), { ok: true, member_id: pending.member_id, state: 'active' });
  assert.deepEqual(await call('memberSetRole', { member_id: pending.member_id, role: 'read_only' }),
    { ok: true, member_id: pending.member_id, role: 'read_only' });
  assert.deepEqual(await call('rename', { name: 'Studio Two' }), { ok: true });
  assert.deepEqual(await call('profileSet', { display_name: 'Olive Two', label: 'Desk' }), { ok: true });
  const page = host.env.store.audit.read({});
  assert.deepEqual(await call('auditRead'), { ok: true, entries: page.entries, next_cursor: page.next_cursor });
  assert.ok(page.entries.length >= 5);
  const second = await host.env.redeemDirect({ actor: me.member_id, name: 'Sam Second' });
  assert.equal((await call('memberAdmit', { member_id: second.member_id })).ok, true);
  const otherDevice = doc().devices.find((entry) => entry.member_id === second.member_id).device_id;
  assert.deepEqual(await call('deviceRevoke', { device_id: otherDevice }), { ok: true });
  assert.deepEqual(await call('memberRevoke', { member_id: second.member_id }), { ok: true });
  assert.deepEqual(await call('ownerTransfer', { member_id: pending.member_id }), { ok: true, member_id: pending.member_id });
});

test('one wrong documented field fails the whole answer with team_answer_invalid and nothing the host sent', async (t) => {
  const { host, me, call, pending, doc } = await ownerHost(t);
  const roster = rosterView(doc(), { owner: true });
  const created = await call('inviteCreate', { role: 'member' });
  const invites = inviteListView(doc(), host.clock());
  const entries = host.env.store.audit.read({}).entries;
  const devices = deviceListView(doc(), { memberId: me.member_id, owner: true });
  const memberAt = (role) => ({ ...roster, members: roster.members.map((member, n) => (n === 0 ? { ...member, role } : member)) });
  const cases = [
    ['members', {}, 'team.members.list', memberAt('boss')],
    ['members', {}, 'team.members.list', { ...roster, team: { ...roster.team, name: 'x'.repeat(41) } }],
    ['members', {}, 'team.members.list', { team: roster.team, members: Array.from({ length: LIMITS.MAX_MEMBER_RECORDS + 1 }, () => roster.members[0]) }],
    ['members', {}, 'team.members.list', { ...roster, members: [{ ...roster.members[0], devices: [{ ...roster.members[0].devices[0], fingerprint: 'XYZ' }] }] }],
    ['members', {}, 'team.members.list', { ...roster, members: [{ ...roster.members[0], created_at: undefined, devices: [] }] }],
    ['members', {}, 'team.members.list', { ...roster, team: [roster.team] }],
    ['members', {}, 'team.members.list', { ...roster, members: [Object.values(roster.members[0])] }],
    ['inviteCreate', { role: 'member' }, 'team.invite.create', { invite_id: me.member_id, expires_at: 1 }],
    ['inviteCreate', { role: 'member' }, 'team.invite.create', { invite_id: created.invite_id, expires_at: String(created.expires_at) }],
    ['inviteReveal', { invite_id: created.invite_id }, 'team.invite.reveal', { invite: 'j'.repeat(513) }],
    ['inviteReveal', { invite_id: created.invite_id }, 'team.invite.reveal', { invite: 'jteam2_a\nb' }],
    ['inviteList', {}, 'team.invite.list', { invites: Array.from({ length: LIMITS.MAX_INVITE_RECORDS + 1 }, () => invites[0]) }],
    ['inviteList', {}, 'team.invite.list', { invites: [{ ...invites[0], kind: 'everyone' }] }],
    ['deviceInvite', {}, 'team.device.invite', { invite_id: created.invite_id, expires_at: -1, invite: 'jteam2_x' }],
    ['deviceList', {}, 'team.device.list', { devices: [{ ...devices[0], label: 'x'.repeat(41) }] }],
    ['deviceList', {}, 'team.device.list', { devices: Array.from({ length: LIMITS.MAX_DEVICE_RECORDS + 1 }, () => devices[0]) }],
    ['memberAdmit', { member_id: pending.member_id }, 'team.member.admit', { member_id: pending.member_id, state: 'gone' }],
    ['memberSetRole', { member_id: pending.member_id, role: 'member' }, 'team.member.setRole', { member_id: pending.member_id, role: 'boss' }],
    ['ownerTransfer', { member_id: pending.member_id }, 'team.owner.transfer', { member_id: devices[0].device_id }],
    ['auditRead', {}, 'team.audit.read', { entries: Array.from({ length: AUDIT_LIMITS.MAX_PAGE + 1 }, () => entries[0]), next_cursor: null }],
    ['auditRead', {}, 'team.audit.read', { entries: [{ ...entries[0], at: -1 }], next_cursor: null }],
    ['auditRead', {}, 'team.audit.read', { entries, next_cursor: 'later' }],
    ['auditRead', {}, 'team.audit.read', { entries: [{ ...entries[0], detail: 'a'.repeat(32) }], next_cursor: null }],
    ['auditRead', {}, 'team.audit.read', { entries: [{ ...entries[0], detail: 'jteam1_x' }], next_cursor: null }],
    ['auditRead', {}, 'team.audit.read', { entries: [{ ...entries[0], detail: 'ab '.repeat(60).slice(0, AUDIT_LIMITS.MAX_DETAIL_CHARS + 1) }], next_cursor: null }],
  ];
  for (const [method, payload, operation, body] of cases) {
    hookOnce(host, operation, (command) => ({ ok: true, ...body, request_id: command.request_id, marker: 'HOSTSENT' }));
    const answer = await call(method, payload);
    assert.deepEqual(answer, INVALID, `${method}: ${JSON.stringify(answer).slice(0, 200)}`);
  }
  // An unknown kind is a word, not a closed list: a newer host may write one. An unknown field is dropped.
  hookOnce(host, 'team.audit.read', (command) => ({ ok: true, entries: [{ ...entries[0], kind: 'future_kind' }],
    next_cursor: null, floor_seq: 3, request_id: command.request_id }));
  assert.deepEqual(await call('auditRead'), { ok: true, entries: [{ ...entries[0], kind: 'future_kind' }], next_cursor: null });
  const atCap = 'ab '.repeat(60).slice(0, AUDIT_LIMITS.MAX_DETAIL_CHARS);
  for (const detail of ['kept=name', atCap]) {
    hookOnce(host, 'team.audit.read', () => ({ ok: true, entries: [{ ...entries[0], detail }], next_cursor: null }));
    assert.deepEqual(await call('auditRead'), { ok: true, entries: [{ ...entries[0], detail }], next_cursor: null });
  }
});

test('a host failure keeps its code and reason only, also in the log line and during a rate-limit hold', async (t) => {
  const { host, call } = await ownerHost(t);
  hookOnce(host, 'team.members.list', (command) => ({ ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_member_state_invalid',
    request_id: command.request_id, limit_bytes: 9, actual_bytes: 10, extra: 'x' } }));
  assert.deepEqual(await call('members'), { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_member_state_invalid' } });
  hookOnce(host, 'team.invite.list', (command) => ({ ok: false, error: { code: 'not a code', reason: 'Not A Reason 192.0.2.9',
    request_id: command.request_id } }));
  assert.deepEqual(await call('inviteList'), { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_unavailable' } });
  const logged = host.logs.filter((line) => line.event === 'team.ipc.answered' && line.fields.method === 'inviteList');
  assert.deepEqual(logged.at(-1).fields, { method: 'inviteList', ok: false, reason: 'team_unavailable' });
  assert.equal(JSON.stringify(host.logs).includes('192.0.2.9'), false);
  // The rate-limit hold: the second answer is the held one, never sent to the host, rebuilt the same way.
  hookOnce(host, 'team.device.list', (command) => ({ ok: false, error: { code: 'bogus', reason: 'team_rate_limit', retryable: true,
    request_id: command.request_id } }));
  const limited = { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_rate_limit', retryable: true } };
  assert.deepEqual(await call('deviceList'), limited);
  const seen = host.env.commandsSeen.length;
  assert.deepEqual(await call('members'), limited);
  assert.equal(host.env.commandsSeen.length, seen, 'held: nothing sent');
});

test('the own-device revoke and a refused leave are rebuilt', async (t) => {
  const { host, call, me } = await ownerHost(t);
  hookOnce(host, 'team.device.revoke', (command) => ({ ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_last_device',
    request_id: command.request_id, extra: 'x' } }));
  assert.deepEqual(await call('deviceRevoke', { device_id: me.device_id }),
    { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_last_device' } });
  const left = await call('leave');
  assert.equal(left.ok, false);
  assert.deepEqual(Object.keys(left.error).sort(), ['code', 'reason'], JSON.stringify(left));
});

// The team name half lives in tests/team-ipc-contract.test.js (the review's hostile-host case).
test('role and member state outside the host rules are null in the status answer and every push', async (t) => {
  const host = await createTeamClientHost(t);
  const first = host.createService();
  const me = await joinAs(host, first, { name: 'Olive Owner' });
  await host.waitForState(me.teamId, 'online');
  await first.stopAll();
  host.env.statusActor = (live) => ({ ...live, role: 'boss' });
  t.after(() => { host.env.statusActor = null; });
  const service = host.createService();
  await service.startExisting();
  await host.waitForState(me.teamId, 'online');
  const row = (await service.handle('status')).teams[0];
  assert.deepEqual([row.role, row.member_state], [null, 'active']);
  for (const snapshot of host.states) {
    for (const team of snapshot.teams) {
      assert.equal(team.role === null || ['owner', 'member', 'read_only'].includes(team.role), true);
    }
  }
  // A member state outside the list: the manager ends as revoked, and the snapshot names no state.
  await service.stopAll();
  host.env.statusActor = (live) => ({ ...live, state: 'weird' });
  const second = host.createService();
  await second.startExisting();
  await host.waitForState(me.teamId, 'revoked');
  assert.equal((await second.handle('status')).teams[0].member_state, null);
  assert.equal(host.states.some((snapshot) => snapshot.teams.some((team) => team.member_state === 'weird')), false);
});

// Fix list item 1. Fault: a refused join or recovery returned as the host sent it (request id, byte counts,
// any key, a reason of any length, a non-boolean retryable), and that object held for the rate limit.
test('a refused join or recovery keeps a checked code and reason only, also while a rate limit is held', async (t) => {
  const host = await createTeamClientHost(t);
  const service = host.createService();
  // The real host: its refusal carries its request id, `retryable: false` and the byte counts.
  const { invites } = host.env.context;
  const redeem = invites.redeem;
  invites.redeem = async () => ({ ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_invite_spent', limit_bytes: 9, actual_bytes: 10 } });
  t.after(() => { invites.redeem = redeem; seams.joinAnswer = null; });
  const refused = await service.handle('join', { invite: (await host.invite({ kind: 'owner_first' })).invite,
    display_name: 'Olive Owner', label: 'Laptop' });
  assert.equal(refused.ok, false);
  assert.deepEqual(Object.keys(refused.error).sort(), ['code', 'reason'], JSON.stringify(refused));
  assert.equal(refused.error.reason, 'team_invite_spent');
  invites.redeem = redeem;
  // A hostile host behind the invite.
  const join = async () => service.handle('join', { invite: (await host.invite({ kind: 'owner_first' })).invite,
    display_name: 'Olive Owner', label: 'Laptop' });
  seams.joinAnswer = { ok: false, error: { code: 'CMP-HOST-0003', reason: 'r'.repeat(10_000), retryable: 'yes',
    request_id: 'req_1', extra: 'x' }, marker: 'HOSTSENT' };
  assert.deepEqual(await join(), { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_unavailable' } });
  const answered = host.logs.filter((line) => line.event === 'team.ipc.answered');
  assert.equal(answered.at(-1).fields.reason, 'team_unavailable');
  assert.equal(JSON.stringify(answered).includes('r'.repeat(81)), false);
  seams.joinAnswer = { ok: false, error: { code: 'CMP-HOST-0007', reason: 'team_rate_limit', retryable: 'yes', request_id: 'req_2', extra: 'x' } };
  const limited = { ok: false, error: { code: 'CMP-HOST-0007', reason: 'team_rate_limit' } };
  const invite = (await host.invite({ kind: 'owner_first' })).invite;
  const press = () => service.handle('join', { invite, display_name: 'Olive Owner', label: 'Laptop' });
  assert.deepEqual(await press(), limited);
  seams.joinAnswer = { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_other' } };
  assert.deepEqual(await press(), limited, 'the second press inside the hold answers the held, rebuilt answer');
  // A recovery the host refuses the same way (a second service: the first holds the rate limit).
  seams.joinAnswer = null;
  const second = host.createService();
  const me = await joinAs(host, second, { name: 'Olive Owner' });
  await host.waitForState(me.teamId, 'online');
  seams.joinAnswer = { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_invite_spent', retryable: 'yes', request_id: 'req_3' } };
  assert.deepEqual(await second.ownerRecover({ invite: (await host.invite({ kind: 'recovery' })).invite,
    display_name: 'Olive Owner', label: 'New desk' }), { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_invite_spent' } });
});

// Fix list item 2. Fault: the join, recover or reconnect answer carrying the manager's snapshot unchecked.
test('the join, recover and reconnect answers carry the three host facts checked', async (t) => {
  const host = await createTeamClientHost(t);
  const service = host.createService();
  seams.facts = { team_name: 'x'.repeat(10_000), role: 'boss', member_state: 'weird' };
  t.after(() => { seams.facts = null; });
  const facts = (answer) => [answer.ok, answer.team?.team_name, answer.team?.role, answer.team?.member_state];
  const joined = await service.handle('join', { invite: (await host.invite({ kind: 'owner_first' })).invite,
    display_name: 'Olive Owner', label: 'Laptop' });
  assert.deepEqual(facts(joined), [true, null, null, null], JSON.stringify(joined).slice(0, 300));
  const teamId = joined.team.team_id;
  await host.waitForState(teamId, 'online');
  const recovered = await service.ownerRecover({ invite: (await host.invite({ kind: 'recovery' })).invite,
    display_name: 'Olive Owner', label: 'New desk' });
  assert.deepEqual(facts(recovered), [true, null, null, null], JSON.stringify(recovered).slice(0, 300));
  await host.waitForState(teamId, 'online');
  const { record } = loadClientFile(host.userData, teamId);
  const code = encodeReconnectCode({ hostPublicKey: record.host_public_key, hints: record.address_hints }).code;
  const reconnected = await service.handle('teamReconnectCode', { team_id: teamId, code });
  assert.deepEqual(facts(reconnected), [true, null, null, null], JSON.stringify(reconnected).slice(0, 300));
});
