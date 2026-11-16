'use strict';

// Slice 4b host core (node protocol spec "Team engine (N10)"): the two host engine
// routes over real loopback sockets, the real scheduler and pool composition, a
// scripted node and a guard from the real authorizer over a team directory
// fixture. The routes are built and tested here, not mounted on the host.

const assert = require('node:assert/strict');
const nodeTest = require('node:test');

// A hang fails its own test instead of the whole file.
const test = (name, fn) => nodeTest(name, { timeout: 15_000 }, fn);

const {
  CHAT_PATH, DONE, MODELS_PATH, chatBody, createNode, delta, engineError, headersFor, model, openHeld, openStream, send,
  setupEngine, sleep, sse, sseErrorCode, usageChunk, waitFor,
} = require('./helpers/team-engine-fixture');
const { UsageLog } = require('../../server/team/usage-log');

const MARKER = 'SECRET_MARKER_5d1e';
const ENGINE_KEY = 'K'.repeat(43);

const leasesOf = (scheduler, memberId) => scheduler.listLeases().filter((lease) => lease.member_id === memberId);
const live = (scheduler) => scheduler.listLeases().filter((lease) => lease.state === 'queued' || lease.state === 'active');

// ---------------------------------------------------------------------------
// 1. Authorization.

test('owner and member are served; every other principal, no actor and no guard are refused before the body is read', async (t) => {
  const fx = await setupEngine(t, { nodes: [{ models: [model('alpha'), model('beta')] }] });
  for (const who of ['owner', 'member']) {
    const answer = await send(fx.port, { method: 'GET', path: MODELS_PATH, headers: headersFor(who) });
    assert.equal(answer.status, 200, who);
  }
  const cases = [
    ['read_only', {}, 403, 'role_forbidden'], ['pending', {}, 403, 'member_pending'],
    ['invite', {}, 403, 'role_forbidden'], ['revoked', {}, 403, 'member_revoked'],
    ['member', { 'x-test-actor': 'none' }, 403, 'role_forbidden'],
    ['member', { 'x-test-guard': 'none' }, 403, 'role_forbidden'],
    ['member', { 'x-test-guard': 'throw' }, 403, 'role_forbidden'],
  ];
  for (const [who, extra, status, reason] of cases) {
    // The body is never sent: an answer proves the route did not wait to read it.
    const chat = await send(fx.port, { headers: headersFor(who, extra), declaredLength: 1000, holdBody: true });
    assert.equal(chat.status, status, `${who} ${JSON.stringify(extra)}`);
    assert.equal(engineError(chat.text), reason, `${who} ${JSON.stringify(extra)}`);
    const models = await send(fx.port, { method: 'GET', path: MODELS_PATH, headers: headersFor(who, extra) });
    assert.equal(models.status, status);
  }
  assert.ok(fx.guardCalls.length > 0);
  for (const call of fx.guardCalls) assert.deepEqual(call, { action: 'engine.use', resource: { kind: 'team', id: '' } });
  assert.equal(fx.scheduler.listLeases().length, 0);
  assert.deepEqual(fx.usageRows(), []);
});

test('a member revoked while queued is refused when the lease arrives and no job is created', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const first = openStream(fx.port, { headers: headersFor('other'), body: chatBody() });
  const job = await node.claimNext();
  const second = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  await second.until((s) => s.text.includes(': keepalive'), 'queue comments');
  fx.directory.setState('device_a1', 'revoked');
  job.send(delta('one') + DONE, true);
  await first.until((s) => s.ended, 'first stream ends');
  await second.until((s) => s.ended, 'second stream ends');
  assert.equal(sseErrorCode(second.state.text), 'member_revoked');
  const [lease] = leasesOf(fx.scheduler, 'member_a');
  assert.notEqual(lease.state, 'active');
  assert.equal(fx.scheduler.listJobs().filter((j) => j.lease_id === lease.lease_id).length, 0);
  await waitFor(() => fx.routes.resources().requests === 0, 'requests settle');
});

// ---------------------------------------------------------------------------
// 2, 3. Streams, usage and tool calls.

