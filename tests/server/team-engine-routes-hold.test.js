'use strict';

// An engine answer whose reader stopped stays counted against its member until it
// has flushed; each write deadline must see its waiting bytes shrink, and it may
// take only a fixed number of deadlines in all. A queued request holds its raw
// bytes, not its parsed body, and parses again once the lease is granted; one
// granted at once parses once. Real loopback sockets, the real scheduler and pool
// composition, a scripted node. No sidecar, no model, no window. In a file of its
// own because team-engine-routes.test.js is near the 600-line cap.

const assert = require('node:assert/strict');
const nodeTest = require('node:test');

// A hang fails its own test instead of the whole file.
const test = (name, fn) => nodeTest(name, { timeout: 20_000 }, fn);

const {
  DONE, chatBody, createNode, delta, engineError, headersFor, openStream, send, setupEngine, sleep, waitFor,
} = require('./helpers/team-engine-fixture');

const WRITE_IDLE_MS = 150;
const FLUSH_CEILING = 5; // the engine routes' default `maxFlushDeadlines`
const CHUNK = delta('x'.repeat(60 * 1024));

// Answers the next job for a reader that never reads: chunks until the host holds
// bytes the socket would not take, then [DONE].
async function finishUnflushed(node, response, beforeDone = () => {}) {
  const claimed = await node.claimNext();
  for (let i = 0; i < 400 && response().writableLength === 0; i += 1) {
    claimed.send(CHUNK);
    await sleep(5);
  }
  assert.ok(response().writableLength > 0, 'the host holds bytes the reader has not taken');
  beforeDone();
  claimed.send(DONE, true);
}

const settledCount = (fx) => fx.logger.calls.filter(([, event]) => event === 'team.engine.request').length;

// A paused stream answered to its end with its waiting bytes under the test's hand.
// The hand is in place before the answer ends, so no write deadline ever reads the
// real count, however late this test is scheduled. Once the request has settled
// (its log line, written in the same tick), nothing but the write deadline reads
// them, so `reads` counts deadlines. While `held.shrink` is on each read answers one
// byte fewer; otherwise the count stays.
async function heldAnswer(fx, node, who, { shrink }) {
  const index = fx.responses.length;
  const rows = fx.usageRows().length;
  const settled = settledCount(fx);
  const stream = openStream(fx.port, { headers: headersFor(who), body: chatBody(), paused: true });
  const held = { response: null, stream, reads: 0, shrink };
  await finishUnflushed(node, () => fx.responses[index], () => {
    held.response = fx.responses[index];
    let waiting = held.response.writableLength;
    Object.defineProperty(held.response, 'writableLength', { configurable: true, get() {
      if (settledCount(fx) > settled) held.reads += 1;
      if (held.shrink) waiting -= 1;
      return waiting;
    } });
  });
  await waitFor(() => fx.usageRows().length === rows + 1, 'the job completed and its lease went back');
  return held;
}

// For a test that must look at held answers before any deadline ends them: a
// draining answer lives FLUSH_CEILING of these, seconds where the checks take
// milliseconds, so a loaded machine cannot put the deadline first.
const SLOW_IDLE_MS = 1000;

const cutsOf = (fx) => fx.logger.calls.filter(([, event]) => event === 'team.engine.unflushed_destroyed')
  .map(([, , fields]) => fields);

test('a finished stream whose reader stopped stays counted, then the write-idle deadline destroys it', async (t) => {
  // Both answers keep draining until the busy answer has been seen, then stop, so
  // the deadline that frees them comes after the checks it would undo.
  const fx = await setupEngine(t, { limits: { responseWriteTimeoutMs: SLOW_IDLE_MS } });
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const held = [];
  for (let i = 0; i < 2; i += 1) held.push(await heldAnswer(fx, node, 'member', { shrink: true }));
  assert.equal(fx.routes.resources().requests, 2, 'both unflushed answers still count');
  const third = await send(fx.port, { headers: headersFor('member'), body: chatBody() });
  assert.deepEqual([third.status, engineError(third.text)], [429, 'engine_member_busy']);
  for (const answer of held) answer.shrink = false;
  await waitFor(() => fx.routes.resources().requests === 0, 'the deadline frees both', SLOW_IDLE_MS * 4);
  for (const answer of held) assert.equal(answer.response.destroyed, true);
  assert.deepEqual(cutsOf(fx).map((fields) => fields.reason ?? null), [null, null]);
  assert.deepEqual(fx.routes.resources(), { requests: 0, timers: 0, leases: 0, body_bytes: 0 });
  for (const answer of held) assert.equal(answer.stream.state.ended, false, 'never a clean end');
});

