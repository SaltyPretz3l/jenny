'use strict';

// Slice 4b member wiring (row 123), the team engine on its own (services/team/team-engine.js):
// the models read and its bounds, the list TTL, the port's start retry and stop on a final
// state, and the connection manager's `engine` call. Fake ports and fake managers; the
// real ports and real hosts run in tests/team-engine.test.js and team-connection-manager.test.js.

const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createTeamEngine, engineCall } = require('../services/team/team-engine');
const { TeamError } = require('../services/team/team-errors');

const TEAM = 'team_alpha1';
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(times = 6) { for (let i = 0; i < times; i += 1) await tick(); }

function fakePort({ failStart = false } = {}) {
  const port = { state: 'idle', starts: 0, stops: 0, turnRoute: {} };
  port.start = async () => { port.starts += 1; if (failStart) throw new Error('listen_failed'); port.state = 'ready'; };
  port.stop = async () => { port.stops += 1; port.state = 'stopped'; };
  port.getStatus = () => ({ state: port.state });
  return port;
}

// One answer of the host's models route: `body` is written whole unless `hold` keeps it open.
function upstream(status, body = '', { hold = false } = {}) {
  const stream = new PassThrough();
  const answer = { status, body: stream, closed: false, close: () => { answer.closed = true; stream.destroy(); } };
  setImmediate(() => { if (hold) stream.write(body); else stream.end(body); });
  return answer;
}

const models = (...ids) => JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });

function fakeManager(answers) {
  const manager = { reads: 0, snap: { state: 'online', member_state: 'active', team_name: 'Alpha crew' } };
  manager.snapshot = () => ({ ...manager.snap });
  manager.engine = (route) => {
    manager.reads += 1;
    const next = typeof answers === 'function' ? answers(manager.reads) : answers;
    return Promise.resolve(next);
  };
  return manager;
}

function world({ answers = () => upstream(200, models('alpha')), failStarts = 0, listTimeoutMs = 200 } = {}) {
  let clock = 1_000;
  const ports = [];
  const events = [];
  const counts = { list: 0, port: 0, gone: [] };
  const engine = createTeamEngine({
    createPort: () => {
      const port = fakePort({ failStart: ports.length < failStarts });
      ports.push(port);
      return port;
    },
    onListChange: () => { counts.list += 1; },
    onPortChange: () => { counts.port += 1; },
    onTeamGone: (teamId) => counts.gone.push(teamId),
    log: (level, event, fields) => events.push({ level, event, fields }),
    now: () => clock, listTtlMs: 15_000, listTimeoutMs, startRetryMs: 5000,
  });
  const manager = fakeManager(answers);
  return { engine, manager, ports, events, counts, advance: (ms) => { clock += ms; } };
}

test('the list is read on coming online and again only after the TTL; an unchanged read announces nothing', async () => {
  const w = world();
  w.engine.connectionChanged(TEAM, w.manager);
  await settle();
  assert.equal(w.manager.reads, 1);
  assert.deepEqual(w.engine.listTeams(), [{ teamId: TEAM, name: 'Alpha crew', models: ['alpha'], contextLengths: {}, capabilities: {} }]);
  const announced = w.counts.list;
  w.advance(14_999);
  w.engine.listTeams();
  await settle();
  assert.equal(w.manager.reads, 1, 'inside the TTL: no read');
  w.advance(1);
  w.engine.listTeams();
  await settle();
  assert.equal(w.manager.reads, 2, 'at the TTL: read again');
  assert.equal(w.counts.list, announced, 'the same list announces nothing');
  assert.deepEqual(w.events.filter((line) => line.event === 'team.engine.models_read').map((line) => line.fields),
    [{ team_id: TEAM, count: 1 }, { team_id: TEAM, count: 1 }]);
});