test('a stream relays every chunk in order, ends, and the usage row holds the final usage counts', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const stream = openStream(fx.port, { headers: headersFor('member', { 'x-engine-key': ENGINE_KEY }), body: chatBody() });
  const claimed = await node.claimNext();
  assert.equal(claimed.request.model, 'alpha');
  const chunks = [delta('a'), delta('b'), delta('c'), usageChunk(11, 7) + DONE];
  for (const [i, chunk] of chunks.entries()) claimed.send(chunk, i === chunks.length - 1);
  await stream.until((s) => s.ended, 'stream end');
  assert.equal(stream.state.status, 200);
  assert.equal(stream.state.headers['content-type'], 'text/event-stream');
  assert.equal(stream.state.text, chunks.join(''));
  assert.match(leasesOf(fx.scheduler, 'member_a')[0].conversation_key, /^engine:member_a:[0-9a-f]$/u);
  await waitFor(() => fx.usageRows().length === 1, 'usage row');
  const [row] = fx.usageRows();
  assert.equal(row.member_id, 'member_a');
  assert.equal(row.model, 'alpha');
  assert.equal(row.node_id, fx.nodeIds[0]);
  assert.deepEqual([row.prompt_tokens, row.completion_tokens, row.outcome, row.reason], [11, 7, 'completed', null]);
  assert.equal(leasesOf(fx.scheduler, 'member_a')[0].state, 'released');
  assert.equal(fx.admission.active, 0);
});

test('a stream without a usage chunk records null tokens', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const stream = openStream(fx.port, { headers: headersFor('owner'), body: chatBody() });
  (await node.claimNext()).send(delta('only') + DONE, true);
  await stream.until((s) => s.ended, 'stream end');
  await waitFor(() => fx.usageRows().length === 1, 'usage row');
  const [row] = fx.usageRows();
  assert.deepEqual([row.member_id, row.prompt_tokens, row.completion_tokens, row.outcome],
    ['member_owner', null, null, 'completed']);
});

test('a tool-call round trip reaches the node and returns to the caller unchanged', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object',
    properties: { path: { type: 'string' } } } } }];
  const messages = [{ role: 'user', content: 'read it' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function',
      function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'file text' }];
  const stream = openStream(fx.port, { headers: headersFor('member'), body: chatBody({ tools, messages }) });
  const claimed = await node.claimNext();
  assert.deepEqual(claimed.request.tools, tools);
  assert.deepEqual(claimed.request.messages, messages);
  const chunks = [
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_2', type: 'function',
      function: { name: 'read_file', arguments: '' } }] } }] }),
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"b.txt"}' } }] } }] }),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + DONE,
  ];
  for (const [i, chunk] of chunks.entries()) claimed.send(chunk, i === chunks.length - 1);
  await stream.until((s) => s.ended, 'stream end');
  assert.equal(stream.state.text, chunks.join(''));
});

// ---------------------------------------------------------------------------
// 4. Cancel.

test('the caller closing mid-stream cancels the job and the lease, retries nothing, and records cancelled', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const stream = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  const claimed = await node.claimNext();
  claimed.send(delta('partial'));
  await stream.until((s) => s.text.includes('partial'), 'first chunk');
  stream.request.destroy();
  await waitFor(() => fx.scheduler.getJob(claimed.job.job_id).state === 'cancelled', 'job cancelled');
  await waitFor(() => fx.usageRows().length === 1, 'usage row');
  assert.deepEqual(live(fx.scheduler), []);
  assert.equal(fx.scheduler.listJobs().length, 1, 'nothing retried');
  assert.equal(fx.usageRows()[0].outcome, 'cancelled');
  assert.deepEqual(fx.routes.resources(), { requests: 0, timers: 0, leases: 0, body_bytes: 0 });
});

// ---------------------------------------------------------------------------
// 5. No text at rest or in logs.

