'use strict';

// Row 123 slice 4c agent: the member's node agent (services/team/node/) against a fake
// team host behind its link, a scripted SSE engine on a real loopback socket and
// manual timers. No team host, no GPU, no model, no window.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const nodeTest = require('node:test');

const { createPoolScheduler } = require('../server/team/scheduler');
const { NODE_PROTOCOL_VERSION, STATE_TRANSITIONS, createNodeAgent, nextState } = require('../services/team/node/node-agent');
const { JOB_TRANSITIONS, checkEngineUrl, nextJobState } = require('../services/team/node/engine-forward');
const { NODE_PROTOCOL_VERSION: HOST_VERSION } = require('../server/team/node-commands');
const {
  DONE, MARKER, createFakeHost, createLogs, createManualTimers, failure, flush, requestBody, sse, startEngine, until,
} = require('./helpers/team-node-agent-fixture');

const test = (name, fn) => nodeTest(name, { timeout: 30_000 }, fn);

async function setup(t, { slots = 1, url = null, isBusy = () => false, now = null, protocolVersion, heartbeatMs } = {}) {
  const timers = createManualTimers();
  const host = createFakeHost({ timers, ...(heartbeatMs ? { heartbeatMs } : {}) });
  const engine = await startEngine(t);
  const logs = createLogs();
  const agent = createNodeAgent({ link: host.link, resolveEngineUrl: () => url || engine.url, isBusy, slots,
    timers, now: now || timers.now, clock: timers.now, logger: logs.logger,
    ...(protocolVersion === undefined ? {} : { protocolVersion }) });
  t.after(() => agent.dispose());
  return { timers, host, engine, logs, agent };
}

// Advances manual time in steps until `predicate` holds.
async function drive(timers, predicate, label, step = 125, steps = 4000) {
  for (let i = 0; i < steps; i += 1) {
    if (predicate()) return;
    await timers.advance(step);
  }
  throw new Error(`not reached: ${label}`);
}

const reasonsOf = (host) => host.of('team.node.fail').map((call) => call.params.reason);
const jobChunks = (host, jobId) => host.chunks.filter((chunk) => chunk.jobId === jobId);
// An engine that answers the head and one delta, then waits for the test.
const holdAfterOne = (engine) => {
  const held = [];
  engine.handle = (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(sse('first')); held.push(res); };
  return held;
};

// ------------------------------------------------------------------ the tables

const STATES = ['off', 'starting', 'idle', 'busy_own', 'paused', 'stopping'];
const EVENTS = ['start', 'registered', 'final', 'busy', 'free', 'pause', 'resume', 'stop', 'stopped'];
const EXPECTED = {
  off: { start: 'starting' },
  starting: { registered: 'idle', final: 'off', stop: 'stopping' },
  idle: { busy: 'busy_own', pause: 'paused', stop: 'stopping', final: 'stopping' },
  busy_own: { free: 'idle', pause: 'paused', stop: 'stopping', final: 'stopping' },
  paused: { pause: 'paused', resume: 'idle', stop: 'stopping', final: 'stopping' },
  stopping: { stopped: 'off' },
};

test('the state table: every listed transition and nothing else', () => {
  assert.deepEqual(Object.keys(STATE_TRANSITIONS).sort(), [...STATES].sort());
  for (const state of STATES) {
    for (const event of EVENTS) assert.equal(nextState(state, event), EXPECTED[state][event] ?? null, `${state} + ${event}`);
  }
  assert.equal(nextState('nowhere', 'start'), null);
  const jobStates = ['fetching', 'forwarding', 'done', 'failed', 'cancelled', 'stopped'];
  const jobExpected = { fetching: ['forwarding', 'failed', 'cancelled', 'stopped'], forwarding: ['done', 'failed', 'cancelled', 'stopped'] };
  assert.deepEqual(Object.keys(JOB_TRANSITIONS).sort(), ['fetching', 'forwarding']);
  for (const from of jobStates) {
    for (const to of jobStates) assert.equal(nextJobState(from, to), (jobExpected[from] || []).includes(to) ? to : null, `${from} -> ${to}`);
  }
});

