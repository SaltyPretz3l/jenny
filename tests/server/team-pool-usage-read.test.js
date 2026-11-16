'use strict';

// Row 123 slice 4e host: the owner's GPU use read (UsageLog.read and team.pool.usage) and the team
// model setting (team.pool.model.set; team_model and automatic_model on the GPU list). Through the
// real command router over a real member store, the real authorizer and a real pool scheduler.
// No sidecar, no model, no engine, no window.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nodeTest = require('node:test');

const { USAGE_LOG_FILE, UsageLog } = require('../../server/team/usage-log');
const { automaticModel } = require('../../server/team/node-commands');
const { MARKER, createNodeCommandsFixture, model } = require('./helpers/team-node-fixture');

const test = (name, fn) => nodeTest(name, { timeout: 20_000 }, fn);
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const reason = (answer) => (answer.ok ? 'ok' : answer.error.reason);

function tempLog(t, clock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-usage-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, USAGE_LOG_FILE);
  return { filePath, log: new UsageLog({ filePath, clock }) };
}
const row = (over = {}) => ({ member_id: 'member_a', model: 'alpha', node_id: 'node_AAAAAAAAAAAAAAAAAAAAAA', prompt_tokens: 11,
  completion_tokens: 7, duration_ms: 1200, outcome: 'completed', reason: null, ...over });

// ------------------------------------------------------------------ the reader

test('totals per member over the last 7 days are right at the boundary; an all-null count counts 0', (t) => {
  const clock = { now: NOW - 8 * DAY };
  const { log } = tempLog(t, () => clock.now);
  log.append(row({ member_id: 'member_old' })); // 8 days ago: outside
  clock.now = NOW - 7 * DAY; // exactly at the boundary: inside
  log.append(row({ member_id: 'member_b' }));
  clock.now = NOW - 1;
  log.append(row({ member_id: 'member_a', prompt_tokens: null, completion_tokens: null }));
  log.append(row({ member_id: 'member_a', prompt_tokens: 5, completion_tokens: null }));
  log.append(row({ member_id: 'member_b' }));
  const page = log.read({ since: NOW - 7 * DAY });
  assert.deepEqual(page.totals, [
    { member_id: 'member_a', requests: 2, tokens: 5 },
    { member_id: 'member_b', requests: 2, tokens: 36 },
  ], 'equal requests: by member id');
  assert.deepEqual(page.rows.map((r) => r.member_id), ['member_b', 'member_a', 'member_a', 'member_b'], 'rows newest first, the same 7 days');
  assert.equal(log.read({}).rows.length, 5, 'without a window every row is read');
  assert.equal(page.rows[2].tokens, null, 'no count sent stays null on the row');
  assert.deepEqual(Object.keys(page.rows[0]).sort(), ['at', 'duration_ms', 'member_id', 'model', 'node_id', 'reported_by', 'seq',
    'tokens']);
  assert.equal(page.rows[0].reported_by, 'node', 'R16-F03: the count is the serving hardware\'s');
});

test('the page and its cursor stay stable while rows are appended', (t) => {
  const { log } = tempLog(t, () => NOW);
  for (let i = 0; i < 45; i += 1) log.append(row({ duration_ms: i }));
  const first = log.read({ limit: 20 });
  assert.deepEqual(first.rows.map((r) => r.seq), Array.from({ length: 20 }, (_, i) => 45 - i));
  assert.equal(first.next_cursor, 26);
  for (let i = 0; i < 5; i += 1) log.append(row());
  const second = log.read({ cursor: first.next_cursor, limit: 20 });
  assert.deepEqual(second.rows.map((r) => r.seq), Array.from({ length: 20 }, (_, i) => 25 - i));
  const third = log.read({ cursor: second.next_cursor, limit: 20 });
  assert.deepEqual(third.rows.map((r) => r.seq), [5, 4, 3, 2, 1]);
  assert.equal(third.next_cursor, null);
  assert.equal(log.read({ limit: 500 }).rows.length, 50, 'a page is at most 50');
});