test('no prompt, reply or header text reaches a log line, a usage row or an error body', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const marked = { 'x-marker': MARKER, authorization: `Bearer ${MARKER}` };
  const stream = openStream(fx.port, { headers: headersFor('member', marked),
    body: chatBody({ messages: [{ role: 'user', content: MARKER }], user: MARKER }) });
  const claimed = await node.claimNext();
  assert.equal(JSON.stringify(claimed.request).includes(MARKER), true, 'the prompt reaches the node');
  claimed.send(delta(MARKER) + usageChunk(3, 2) + DONE, true);
  await stream.until((s) => s.ended, 'stream end');
  assert.equal(stream.state.text.includes(MARKER), true, 'the reply reaches the caller');
  const bodies = [
    await send(fx.port, { headers: headersFor('member', { 'x-engine-key': `${MARKER}${'x'.repeat(26)}` }), body: chatBody() }),
    await send(fx.port, { headers: headersFor('member', marked), body: `{"messages":"${MARKER}"` }),
    await send(fx.port, { headers: headersFor('member', marked), body: chatBody({ model: MARKER }) }),
    await send(fx.port, { headers: headersFor('read_only', marked), body: chatBody({ user: MARKER }) }),
  ];
  for (const answer of bodies) {
    assert.ok(answer.status >= 400);
    assert.equal(answer.text.includes(MARKER), false, answer.text);
  }
  await waitFor(() => fx.usageRows().length === 1, 'usage row');
  assert.equal(JSON.stringify(fx.usageRows()).includes(MARKER), false);
  assert.ok(fx.logger.calls.length > 0);
  assert.equal(fx.logger.text().includes(MARKER), false);
});

// ---------------------------------------------------------------------------
// 6. Body rules.

function bodyOfLength(length) {
  const base = JSON.stringify(chatBody({ pad: '' }));
  return JSON.stringify(chatBody({ pad: 'p'.repeat(length - base.length) }));
}

test('the body cap: exactly the cap is served, a little over is drained and 413, twice over is refused unread', async (t) => {
  const cap = 4096;
  const fx = await setupEngine(t, { limits: { maxBodyBytes: cap } });
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const exact = bodyOfLength(cap);
  assert.equal(Buffer.byteLength(exact), cap);
  const served = send(fx.port, { headers: headersFor('member'), body: exact });
  (await node.claimNext()).send(delta('ok') + DONE, true);
  assert.equal((await served).status, 200);
  const over = await send(fx.port, { headers: headersFor('member'), body: bodyOfLength(cap + 10) });
  assert.equal(over.status, 413);
  assert.equal(engineError(over.text), 'job_request_too_large');
  const unread = await send(fx.port, { headers: headersFor('member'), declaredLength: 2 * cap + 1, holdBody: true });
  assert.equal(unread.status, 413);
  assert.equal(engineError(unread.text), 'job_request_too_large');
  const notJson = await send(fx.port, { headers: headersFor('member'), body: 'not json at all' });
  assert.equal(notJson.status, 400);
  assert.equal(engineError(notJson.text), 'request_body_invalid');
  const array = await send(fx.port, { headers: headersFor('member'), body: '[1,2]' });
  assert.equal(engineError(array.text), 'request_body_invalid');
});

// ---------------------------------------------------------------------------
// 7. Queue.

test('with every slot busy the caller gets comment lines, keeps no request slot and then streams', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  // A lease with no job holds the only slot, so only the queue wait runs on the clock.
  const filler = fx.scheduler.requestLease({ conversationKey: 'conv:-:filler', memberId: 'member_owner', model: 'alpha',
    wantsVision: false });
  assert.equal(filler.lease.state, 'active');
  const second = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  await second.until((s) => (s.text.match(/: keepalive/gu) || []).length >= 2, 'two comment lines');
  assert.equal(second.state.headers['content-type'], 'text/event-stream');
  assert.equal(fx.admission.active, 0, 'a queued SSE answer holds no request slot');
  assert.equal(leasesOf(fx.scheduler, 'member_a')[0].state, 'queued');
  assert.equal(fx.scheduler.releaseLease(filler.lease.lease_id).ok, true);
  const secondJob = await node.claimNext();
  secondJob.send(delta('second') + DONE, true);
  await second.until((s) => s.ended, 'second stream end');
  assert.match(second.state.text, /^(: keepalive\n\n)+data: /u);
  assert.equal(second.state.text.endsWith(delta('second') + DONE), true);
});