test('refused calls change nothing: a second start, pause or stop when off, resume when not paused', async (t) => {
  const { agent, host } = await setup(t);
  for (const call of [() => agent.pause({ on: true }), () => agent.pause({ on: false }), () => agent.stop()]) {
    assert.deepEqual(await call(), { ok: false, reason: 'node_agent_state' });
    assert.equal(agent.status().state, 'off');
  }
  assert.equal((await agent.start()).ok, true);
  assert.equal(agent.status().state, 'idle');
  assert.deepEqual(await agent.start(), { ok: false, reason: 'node_agent_running' });
  assert.deepEqual(await agent.pause({ on: false }), { ok: false, reason: 'node_agent_state' });
  assert.equal(agent.status().state, 'idle');
  assert.equal(host.of('team.node.register').length, 1, 'one team at a time');
  assert.equal(NODE_PROTOCOL_VERSION, HOST_VERSION, 'the agent and the host speak the same version');
});

// ------------------------------------------------------------------ register

// Live run 2026-11-16: every shared model registered with no thinking and no vision, so a team conversation never
// offered Thinking and the host dropped every turn's effort. The member's own model list names both.
async function capsAgent(t, readCapabilities) {
  const timers = createManualTimers();
  const host = createFakeHost({ timers });
  const engine = await startEngine(t, { models: ['alpha', 'beta'] });
  const agent = createNodeAgent({ link: host.link, resolveEngineUrl: () => engine.url, isBusy: () => false, timers,
    now: timers.now, clock: timers.now, readCapabilities });
  t.after(() => agent.dispose());
  return { timers, host, agent };
}
const registered = (host) => host.of('team.node.register')[0].params.models;

test('register carries what the member\'s Jenny says each model can do; an unnamed model stays off', async (t) => {
  const { host, agent } = await capsAgent(t, async () => new Map([['alpha', { vision: true, thinking: true }],
    ['gamma', { vision: true, thinking: true }], ['beta', { vision: 'yes', thinking: 1 }]]));
  assert.equal((await agent.start()).ok, true);
  assert.deepEqual(registered(host).map(({ name, vision, thinking }) => ({ name, vision, thinking })),
    [{ name: 'alpha', vision: true, thinking: true }, { name: 'beta', vision: false, thinking: false }]);
});

test('a capabilities read that throws, answers junk or hangs registers every model with no vision or thinking', async (t) => {
  for (const reader of [async () => { throw new Error('sidecar'); }, async () => 'junk', () => { throw new Error('sync'); }]) {
    const { host, agent } = await capsAgent(t, reader);
    assert.equal((await agent.start()).ok, true);
    assert.ok(registered(host).every((m) => m.vision === false && m.thinking === false));
  }
  const { host, agent, timers } = await capsAgent(t, () => new Promise(() => {}));
  const started = agent.start();
  await drive(timers, () => host.of('team.node.register').length === 1, 'register after the bound', 250, 40);
  assert.equal((await started).ok, true);
  assert.ok(registered(host).every((m) => m.vision === false && m.thinking === false));
});

test('a version mismatch is final; another refusal is retried with backoff', async (t) => {
  const first = await setup(t, { protocolVersion: 2 });
  assert.deepEqual(await first.agent.start(), { ok: false, reason: 'node_version_mismatch' });
  assert.deepEqual([first.agent.status().state, first.agent.status().reason], ['off', 'node_version_mismatch']);
  await first.timers.advance(10 * 60_000);
  assert.equal(first.host.of('team.node.register').length, 1, 'never retried');

  const second = await setup(t);
  second.host.script['team.node.register'] = [failure('CMP-HOST-0005', 'team_pool_unavailable')];
  const started = second.agent.start();
  await until(() => second.host.of('team.node.register').length === 1, 'the first register');
  await flush();
  assert.equal(second.agent.status().state, 'starting');
  await second.timers.advance(1_000);
  assert.equal((await started).ok, true);
  assert.equal(second.host.of('team.node.register').length, 2);
  const [call] = second.host.of('team.node.register');
  assert.deepEqual([call.params.protocol_version, call.params.slots, call.params.models.map((entry) => entry.name)],
    [1, 1, ['alpha']]);
});

