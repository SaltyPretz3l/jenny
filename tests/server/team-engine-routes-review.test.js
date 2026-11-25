'use strict';

// new-test-file: team-engine-routes.test.js sits at 586 lines; these are the adversarial-review fixes (C5, H6, H14)
// for the same routes, over the same loopback fixture.
//
// C5: the body a node reads is rebuilt from a lowercase allowlist; a case variant of an allowed key is refused.
// H6: a revoked member's requests end through the pool's recheck and on the keepalive tick.
// H14: a caller that closes right after `data: [DONE]` is recorded as completed, not cancelled.

const assert = require('node:assert/strict');
const nodeTest = require('node:test');

const test = (name, fn) => nodeTest(name, { timeout: 8_000 }, fn);

const {
  DONE, chatBody, createNode, delta, engineError, headersFor, openStream, send, setupEngine, sseErrorCode, waitFor,
} = require('./helpers/team-engine-fixture');

const leasesOf = (scheduler, memberId) => scheduler.listLeases().filter((lease) => lease.member_id === memberId);

// ---------------------------------------------------------------------------
// C5.

test('C5: a case variant of an allowed key is refused with 400 and nothing reaches the pool', async (t) => {
  const fx = await setupEngine(t);
  for (const raw of ['{"Stream":true,"model":"alpha","messages":[{"role":"user","content":"hi"}]}',
    '{"model":"alpha","MESSAGES":[{"role":"user","content":"hi"}]}',
    '{"model":"alpha","messages":[],"Reasoning_Effort":"high"}',
    '{"model":"alpha","messages":[],"N":50}']) {
    const answer = await send(fx.port, { headers: headersFor('member'), body: raw });
    assert.equal(answer.status, 400, raw);
    assert.equal(engineError(answer.text), 'team_request_field_invalid', raw);
  }
  assert.deepEqual(fx.scheduler.listLeases(), [], 'no lease was taken');
  assert.deepEqual(fx.scheduler.listJobs(), []);
  await waitFor(() => fx.routes.resources().requests === 0, 'requests settle');
});

test('C5: the node reads a rebuilt body: engine knobs and unknown keys are dropped, n is 1, fields keep their values', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }];
  const stream = openStream(fx.port, { headers: headersFor('member'), body: chatBody({
    n: 50, options: { num_ctx: 1048576, num_gpu: 0 }, keep_alive: 0, slot_id: 3, lora: [{ id: 0 }], grammar: 'root ::= x',
    Options: { num_ctx: 1 }, temperature: 0.2, top_k: 40, max_tokens: 64, tools, seed: 7,
    stream_options: { include_usage: true, extra: 1 }, chat_template_kwargs: { enable_thinking: true, other: 'x' },
  }) });
  const claimed = await node.claimNext();
  assert.deepEqual(Object.keys(claimed.request).sort(), ['chat_template_kwargs', 'max_tokens', 'messages', 'model', 'n', 'seed',
    'stream', 'stream_options', 'temperature', 'tools', 'top_k'].sort());
  assert.equal(claimed.request.n, 1);
  assert.deepEqual(claimed.request.stream_options, { include_usage: true });
  assert.deepEqual(claimed.request.chat_template_kwargs, {}, 'only the thinking arguments pass, and a model that does not think drops them');
  assert.deepEqual(claimed.request.tools, tools);
  assert.equal(claimed.request.model, 'alpha');
  claimed.send(delta('ok') + DONE, true);
  await stream.until((s) => s.ended, 'stream end');
});

test('C5: a streaming flag spelled with a case variant no longer switches off the stream scan', async (t) => {
  const fx = await setupEngine(t);
  const answer = await send(fx.port, { headers: headersFor('member'),
    body: '{"model":"alpha","Stream":true,"messages":[{"role":"user","content":"hi"}]}' });
  assert.equal(answer.status, 400);
  assert.equal(fx.scheduler.listJobs().length, 0, 'no job was created with stream:false');
});

// ---------------------------------------------------------------------------
// H6.

