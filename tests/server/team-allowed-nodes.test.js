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
