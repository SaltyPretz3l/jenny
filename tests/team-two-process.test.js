'use strict';

// Row 123 slice 4c agent: the two-process test on one machine. A real team host with
// a pool block in this process; a real node agent in a child process with its own
// scripted SSE engine; the member's link goes through a bridge stand-in to the team
// listener over loopback. A turn enters through the pool gateway as the host's sidecar
// would send it. No bridge binary, no GPU, no model, no window.

const assert = require('node:assert/strict');
const nodeTest = require('node:test');

const { chatTurn, gatewayChat, message, startTwoProcess, until } = require('./helpers/team-node-two-process');

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const MARKER = 'MARKER_two_process_9e4b';
const MIB = 1024 * 1024;

async function onlineNode(h) {
  await until(() => h.m.scheduler.listNodes().some((node) => node.online), 'the agent\'s node is online', 20_000);
  const [node] = h.m.scheduler.listNodes();
  assert.equal(node.device_id, h.seats.member.device_id, 'the node is the member\'s device');
  return node;
}

async function engineLog(h, predicate, label) {
  for (let i = 0; i < 400; i += 1) {
    const { engine } = await h.agent.send('status');
    if (predicate(engine)) return engine;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error(`not reached: ${label}`);
}

test('a streamed turn goes through the pool gateway to the member\'s engine and back', async (t) => {
  const h = await startTwoProcess(t, { script: { marker: MARKER } });
  assert.deepEqual([h.started.ok, h.started.started.ok, h.started.status.state], [true, true, 'idle'], JSON.stringify(h.started));
  await onlineNode(h);
  const turn = await h.m.pool.turnRoute.acquire(chatTurn(h.seats.owner, 'session_general_1'));
  const chat = gatewayChat(h.m, turn.token, message(`${MARKER} hello`));
  await until(() => chat.state.ended, 'the answer ends', 20_000);
  turn.release({ ok: true });
  assert.equal(chat.state.status, 200);
  for (const part of ['one ', 'two ', `three ${MARKER}`, '[DONE]']) assert.ok(chat.state.text.includes(part), part);
  const engine = await engineLog(h, (log) => log.length > 0, 'the engine saw the request');
  assert.deepEqual(engine.map((entry) => [entry.event, entry.marker]), [['request', true]]);
  const [job] = h.m.scheduler.listJobs();
  assert.equal(job.state, 'done');
  const stopped = await h.agent.send('stop');
  assert.equal(stopped.status.state, 'off');
  await until(() => h.m.scheduler.listNodes().length === 0, 'the node is unregistered');
});

test('a cancel on the gateway side reaches the engine: its request is aborted', async (t) => {
  const h = await startTwoProcess(t, { script: { mode: 'hold' } });
  await onlineNode(h);
  const turn = await h.m.pool.turnRoute.acquire(chatTurn(h.seats.owner, 'session_general_1'));
  const chat = gatewayChat(h.m, turn.token, message('hold on'));
  await until(() => chat.state.text.includes('first'), 'the first delta reaches the gateway', 20_000);
  chat.request.destroy();
  await until(() => h.m.scheduler.listJobs().some((job) => job.state === 'cancelled'), 'the job is cancelled');
  await h.agent.send('write', { text: 'second' });
  const engine = await engineLog(h, (log) => log.some((entry) => entry.event === 'aborted'), 'the engine request is aborted');
  assert.deepEqual(engine.map((entry) => entry.event), ['request', 'aborted']);
  turn.release({ ok: false });
});

test('a request just under 8 MiB reaches the engine whole', async (t) => {
  const h = await startTwoProcess(t, { script: { marker: MARKER } });
  await onlineNode(h);
  const turn = await h.m.pool.turnRoute.acquire(chatTurn(h.seats.owner, 'session_general_1'));
  const body = message(`${MARKER}${'x'.repeat(8 * MIB - 4096)}`);
  const size = Buffer.byteLength(JSON.stringify(body));
  assert.ok(size < 8 * MIB);
  const chat = gatewayChat(h.m, turn.token, body);
  await until(() => chat.state.ended, 'the answer ends', 40_000);
  turn.release({ ok: true });
  assert.equal(chat.state.status, 200);
  assert.ok(chat.state.text.includes('[DONE]'));
  const [entry] = await engineLog(h, (log) => log.length > 0, 'the engine saw the request');
  assert.equal(entry.marker, true);
  assert.ok(entry.bytes > 8 * MIB - 8192 && entry.bytes < 8 * MIB, String(entry.bytes));
});

test('a mismatched protocol_version registers nothing', async (t) => {
  const h = await startTwoProcess(t, { protocolVersion: 2 });
  assert.equal(h.started.ok, true, JSON.stringify(h.started));
  assert.deepEqual(h.started.started, { ok: false, reason: 'node_version_mismatch' });
  assert.deepEqual([h.started.status.state, h.started.status.reason], ['off', 'node_version_mismatch']);
  assert.deepEqual(h.m.scheduler.listNodes(), []);
});