test('an answer whose waiting bytes shrink survives the deadline; one whose bytes stay is destroyed', async (t) => {
  // The stuck answer first: the draining one's ceiling then starts last, three
  // deadlines after the two this test waits for.
  const idle = WRITE_IDLE_MS * 3;
  const fx = await setupEngine(t, { limits: { responseWriteTimeoutMs: idle } });
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const stuck = await heldAnswer(fx, node, 'other', { shrink: false });
  const draining = await heldAnswer(fx, node, 'member', { shrink: true });
  await waitFor(() => stuck.response.destroyed, 'the stuck answer is destroyed', idle * 20);
  await waitFor(() => draining.reads >= 2 || draining.response.destroyed, 'two deadlines pass', idle * 20);
  assert.equal(draining.response.destroyed, false, 'bytes that keep leaving are never cut');
  assert.equal(fx.routes.resources().requests, 1, 'the draining answer still counts until it has flushed');
  assert.deepEqual(cutsOf(fx).map((fields) => fields.reason ?? null), [null]);
});

test('an answer destroyed at the deadline ceiling however its bytes move, and its place is freed', async (t) => {
  const fx = await setupEngine(t, { limits: { responseWriteTimeoutMs: WRITE_IDLE_MS } });
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const draining = await heldAnswer(fx, node, 'member', { shrink: true });
  await waitFor(() => draining.response.destroyed, 'the ceiling destroys it', WRITE_IDLE_MS * (FLUSH_CEILING + 10));
  assert.equal(draining.reads, FLUSH_CEILING, 'destroyed at the ceiling\'s deadline, not before');
  assert.deepEqual(cutsOf(fx).map((fields) => fields.reason), ['ceiling']);
  assert.deepEqual(fx.routes.resources(), { requests: 0, timers: 0, leases: 0, body_bytes: 0 });
});

// Calls of JSON.parse on this exact request text: the route's own parses.
function countParses(t, text) {
  const spy = t.mock.method(JSON, 'parse');
  return () => spy.mock.calls.filter((call) => call.arguments[0] === text).length;
}

const jobFor = (fx) => fx.scheduler.listJobs().find((job) => job.state === 'queued');

test('a queued request holds only its raw bytes while it waits and parses again once the lease is granted', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const filler = fx.scheduler.requestLease({ conversationKey: 'conv:-:filler', memberId: 'member_owner', model: 'alpha',
    wantsVision: false });
  assert.equal(filler.lease.state, 'active', 'the one slot is busy');
  const body = chatBody({ temperature: 0.5 });
  const parses = countParses(t, JSON.stringify(body));
  const waiting = openStream(fx.port, { headers: headersFor('member'), body });
  await waiting.until((state) => state.text.includes(': keepalive'), 'queued');
  assert.equal(parses(), 1, 'parsed once for admission');
  assert.equal(fx.routes.resources().body_bytes, Buffer.byteLength(JSON.stringify(body)));
  fx.scheduler.releaseLease(filler.lease.lease_id);
  await waitFor(() => jobFor(fx), 'the job');
  assert.equal(parses(), 2, 'parsed again after the lease');
  assert.equal(fx.routes.resources().body_bytes, 0, 'the raw bytes went to the job');
  const claimed = await node.claimNext();
  assert.deepEqual(claimed.request, body, 'the job gets the same body as before');
  claimed.send(delta('ok') + DONE, true);
  await waiting.until((state) => state.ended, 'the stream ends');
});

test('a request granted at once parses once and holds no body after the lease', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const body = chatBody({ temperature: 0.25 });
  const parses = countParses(t, JSON.stringify(body));
  const stream = openStream(fx.port, { headers: headersFor('member'), body });
  await waitFor(() => jobFor(fx), 'the job');
  assert.equal(parses(), 1, 'the admission parse is the one the job is built from');
  assert.equal(fx.routes.resources().body_bytes, 0);
  const claimed = await node.claimNext();
  assert.deepEqual(claimed.request, body);
  claimed.send(delta('ok') + DONE, true);
  await stream.until((state) => state.ended, 'the stream ends');
});
