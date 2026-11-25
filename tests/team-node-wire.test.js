'use strict';

// new-test-file: tests/team-node-agent.test.js would pass 600 lines; these cases are the node wire of the team review fixes
// (row 201, slice G1): the link's credentials, the chunk retry after a lost answer, the pause heartbeat and the claim wait.
// The node agent against the agent fixture's fake host and manual timers; no team host, no GPU, no model, no window.

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const nodeTest = require('node:test');

const { createNodeAgent } = require('../services/team/node/node-agent');
const { createEngineClient, readModels } = require('../services/team/node/engine-forward');
const { createTeamLink } = require('../services/team/node/team-link');
const { DONE, createFakeHost, createManualTimers, failure, sse, startEngine, until } = require('./helpers/team-node-agent-fixture');

const test = (name, fn) => nodeTest(name, { timeout: 30_000 }, fn);

async function setup(t, { heartbeatMs, readCapabilities, engineFor } = {}) {
  const timers = createManualTimers();
  const host = createFakeHost({ timers, ...(heartbeatMs ? { heartbeatMs } : {}) });
  const engine = await startEngine(t);
  const agent = createNodeAgent({ link: host.link, resolveEngineUrl: () => engine.url, isBusy: () => false, timers,
    now: timers.now, clock: timers.now, ...(readCapabilities ? { readCapabilities } : {}), ...(engineFor ? { engine: engineFor() } : {}) });
  t.after(() => agent.dispose());
  return { timers, host, engine, agent };
}

async function drive(timers, predicate, label, step = 125, steps = 4000) {
  for (let i = 0; i < steps; i += 1) {
    if (predicate()) return;
    await timers.advance(step);
  }
  throw new Error(`not reached: ${label}`);
}

const streamOf = (value) => Readable.from([Buffer.from(JSON.stringify(value))]);
const oneReply = (engine) => {
  engine.handle = (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(Buffer.concat([sse('one'), DONE])); };
};

// ------------------------------------------------------------------ C7: the link's credentials

// A manager lending a link with no client until ensureClient registers one; `rotate` swaps the held one at the call.
function lendingManager({ held = null, rotate = null } = {}) {
  const sent = [];
  const link = {
    client: held,
    http: { openRequestStream: async (method, path, options) => {
      sent.push({ method, path, headers: options.headers, body: path.endsWith('/commands') ? JSON.parse(options.body.toString('utf8')) : null });
      return { status: 200, body: streamOf({ ok: true }), close() {} };
    } },
  };
  const lent = { link, online: true, ensureClient: async (target) => {
    if (target.client && !rotate) return null;
    target.client = rotate || { client_id: 'client_new', client_token: 'token_new', bootEpoch: 'epoch_new' };
    return null;
  } };
  return { sent, manager: { borrow: () => lent } };
}

test('C7: a first call on a fresh connection registers the client before its credentials are read', async () => {
  const { sent, manager } = lendingManager();
  const answer = await createTeamLink(manager).command('team.node.pause', { on: false });
  assert.equal(answer.ok, true);
  assert.deepEqual([sent[0].body.client_id, sent[0].body.boot_epoch, sent[0].headers['X-Client-Token']], ['client_new', 'epoch_new', 'token_new']);
});

test('C7: after a host restart every call carries the client ensureClient made, not the stale one', async () => {
  const stale = { client_id: 'client_old', client_token: 'token_old', bootEpoch: 'epoch_old' };
  const fresh = { client_id: 'client_new', client_token: 'token_new', bootEpoch: 'epoch_new' };
  const { sent, manager } = lendingManager({ held: stale, rotate: fresh });
  const link = createTeamLink(manager);
  await link.command('team.node.pause', { on: false });
  await link.postChunk('job_1', { seq: 0, final: false, bytes: Buffer.alloc(0) });
  await link.fetchRequest('job_1');
  assert.deepEqual(sent.map((call) => call.body?.client_id ?? call.headers['X-Client-Id']), ['client_new', 'client_new', 'client_new']);
  assert.deepEqual(sent.map((call) => call.headers['X-Client-Token']), ['token_new', 'token_new', 'token_new']);
});

// ------------------------------------------------------------------ C7: a chunk whose answer was lost

// The host takes the chunk (its next number moves on by `advance`) and the answer is lost.
const landedThenLost = (host, advance) => (params) => {
  host.jobs.get(params.jobId).nextSeq += advance;
  throw Object.assign(new Error('team_connection_reset'), { reset: true });
};

test('C7: a retried chunk the host already holds (next_seq is seq + 1) is accepted and the job goes on', async (t) => {
  const { agent, host, engine, timers } = await setup(t);
  oneReply(engine);
  await agent.start();
  host.script.chunk = [landedThenLost(host, 1)];
  const { descriptor } = host.queueJob();
  await drive(timers, () => host.chunks.filter((chunk) => chunk.jobId === descriptor.job_id).length >= 2, 'the chunk is sent again');
  await timers.advance(5_000);
  assert.deepEqual(host.of('team.node.fail').map((call) => call.params.reason), [], 'the job is not failed');
  assert.equal(agent.status().jobs, 0);
});

test('C7: a retried chunk answered with any other next_seq still fails the job', async (t) => {
  const { agent, host, engine, timers } = await setup(t);
  oneReply(engine);
  await agent.start();
  host.script.chunk = [landedThenLost(host, 3)];
  host.queueJob();
  await drive(timers, () => host.of('team.node.fail').length === 1, 'the job fails');
  assert.deepEqual(host.of('team.node.fail').map((call) => call.params.reason), ['engine_error']);
});

// ------------------------------------------------------------------ H12: pause

const pausesOf = (host) => host.of('team.node.pause').map((call) => call.params);