// ---------------------------------------------------------------------------
// 8. Failure reasons in the member port's error shape.

test('pool refusals reach the caller as team_engine_error with a fitting status', async (t) => {
  const fx = await setupEngine(t, { schedulerLimits: { maxQueued: 1 } });
  const answer = (body, headers = {}) => send(fx.port, { headers: headersFor('member', headers), body });
  const key = await send(fx.port, { headers: headersFor('member', { 'x-engine-key': 'too-short' }),
    declaredLength: 100, holdBody: true });
  assert.deepEqual([key.status, engineError(key.text)], [400, 'engine_key_invalid']);
  const missing = await answer(chatBody({ model: 'gamma' }));
  assert.deepEqual([missing.status, engineError(missing.text)], [404, 'model_not_in_pool']);
  const image = chatBody({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] }] });
  const vision = await answer(image);
  assert.deepEqual([vision.status, engineError(vision.text)], [400, 'model_lacks_vision']);
  const busy = openStream(fx.port, { headers: headersFor('other'), body: chatBody() });
  await waitFor(() => fx.scheduler.listJobs().length === 1, 'first job');
  fx.scheduler.requestLease({ conversationKey: 'conv:-:filler', memberId: 'member_owner', model: 'alpha', wantsVision: false });
  const full = await answer(chatBody());
  assert.deepEqual([full.status, engineError(full.text)], [429, 'pool_queue_full']);
  fx.scheduler.setNodePaused(fx.nodeIds[0], { on: true });
  const none = await answer(chatBody());
  assert.deepEqual([none.status, engineError(none.text)], [503, 'no_eligible_node']);
  busy.request.destroy();
});

test('a queued stream that reaches the scheduler wait gets a queue_timeout error frame', async (t) => {
  const fx = await setupEngine(t);
  fx.scheduler.requestLease({ conversationKey: 'conv:-:filler', memberId: 'member_owner', model: 'alpha', wantsVision: false });
  const waiting = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  await waiting.until((s) => s.text.includes(': keepalive'), 'queued');
  fx.clock.advance(10 * 60_000);
  fx.scheduler.touchNode(fx.nodeIds[0]);
  await waiting.until((s) => s.ended, 'queue timeout');
  assert.equal(sseErrorCode(waiting.state.text), 'queue_timeout');
  await waitFor(() => fx.usageRows().length === 1, 'usage row');
  assert.deepEqual([fx.usageRows()[0].outcome, fx.usageRows()[0].reason, fx.usageRows()[0].node_id],
    ['failed', 'queue_timeout', null]);
});

test('a member holds at most two engine requests at once', async (t) => {
  const fx = await setupEngine(t, { nodes: [{ slots: 4, models: [model('alpha')] }] });
  const a = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  const b = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  await waitFor(() => fx.scheduler.listJobs().length === 2, 'two jobs');
  const third = await send(fx.port, { headers: headersFor('member'), body: chatBody() });
  assert.deepEqual([third.status, engineError(third.text)], [429, 'engine_member_busy']);
  a.request.destroy();
  b.request.destroy();
});

// ---------------------------------------------------------------------------
// 3. Models.

test('the models route answers the union of online models in the OpenAI list shape, without node ids or members', async (t) => {
  const fx = await setupEngine(t, { nodes: [{ models: [model('beta'), model('alpha')] }, { models: [model('alpha')] }] });
  const answer = await send(fx.port, { method: 'GET', path: MODELS_PATH, headers: headersFor('member') });
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(answer.text), { object: 'list', data: [
    { id: 'alpha', object: 'model', created: 0, owned_by: 'team', context_length: 32768 },
    { id: 'beta', object: 'model', created: 0, owned_by: 'team', context_length: 32768 },
  ] });
  assert.equal(/node_|member_/u.test(answer.text), false);
  assert.equal((await send(fx.port, { method: 'GET', path: '/api/v1/team/engine/v1/other', headers: headersFor('member') })).status, 404);
  assert.equal((await send(fx.port, { method: 'GET', path: CHAT_PATH, headers: headersFor('member') })).status, 404);
});