test('a non-loopback, an https, a credentialed or a rewritten URL never registers', async (t) => {
  for (const url of ['http://10.0.0.5:8080', 'https://127.0.0.1:8080', 'http://user:pass@127.0.0.1:8080',
    'http://127.1:8080', 'http://127.0.0.1', 'http://127.0.0.1:8080/api', 'http://localhost.example:80', '']) {
    assert.equal(checkEngineUrl(url).ok, false, url);
    const { agent, host, engine } = await setup(t, { url: url || ' ' });
    assert.deepEqual(await agent.start(), { ok: false, reason: 'node_engine_not_local' });
    assert.equal(agent.status().state, 'off');
    assert.deepEqual([host.calls.length, engine.requests.length], [0, 0], url);
  }
  for (const url of ['http://127.0.0.1:8080', 'http://[::1]:8080/v1', 'http://localhost:11434/']) {
    assert.equal(checkEngineUrl(url).ok, true, url);
  }
  assert.deepEqual(checkEngineUrl('http://localhost:1234'), { ok: true, host: '127.0.0.1', port: 1234 },
    'localhost never reaches the system resolver');
  assert.throws(() => createNodeAgent({ link: createFakeHost({ timers: createManualTimers() }).link,
    resolveEngineUrl: () => 'http://127.0.0.1:1' }), TypeError, 'isBusy is required');
});

// ------------------------------------------------------------------ claims

test('no claim while the member\'s own turn runs; claims resume after', async (t) => {
  let busy = true;
  const { agent, host, timers } = await setup(t, { isBusy: () => busy });
  await agent.start();
  await timers.advance(5_000);
  assert.deepEqual([host.of('team.node.claim').length, agent.status().state], [0, 'busy_own']);
  busy = false;
  await drive(timers, () => host.of('team.node.claim').length === 1, 'a claim');
  assert.equal(agent.status().state, 'idle');
  assert.equal(host.of('team.node.claim')[0].params.wait_ms, 10_000, 'the wait is capped by the host heartbeat (H12)');
});

test('the claim sequence starts past an earlier run\'s and a lost answer repeats its number', async (t) => {
  const first = await setup(t, { now: () => 1_000 });
  first.host.script['team.node.claim'] = ['reset'];
  await first.agent.start();
  const job = first.host.queueJob();
  await drive(first.timers, () => first.host.of('team.node.claim').length >= 2, 'the retried claim');
  const seqs = first.host.of('team.node.claim').map((call) => call.params.claim_seq);
  assert.deepEqual(seqs.slice(0, 2), [1_000, 1_000], 'the lost claim is asked again under its number');
  await drive(first.timers, () => first.host.of('request').length === 1, 'the job is read');
  assert.equal(first.host.of('request')[0].jobId, job.descriptor.job_id, 'the replayed claim answered the same job');
  await first.agent.stop();
  const before = first.host.of('team.node.claim').length;
  const used = Math.max(...first.host.of('team.node.claim').map((call) => call.params.claim_seq));
  await first.agent.start(); // the same wall clock: only the numbers already used move it on
  await drive(first.timers, () => first.host.of('team.node.claim').length > before, 'the next run claims');
  assert.ok(first.host.of('team.node.claim')[before].params.claim_seq > used);
});

// ------------------------------------------------------------------ one job

test('a job relays every engine byte in order, ends with one final chunk and keeps the pacing', async (t) => {
  const { agent, host, engine, timers, logs } = await setup(t);
  const reply = Buffer.concat([sse(`${MARKER} one`), sse('two'), sse('three'), DONE]);
  engine.handle = (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(reply); };
  await agent.start();
  const request = requestBody(' hello');
  const { descriptor } = host.queueJob(request);
  const job = host.jobs.get(descriptor.job_id);
  await drive(timers, () => job.state === 'done', 'the job is done');
  assert.deepEqual(Buffer.concat(job.received), reply);
  const chunks = jobChunks(host, descriptor.job_id);
  assert.deepEqual(chunks.filter((chunk) => chunk.final).length, 1);
  assert.equal(chunks[chunks.length - 1].final, true);
  for (let i = 1; i < chunks.length; i += 1) assert.ok(chunks[i].at - chunks[i - 1].at >= 125, 'at most 8 a second');
  const [chat] = engine.chats();
  assert.deepEqual(chat.body, request, 'the request is forwarded unchanged');
  assert.deepEqual(Object.keys(chat.headers).sort(), ['accept', 'connection', 'content-length', 'content-type', 'host']);
  assert.equal(chat.method, 'POST');
  assert.equal(reasonsOf(host).length, 0);
  assert.equal(logs.text().includes(MARKER), false, 'no prompt or reply text in a log line');
  assert.equal(JSON.stringify(agent.status()).includes(MARKER), false);
  assert.equal(JSON.stringify(agent.status()).includes('127.0.0.1'), false, 'no engine address in status');
});