test('a degraded or refused log answers its failure, never an empty list', (t) => {
  const { filePath, log } = tempLog(t, () => NOW);
  log.append(row());
  fs.writeFileSync(filePath, JSON.stringify({ schema_version: 99, entries: [] }));
  const bytes = fs.readFileSync(filePath);
  const refused = new UsageLog({ filePath, clock: () => NOW });
  assert.deepEqual([refused.read().ok, refused.read().error.reason], [false, 'pool_schema_unsupported']);
  assert.deepEqual(fs.readFileSync(filePath), bytes, 'a refused file stays as it was');
  const broken = new UsageLog({ filePath, clock: () => NOW });
  broken._degraded = true;
  assert.equal(broken.read().ok, false);
  assert.equal(broken.read().error.reason, 'pool_usage_store_failed');
});

test('the read never writes the file', (t) => {
  const { filePath, log } = tempLog(t, () => NOW);
  for (let i = 0; i < 3; i += 1) log.append(row());
  const before = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  const fresh = new UsageLog({ filePath, clock: () => NOW + DAY });
  fresh.read();
  fresh.read({ cursor: 2 });
  assert.deepEqual(fs.readFileSync(filePath), before);
  assert.equal(fs.statSync(filePath).mtimeMs, stat.mtimeMs);
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), [USAGE_LOG_FILE], 'no temporary file either');
});

// ------------------------------------------------------------------ the operations

async function withUsage(t, options = {}) {
  const holder = { log: null };
  const f = await createNodeCommandsFixture(t, { usage: () => holder.log, ...options });
  const filePath = path.join(f.fx.dir, USAGE_LOG_FILE);
  holder.log = new UsageLog({ filePath, clock: f.fx.clock });
  return { ...f, holder, filePath };
}

test('team.pool.usage answers totals and rows with the serving hardware’s owner and PC name, and never a word', async (t) => {
  const f = await withUsage(t, { nodeOptions: (store) => ({ names: () => store.poolNames() }) });
  const nodeId = await f.register(f.seats.alice);
  f.holder.log.append(row({ member_id: f.seats.owner.member_id, node_id: nodeId }));
  f.holder.log.append(row({ member_id: f.seats.alice.member_id, node_id: null, prompt_tokens: null, completion_tokens: null }));
  const answer = await f.send(f.seats.owner, 'team.pool.usage', { limit: 20 });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.totals.map((total) => total.member_id).sort(), [f.seats.alice.member_id, f.seats.owner.member_id].sort());
  const [newest, older] = answer.rows;
  assert.equal(newest.node_member_id, null);
  assert.equal(newest.tokens, null);
  assert.equal(older.node_member_id, f.seats.alice.member_id);
  assert.equal(typeof older.node_label, 'string');
  assert.equal(answer.next_cursor, null);
  assert.equal(JSON.stringify(answer).includes(MARKER), false);
  for (const key of ['prompt', 'reply', 'messages', 'content', 'device_id', 'job_id', 'lease_id']) {
    assert.equal(JSON.stringify(answer).includes(`"${key}"`), false, `no ${key} in the answer`);
  }
});

test('team.pool.usage with no usage log answers unavailable', async (t) => {
  const f = await withUsage(t);
  f.holder.log = null;
  const answer = await f.send(f.seats.owner, 'team.pool.usage', {});
  assert.equal(reason(answer), 'team_pool_unavailable');
});

test('only the owner reads GPU use or sets the team model: everyone else gets the owner-only answer and nothing changes', async (t) => {
  const f = await withUsage(t);
  const removed = await f.join('Remy');
  const revoked = await f.store.revokeMember({ actorMemberId: f.seats.owner.member_id, memberId: removed.member_id });
  assert.equal(revoked.ok, true);
  const before = JSON.stringify(f.store.snapshot().team);
  const shape = (answer) => [answer.ok, answer.error?.code, answer.error?.reason];
  for (const seat of [f.seats.alice, f.seats.rae, f.seats.pat, removed]) {
    const owned = shape(await f.send(seat, 'team.audit.read', {}));
    assert.equal(owned[0], false);
    assert.deepEqual(shape(await f.send(seat, 'team.pool.usage', {})), owned, `${seat.display_name || seat.member_id}: usage`);
    assert.deepEqual(shape(await f.send(seat, 'team.pool.model.set', { model: 'alpha' })), owned, `${seat.display_name || seat.member_id}: model`);
  }
  assert.equal(JSON.stringify(f.store.snapshot().team), before, 'nothing changed');
  assert.equal(fs.existsSync(f.filePath), false, 'the usage log was never written');
});

// ------------------------------------------------------------------ the team model

const view = (id, models, online = true, paused = false) => ({ node_id: id, online, paused,
  models: models.map(([modelId, context]) => ({ id: modelId, context_length: context })) });

