'use strict';

// The conversation's allowed-node list (schema 28). The store keeps a valid list, and a
// damaged one as a restriction no turn satisfies; the summary projects it; only the
// symbol key or the team host's `sessions.preferences` (behind the one authorization
// function) sets it. A desktop profile (IPC, a plain object) and the single-owner host cannot.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ClientRegistry } = require('../../server/client-registry');
const { CommandReceipts } = require('../../server/command-receipts');
const { ControlLeases } = require('../../server/control-leases');
const { createCommandRouter } = require('../../server/command-router');
const { createAuthorizer } = require('../../server/team/authorize');
const { nodeIdFor } = require('../../server/team/scheduler/state');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { encodeRecord } = require('../../services/backend/session-journal');
const {
  ALLOWED_NODES_PREFERENCE, allowedNodesPatch, readAllowedNodes,
} = require('../../services/backend/session-allowed-nodes');
const { BOOT, BackendHarness, command } = require('../helpers/command-router-fixture');
const { createTeamDirectoryFixture } = require('./helpers/team-directory-fixture');
const { composePool, poolTurn, registerNode } = require('./helpers/team-pool-fixture');

const A = nodeIdFor('device_node_a');
const B = nodeIdFor('device_node_b');
const OVER_LIMIT = Array.from({ length: 17 }, (_, i) => nodeIdFor(`device_${i}`));
const BAD_LISTS = [
  ['empty', []], ['duplicate', [A, A]], ['foreign prefix', ['device_x']], ['not an array', A],
  ['over the node limit', OVER_LIMIT], ['a hole', [A, , B]], // eslint-disable-line no-sparse-arrays
  ['a number', [1]], ['over-long id', [`node_${'a'.repeat(65)}`]],
];
// The reason the team host's router gives for each bad list: the schema's size bounds refuse
// a non-array and a non-string item first; the list rule refuses the rest.
const ROUTER_REASON = { 'not an array': 'invalid_command_parameters', 'a number': 'invalid_command_parameters' };