test('H6: the pool recheck ends a revoked member\'s queued and running requests through the routes', async (t) => {
  const fx = await setupEngine(t, { limits: { commentIntervalMs: 15_000 } });
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const running = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  const claimed = await node.claimNext();
  claimed.send(delta('partial'));
  await running.until((s) => s.text.includes('partial'), 'first chunk');
  const queued = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  await waitFor(() => leasesOf(fx.scheduler, 'member_a').some((lease) => lease.state === 'queued'), 'queued lease');
  fx.directory.setState('device_a1', 'revoked');
  fx.pool.recheckLeases(); // the revocation fan-out calls this
  await running.until((s) => s.aborted || s.ended || s.closed, 'running request ends');
  await queued.until((s) => s.aborted || s.ended || s.closed, 'queued request ends');
  assert.equal(fx.scheduler.getJob(claimed.job.job_id).state, 'cancelled');
  assert.deepEqual(leasesOf(fx.scheduler, 'member_a').filter((lease) => lease.state === 'queued' || lease.state === 'active'), []);
  await waitFor(() => fx.routes.resources().requests === 0, 'requests settle');
  await waitFor(() => fx.usageRows().length === 2, 'usage rows');
  assert.deepEqual(fx.usageRows().map((row) => [row.outcome, row.reason]).sort(),
    [['cancelled', 'member_revoked'], ['cancelled', 'member_revoked']]);
});

test('H6: recheck() drops a request whose member lost the right, with no pool recheck at all', async (t) => {
  const fx = await setupEngine(t, { limits: { commentIntervalMs: 15_000 } });
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const kept = openStream(fx.port, { headers: headersFor('other'), body: chatBody() });
  const keptJob = await node.claimNext();
  const doomed = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  await waitFor(() => leasesOf(fx.scheduler, 'member_a').length === 1, 'the second request queues');
  fx.directory.setState('device_a1', 'revoked');
  assert.equal(typeof fx.routes.recheck, 'function');
  fx.routes.recheck();
  await doomed.until((s) => s.aborted || s.ended || s.closed, 'the revoked request ends');
  assert.equal(fx.scheduler.getJob(keptJob.job.job_id).state, 'claimed', 'another member\'s request is untouched');
  keptJob.send(delta('fine') + DONE, true);
  await kept.until((s) => s.ended, 'kept stream ends');
  assert.equal(kept.state.text.includes('fine'), true);
});

test('H6: a queued stream notices a revocation on its keepalive tick, not only when the lease arrives', async (t) => {
  const fx = await setupEngine(t); // commentIntervalMs is 15 ms
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const first = openStream(fx.port, { headers: headersFor('other'), body: chatBody() });
  const job = await node.claimNext();
  const second = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  await second.until((s) => s.text.includes(': keepalive'), 'queue comments');
  fx.directory.setState('device_a1', 'revoked');
  await second.until((s) => s.aborted || s.ended || s.closed, 'the tick ends the queued request');
  assert.equal(leasesOf(fx.scheduler, 'member_a').some((lease) => lease.state === 'queued' || lease.state === 'active'), false);
  assert.equal(sseErrorCode(second.state.text), null, 'the answer was cut, not completed');
  job.send(delta('one') + DONE, true);
  await first.until((s) => s.ended, 'first stream ends');
});

// ---------------------------------------------------------------------------
// H14.

test('H14: the caller closing right after [DONE] records the turn completed and releases the lease', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const stream = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  const claimed = await node.claimNext();
  claimed.send(delta('answer') + DONE); // not the final chunk: the node is still closing its side
  await stream.until((s) => s.text.includes('[DONE]'), 'the done line');
  stream.request.destroy();
  await waitFor(() => fx.usageRows().length === 1, 'usage row');
  assert.equal(fx.scheduler.getJob(claimed.job.job_id).state, 'done');
  assert.deepEqual([fx.usageRows()[0].outcome, fx.usageRows()[0].reason], ['completed', null]);
  assert.equal(leasesOf(fx.scheduler, 'member_a')[0].state, 'released');
  await waitFor(() => fx.routes.resources().requests === 0, 'requests settle');
});

test('H14: a caller that closes before [DONE] is still cancelled', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const stream = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  const claimed = await node.claimNext();
  claimed.send(delta('partial'));
  await stream.until((s) => s.text.includes('partial'), 'first chunk');
  stream.request.destroy();
  await waitFor(() => fx.usageRows().length === 1, 'usage row');
  assert.equal(fx.usageRows()[0].outcome, 'cancelled');
});
