'use strict';

// Row 123 slice 4e: the team's GPUs as this Jenny holds them (services/team/node/pool-view.js).
// Every host answer and event is rebuilt field by field before it is kept: a field the host adds
// (a device id, a job) never reaches the renderer; a list that fails a rule is refused and the
// last good one is kept. A fake manager stands in for the team connection: no host, no network.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createPoolView } = require('../services/team/node/pool-view');

const TEAM = 'team_pool_view';
const settle = () => new Promise((resolve) => setImmediate(resolve));
const model = (name) => ({ name, context_length: 8192, vision: false, thinking: true });
const row = (n, over = {}) => ({ node_id: `node_${n}`, member_id: 'member_a', label: `PC ${n}`, online: true, paused: false,
  busy_slots: 0, slots: 1, models: [model('alpha')], ...over });
const list = (nodes = [row(1)], over = {}) => ({ nodes, team_model: null, automatic_model: 'alpha', ...over });

function fakeManager(answers = {}) {
  const listeners = new Set();
  const calls = [];
  const manager = {
    state: 'online',
    calls,
    answers,
    snapshot: () => ({ state: manager.state, member_state: 'active' }),
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    listeners: () => listeners.size,
    emit(event) { for (const fn of [...listeners]) fn(event); },
    async command(operation, params) {
      calls.push({ operation, params });
      const answer = manager.answers[operation];
      return typeof answer === 'function' ? answer(params) : answer;
    },
  };
  return manager;
}

function setup(answers) {
  const logs = [];
  let changes = 0;
  const view = createPoolView({ log: (level, event, fields) => logs.push({ level, event, fields }), onChange: () => { changes += 1; } });
  const manager = fakeManager({ 'team.node.list': { ok: true, ...list() }, ...answers });
  view.connectionChanged(TEAM, manager);
  return { view, manager, logs, changes: () => changes };
}

test('a row is rebuilt field by field: a device id or a job the host adds is never kept', async () => {
  const { view, manager } = setup();
  await settle();
  manager.emit({ event_type: 'team_pool_nodes', ...list([row(2, { device_id: 'device_x', job: { job_id: 'j' },
    models: [{ ...model('beta'), prompt: 'secret' }] })], { lease: 'l' }) });
  const held = view.snapshot()[TEAM];
  const text = JSON.stringify(held);
  for (const word of ['device_id', 'device_x', 'job', 'lease', 'prompt', 'secret']) assert.equal(text.includes(word), false, word);
  assert.deepEqual(Object.keys(held.nodes[0]).sort(), ['busy_slots', 'label', 'member_id', 'models', 'node_id', 'online', 'owner_busy', 'paused', 'slots']);
  assert.deepEqual(held.nodes[0].models, [model('beta')]);
});

test('a refused list answers team_answer_invalid and keeps the last good list', async () => {
  const { view, manager, logs } = setup();
  await settle();
  const good = view.snapshot()[TEAM];
  manager.answers['team.node.list'] = { ok: true, ...list([row(1, { node_id: 'device_1' })]) };
  const answer = await view.call('gpuList', { team_id: TEAM });
  assert.deepEqual(answer.error.reason, 'team_answer_invalid');
  assert.deepEqual(view.snapshot()[TEAM], good);
  assert.ok(logs.some((entry) => entry.event === 'team.pool.list_refused' && entry.fields.team_id === TEAM));
  manager.emit({ event_type: 'team_pool_nodes', ...list([row(1, { slots: 9 })]) });
  assert.deepEqual(view.snapshot()[TEAM], good, 'a refused event too');
});

test('resync_required reads the list again; team_pool_unavailable clears it', async () => {
  const { view, manager } = setup();
  await settle();
  assert.equal(manager.calls.length, 1, 'read when the team came online');
  manager.answers['team.node.list'] = { ok: true, ...list([row(3)]) };
  manager.emit({ event_type: 'resync_required' });
  await settle();
  assert.equal(manager.calls.length, 2);
  assert.equal(view.snapshot()[TEAM].nodes[0].node_id, 'node_3');
  manager.answers['team.node.list'] = { ok: false, error: { code: 'unavailable', reason: 'team_pool_unavailable' } };
  const answer = await view.call('gpuList', { team_id: TEAM });
  assert.equal(answer.error.reason, 'team_pool_unavailable');
  assert.equal(view.snapshot()[TEAM], undefined, 'a host with no pool has no GPUs');
});