for (const [label, overrides, engineScript, settle] of [
  ['no first byte', { first_byte_ms: 5_000 }, () => {}, 5_000],
  ['a stall', { stall_ms: 3_000 }, 'one', 3_000],
  ['the total time', { total_ms: 4_000, stall_ms: 600_000 }, 'one', 4_000],
]) {
  test(`${label} aborts the engine request and sends exactly one engine_timeout`, async (t) => {
    const { agent, host, engine, timers } = await setup(t);
    if (engineScript === 'one') holdAfterOne(engine); else engine.handle = engineScript;
    await agent.start();
    const { descriptor } = host.queueJob(requestBody(), overrides);
    await until(() => engine.chats().length === 1, 'the engine is asked');
    if (engineScript === 'one') await drive(timers, () => jobChunks(host, descriptor.job_id).length > 0, 'the first chunk');
    await timers.advance(settle);
    await until(() => reasonsOf(host).length === 1 && engine.chats()[0].closedEarly, 'failed and aborted');
    await timers.advance(5_000);
    assert.deepEqual(reasonsOf(host), ['engine_timeout']);
    assert.equal(engine.chats().length, 1, 'never asked again');
  });
}

test('cancel in a chunk answer aborts the engine request and nothing more is sent', async (t) => {
  const { agent, host, engine, timers } = await setup(t);
  const held = holdAfterOne(engine);
  await agent.start();
  const { descriptor } = host.queueJob();
  await drive(timers, () => jobChunks(host, descriptor.job_id).length === 1, 'the first chunk');
  host.cancel(descriptor.job_id);
  held[0].write(sse('second'));
  await drive(timers, () => engine.chats()[0].closedEarly, 'the engine request is aborted');
  const sent = jobChunks(host, descriptor.job_id).length;
  await timers.advance(30_000);
  assert.equal(jobChunks(host, descriptor.job_id).length, sent);
  assert.equal(reasonsOf(host).length, 0, 'a cancelled job is not failed');
});

test('a silent job sends an empty chunk each heartbeat; a redirect fails the job', async (t) => {
  const { agent, host, engine, timers } = await setup(t, { heartbeatMs: 4_000 });
  engine.handle = () => {};
  await agent.start();
  const { descriptor } = host.queueJob();
  await until(() => engine.chats().length === 1, 'the engine is asked');
  await timers.advance(4_000);
  const pings = jobChunks(host, descriptor.job_id);
  assert.ok(pings.length >= 1 && pings.every((chunk) => chunk.bytes.length === 0 && !chunk.final), 'a ping');

  const other = await setup(t);
  other.engine.handle = (req, res) => { res.writeHead(302, { Location: `${other.engine.url}/v1/chat/completions` }); res.end(); };
  await other.agent.start();
  other.host.queueJob();
  await drive(other.timers, () => reasonsOf(other.host).length === 1, 'the job fails');
  assert.deepEqual([reasonsOf(other.host), other.engine.chats().length], [['engine_error'], 1]);
});

// ------------------------------------------------------------------ pause and stop

test('pause lets the running job finish and claims nothing more', async (t) => {
  const { agent, host, engine, timers } = await setup(t);
  const held = holdAfterOne(engine);
  await agent.start();
  const { descriptor } = host.queueJob();
  await drive(timers, () => jobChunks(host, descriptor.job_id).length === 1, 'the first chunk');
  assert.equal((await agent.pause({ on: true })).ok, true);
  assert.deepEqual(host.of('team.node.pause').map((call) => call.params), [{ on: true, stop_running: false }]);
  held[0].end(Buffer.concat([sse('rest'), DONE]));
  await drive(timers, () => host.jobs.get(descriptor.job_id).state === 'done', 'the job finishes');
  const claims = host.of('team.node.claim').length;
  host.queueJob();
  await timers.advance(60_000);
  assert.equal(host.of('team.node.claim').length, claims, 'no claim while paused');
  assert.equal((await agent.pause({ on: false })).ok, true);
  await drive(timers, () => host.of('team.node.claim').length > claims, 'claims again');
});