test('a refused or failed read keeps the last good list, stale, closes the answer and clears it after three in a row', async () => {
  const answers = [];
  const w = world({ answers: (n) => {
    const answer = n === 1 ? upstream(200, models('alpha')) : n === 2 ? upstream(503, 'busy') : Promise.reject(
      new TeamError('CONNECTION_FAILED', 'team_connection_reset'));
    answers.push(answer);
    return answer;
  } });
  w.engine.connectionChanged(TEAM, w.manager);
  await settle();
  const announced = w.counts.list;
  w.advance(15_000);
  w.engine.listTeams();
  await settle();
  assert.equal(answers[1].closed, true, 'a non-200 answer is closed');
  assert.deepEqual(w.engine.teamState(TEAM).models, ['alpha'], 'one failed read keeps the list');
  assert.equal(w.engine.teamState(TEAM).stale, true);
  assert.equal(w.engine.listTeams()[0].models[0], 'alpha');
  assert.equal(w.counts.list, announced + 1, 'the stale mark is announced');
  w.advance(15_000);
  w.engine.listTeams();
  await settle();
  assert.deepEqual(w.engine.teamState(TEAM).models, ['alpha'], 'two in a row still keep it');
  w.advance(15_000);
  w.engine.listTeams();
  await settle();
  assert.deepEqual(w.engine.teamState(TEAM).models, [], 'three in a row clear it');
  assert.equal(w.engine.teamState(TEAM).stale, false);
  const reasons = w.events.filter((line) => line.event === 'team.engine.models_unavailable').map((line) => line.fields.reason);
  assert.deepEqual(reasons, ['team_engine_models_refused', 'team_connection_reset', 'team_connection_reset']);
});

test('a timed-out read keeps the cached models (OD-4 team engine: one 3 s miss never wipes the list)', async () => {
  let n = 0;
  const w = world({ listTimeoutMs: 30, answers: () => { n += 1; return n === 1 ? upstream(200, models('alpha')) : new Promise(() => {}); } });
  w.engine.connectionChanged(TEAM, w.manager);
  await settle();
  w.advance(15_000);
  w.engine.listTeams();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(w.engine.teamState(TEAM).models, ['alpha']);
  assert.equal(w.engine.teamState(TEAM).stale, true);
  w.advance(15_000);
  w.manager.engine = () => Promise.resolve(upstream(200, models('alpha', 'beta')));
  w.engine.listTeams();
  await settle();
  assert.deepEqual(w.engine.teamState(TEAM).models, ['alpha', 'beta']);
  assert.equal(w.engine.teamState(TEAM).stale, false, 'a good read lifts the mark');
});

test('a team_pool_nodes push reads the list again at once; a push during a read asks for one more; other events do nothing', async () => {
  let listener = null;
  let current = ['alpha'];
  const w = world({ answers: () => upstream(200, models(...current)) });
  w.manager.onEvent = (fn) => { listener = fn; return () => { listener = null; }; };
  w.engine.connectionChanged(TEAM, w.manager);
  await settle();
  assert.equal(w.manager.reads, 1);
  listener({ event_type: 'team_chat_message' });
  await settle();
  assert.equal(w.manager.reads, 1, 'another event reads nothing');
  current = ['alpha', 'beta'];
  const node = (models, extra = {}) => ({ node_id: 'node_1', online: true, paused: false, busy_slots: 0, models, ...extra });
  listener({ event_type: 'team_pool_nodes', nodes: [node(current)] });
  await settle();
  assert.equal(w.manager.reads, 2, 'inside the TTL, a push still reads');
  assert.deepEqual(w.engine.teamState(TEAM).models, ['alpha', 'beta']);
  listener({ event_type: 'team_pool_nodes', nodes: [node(current, { busy_slots: 1 })] });
  await settle();
  assert.equal(w.manager.reads, 2, 'row 201: a job starting (busy slots only) reads nothing');
  listener({ event_type: 'team_pool_nodes', nodes: [node(current, { paused: true })] });
  listener({ event_type: 'team_pool_nodes', nodes: [node(current)] });
  await settle(10);
  assert.equal(w.manager.reads, 4, 'pushes during one read ask for exactly one more');
  await w.engine.drop(TEAM);
  assert.equal(listener, null, 'a dropped team is unsubscribed');
});