// ---------------------------------------------------------------------------
// 9. The usage store.

test('an unloadable usage store refuses the chat route with its reason', async (t) => {
  for (const [content, reason] of [['{not json', 'pool_usage_store_failed'],
    [JSON.stringify({ schema_version: 9, floor_seq: 1, next_seq: 1, entries: [] }), 'pool_schema_unsupported']]) {
    const fx = await setupEngine(t, { usageLog: ({ usageFile, clock, logger }) => {
      require('node:fs').writeFileSync(usageFile, content);
      const { UsageLog } = require('../../server/team/usage-log');
      return new UsageLog({ filePath: usageFile, clock, logger });
    } });
    const refused = await send(fx.port, { headers: headersFor('member'), body: chatBody() });
    assert.deepEqual([refused.status, engineError(refused.text)], [503, reason]);
    assert.equal(fx.scheduler.listLeases().length, 0);
  }
});

test('a failed usage append after a served stream is logged and counted and the stream is whole', async (t) => {
  const fx = await setupEngine(t, { usageLog: ({ clock, logger }) => {
    const { UsageLog } = require('../../server/team/usage-log');
    return new UsageLog({ filePath: 'memory://usage', clock, logger, readJson: () => null,
      writeJson: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
  } });
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const stream = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  const chunks = delta('whole') + usageChunk(1, 1) + DONE;
  (await node.claimNext()).send(chunks, true);
  await stream.until((s) => s.ended, 'stream end');
  assert.equal(stream.state.aborted, false);
  assert.equal(stream.state.text, chunks);
  await waitFor(() => fx.routes.counters().usage_append_failures === 1, 'counted');
  assert.match(fx.logger.text(), /team\.engine\.usage_append_failed/u);
});

// ---------------------------------------------------------------------------
// 10. Teardown.

test('stop cancels in-flight and queued requests and leaves nothing behind', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const running = openStream(fx.port, { headers: headersFor('other'), body: chatBody() });
  const claimed = await node.claimNext();
  claimed.send(delta('started'));
  const queued = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  await queued.until((s) => s.text.includes(': keepalive'), 'queued');
  assert.equal(fx.routes.resources().requests, 2);
  await fx.routes.stop();
  assert.deepEqual(fx.routes.resources(), { requests: 0, timers: 0, leases: 0, body_bytes: 0 });
  assert.deepEqual(live(fx.scheduler), []);
  assert.equal(fx.scheduler.getJob(claimed.job.job_id).state, 'cancelled');
  await running.until((s) => s.ended || s.aborted, 'running cut');
  await queued.until((s) => s.ended || s.aborted, 'queued cut');
  const after = await send(fx.port, { headers: headersFor('member'), body: chatBody() });
  assert.deepEqual([after.status, engineError(after.text)], [503, 'team_pool_unavailable']);
});

// ---------------------------------------------------------------------------
// Review round: the client binding, re-checks, limits, keys, stalls and failures.

test('the client binding must be a function that answers true, checked before the body is read', async (t) => {
  const fx = await setupEngine(t);
  for (const mode of ['false', 'throw', 'absent', 'literal']) {
    const chat = await send(fx.port, { headers: headersFor('member', { 'x-test-authorized': mode }),
      declaredLength: 1000, holdBody: true });
    assert.deepEqual([chat.status, engineError(chat.text)], [403, 'client_required'], mode);
    const models = await send(fx.port, { method: 'GET', path: MODELS_PATH,
      headers: headersFor('member', { 'x-test-authorized': mode }) });
    assert.equal(models.status, 403, mode);
  }
  assert.equal(fx.scheduler.listLeases().length, 0);
});

test('a member revoked while the body arrives is refused when it ends and takes no lease', async (t) => {
  const fx = await setupEngine(t);
  const held = openHeld(fx.port, { headers: headersFor('member'), body: chatBody() });
  await waitFor(() => fx.routes.resources().requests === 1, 'admitted');
  fx.directory.setState('device_a1', 'revoked');
  held.finish();
  const answer = await held.answer;
  assert.deepEqual([answer.status, engineError(answer.text)], [403, 'member_revoked']);
  assert.equal(fx.scheduler.listLeases().length, 0);
});

test('the per-member limit spans the member devices and engine keys', async (t) => {
  const fx = await setupEngine(t, { nodes: [{ slots: 4, models: [model('alpha')] }] });
  const a = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  const b = openStream(fx.port, { headers: headersFor('member', { 'x-engine-key': ENGINE_KEY }), body: chatBody() });
  await waitFor(() => fx.scheduler.listJobs().length === 2, 'two jobs');
  const third = await send(fx.port, { headers: headersFor('device_a2', { 'x-engine-key': 'Z'.repeat(43) }), body: chatBody() });
  assert.deepEqual([third.status, engineError(third.text)], [429, 'engine_member_busy']);
  a.request.destroy();
  b.request.destroy();
});

test('a non-streamed request is relayed as JSON and its usage recorded; a second one at once is busy', async (t) => {
  const fx = await setupEngine(t, { nodes: [{ slots: 4, models: [model('alpha')] }] });
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const first = send(fx.port, { headers: headersFor('member'), body: chatBody({ stream: false }) });
  const claimed = await node.claimNext();
  const second = await send(fx.port, { headers: headersFor('member'), body: chatBody({ stream: false }) });
  assert.deepEqual([second.status, engineError(second.text)], [429, 'engine_member_busy']);
  assert.equal(fx.scheduler.listLeases().length, 1, 'the busy request took no lease');
  const reply = JSON.stringify({ id: 'c1', object: 'chat.completion', choices: [{ index: 0,
    message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } });
  claimed.send(reply, true);
  const answer = await first;
  assert.equal(answer.status, 200);
  assert.equal(answer.headers['content-type'], 'application/json');
  assert.equal(answer.text, reply);
  await waitFor(() => fx.usageRows().length === 1, 'usage row');
  assert.deepEqual([fx.usageRows()[0].prompt_tokens, fx.usageRows()[0].completion_tokens], [5, 3]);
});

test('a non-streamed failure before the first byte answers 502, or 504 for a timeout', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const failed = send(fx.port, { headers: headersFor('member'), body: chatBody({ stream: false }) });
  (await node.claimNext()).fail('engine_error');
  const answer = await failed;
  assert.deepEqual([answer.status, engineError(answer.text)], [502, 'engine_error']);
  // The failure excluded this member's keyless bucket from the only node for 10 minutes; another bucket is served.
  const slow = send(fx.port, { headers: headersFor('member', { 'x-engine-key': ENGINE_KEY }), body: chatBody({ stream: false }) });
  await node.claimNext();
  fx.clock.advance(121_000);
  fx.scheduler.touchNode(fx.nodeIds[0]);
  const timedOut = await slow;
  assert.deepEqual([timedOut.status, engineError(timedOut.text)], [504, 'first_byte_timeout']);
});

test('a node failure after bytes cuts the stream: no [DONE] and never a clean end', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const stream = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  const claimed = await node.claimNext();
  claimed.send(delta('half'));
  await stream.until((s) => s.text.includes('half'), 'first chunk');
  claimed.fail('engine_error');
  await stream.until((s) => s.aborted || s.closed, 'cut');
  assert.equal(stream.state.text.includes('[DONE]'), false);
  assert.equal(stream.state.ended, false);
  await waitFor(() => fx.usageRows().length === 1, 'usage row');
  assert.deepEqual([fx.usageRows()[0].outcome, fx.usageRows()[0].reason], ['failed', 'engine_error']);
});