function tempDir(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function openStore(root) {
  return new ElectronSessionStore(path.join(root, 'sessions.json'), { writeDebounceMs: 0 });
}

test('the list rule is the scheduler\'s: null is any node, malformed lists are refused', () => {
  assert.equal(readAllowedNodes(null), null);
  assert.equal(readAllowedNodes(undefined), null);
  assert.deepEqual(readAllowedNodes([A, B]), [A, B]);
  for (const [label, value] of BAD_LISTS) assert.equal(readAllowedNodes(value), undefined, label);
  assert.deepEqual(allowedNodesPatch({ allowed_nodes: [A] }), {}, 'a string key is not the list');
  assert.deepEqual(allowedNodesPatch({ [ALLOWED_NODES_PREFERENCE]: null }), { allowed_nodes: null });
  assert.throws(() => allowedNodesPatch({ [ALLOWED_NODES_PREFERENCE]: [A, A] }), { reason: 'allowed_nodes_invalid' });
});

test('a saved list round-trips through the store and the summary; null clears it; a malformed save writes nothing', (t) => {
  const root = tempDir(t, 'jenny-allowed-store-');
  const store = openStore(root);
  const id = store.createSession({ title: 'Allowed' }).id;
  assert.equal(Object.hasOwn(store.getSession(id), 'allowed_nodes'), false, 'a new conversation has no list');
  assert.equal(Object.hasOwn(store.getSessionSummary(id), 'allowed_nodes'), false, 'no list, no summary field');
  store.setSessionPreferences(id, { [ALLOWED_NODES_PREFERENCE]: [A, B] });
  assert.deepEqual([store.getSession(id).allowed_nodes, store.getSessionSummary(id).allowed_nodes], [[A, B], [A, B]]);
  for (const [label, value] of BAD_LISTS) {
    assert.throws(() => store.setSessionPreferences(id, { [ALLOWED_NODES_PREFERENCE]: value }), RangeError, label);
  }
  // A desktop renderer's preference object: the string key changes nothing.
  store.setSessionPreferences(id, { allowed_nodes: [B], plan_mode: false });
  assert.deepEqual(store.getSession(id).allowed_nodes, [A, B]);
  store.updateSession(id, { allowed_nodes: [B], title: 'Generic patch' });
  assert.deepEqual([store.getSession(id).allowed_nodes, store.getSession(id).title], [[A, B], 'Generic patch'],
    'a generic patch strips the string key; the symbol key is the only way in');
  store.flushSession(id);
  store.dispose();
  const reopened = openStore(root);
  assert.deepEqual(reopened.getSession(id).allowed_nodes, [A, B], 'the list survives a reload');
  reopened.setSessionPreferences(id, { [ALLOWED_NODES_PREFERENCE]: null });
  assert.equal(Object.hasOwn(reopened.getSession(id), 'allowed_nodes'), false, 'null clears the list');
  reopened.dispose();
});

// The team host's router over a real store: project_a has the owner (admin), member_a (writer)
// and member_ro (reader); project_b has member_b only.
async function teamRouter(t, { team = true } = {}) {
  const directory = createTeamDirectoryFixture({ projects: {
    project_a: { members: { member_owner: 'admin', member_a: 'writer', member_ro: 'reader' } },
    project_b: { members: { member_b: 'writer' } },
  } });
  const root = tempDir(t, 'jenny-allowed-router-');
  const backend = new BackendHarness(root);
  const clients = new ClientRegistry();
  const authorize = team ? createAuthorizer({ directory: directory.directory,
    sessionProject: (id) => backend.sessionStore.getSession(id)?.project_id ?? null }).authorize : undefined;
  const router = createCommandRouter({ backend, clients, leases: new ControlLeases(), bootEpoch: BOOT,
    receipts: new CommandReceipts({ filePath: path.join(root, 'receipts.json') }), eventStream: { publish() {} }, authorize });
  t.after(() => { router.dispose(); backend.dispose(); });
  const seat = {};
  for (const [name, actor] of Object.entries(directory.actors)) {
    const client = clients.register(actor.device_id);
    seat[name] = { client, context: { deviceId: actor.device_id, clientToken: client.client_token,
      isAuthenticated: () => true, ...(team ? { actor } : {}) } };
  }
  const send = (who, operation, params = {}, extra = {}, context = seat[who].context) => router.dispatch(
    command(seat[who].client, operation, params, extra), context);
  const sessionIn = (projectId) => {
    const id = backend.sessionStore.createSession({ title: projectId }).id;
    backend.sessionStore.updateSession(id, { project_id: projectId });
    return id;
  };
  return { backend, router, directory, seat, send, ids: { a: sessionIn('project_a'), b: sessionIn('project_b') } };
}

async function setList(f, who, sessionId, list, { lease = null, context } = {}) {
  const acquired = lease || await f.send(who, 'control.acquire', { takeover: true }, { session_id: sessionId });
  const generation = acquired.ok ? acquired.lease.generation : 1;
  return f.send(who, 'sessions.preferences', { allowed_nodes: list }, { session_id: sessionId,
    control_generation: generation, expected_revision: f.router.snapshot(sessionId)?.session?.revision ?? `${BOOT}:1` },
  context);
}

const reasonOf = (value) => (value.ok ? 'ok' : value.error.reason);

test('on a team host a writer sets and clears the list; every id is checked again on the host', async (t) => {
  const f = await teamRouter(t);
  assert.equal(reasonOf(await setList(f, 'member', f.ids.a, [A, B])), 'ok');
  assert.deepEqual(f.backend.sessionStore.getSession(f.ids.a).allowed_nodes, [A, B]);
  for (const [label, value] of BAD_LISTS.filter(([name]) => name !== 'a hole')) {
    const refused = await setList(f, 'member', f.ids.a, value);
    assert.equal(reasonOf(refused), ROUTER_REASON[label] || 'allowed_nodes_invalid', label);
  }
  assert.deepEqual(f.backend.sessionStore.getSession(f.ids.a).allowed_nodes, [A, B], 'a refused list writes nothing');
  assert.equal(reasonOf(await setList(f, 'owner', f.ids.a, null)), 'ok', 'the project admin clears it');
  assert.equal(Object.hasOwn(f.backend.sessionStore.getSession(f.ids.a), 'allowed_nodes'), false);
});

test('a reader, another project\'s member, a pending or revoked member and a missing actor are refused as without the field', async (t) => {
  const f = await teamRouter(t);
  const before = JSON.stringify(f.backend.sessionStore.getSession(f.ids.a));
  const cases = [['read_only', f.ids.a], ['otherMember', f.ids.a], ['pending', f.ids.a], ['revoked', f.ids.a],
    ['member', f.ids.b]];
  for (const [who, sessionId] of cases) {
    const fake = { ok: true, lease: { generation: 1 } };
    const withList = await setList(f, who, sessionId, [A], { lease: fake });
    const withoutList = await f.send(who, 'sessions.preferences', { plan_mode: true }, { session_id: sessionId,
      control_generation: 1, expected_revision: `${BOOT}:1` });
    assert.equal(withList.ok, false, who);
    assert.equal(reasonOf(withList), reasonOf(withoutList), `${who}: the field changes no answer`);
  }
  const { actor: _actor, ...noActor } = f.seat.member.context;
  const missing = await setList(f, 'member', f.ids.a, [A], { lease: { ok: true, lease: { generation: 1 } }, context: noActor });
  assert.equal(missing.ok, false, 'a missing actor is a refusal');
  assert.equal(JSON.stringify(f.backend.sessionStore.getSession(f.ids.a)), before, 'nothing was written');
  assert.equal(JSON.stringify(f.backend.sessionStore.getSession(f.ids.b)).includes('allowed_nodes'), false);
});

test('the single-owner host cannot set the list', async (t) => {
  const f = await teamRouter(t, { team: false });
  const refused = await setList(f, 'owner', f.ids.a, [A]);
  assert.equal(reasonOf(refused), 'allowed_nodes_invalid');
  assert.equal(Object.hasOwn(f.backend.sessionStore.getSession(f.ids.a), 'allowed_nodes'), false);
  assert.equal(reasonOf(await f.send('owner', 'sessions.preferences', { plan_mode: true }, { session_id: f.ids.a,
    control_generation: (await f.send('owner', 'control.acquire', { takeover: true }, { session_id: f.ids.a })).lease.generation,
    expected_revision: f.router.snapshot(f.ids.a).session.revision })), 'ok', 'other preferences still work there');
});

// ---------------------------------------------------------------------------
// The pool composition passes the saved list to the scheduler (real scheduler and gateway).

test('a turn with a list is leased only to a listed node: the free unlisted node is not used, the turn waits', async (t) => {
  const { pool } = composePool(t);
  await pool.start();
  const a = registerNode(pool.scheduler, { deviceId: 'device_node_a', memberId: 'member_node' });
  const b = registerNode(pool.scheduler, { deviceId: 'device_node_b', memberId: 'member_node' });
  assert.deepEqual([a, b], [A, B], 'node ids are the fixed function of the device');
  const busy = await pool.turnRoute.acquire(poolTurn({ sessionId: 'session_busy', allowedNodes: [B] }));
  const waiting = pool.turnRoute.acquire(poolTurn({ allowedNodes: [B] }));
  await new Promise((resolve) => { setImmediate(resolve); });
  const leases = pool.scheduler.listLeases();
  assert.deepEqual(leases.map((lease) => [lease.state, lease.node_id]), [['active', B], ['queued', null]]);
  assert.equal(pool.scheduler.listNodes().find((node) => node.node_id === A).busy_slots, 0, 'A stays free');
  busy.release({ ok: true });
  const granted = await waiting;
  assert.equal(pool.scheduler.listLeases().at(-1).node_id, B);
  granted.release({ ok: true });
  // The engine path passes no list: any node.
  const engine = await pool.engineRoute.acquire({ memberId: 'member_alice', model: 'alpha', wantsVision: false });
  assert.equal(engine.lease.state, 'active');
  engine.release({ ok: true });
});

test('with project files on, a conversation turn goes only to a node whose member may read it; the engine is unchanged', async (t) => {
  // Row 123 (team host file tools, review finding 1): a tool result can carry a project file back to the node.
  const reads = (memberId, sessionId) => memberId === 'member_reader' && sessionId === 'session_1';
  const { pool } = composePool(t, { nodesMustRead: true, mayReadConversation: reads });
  await pool.start();
  registerNode(pool.scheduler, { deviceId: 'device_node_a', memberId: 'member_reader' });
  registerNode(pool.scheduler, { deviceId: 'device_node_b', memberId: 'member_outsider', slots: 2 });
  const first = await pool.turnRoute.acquire(poolTurn());
  assert.equal(pool.scheduler.listLeases().at(-1).node_id, A, 'the free outsider node is never chosen');
  first.release({ ok: true });
  await assert.rejects(pool.turnRoute.acquire(poolTurn({ allowedNodes: [B] })), { reason: 'file_tools_no_reader_node' },
    'a saved list narrows the readers, never widens them');
  await assert.rejects(pool.turnRoute.acquire(poolTurn({ sessionId: 'session_2' })), { reason: 'file_tools_no_reader_node' });
  const engine = await pool.engineRoute.acquire({ memberId: 'member_alice', model: 'alpha', wantsVision: false });
  assert.equal(engine.lease.state, 'active', 'the team engine route carries no conversation and no file tools');
  engine.release({ ok: true });
  assert.throws(() => composePool(t, { nodesMustRead: true }), /read check/u);
});

// H2: the serving node's owner is asked again, at activation and by recheckLeases, not only the prompter.
function fileToolsPool(t, lost) {
  const reads = (memberId, sessionId) => memberId.startsWith('member_reader') && !lost.has(`${memberId}|${sessionId}`);
  return composePool(t, { nodesMustRead: true, mayReadConversation: reads });
}

test('H2: a free node whose owner lost access to the conversation is skipped when the queued turn is dispatched', { timeout: 8000 }, async (t) => {
  const lost = new Set();
  const { pool } = fileToolsPool(t, lost);
  await pool.start();
  const a = registerNode(pool.scheduler, { deviceId: 'device_node_a', memberId: 'member_reader_a' });
  const b = registerNode(pool.scheduler, { deviceId: 'device_node_b', memberId: 'member_reader_b' });
  const busyA = await pool.turnRoute.acquire(poolTurn({ sessionId: 'session_a', allowedNodes: [a] }));
  const busyB = await pool.turnRoute.acquire(poolTurn({ sessionId: 'session_b', allowedNodes: [b] }));
  const waiting = pool.turnRoute.acquire(poolTurn({ sessionId: 'session_2' }));
  const outcome = waiting.then((granted) => granted, (error) => error);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(pool.scheduler.listLeases().at(-1).state, 'queued');
  lost.add('member_reader_b|session_2'); // B's owner is removed from that project; no recheck has run yet
  busyB.release({ ok: true });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(pool.scheduler.listLeases().at(-1).state, 'queued', 'the freed B is not given a project it may not read');
  busyA.release({ ok: true });
  const granted = await outcome;
  assert.equal(pool.scheduler.listLeases().at(-1).node_id, a, 'A, whose owner still reads it, serves the turn');
  granted.release({ ok: true });
});

test('H2: a queued turn with no node left whose owner may read it fails as no_eligible_node at the recheck', { timeout: 8000 }, async (t) => {
  const lost = new Set();
  const { pool } = fileToolsPool(t, lost);
  await pool.start();
  const a = registerNode(pool.scheduler, { deviceId: 'device_node_a', memberId: 'member_reader_a' });
  const busy = await pool.turnRoute.acquire(poolTurn({ sessionId: 'session_a', allowedNodes: [a] }));
  const waiting = pool.turnRoute.acquire(poolTurn({ sessionId: 'session_2' }));
  const outcome = waiting.then(() => 'granted', (error) => error.reason);
  await new Promise((resolve) => { setImmediate(resolve); });
  lost.add('member_reader_a|session_2');
  pool.recheckLeases();
  assert.equal(await outcome, 'no_eligible_node');
  assert.equal(pool.scheduler.listLeases().filter((lease) => lease.state === 'queued').length, 0);
  assert.equal(pool.scheduler.listLeases()[0].state, 'active', 'the other conversation keeps its lease');
  busy.release({ ok: true });
});

test('H2: recheckLeases ends an active lease whose serving node owner may no longer read its conversation', { timeout: 8000 }, async (t) => {
  const lost = new Set();
  const { pool } = fileToolsPool(t, lost);
  await pool.start();
  const a = registerNode(pool.scheduler, { deviceId: 'device_node_a', memberId: 'member_reader_a' });
  const first = await pool.turnRoute.acquire(poolTurn({ sessionId: 'session_1' }));
  assert.equal(pool.scheduler.listLeases().at(-1).node_id, a);
  assert.equal(pool.recheckLeases(), 0, 'every owner still reads it');
  lost.add('member_reader_a|session_1');
  assert.equal(pool.recheckLeases(), 1);
  assert.equal(pool.scheduler.listLeases().at(-1).state, 'failed');
  first.release({ ok: false });
});

test('a list that names no registered node is refused at once with its own reason; a malformed one too', async (t) => {
  const { pool } = composePool(t);
  await pool.start();
  registerNode(pool.scheduler, { deviceId: 'device_node_a', memberId: 'member_node' });
  await assert.rejects(pool.turnRoute.acquire(poolTurn({ allowedNodes: [B] })), (error) => {
    assert.equal(error.reason, 'allowed_nodes_unavailable');
    assert.match(error.message, /Allow another node/u, 'a sentence the member can act on');
    return true;
  });
  await assert.rejects(pool.turnRoute.acquire(poolTurn({ allowedNodes: [A, A] })), { reason: 'allowed_nodes_invalid' });
  assert.deepEqual(pool.scheduler.listLeases(), [], 'nothing reached the scheduler');
});

test('a waiting turn whose last listed node leaves fails at once, not at its queue timeout', async (t) => {
  const { pool } = composePool(t);
  await pool.start();
  registerNode(pool.scheduler, { deviceId: 'device_node_a', memberId: 'member_node' });
  registerNode(pool.scheduler, { deviceId: 'device_node_b', memberId: 'member_node' });
  const busy = await pool.turnRoute.acquire(poolTurn({ sessionId: 'session_busy', allowedNodes: [B] }));
  const waiting = pool.turnRoute.acquire(poolTurn({ allowedNodes: [B] }));
  const outcome = waiting.then(() => 'granted', (error) => error.reason);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(pool.scheduler.unregisterNode(B).ok, true);
  assert.equal(await outcome, 'allowed_nodes_unavailable');
  assert.equal(pool.scheduler.listLeases().filter((lease) => lease.state === 'queued').length, 0, 'the waiting lease ended');
  busy.release({ ok: false });
  assert.equal(pool.resources().leases, 0);
});

test('a damaged stored list loads as a restriction no turn satisfies; a valid list or null repairs it', async (t) => {
  const { pool } = composePool(t);
  await pool.start();
  registerNode(pool.scheduler, { deviceId: 'device_node_a', memberId: 'member_node' });
  const fixture = path.join(__dirname, '..', 'release-compat', 'fixtures', 'userdata-v28-current', 'sessions');
  for (const [label, damaged] of [['not an array', 'node_fixture_v28'], ['over the node limit', OVER_LIMIT], ['foreign id', ['member_fixture']]]) {
    const root = tempDir(t, 'jenny-allowed-disk-');
    fs.cpSync(fixture, path.join(root, 'sessions'), { recursive: true });
    fs.appendFileSync(path.join(root, 'sessions', 'sess_v23_second.1.journal'),
      encodeRecord([{ o: 'set', k: 'allowed_nodes', v: damaged }]));
    const store = new ElectronSessionStore(path.join(root, 'sessions.json'), { sessionJournal: true });
    const stored = store.getSession('sess_v23_second').allowed_nodes;
    assert.deepEqual(stored, [], `${label}: kept as a restriction, never "any node"`);
    await assert.rejects(pool.turnRoute.acquire(poolTurn({ allowedNodes: stored })), { reason: 'allowed_nodes_invalid' }, label);
    assert.deepEqual(pool.scheduler.listLeases(), [], `${label}: leased to nobody`);
    // The index entry is the last projection written; the next write projects the record again.
    store.renameSession('sess_v23_second', 'Renamed');
    assert.deepEqual(store.getSessionSummary('sess_v23_second').allowed_nodes, [], label);
    store.setSessionPreferences('sess_v23_second', { [ALLOWED_NODES_PREFERENCE]: [A] });
    assert.deepEqual(store.getSession('sess_v23_second').allowed_nodes, [A], `${label}: a valid list repairs it`);
    store.setSessionPreferences('sess_v23_second', { [ALLOWED_NODES_PREFERENCE]: null });
    assert.equal(Object.hasOwn(store.getSession('sess_v23_second'), 'allowed_nodes'), false, `${label}: null clears it`);
    store.dispose();
  }
});

// ---------------------------------------------------------------------------
// Row 172: the conversation's model, thinking effort and tool switches (sessions.preferences on a team host).

async function setPrefs(f, who, sessionId, params) {
  const acquired = await f.send(who, 'control.acquire', { takeover: true }, { session_id: sessionId });
  return f.send(who, 'sessions.preferences', params, { session_id: sessionId,
    control_generation: acquired.ok ? acquired.lease.generation : 1,
    expected_revision: f.router.snapshot(sessionId)?.session?.revision ?? `${BOOT}:1` });
}

const TEAM_DEFAULT = { model: null, effort: 'default', read: true, write: true };
const offering = (f, models) => { f.backend.turnRoute = { acquire: async () => ({}), offeredModels: () => models }; };

test('row 172: a writer holding the lease sets each key; it is stored, in the snapshot and logged once per change', async (t) => {
  const f = await teamRouter(t);
  offering(f, ['m1', 'm2']);
  const before = f.router.snapshot(f.ids.a).session;
  assert.deepEqual([before.preferred_model, before.reasoning_effort, before.team_tools, before.preference_log, before.file_tools],
    [null, 'default', { read: true, write: true }, [], 'unavailable'], 'an old conversation reads as the team default');
  const set = await setPrefs(f, 'member', f.ids.a, { preferred_model: 'm1', reasoning_effort: 'high', team_tools: { write: false } });
  assert.equal(reasonOf(set), 'ok');
  assert.equal(typeof set.revision, 'string');
  const stored = f.backend.sessionStore.getSession(f.ids.a);
  assert.deepEqual([stored.preferred_model, stored.reasoning_effort, stored.team_tool_switches], ['m1', 'high', { read: true, write: false }]);
  // Row 123 (team host file tools): on also needs the worker's own report that its file tools started.
  f.backend.currentStatus = { tools_status: { read_file: { available: true }, write_file: { available: true } },
    hosted_files: { available: true, reason: null } };
  const after = f.router.snapshot(f.ids.a).session;
  assert.deepEqual([after.preferred_model, after.reasoning_effort, after.team_tools, after.file_tools],
    ['m1', 'high', { read: true, write: false }, 'available']);
  assert.equal(after.preference_log.length, 1, 'one call, one entry');
  const [entry] = after.preference_log;
  assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/u);
  assert.deepEqual([entry.by, entry.from, entry.to], ['member_a', TEAM_DEFAULT, { model: 'm1', effort: 'high', read: true, write: false }]);
  assert.equal(reasonOf(await setPrefs(f, 'member', f.ids.a, { preferred_model: 'm1', team_tools: { write: false } })), 'ok');
  assert.equal(f.router.snapshot(f.ids.a).session.preference_log.length, 1, 'a call that changes nothing appends nothing');
  const reset = { preferred_model: null, reasoning_effort: 'default', team_tools: { write: true } };
  assert.equal(reasonOf(await setPrefs(f, 'owner', f.ids.a, reset)), 'ok');
  const cleared = f.router.snapshot(f.ids.a).session;
  assert.deepEqual([cleared.preferred_model, cleared.reasoning_effort, cleared.team_tools], [null, 'default', { read: true, write: true }]);
  assert.deepEqual(cleared.preference_log.map((one) => [one.by, one.to]), [['member_a', entry.to], ['member_owner', TEAM_DEFAULT]]);
  f.backend.currentStatus = { tools_status: { read_file: { available: true }, write_file: { available: false } } };
  assert.equal(f.router.snapshot(f.ids.a).session.file_tools, 'unavailable', 'both typed file tools, or unavailable');
});