test('Automatic is the model on the most connected hardware; ties go to the larger context, then the id', () => {
  assert.equal(automaticModel([]), null);
  assert.equal(automaticModel([view('a', [['beta', 8192]], false)]), null, 'offline hardware counts for nothing');
  assert.equal(automaticModel([view('a', [['beta', 8192]]), view('b', [['beta', 8192], ['alpha', 4096]]), view('c', [['alpha', 4096]], false)]), 'beta');
  assert.equal(automaticModel([view('a', [['beta', 8192]]), view('b', [['alpha', 32768]])]), 'alpha', 'larger context wins a tie');
  assert.equal(automaticModel([view('a', [['beta', null]]), view('b', [['alpha', null]])]), 'alpha', 'then the id in order');
  assert.equal(automaticModel([view('a', [['beta', 8192]], true, true), view('b', [['alpha', 4096]])]), 'alpha', 'paused hardware answers nothing');
  assert.equal(automaticModel([view('a', [['beta', 8192]], true, true)]), null);
});

test('the owner sets the team model; the GPU list answers it and what Automatic means now', async (t) => {
  const f = await withUsage(t, { nodeOptions: (store) => ({ names: () => store.poolNames() }) });
  await f.register(f.seats.alice, { models: [model('alpha'), model('beta')] });
  let list = await f.send(f.seats.rae, 'team.node.list', {});
  assert.deepEqual([list.team_model, list.automatic_model], [null, 'alpha']);
  assert.equal((await f.send(f.seats.owner, 'team.pool.model.set', { model: 'beta' })).ok, true);
  list = await f.send(f.seats.alice, 'team.node.list', {});
  assert.deepEqual([list.team_model, list.automatic_model], ['beta', 'alpha']);
  assert.equal(f.store.snapshot().team.model, 'beta', 'stored where the team name lives');
  assert.equal((await f.send(f.seats.owner, 'team.pool.model.set', { model: null })).ok, true);
  assert.equal(f.store.snapshot().team.model, null, 'Automatic is stored as null');
  for (const bad of ['', ' leading', 'x'.repeat(129), 'tab\there', 7]) {
    assert.equal(reason(await f.send(f.seats.owner, 'team.pool.model.set', { model: bad })), 'invalid_command_parameters', JSON.stringify(bad));
  }
  assert.equal(reason(await f.send(f.seats.owner, 'team.pool.model.set', { model: 'trailing ' })), 'team_model_invalid', 'the store’s rule');
});

// ------------------------------------------------------------------ the real host

test('through the real host: each row names its PC, the team model is answered, GPU use is one 7-day window in pages', async (t) => {
  const { startNodeHost } = require('./helpers/team-node-fixture');
  const h = await startNodeHost(t, { before: (fx) => {
    let at = NOW - 9 * DAY;
    const log = new UsageLog({ filePath: path.join(fx.profile, USAGE_LOG_FILE), clock: () => at });
    assert.equal(log.append(row({ member_id: 'member_old' })).ok, true);
    for (let i = 0; i < 25; i += 1) { at = NOW - DAY + i; assert.equal(log.append(row({ member_id: i % 2 ? 'member_a' : 'member_b' })).ok, true); }
  } });
  const owner = await h.as(h.seats.owner);
  await h.register(h.seats.member, { models: [model('alpha')] });
  let list = await owner.send('team.node.list', {});
  assert.equal(list.nodes[0].label, 'Laptop', 'the PC’s name from the member’s device');
  assert.equal(list.team_model, null);
  assert.equal((await owner.send('team.pool.model.set', { model: 'alpha' })).ok, true);
  list = await owner.send('team.node.list', {});
  assert.deepEqual([list.team_model, list.automatic_model], ['alpha', 'alpha']);
  const first = await owner.send('team.pool.usage', {});
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.rows.length, 20, 'the default page');
  assert.deepEqual(first.totals.map((total) => total.member_id).sort(), ['member_a', 'member_b'], 'nothing older than 7 days');
  const second = await owner.send('team.pool.usage', { cursor: first.next_cursor });
  assert.equal(second.rows.length, 5);
  assert.equal(second.next_cursor, null, 'the row older than 7 days is not a page of its own');
  assert.equal([...first.rows, ...second.rows].some((entry) => entry.member_id === 'member_old'), false);
});