test('H12: a manually paused node keeps telling the host at the heartbeat interval', async (t) => {
  const { agent, host, timers } = await setup(t, { heartbeatMs: 10_000 });
  await agent.start();
  assert.equal((await agent.pause({ on: true })).ok, true);
  await timers.advance(35_000);
  const beats = host.of('team.node.pause');
  assert.ok(beats.length >= 4, `one pause and a heartbeat each 10 s (got ${beats.length})`);
  for (const beat of beats) assert.deepEqual(beat.params, { on: true, stop_running: false });
  const gap = beats[3].at - beats[2].at;
  assert.ok(gap >= 9_000 && gap <= 11_000, `at the heartbeat interval (got ${gap} ms)`);
  assert.equal((await agent.pause({ on: false })).ok, true);
  const count = host.of('team.node.pause').length;
  await timers.advance(35_000);
  assert.equal(host.of('team.node.pause').length, count, 'no heartbeat once resumed');
  assert.deepEqual(pausesOf(host).at(-1), { on: false });
});

test('H12: a pause send the host did not take is tried again, not forgotten', async (t) => {
  const { agent, host, timers } = await setup(t, { heartbeatMs: 10_000 });
  await agent.start();
  host.script['team.node.pause'] = ['reset'];
  await agent.pause({ on: true });
  assert.equal(host.of('team.node.pause').length, 1);
  await timers.advance(6_000);
  assert.equal(host.of('team.node.pause').length, 2, 'asked again soon after the lost answer');
});

test('H12: a resume the host did not take is sent again until it does', async (t) => {
  const { agent, host, timers } = await setup(t, { heartbeatMs: 10_000 });
  await agent.start();
  await agent.pause({ on: true });
  host.script['team.node.pause'] = ['reset', failure('CMP-HOST-0001', 'node_rate_limit')];
  await agent.pause({ on: false });
  await timers.advance(30_000);
  const lifts = pausesOf(host).filter((params) => params.on === false);
  assert.equal(lifts.length, 3, 'two sends the host did not take, then one it did');
  const after = host.of('team.node.pause').length;
  await timers.advance(30_000);
  assert.equal(host.of('team.node.pause').length, after, 'nothing more once the host took it');
});

test('H12: a Resume clicked while Pause is stopping jobs wins; the pause is never sent after it', async (t) => {
  const { agent, host, engine, timers } = await setup(t);
  engine.handle = (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(sse('first')); };
  await agent.start();
  const { descriptor } = host.queueJob();
  await drive(timers, () => host.chunks.some((chunk) => chunk.jobId === descriptor.job_id), 'the first chunk');
  let release;
  host.script['team.node.fail'] = [() => new Promise((resolve) => { release = () => resolve({ ok: true }); })];
  const pausing = agent.pause({ on: true, stopRunning: true });
  await until(() => host.of('team.node.fail').length === 1, 'the stop is under way');
  assert.equal((await agent.pause({ on: false })).ok, true, 'Resume is taken while the stop runs');
  release();
  await pausing;
  await timers.advance(40_000);
  assert.equal(agent.status().state, 'idle');
  assert.deepEqual(pausesOf(host).filter((params) => params.on === true), [], 'no pause reaches the host after the Resume');
  assert.deepEqual(pausesOf(host).at(-1), { on: false });
});

// ------------------------------------------------------------------ H12: the claim wait

for (const [heartbeatMs, waitMs] of [[5_000, 5_000], [60_000, 25_000]]) {
  test(`H12: a ${heartbeatMs} ms heartbeat gives a claim wait of ${waitMs} ms`, async (t) => {
    const { agent, host, timers } = await setup(t, { heartbeatMs });
    await agent.start();
    await drive(timers, () => host.of('team.node.claim').length >= 1, 'a claim');
    assert.equal(host.of('team.node.claim')[0].params.wait_ms, waitMs);
  });
}

// ------------------------------------------------------------------ context_length

test('context_length: a row keeps the length the engine reports under its usual names', async () => {
  const rows = [{ id: 'a', context_length: 8192 }, { id: 'b', meta: { n_ctx: 4096 } }, { id: 'c', max_model_len: 32768 },
    { id: 'd', context_window: 16384 }, { id: 'e', max_context_length: 65536 }, { id: 'f' }];
  const engine = { call: async () => ({ status: 200, body: streamOf({ data: rows }) }) };
  const read = await readModels({ engine, target: {}, timers: createManualTimers() });
  assert.deepEqual(read.models.map((entry) => entry.context_length), [8192, 4096, 32768, 16384, 65536, null]);
});

test('context_length: the length the member\'s Jenny reports for a model is registered when the engine names none', async (t) => {
  const caps = new Map([['alpha', { vision: false, thinking: true, context_length: 131072 }]]);
  const { agent, host } = await setup(t, { readCapabilities: () => caps });
  await agent.start();
  const [model] = host.of('team.node.register')[0].params.models;
  assert.deepEqual([model.name, model.context_length, model.thinking], ['alpha', 131072, true]);
});

test('context_length: the engine\'s own length wins over the member\'s Jenny\'s', async (t) => {
  const caps = new Map([['alpha', { vision: false, thinking: false, context_length: 131072 }]]);
  const { agent, host } = await setup(t, { readCapabilities: () => caps, engineFor: () => {
    const base = createEngineClient();
    return { openRequests: base.openRequests, call: (options) => (options.path === '/v1/models'
      ? Promise.resolve({ status: 200, body: streamOf({ data: [{ id: 'alpha', context_length: 8192 }] }) }) : base.call(options)) };
  } });
  await agent.start();
  assert.equal(host.of('team.node.register')[0].params.models[0].context_length, 8192);
});