test('row 172: a model the pool does not offer, the alias, a bad shape, a reader and another project are refused', async (t) => {
  const f = await teamRouter(t);
  offering(f, ['m1']);
  const before = JSON.stringify(f.backend.sessionStore.getSession(f.ids.a));
  for (const model of ['gone', 'team-pool']) {
    assert.equal(reasonOf(await setPrefs(f, 'member', f.ids.a, { preferred_model: model })), 'conversation_model_not_offered', model);
  }
  for (const params of [{ team_tools: {} }, { team_tools: { write: false, run: false } }, { team_tools: { read: 'no' } },
    { reasoning_effort: 'xhigh' }, { preferred_model: '' }, { preferred_model: 'x'.repeat(257) }]) {
    assert.equal(reasonOf(await setPrefs(f, 'member', f.ids.a, params)), 'invalid_command_parameters', JSON.stringify(params));
  }
  for (const [who, sessionId] of [['read_only', f.ids.a], ['otherMember', f.ids.a], ['member', f.ids.b]]) {
    const refused = await f.send(who, 'sessions.preferences', { team_tools: { write: false } }, { session_id: sessionId,
      control_generation: 1, expected_revision: `${BOOT}:1` });
    assert.equal(refused.ok, false, who);
  }
  const noLease = await f.send('member', 'sessions.preferences', { team_tools: { write: false } }, { session_id: f.ids.a,
    control_generation: 9999, expected_revision: f.router.snapshot(f.ids.a).session.revision });
  assert.equal(reasonOf(noLease), 'control_lease_required', 'the driver\'s lease, as chat.send');
  assert.equal(JSON.stringify(f.backend.sessionStore.getSession(f.ids.a)), before, 'nothing was written');
});