test('drop forgets the team and its listener', async () => {
  const { view, manager, changes } = setup();
  await settle();
  const before = changes();
  view.drop(TEAM);
  assert.equal(manager.listeners(), 0);
  assert.equal(view.snapshot()[TEAM], undefined);
  assert.equal(changes(), before + 1);
  assert.equal((await view.call('gpuList', { team_id: TEAM })).error.reason, 'team_not_found');
  manager.emit({ event_type: 'team_pool_nodes', ...list() });
  assert.equal(view.snapshot()[TEAM], undefined);
});

test('the bounds: 64 rows and 50 usage rows pass, one more is refused', async () => {
  const { view, manager } = setup();
  await settle();
  manager.emit({ event_type: 'team_pool_nodes', ...list(Array.from({ length: 64 }, (_, i) => row(i))) });
  assert.equal(view.snapshot()[TEAM].nodes.length, 64);
  manager.emit({ event_type: 'team_pool_nodes', ...list(Array.from({ length: 65 }, (_, i) => row(i))) });
  assert.equal(view.snapshot()[TEAM].nodes.length, 64, '65 refused');
  const usageRow = (seq) => ({ seq, at: 1, member_id: 'member_a', model: 'alpha', tokens: 3, duration_ms: 10, node_id: 'node_1',
    node_member_id: 'member_b', node_label: 'PC', device_id: 'device_x' });
  manager.answers['team.pool.usage'] = { ok: true, totals: [], rows: Array.from({ length: 50 }, (_, i) => usageRow(i + 1)), next_cursor: null };
  const page = await view.call('gpuUse', { team_id: TEAM });
  assert.equal(page.rows.length, 50);
  assert.equal(JSON.stringify(page).includes('device'), false, 'rebuilt');
  manager.answers['team.pool.usage'] = { ok: true, totals: [], rows: Array.from({ length: 51 }, (_, i) => usageRow(i + 1)), next_cursor: null };
  assert.equal((await view.call('gpuUse', { team_id: TEAM })).error.reason, 'team_answer_invalid');
});

test('R16-F03: a usage row keeps who reported its count (the serving hardware) and nothing else in that field', async () => {
  const { view, manager } = setup();
  await settle();
  const usageRow = (seq, reportedBy) => ({ seq, at: 1, member_id: 'member_a', model: 'alpha', tokens: 3, duration_ms: 10,
    node_id: 'node_1', node_member_id: 'member_b', node_label: 'PC', ...(reportedBy === undefined ? {} : { reported_by: reportedBy }) });
  manager.answers['team.pool.usage'] = { ok: true, totals: [], next_cursor: null,
    rows: [usageRow(3, 'node'), usageRow(2, 'Node\nsecret'), usageRow(1)] };
  const page = await view.call('gpuUse', { team_id: TEAM });
  assert.deepEqual(page.rows.map((entry) => entry.reported_by), ['node', null, null]);
});

test('a list answer is dropped when an event arrived after its request was sent', async () => {
  let release;
  const { view, manager } = setup();
  await settle();
  manager.answers['team.node.list'] = () => new Promise((resolve) => { release = resolve; });
  const pending = view.call('gpuList', { team_id: TEAM });
  manager.emit({ event_type: 'team_pool_nodes', ...list([row(7)]) });
  release({ ok: true, ...list([row(1)]) });
  await pending;
  assert.equal(view.snapshot()[TEAM].nodes[0].node_id, 'node_7', 'the newer event stands');
});

test('E76: owner_busy is kept as a boolean; a host that does not send it reads as false; a non-boolean refuses the list', async () => {
  const { view, manager } = setup();
  await settle();
  manager.emit({ event_type: 'team_pool_nodes', ...list([row(2, { paused: true, owner_busy: true }), row(3, { paused: true })]) });
  assert.deepEqual(view.snapshot()[TEAM].nodes.map((node) => node.owner_busy), [true, false]);
  const good = view.snapshot()[TEAM];
  manager.emit({ event_type: 'team_pool_nodes', ...list([row(4, { owner_busy: 'yes' })]) });
  assert.deepEqual(view.snapshot()[TEAM], good);
});