for (const label of ['pause with stopRunning', 'stop']) {
  test(`${label} ends the running job with user_stopped_sharing`, async (t) => {
    const { agent, host, engine, timers } = await setup(t);
    holdAfterOne(engine);
    await agent.start();
    const { descriptor } = host.queueJob();
    await drive(timers, () => jobChunks(host, descriptor.job_id).length === 1, 'the first chunk');
    const answer = label === 'stop' ? await agent.stop() : await agent.pause({ on: true, stopRunning: true });
    assert.equal(answer.ok, true);
    assert.deepEqual(reasonsOf(host), ['user_stopped_sharing']);
    await until(() => engine.chats()[0].closedEarly, 'the engine request is aborted');
    if (label === 'stop') {
      assert.deepEqual([agent.status().state, host.of('team.node.unregister').length], ['off', 1]);
    } else {
      assert.deepEqual(host.of('team.node.pause').map((call) => call.params), [{ on: true, stop_running: true }]);
    }
  });
}

for (const label of ['stop', 'dispose']) {
  test(`after ${label} nothing is left: no timer, socket, team call or engine request`, async (t) => {
    const { agent, host, engine, timers } = await setup(t, { slots: 2 });
    holdAfterOne(engine);
    await agent.start();
    host.queueJob();
    await until(() => engine.chats().length === 1, 'one job runs');
    await drive(timers, () => host.waiting() === 1, 'one claim waits');
    if (label === 'stop') await agent.stop(); else agent.dispose();
    await until(() => engine.openSockets() === 0, 'the engine socket closed');
    await flush();
    assert.equal(agent.status().state, 'off');
    assert.deepEqual(agent.resources(), { timers: 0, sleepers: 0, teamCalls: 0, engineRequests: 0 });
    assert.equal(agent.status().jobs, 0);
    assert.deepEqual([timers.pending(), host.inflight(), host.waiting()], [0, 0, 0]);
    assert.equal(host.of('team.node.unregister').length, label === 'stop' ? 1 : 0);
    const calls = host.calls.length;
    await timers.advance(120_000);
    assert.equal(host.calls.length, calls, 'nothing writes later');
  });
}

// ------------------------------------------------------------------ refusals and races

const NOT_FOUND = failure('CMP-HOST-0003', 'node_not_found');
test('node_not_found re-registers once after a pause, then claims again', async (t) => {
  const { agent, host, timers } = await setup(t);
  host.script['team.node.claim'] = [NOT_FOUND];
  await agent.start();
  await drive(timers, () => host.of('team.node.claim').length === 2, 'the claim after the re-register');
  const [first, second] = host.of('team.node.claim');
  assert.equal(host.of('team.node.register').length, 2, 'one re-register');
  assert.ok(second.at - first.at >= 1_000, 'a pause before claiming again');
  assert.equal(agent.status().state, 'idle');
});

for (const word of ['member_revoked', 'role_forbidden']) {
  test(`${word} on a claim ends sharing and nothing more is sent`, async (t) => {
    const { agent, host, timers } = await setup(t);
    host.script['team.node.claim'] = [failure('CMP-HOST-0003', word)];
    await agent.start();
    await drive(timers, () => agent.status().state === 'off', 'sharing ended');
    assert.equal(agent.status().reason, word);
    const calls = host.calls.length;
    await timers.advance(120_000);
    assert.equal(host.calls.length, calls);
  });
}

test('job_not_found on a chunk ends the job as cancelled with no fail', async (t) => {
  const { agent, host, engine, timers, logs } = await setup(t);
  holdAfterOne(engine);
  host.script.chunk = [failure('CMP-HOST-0003', 'job_not_found')];
  await agent.start();
  host.queueJob();
  await drive(timers, () => engine.chats()[0]?.closedEarly === true, 'the engine request is aborted');
  const ended = logs.lines.find((line) => line.event === 'team.node.job_ended');
  assert.deepEqual([ended.fields.state, reasonsOf(host).length], ['cancelled', 0]);
});