test('row 172: the single-owner host refuses every team key and its snapshot is unchanged', async (t) => {
  const f = await teamRouter(t, { team: false });
  offering(f, ['m1']);
  for (const params of [{ preferred_model: 'm1' }, { preferred_model: null }, { reasoning_effort: 'high' }, { team_tools: { read: false } }]) {
    assert.equal(reasonOf(await setPrefs(f, 'owner', f.ids.a, params)), 'team_preference_unsupported', JSON.stringify(params));
  }
  assert.deepEqual(Object.keys(f.router.snapshot(f.ids.a).session).sort(), ['plan_mode', 'revision', 'session_id', 'title']);
});

test('row 172: the change log keeps the newest 50 entries; a snapshot carries the newest 20', async (t) => {
  const f = await teamRouter(t);
  for (let i = 0; i < 53; i += 1) {
    assert.equal(reasonOf(await setPrefs(f, 'member', f.ids.a, { team_tools: { read: i % 2 === 1 } })), 'ok');
  }
  const log = f.backend.sessionStore.getSession(f.ids.a).preference_log;
  assert.equal(log.length, 50);
  assert.deepEqual(f.router.snapshot(f.ids.a).session.preference_log, log.slice(-20));
  assert.equal(log.at(-1).to.read, false, 'the newest change is kept');
  assert.equal(log[0].to.read, true, 'the oldest three are gone');
});