test('a client that stops reading is cut as client_stalled once its buffer passes the limit', async (t) => {
  const fx = await setupEngine(t, { limits: { maxBufferedBytes: 16 * 1024 } });
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const stream = openStream(fx.port, { headers: headersFor('member'), body: chatBody(), paused: true });
  const claimed = await node.claimNext();
  const big = delta('x'.repeat(60 * 1024));
  for (let i = 0; i < 400 && fx.scheduler.getJob(claimed.job.job_id).state !== 'cancelled'; i += 1) {
    claimed.send(big);
    await sleep(2);
  }
  assert.equal(fx.scheduler.getJob(claimed.job.job_id).state, 'cancelled');
  assert.deepEqual(live(fx.scheduler), []);
  await waitFor(() => fx.usageRows().length === 1, 'usage row');
  assert.deepEqual([fx.usageRows()[0].outcome, fx.usageRows()[0].reason], ['cancelled', 'client_stalled']);
  await stream.until((s) => s.closed || s.aborted, 'socket cut');
});

test('a failed usage write refuses the next chat until a write succeeds again', async (t) => {
  let failWrites = true;
  const fx = await setupEngine(t, { usageLog: ({ clock, logger }) => new UsageLog({ filePath: 'memory://usage', clock,
    logger, readJson: () => null,
    writeJson: () => { if (failWrites) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } }) });
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const served = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  (await node.claimNext()).send(delta('one') + DONE, true);
  await served.until((s) => s.ended, 'first stream');
  await waitFor(() => fx.routes.counters().usage_append_failures === 1, 'counted');
  const refused = await send(fx.port, { headers: headersFor('member'), declaredLength: 1000, holdBody: true });
  assert.deepEqual([refused.status, engineError(refused.text)], [503, 'pool_usage_store_failed']);
  failWrites = false;
  fx.clock.advance(1000);
  const healed = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  (await node.claimNext()).send(delta('two') + DONE, true);
  await healed.until((s) => s.ended, 'healed stream');
  assert.equal(healed.state.status, 200);
});