test('node_rate_limit on the request read waits, then reads', async (t) => {
  const { agent, host, timers } = await setup(t);
  host.script.request = [failure('CMP-HOST-0007', 'node_rate_limit')];
  await agent.start();
  const job = host.queueJob();
  await drive(timers, () => job.state === 'done', 'the job is done');
  const reads = host.of('request');
  assert.equal(reads.length, 2);
  assert.ok(reads[1].at - reads[0].at >= 2_000, 'it waited');
  assert.equal(reasonsOf(host).length, 0);
});

test('a host reason that is not a word never reaches status, the start answer or a log', async (t) => {
  const evil = `bad\n${'x'.repeat(1_000)}`;
  const { agent, host, logs } = await setup(t);
  host.script['team.node.register'] = [failure('CMP-HOST-0005', evil)];
  const started = agent.start();
  await until(() => host.of('team.node.register').length === 1, 'the first register');
  await flush();
  assert.equal(agent.status().reason, 'team_refused');
  await agent.stop();
  assert.equal((await started).reason.includes('xxx'), false);
  const other = await setup(t);
  holdAfterOne(other.engine);
  other.host.script.chunk = [failure('CMP-HOST-0001', evil)];
  await other.agent.start();
  other.host.queueJob();
  await drive(other.timers, () => reasonsOf(other.host).length === 1, 'the job fails');
  for (const text of [logs.text(), other.logs.text(), JSON.stringify(other.agent.status())]) {
    assert.equal(text.includes('xxx') || text.includes('bad\\n'), false);
  }
});

for (const label of ['isBusy turned true', 'pause with stopRunning']) {
  test(`a claim answered with a job after ${label} runs nothing on the engine`, async (t) => {
    let busy = false;
    const { agent, host, engine, timers } = await setup(t, { isBusy: () => busy });
    await agent.start();
    await drive(timers, () => host.waiting() === 1, 'a claim waits at the host');
    if (label === 'pause with stopRunning') await agent.pause({ on: true, stopRunning: true }); else busy = true;
    const job = host.queueJob();
    await drive(timers, () => reasonsOf(host).length === 1, 'the job is given back');
    await timers.advance(10_000);
    // R16-F02: a give-back for the member's own work says so (node_busy excludes nothing at the host).
    const word = label === 'isBusy turned true' ? 'node_busy' : 'user_stopped_sharing';
    assert.deepEqual([reasonsOf(host), job.state], [[word], 'failed']);
    assert.deepEqual([host.of('request').length, engine.chats().length], [0, 0]);
  });
}

test('R16-F01: a body naming another model in any case, twice, or none, never reaches the engine', async (t) => {
  const { agent, host, engine, timers } = await setup(t);
  await agent.start();
  const tail = '"stream":true,"messages":[{"role":"user","content":"hi"}]';
  for (const text of [`{"model":"alpha","Model":"gpt-oss:120b-cloud",${tail}}`, `{"model":"alpha","MODEL":"beta",${tail}}`,
    `{"model":"alpha",${tail},"model":"alpha"}`, `{"model":"alpha","\\u004dodel":"x:cloud",${tail}}`,
    `{"model":"beta",${tail}}`, `{${tail}}`, `["alpha"]`]) {
    const job = host.queueJob(Buffer.from(text));
    await drive(timers, () => job.state === 'failed', text);
    assert.equal(job.reason, 'model_not_loaded', text);
  }
  const reads = host.of('request').length;
  const foreign = host.queueJob(Buffer.from(`{"model":"beta",${tail}}`), { model: 'beta' });
  await drive(timers, () => foreign.state === 'failed', 'a model this PC did not offer');
  assert.deepEqual([foreign.reason, host.of('request').length], ['model_not_loaded', reads], 'refused before the read');
  assert.equal(engine.chats().length, 0, 'the engine received nothing');
});

test('C5: a body the host would not have forwarded (a dropped key, a capital inside messages, n above 1) is not run here', async (t) => {
  const { agent, host, engine, timers } = await setup(t);
  await agent.start();
  const msg = '"messages":[{"role":"user","content":"hi"}]';
  for (const text of [`{"model":"alpha",${msg},"keep_alive":0}`, `{"model":"alpha",${msg},"n":50}`,
    `{"model":"alpha","messages":[{"role":"user","content":[{"type":"image_url","Image_Url":{"url":"x"}}]}]}`]) {
    const job = host.queueJob(Buffer.from(text));
    await drive(timers, () => job.state === 'failed', text);
    assert.equal(job.reason, 'engine_error', text);
  }
  assert.equal(engine.chats().length, 0, 'the engine received nothing');
});