test('row 172: a turn carries the switched-off group as disabled tools, keeps the families, and leaves the pick alone', async (t) => {
  const f = await teamRouter(t);
  offering(f, ['m1']);
  const submitted = [];
  f.backend.runtimeApplicationService = { submit: async (payload, { beforeCommit }) => {
    beforeCommit();
    submitted.push(payload);
    return { ok: true, work_id: 'work_1', turn_id: 'turn_1', session_id: payload.session_id, revision: 1, status: 'pending' };
  } };
  f.backend.sessionStore.setSessionPreferences(f.ids.a, { tool_category_overrides: { web: false } });
  const send = async () => {
    const acquired = await f.send('member', 'control.acquire', { takeover: true }, { session_id: f.ids.a });
    return f.send('member', 'chat.send', { prompt: 'hi' }, { session_id: f.ids.a, control_generation: acquired.lease.generation,
      expected_revision: f.router.snapshot(f.ids.a).session.revision });
  };
  assert.equal(reasonOf(await send()), 'ok');
  assert.deepEqual(submitted[0].tool_preferences, { families: { web: false }, connections: {} }, 'both switches on: as before');
  assert.equal(reasonOf(await setPrefs(f, 'member', f.ids.a, { preferred_model: 'm1', team_tools: { write: false } })), 'ok');
  assert.equal(reasonOf(await send()), 'ok');
  assert.deepEqual(Object.keys(submitted[1].tool_preferences), ['disabled_tools']);
  const disabled = submitted[1].tool_preferences.disabled_tools;
  for (const tool of ['write_file', 'edit_file', 'propose_change']) assert.ok(disabled.includes(tool), tool);
  for (const tool of ['read_file', 'list_dir', 'glob_files', 'grep_search']) assert.equal(disabled.includes(tool), false, tool);
  assert.ok(disabled.includes('web_search'), 'the web family the session switched off stays off');
  // The turn saves its preferences when it starts (managed-sidecar-chat.js); on a pool host it asks for the alias.
  f.backend.sessionStore.setSessionPreferences(f.ids.a, { preferred_model: 'team-pool', reasoning_effort: 'low' });
  const stored = f.backend.sessionStore.getSession(f.ids.a);
  assert.deepEqual([stored.preferred_model, stored.reasoning_effort], ['m1', 'default'], 'the turn\'s echo changes no pick');
});