test('a member who turns from pending to active while online gets the list read at once', async () => {
  const w = world();
  w.manager.snap = { ...w.manager.snap, member_state: 'pending' };
  w.engine.connectionChanged(TEAM, w.manager);
  await settle();
  assert.equal(w.manager.reads, 0, 'a pending member reads nothing');
  w.manager.snap = { ...w.manager.snap, member_state: 'active' };
  w.engine.connectionChanged(TEAM, w.manager);
  await settle();
  assert.equal(w.manager.reads, 1);
  assert.deepEqual(w.engine.teamState(TEAM).models, ['alpha']);
});

test('vision and thinking the host names are passed through, only as true', async () => {
  const body = JSON.stringify({ object: 'list', data: [
    { id: 'seer', vision: true }, { id: 'thinker', thinking: true, context_length: 8192 },
    { id: 'plain' }, { id: 'odd', vision: 'yes', thinking: 1 }] });
  const w = world({ answers: () => upstream(200, body) });
  w.engine.connectionChanged(TEAM, w.manager);
  await settle();
  const expected = { seer: { vision: true, thinking: false }, thinker: { vision: false, thinking: true } };
  assert.deepEqual(w.engine.teamState(TEAM).capabilities, expected);
  assert.deepEqual(w.engine.listTeams()[0].capabilities, expected);
});

test('hostile answers: control characters, an over-long id, duplicates, more than 64 models, an oversized body', async () => {
  const ids = ['ok', 'ctl\u0001x', 'nul\u0000', ' padded', `${'m'.repeat(129)}`, `${'m'.repeat(128)}`, 'ok', 'tab\tx', 'café'];
  const many = Array.from({ length: 80 }, (_, i) => `model-${i}`);
  const cases = [
    [upstream(200, models(...ids)), ['ok', 'm'.repeat(128)]],
    [upstream(200, models(...many)), many.slice(0, 64)],
    [upstream(200, JSON.stringify({ data: [{ id: 'x' }], pad: 'p'.repeat(256 * 1024) })), []],
    [upstream(200, '{"data": [ not json'), []],
    [upstream(200, JSON.stringify({ data: 'nope' })), []],
  ];
  for (const [answer, expected] of cases) {
    const w = world({ answers: () => answer });
    w.engine.connectionChanged(TEAM, w.manager);
    await settle(10);
    assert.deepEqual(w.engine.teamState(TEAM).models, expected);
  }
  const big = upstream(200, JSON.stringify({ data: [], pad: 'p'.repeat(300 * 1024) }));
  const w = world({ answers: () => big });
  w.engine.connectionChanged(TEAM, w.manager);
  await settle(10);
  assert.equal(big.closed, true, 'an oversized answer is cut and closed');
  assert.equal(w.events.find((line) => line.event === 'team.engine.models_unavailable').fields.reason, 'team_engine_models_too_large');
});

test('a read slower than the timeout, and a call that never answers, end the read; a late answer is closed', async () => {
  const slow = upstream(200, '{"data":[', { hold: true });
  const w = world({ answers: () => slow, listTimeoutMs: 30 });
  w.engine.connectionChanged(TEAM, w.manager);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(slow.closed, true);
  assert.deepEqual(w.engine.teamState(TEAM).models, []);

  let late = null;
  const hung = world({ listTimeoutMs: 30, answers: (n) => (n === 1
    ? new Promise((resolve) => setTimeout(() => { late = upstream(200, models('alpha')); resolve(late); }, 80))
    : upstream(200, models('beta'))) });
  hung.engine.connectionChanged(TEAM, hung.manager);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(hung.events.find((line) => line.event === 'team.engine.models_unavailable').fields.reason,
    'team_engine_models_timeout', 'the client registration inside the call is bounded too');
  hung.advance(15_000);
  hung.engine.listTeams();
  await settle();
  assert.equal(hung.manager.reads, 2, 'the read is not stuck: the next one runs');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(late.closed, true, 'the answer that came after the timeout is closed');
  assert.deepEqual(hung.engine.teamState(TEAM).models, ['beta']);
});