// The agent's link answered by a real pool scheduler in process (node-commands.js without the long poll).
function schedulerLink(scheduler, pauses = []) {
  const deviceId = 'device_node1';
  return {
    async command(operation, params) {
      if (operation === 'team.node.pause') pauses.push({ ...params });
      if (operation === 'team.node.register') {
        const done = scheduler.registerNode({ deviceId, memberId: 'member_owner', slots: params.slots,
          models: params.models.map((m) => ({ id: m.name, context_length: m.context_length, vision: m.vision, thinking: m.thinking })) });
        return done.ok ? { ok: true, node_id: done.node_id, heartbeat_ms: 10_000, expires_ms: 30_000 } : done;
      }
      const nodeId = scheduler.nodeIdForDevice(deviceId);
      if (operation === 'team.node.claim') return scheduler.claim(nodeId, params.claim_seq);
      if (operation === 'team.node.fail') return scheduler.failJob(params.job_id, nodeId, params.reason);
      if (operation === 'team.node.pause') return scheduler.setNodePaused(nodeId, { on: params.on, stopRunning: params.stop_running === true });
      return { ok: true };
    },
    async fetchRequest() { throw new Error('not used'); },
    async postChunk() { throw new Error('not used'); },
  };
}

test('R16-F02: the member\'s own chat takes this GPU out of the pool at the host, in contact, and back after', async (t) => {
  const timers = createManualTimers();
  const scheduler = createPoolScheduler({ clock: timers.now, randomBytes: crypto.randomBytes, logger: () => {} });
  const engine = await startEngine(t);
  let busy = false;
  const pauses = [];
  const agent = createNodeAgent({ link: schedulerLink(scheduler, pauses), resolveEngineUrl: () => engine.url,
    isBusy: () => busy, timers, now: timers.now, clock: timers.now });
  t.after(() => agent.dispose());
  assert.equal((await agent.start()).ok, true);
  await timers.advance(3_000);
  busy = true;
  await timers.advance(2_000);
  assert.deepEqual([agent.status().state, scheduler.listNodes()[0].paused], ['busy_own', true], 'the host is told');
  // E76: the host reads a pause that names no stop_running as "in use by its owner" (node-commands.js).
  assert.deepEqual(pauses.at(-1), { on: true }, 'the busy pause names no stop_running');
  const want = { conversationKey: 'conv:project_a:session_1', memberId: 'member_a', model: 'alpha', wantsVision: false };
  const asked = scheduler.requestLease(want);
  assert.equal(asked.ok && asked.lease.state === 'active', false, 'no turn is leased to the busy GPU');
  for (let i = 0; i < 45; i += 1) { await timers.advance(1_000); scheduler.sweep(timers.now()); }
  assert.equal(scheduler.listNodes()[0].online, true, 'a busy GPU stays in contact');
  busy = false;
  await timers.advance(3_000);
  assert.deepEqual([agent.status().state, scheduler.listNodes()[0].paused], ['idle', false]);
  const again = scheduler.requestLease(want);
  assert.deepEqual([again.ok, again.lease?.state], [true, 'active'], 'the conversation is not locked out');
});

test('an engine the agent holds at the high-water mark longer than stall_ms is not failed', async (t) => {
  const { agent, host, engine, timers } = await setup(t);
  const held = holdAfterOne(engine);
  await agent.start();
  const job = host.queueJob(requestBody(), { stall_ms: 3_000 });
  await drive(timers, () => jobChunks(host, job.descriptor.job_id).length === 1, 'the first chunk');
  const open = host.hold();
  await timers.advance(125);
  held[0].write(Buffer.alloc(512 * 1024, 0x61)); // past the high-water mark while a chunk answer waits
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  await timers.advance(10_000);
  assert.equal(reasonsOf(host).length, 0, 'no stall while the agent holds the engine');
  open();
  held[0].end(DONE);
  await drive(timers, () => job.state === 'done', 'the job finishes');
  assert.equal(reasonsOf(host).length, 0);
});