test('row 172: the team fields survive a reload; a plain patch or preference object cannot set them', (t) => {
  const { TEAM_CONVERSATION_PREFERENCES } = require('../../services/backend/session-normalizers');
  const root = tempDir(t, 'jenny-team-prefs-store-');
  const store = openStore(root);
  const id = store.createSession({ title: 'Team' }).id;
  store.setSessionPreferences(id, { [TEAM_CONVERSATION_PREFERENCES]: { model: 'm1', effort: 'low', tools: { read: false },
    by: 'member_a', at: '2026-11-16T10:00:00.000Z' } });
  store.updateSession(id, { team_tool_switches: { read: true, write: false }, preference_log: [] });
  store.setSessionPreferences(id, { team_tool_switches: { read: true, write: false }, preference_log: [] });
  store.flushSession(id);
  store.dispose();
  const reopened = openStore(root);
  const session = reopened.getSession(id);
  assert.deepEqual([session.preferred_model, session.reasoning_effort, session.team_tool_switches],
    ['m1', 'low', { read: false, write: true }]);
  assert.deepEqual(session.preference_log, [{ at: '2026-11-16T10:00:00.000Z', by: 'member_a',
    from: { model: null, effort: 'default', read: true, write: true }, to: { model: 'm1', effort: 'low', read: false, write: true } }]);
  reopened.dispose();
});