test('a member demoted mid-stream is cut at the next once-a-second check and the job is cancelled', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const stream = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
  const claimed = await node.claimNext();
  claimed.send(delta('before'));
  await stream.until((s) => s.text.includes('before'), 'first chunk');
  fx.directory.setRole('device_a1', 'read_only');
  claimed.send(delta('same second'));
  await stream.until((s) => s.text.includes('same second'), 'no check inside the second');
  fx.clock.advance(1000);
  claimed.send(delta('after'));
  await stream.until((s) => s.closed || s.aborted, 'cut');
  assert.equal(stream.state.text.includes('after'), false);
  assert.equal(fx.scheduler.getJob(claimed.job.job_id).state, 'cancelled');
  await waitFor(() => fx.usageRows().length === 1, 'usage row');
  assert.deepEqual([fx.usageRows()[0].outcome, fx.usageRows()[0].reason], ['cancelled', 'role_forbidden']);
});

test('a valid engine key sent on a served stream reaches no lease, event, log line, usage row or error body', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const stream = openStream(fx.port, { headers: headersFor('member', { 'x-engine-key': ENGINE_KEY }), body: chatBody() });
  (await node.claimNext()).send(delta('ok') + usageChunk(1, 1) + DONE, true);
  await stream.until((s) => s.ended, 'stream end');
  const refused = await send(fx.port, { headers: headersFor('member', { 'x-engine-key': ENGINE_KEY }),
    body: chatBody({ model: 'gamma' }) });
  assert.equal(refused.status, 404);
  await waitFor(() => fx.usageRows().length === 1, 'usage row');
  for (const [label, text] of [['leases', JSON.stringify(fx.scheduler.listLeases())], ['events', JSON.stringify(fx.events)],
    ['logs', fx.logger.text()], ['usage', JSON.stringify(fx.usageRows())], ['error', refused.text]]) {
    assert.equal(text.includes(ENGINE_KEY), false, label);
  }
});

test('R16-F01: the node gets one model key, the leased one: case variants and a duplicate never pass', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const raw = '{"model":"x:cloud","Model":"gpt-oss:120b-cloud","MODEL":"another:cloud","\\u004dodel":"y:cloud",'
    + '"stream":true,"messages":[{"role":"user","content":"hello"}],"model":"alpha"}';
  const answer = send(fx.port, { headers: headersFor('member'), body: raw });
  const claimed = await node.claimNext();
  const text = fx.scheduler.jobRequest(claimed.job.job_id, fx.nodeIds[0]).request.toString('utf8');
  assert.deepEqual(Object.keys(JSON.parse(text)).filter((key) => key.toLowerCase() === 'model'), ['model']);
  assert.equal((text.match(/"model"\s*:/giu) || []).length, 1, 'one model key in the bytes the node reads');
  assert.equal(JSON.parse(text).model, 'alpha');
  claimed.send(delta('x'));
  claimed.send(DONE, true);
  assert.equal((await answer).status, 200);
});