test('a port that fails to start is tried again on a later change or list read, no sooner than the retry delay, at most five times', async () => {
  const w = world({ failStarts: 7 });
  w.engine.connectionChanged(TEAM, w.manager);
  await settle();
  assert.equal(w.ports.length, 1);
  assert.equal(w.engine.portFor(TEAM), null);
  w.engine.listTeams();
  w.engine.connectionChanged(TEAM, w.manager);
  assert.equal(w.ports.length, 1, 'not before the retry delay');
  for (let i = 2; i <= 5; i += 1) {
    w.advance(5000);
    w.engine.listTeams();
    await settle();
    assert.equal(w.ports.length, i);
  }
  w.advance(60_000);
  w.engine.listTeams();
  w.engine.connectionChanged(TEAM, w.manager);
  await settle();
  assert.equal(w.ports.length, 5, 'bounded');
  const ok = world({ failStarts: 1 });
  ok.engine.connectionChanged(TEAM, ok.manager);
  await settle();
  ok.advance(5000);
  ok.engine.connectionChanged(TEAM, ok.manager);
  await settle();
  assert.equal(ok.engine.teamState(TEAM).portReady, true);
  assert.equal(ok.counts.port, 1);
});

test('revoked and update_required stop the port and say the team is gone; a dropped manager is never taken back', async () => {
  for (const state of ['revoked', 'update_required']) {
    const w = world();
    w.engine.connectionChanged(TEAM, w.manager);
    await settle();
    const port = w.engine.portFor(TEAM);
    w.manager.snap = { ...w.manager.snap, state };
    w.engine.connectionChanged(TEAM, w.manager);
    await settle();
    assert.equal(port.state, 'stopped', state);
    assert.equal(port.stops, 1);
    assert.deepEqual(w.counts.gone, [TEAM]);
    assert.equal(w.engine.portFor(TEAM), null);
    assert.equal(w.ports.length, 1, `${state}: no new port`);
  }
  const w = world();
  w.engine.connectionChanged(TEAM, w.manager);
  await settle();
  const port = w.engine.portFor(TEAM);
  await w.engine.drop(TEAM);
  assert.equal(port.state, 'stopped');
  w.engine.connectionChanged(TEAM, w.manager);
  await settle();
  assert.equal(w.engine.teamState(TEAM), null, 'a late change from the dropped manager recreates nothing');
  assert.equal(w.ports.length, 1);
  const fresh = fakeManager(() => upstream(200, models('alpha')));
  w.engine.connectionChanged(TEAM, fresh);
  await settle();
  assert.equal(w.engine.teamState(TEAM).portReady, true, 'a new manager for the team is taken');
});

test('engineCall: not online and a blocked client registration refuse with a TeamError; online calls the route', async () => {
  const link = { client: { id: 'c' }, session: {
    engineChat: (client, body, options) => ({ route: 'chat', client, body, options }),
    engineModels: (client, options) => ({ route: 'models', client, options }),
  } };
  let ensured = 0;
  const ensureClient = async () => { ensured += 1; return null; };
  await assert.rejects(engineCall({ link, ensureClient, online: false }, 'chat', 'b'),
    (error) => error instanceof TeamError && error.reason === 'team_not_connected');
  await assert.rejects(engineCall({ link: null, ensureClient, online: true }, 'models'),
    (error) => error instanceof TeamError && error.reason === 'team_not_connected');
  assert.equal(ensured, 0, 'nothing is registered for a team that is not online');
  await assert.rejects(engineCall({ link, ensureClient: async () => ({ ok: false, error: { reason: 'team_client_refused' } }),
    online: true }, 'chat', 'b'), (error) => error instanceof TeamError && error.reason === 'team_client_refused');
  await assert.rejects(engineCall({ link, ensureClient: async () => ({ ok: false }), online: true }, 'chat', 'b'),
    (error) => error.reason === 'team_not_connected');
  const options = { engineKey: 'k', signal: null };
  assert.deepEqual(await engineCall({ link, ensureClient, online: true }, 'chat', 'b', options),
    { route: 'chat', client: link.client, body: 'b', options });
  assert.deepEqual(await engineCall({ link, ensureClient, online: true }, 'models', null, options),
    { route: 'models', client: link.client, options });
  assert.equal(ensured, 2);
});