test('row 175 item 7: on a team host plan_mode is a team preference: a writer sets it; a reader, a running turn and an actor-less call are refused', async (t) => {
  const f = await teamRouter(t);
  assert.equal(reasonOf(await setPrefs(f, 'member', f.ids.a, { plan_mode: true })), 'ok');
  assert.equal(f.router.snapshot(f.ids.a).session.plan_mode, true, 'the session\'s plan_mode stays the on/off truth');
  for (const [who, sessionId] of [['read_only', f.ids.a], ['otherMember', f.ids.a], ['member', f.ids.b]]) {
    assert.equal((await setPrefs(f, who, sessionId, { plan_mode: false })).ok, false, who);
  }
  const noActor = { ...f.seat.member.context, actor: undefined };
  const acquired = await f.send('member', 'control.acquire', { takeover: true }, { session_id: f.ids.a });
  assert.equal((await f.send('member', 'sessions.preferences', { plan_mode: false }, { session_id: f.ids.a,
    control_generation: acquired.lease.generation, expected_revision: f.router.snapshot(f.ids.a).session.revision }, noActor)).ok, false);
  f.backend.sessionStore.getActiveTurn = () => ({ stream_id: 'stream_1' });
  assert.equal(reasonOf(await setPrefs(f, 'member', f.ids.a, { plan_mode: false })), 'session_active', 'nothing changes while a turn runs');
  assert.equal(f.router.snapshot(f.ids.a).session.plan_mode, true);
});

test('row 175 item 7: the single-owner host takes plan_mode as before, with no author and no log', async (t) => {
  const f = await teamRouter(t, { team: false });
  assert.equal(reasonOf(await setPrefs(f, 'owner', f.ids.a, { plan_mode: true })), 'ok');
  assert.equal(f.router.snapshot(f.ids.a).session.plan_mode, true);
  assert.equal(Object.hasOwn(f.backend.sessionStore.getSession(f.ids.a), 'preference_log'), false);
});