test('R16-F03: node usage is clamped to what the request and the reply could hold; the GPU use read stays readable', async (t) => {
  const fx = await setupEngine(t);
  const node = createNode(fx.scheduler, fx.nodeIds[0]);
  const BIG = 999_999_999_999_999; // 15 digits, the most the tail reader takes
  const requestBytes = Buffer.byteLength(JSON.stringify(chatBody()));
  const reply = [delta('hi'), usageChunk(BIG, BIG), DONE];
  for (let round = 0; round < 5; round += 1) {
    const stream = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
    const claimed = await node.claimNext();
    for (const [i, chunk] of reply.entries()) claimed.send(chunk, i === reply.length - 1);
    await stream.until((state) => state.ended, 'the answer');
    await waitFor(() => fx.usageRows().length === round + 1, 'usage row');
  }
  for (const row of fx.usageRows()) {
    assert.ok(row.prompt_tokens <= requestBytes, `prompt ${row.prompt_tokens} within the request's ${requestBytes} bytes`);
    assert.ok(row.completion_tokens <= Buffer.byteLength(reply.join('')), `completion ${row.completion_tokens} within the reply`);
  }
  const page = new UsageLog({ filePath: fx.usageFile, clock: fx.clock }).read({ limit: 20, windowMs: 7 * 24 * 3600 * 1000 });
  assert.equal(page.ok, true);
  assert.equal(Number.isSafeInteger(page.totals[0].tokens), true);
  assert.ok(page.rows.every((row) => row.reported_by === 'node'), 'every row says the serving hardware reported it');
});

// X6b-F03: counts under the usage log's row bound are stored, so only the clamp keeps them to the request's bytes,
// the relayed reply's bytes and the leased model's context length.
test('R16-F03: node counts under the row bound are stored clamped to the request, the reply and the context length', async (t) => {
  const served = async (contextLength) => {
    const fx = await setupEngine(t, { nodes: [{ models: [model('alpha', { contextLength })] }] });
    const reply = [delta('hi'), usageChunk(5_000_000, 6_000_000), DONE];
    const stream = openStream(fx.port, { headers: headersFor('member'), body: chatBody() });
    const claimed = await createNode(fx.scheduler, fx.nodeIds[0]).claimNext();
    for (const [i, chunk] of reply.entries()) claimed.send(chunk, i === reply.length - 1);
    await stream.until((state) => state.ended, 'the answer');
    await waitFor(() => fx.usageRows().length === 1, 'usage row');
    const [row] = fx.usageRows();
    return { row, requestBytes: Buffer.byteLength(JSON.stringify(chatBody())), replyBytes: Buffer.byteLength(reply.join('')) };
  };
  const wide = await served(32768);
  assert.deepEqual([wide.row.prompt_tokens, wide.row.completion_tokens], [wide.requestBytes, wide.replyBytes]);
  const narrow = await served(10);
  assert.ok(narrow.requestBytes > 10 && narrow.replyBytes > 10);
  assert.deepEqual([narrow.row.prompt_tokens, narrow.row.completion_tokens], [10, 10], 'the context length is the ceiling');
});

test('with no pool every route answers team_pool_unavailable', async (t) => {
  const fx = await setupEngine(t, { nullPool: true });
  const chat = await send(fx.port, { headers: headersFor('member'), declaredLength: 1000, holdBody: true });
  assert.deepEqual([chat.status, engineError(chat.text)], [503, 'team_pool_unavailable']);
  const models = await send(fx.port, { method: 'GET', path: MODELS_PATH, headers: headersFor('member') });
  assert.deepEqual([models.status, engineError(models.text)], [503, 'team_pool_unavailable']);
});
