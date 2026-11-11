'use strict';

// Team slice 4a-2 (spec tests 4a-T2, T4, T6, T7): the pool gateway over real
// loopback HTTP, with a real scheduler and a fake node that drives claim and
// acceptChunk in process.

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createPoolGateway, POOL_MODEL_ALIAS, ROUTE_TOKEN_HEADER } = require('../../server/team/pool-gateway');
const {
  DONE_LINE, activeLease, createLoggerSpy, createScheduler, model, registerNode, sseData,
} = require('./helpers/team-pool-fixture');

const BOOT_KEY = 'boot-key-0123456789abcdefghijklmnopqrstuvwxyz';
const PROMPT_MARKER = 'PROMPT_MARKER_7f3a';
const REPLY_MARKER = 'REPLY_MARKER_91bc';

async function setup(t, { nodes = [{ models: [model('alpha')] }], limits = {}, schedulerLimits } = {}) {
  const logger = createLoggerSpy();
  const fx = createScheduler({ logger, limits: schedulerLimits });
  const nodeIds = nodes.map((spec, i) => registerNode(fx.scheduler, {
    deviceId: `device_${i}`, memberId: `member_${i}`, slots: spec.slots || 2, models: spec.models,
  }));
  const gateway = createPoolGateway({
    scheduler: fx.scheduler, bootKey: BOOT_KEY, clock: fx.clock, logger,
    limits: { commentIntervalMs: 15, ...limits },
  });
  const port = await gateway.start();
  t.after(() => gateway.stop());
  return { ...fx, logger, gateway, port, nodeIds };
}

function send(port, { method = 'POST', path = '/v1/chat/completions', headers = {}, body = null, hostHeader } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const request = http.request({
      host: '127.0.0.1', port, method, path, agent: false,
      headers: {
        host: hostHeader || `127.0.0.1:${port}`,
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        text: Buffer.concat(chunks).toString(), aborted: false }));
      response.on('error', () => resolve({ status: response.statusCode, headers: response.headers,
        text: Buffer.concat(chunks).toString(), aborted: true }));
      response.on('aborted', () => resolve({ status: response.statusCode, headers: response.headers,
        text: Buffer.concat(chunks).toString(), aborted: true }));
    });
    request.on('error', reject);
    if (payload) request.end(payload); else request.end();
  });
}

// A streaming request that exposes the response as it arrives.
function openStream(port, headers, body) {
  const payload = Buffer.from(JSON.stringify(body));
  const state = { status: 0, text: '', ended: false, aborted: false };
  let notify = () => {};
  const changed = () => { const n = notify; notify = () => {}; n(); };
  const request = http.request({
    host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', agent: false,
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': payload.length,
      ...headers },
  }, (response) => {
    state.status = response.statusCode;
    state.headers = response.headers;
    response.on('data', (chunk) => { state.text += chunk.toString(); changed(); });
    response.on('end', () => { state.ended = true; changed(); });
    response.on('aborted', () => { state.aborted = true; changed(); });
    response.on('error', () => { state.aborted = true; changed(); });
    changed();
  });
  request.on('error', () => { state.aborted = true; changed(); });
  request.end(payload);
  const until = async (predicate, label) => {
    const deadline = Date.now() + 5000;
    while (!predicate(state)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(state)}`);
      await new Promise((resolve) => { notify = resolve; setTimeout(resolve, 5); });
    }
  };
  return { state, request, until };
}

function authHeaders(token) {
  return { authorization: `Bearer ${BOOT_KEY}`, ...(token ? { [ROUTE_TOKEN_HEADER]: token } : {}) };
}

function chatBody(extra = {}) {
  return { model: POOL_MODEL_ALIAS, stream: true, messages: [{ role: 'user', content: PROMPT_MARKER }], ...extra };
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => { setTimeout(resolve, 2); });
  }
}

// The fake node: waits for the lease's queued job and claims it.
async function claimFor(fx, nodeId, leaseId, claimSeq) {
  let job = null;
  await waitFor(() => {
    job = fx.scheduler.listJobs().find((j) => j.lease_id === leaseId && j.state === 'queued') || null;
    return job !== null;
  }, 'a queued job');
  const claim = fx.scheduler.claim(nodeId, claimSeq);
  assert.equal(claim.job.job_id, job.job_id);
  return claim.job;
}

test('the four unauthorized cases answer identically with 401 route_token_required', async (t) => {
  const fx = await setup(t);
  activeLease(fx.scheduler);
  const cases = [
    {},
    { authorization: 'Bearer wrong-key', [ROUTE_TOKEN_HEADER]: 'x' },
    { authorization: `Bearer ${BOOT_KEY}` },
    authHeaders('A'.repeat(43)),
  ];
  const answers = [];
  for (const headers of cases) answers.push(await send(fx.port, { headers, body: chatBody() }));
  for (const answer of answers) {
    assert.equal(answer.status, 401);
    assert.equal(JSON.parse(answer.text).error.reason, 'route_token_required');
    assert.equal(answer.text, answers[0].text);
    assert.equal(answer.headers['content-type'], answers[0].headers['content-type']);
    assert.equal(answer.headers['content-length'], answers[0].headers['content-length']);
  }
  assert.equal(fx.scheduler.listJobs().length, 0);
});

test('a token on a terminal lease answers 410 lease_not_active', async (t) => {
  const fx = await setup(t);
  const { lease, token } = activeLease(fx.scheduler);
  fx.scheduler.releaseLease(lease.lease_id);
  const answer = await send(fx.port, { headers: authHeaders(token), body: chatBody() });
  assert.equal(answer.status, 410);
  assert.equal(JSON.parse(answer.text).error.reason, 'lease_not_active');
});

test('an Origin header or a wrong Host is refused before anything else', async (t) => {
  const fx = await setup(t);
  const { token } = activeLease(fx.scheduler);
  const withOrigin = await send(fx.port, { headers: { ...authHeaders(token), origin: 'http://evil.example' },
    body: chatBody() });
  assert.equal(withOrigin.status, 403);
  const wrongHost = await send(fx.port, { headers: authHeaders(token), body: chatBody(),
    hostHeader: `localhost:${fx.port}` });
  assert.equal(wrongHost.status, 403);
  const modelsWithOrigin = await send(fx.port, { method: 'GET', path: '/v1/models',
    headers: { authorization: `Bearer ${BOOT_KEY}`, origin: 'null' } });
  assert.equal(modelsWithOrigin.status, 403);
  assert.equal(fx.scheduler.listJobs().length, 0);
});

test('/v1/models and /props work with the key alone and not without it', async (t) => {
  const fx = await setup(t, { nodes: [
    { models: [model('alpha', { contextLength: 16384 }), model('seer', { contextLength: 65536, vision: true })] },
  ] });
  const key = { authorization: `Bearer ${BOOT_KEY}` };
  const models = await send(fx.port, { method: 'GET', path: '/v1/models', headers: key });
  assert.equal(models.status, 200);
  assert.deepEqual(JSON.parse(models.text).data.map((m) => m.id), [POOL_MODEL_ALIAS]);
  const props = await send(fx.port, { method: 'GET', path: '/props', headers: key });
  assert.equal(props.status, 200);
  const body = JSON.parse(props.text);
  assert.equal(body.default_generation_settings.n_ctx, 16384);
  assert.equal(body.modalities.vision, true);
  for (const path of ['/v1/models', '/props']) {
    const none = await send(fx.port, { method: 'GET', path });
    assert.equal(none.status, 401);
    const wrong = await send(fx.port, { method: 'GET', path, headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.text, none.text);
  }
});

test('/props applies the owner context cap and reports no vision when no model has it', async (t) => {
  const fx = await setup(t, { limits: { contextCap: 8192 } });
  const props = await send(fx.port, { method: 'GET', path: '/props', headers: { authorization: `Bearer ${BOOT_KEY}` } });
  const body = JSON.parse(props.text);
  assert.equal(body.default_generation_settings.n_ctx, 8192);
  assert.equal(body.modalities.vision, false);
});

test('any other path or method is a 404 with no detail', async (t) => {
  const fx = await setup(t);
  const key = { authorization: `Bearer ${BOOT_KEY}` };
  for (const [method, path] of [['GET', '/v1/props'], ['POST', '/chat/completions'], ['GET', '/props?x=1'],
    ['GET', '/v1/chat/completions'], ['DELETE', '/v1/models'], ['GET', '/']]) {
    const answer = await send(fx.port, { method, path, headers: key });
    assert.equal(answer.status, 404, `${method} ${path}`);
    assert.equal(answer.text, '');
  }
});

test('the model is rewritten and two leases on different models stream concurrently', async (t) => {
  const fx = await setup(t, { nodes: [{ models: [model('alpha')] }, { models: [model('beta')] }] });
  const [nodeA, nodeB] = fx.nodeIds;
  const a = activeLease(fx.scheduler, { conversationKey: 'conv:p:a', model: 'alpha' });
  const b = activeLease(fx.scheduler, { conversationKey: 'conv:p:b', model: 'beta' });
  const streamA = openStream(fx.port, authHeaders(a.token), chatBody());
  const streamB = openStream(fx.port, authHeaders(b.token), chatBody());
  const jobA = await claimFor(fx, nodeA, a.lease.lease_id, 1);
  const jobB = await claimFor(fx, nodeB, b.lease.lease_id, 1);
  assert.equal(jobA.model, 'alpha');
  assert.equal(JSON.parse(fx.scheduler.jobRequest(jobA.job_id, nodeA).request).model, 'alpha');
  assert.equal(JSON.parse(fx.scheduler.jobRequest(jobB.job_id, nodeB).request).model, 'beta');
  fx.scheduler.acceptChunk(jobA.job_id, nodeA, 0, sseData('"a0"'), false);
  fx.scheduler.acceptChunk(jobB.job_id, nodeB, 0, sseData('"b0"'), false);
  fx.scheduler.acceptChunk(jobB.job_id, nodeB, 1, DONE_LINE, true);
  fx.scheduler.acceptChunk(jobA.job_id, nodeA, 1, DONE_LINE, true);
  await streamA.until((s) => s.ended, 'stream A');
  await streamB.until((s) => s.ended, 'stream B');
  assert.equal(streamA.state.status, 200);
  assert.equal(streamA.state.headers['content-type'], 'text/event-stream');
  assert.equal(streamA.state.text.replace(/^:.*\n\n/gmu, ''), 'data: "a0"\n\ndata: [DONE]\n\n');
  assert.equal(streamB.state.text.replace(/^:.*\n\n/gmu, ''), 'data: "b0"\n\ndata: [DONE]\n\n');
  assert.equal(fx.scheduler.getLease(a.lease.lease_id).state, 'active', 'the lease outlives its job');
});

test('chunks arrive in order and a wrong sequence number changes nothing', async (t) => {
  const fx = await setup(t);
  const { lease, token } = activeLease(fx.scheduler);
  const stream = openStream(fx.port, authHeaders(token), chatBody());
  const job = await claimFor(fx, fx.nodeIds[0], lease.lease_id, 1);
  const node = fx.nodeIds[0];
  assert.equal(fx.scheduler.acceptChunk(job.job_id, node, 0, sseData('"one"'), false).ok, true);
  assert.equal(fx.scheduler.acceptChunk(job.job_id, node, 2, sseData('"skipped"'), false).ok, false);
  assert.equal(fx.scheduler.acceptChunk(job.job_id, node, 0, sseData('"again"'), false).ok, false);
  assert.equal(fx.scheduler.acceptChunk(job.job_id, node, 1, sseData('"two"'), false).ok, true);
  fx.scheduler.acceptChunk(job.job_id, node, 2, DONE_LINE, true);
  await stream.until((s) => s.ended, 'end');
  assert.equal(stream.state.text.replace(/^:.*\n\n/gmu, ''), 'data: "one"\n\ndata: "two"\n\ndata: [DONE]\n\n');
});

test('a comment line is written while waiting for the claim and the first byte', async (t) => {
  const fx = await setup(t);
  const { lease, token } = activeLease(fx.scheduler);
  const stream = openStream(fx.port, authHeaders(token), chatBody());
  await stream.until((s) => /^: /mu.test(s.text), 'a comment before the claim');
  const job = await claimFor(fx, fx.nodeIds[0], lease.lease_id, 1);
  const before = stream.state.text.length;
  await stream.until((s) => s.text.length > before, 'a comment after the claim');
  fx.scheduler.acceptChunk(job.job_id, fx.nodeIds[0], 0, DONE_LINE, true);
  await stream.until((s) => s.ended, 'end');
  assert.match(stream.state.text, /^: keepalive\n\n/u);
  assert.equal(fx.gateway.resources().timers, 0, 'the comment timer stops with the stream');
});

test('the client closing cancels the job and fails the lease', async (t) => {
  const fx = await setup(t);
  const { lease, token } = activeLease(fx.scheduler);
  const stream = openStream(fx.port, authHeaders(token), chatBody());
  const job = await claimFor(fx, fx.nodeIds[0], lease.lease_id, 1);
  fx.scheduler.acceptChunk(job.job_id, fx.nodeIds[0], 0, sseData('"x"'), false);
  await stream.until((s) => s.text.includes('"x"'), 'first chunk');
  stream.request.destroy();
  await waitFor(() => fx.scheduler.getJob(job.job_id).state === 'cancelled', 'job cancelled');
  assert.equal(fx.scheduler.getLease(lease.lease_id).state, 'failed');
  assert.equal(fx.scheduler.getLease(lease.lease_id).reason, 'cancelled');
});

test('a failure after headers and before data is one error frame, then close', async (t) => {
  const fx = await setup(t);
  const { lease, token } = activeLease(fx.scheduler);
  const stream = openStream(fx.port, authHeaders(token), chatBody());
  const job = await claimFor(fx, fx.nodeIds[0], lease.lease_id, 1);
  fx.scheduler.failJob(job.job_id, fx.nodeIds[0], 'engine_error');
  await stream.until((s) => s.ended || s.aborted, 'close');
  const frames = stream.state.text.split('\n\n').filter((f) => f && !f.startsWith(':'));
  assert.equal(frames.length, 1);
  const frame = JSON.parse(frames[0].replace(/^data: /u, ''));
  assert.equal(frame.error.reason, 'engine_error');
  assert.equal(stream.state.ended, true);
});

test('a mid-stream failure closes the socket with no error frame', async (t) => {
  const fx = await setup(t);
  const { lease, token } = activeLease(fx.scheduler);
  const stream = openStream(fx.port, authHeaders(token), chatBody());
  const job = await claimFor(fx, fx.nodeIds[0], lease.lease_id, 1);
  fx.scheduler.acceptChunk(job.job_id, fx.nodeIds[0], 0, sseData('"partial"'), false);
  await stream.until((s) => s.text.includes('partial'), 'first chunk');
  fx.scheduler.failJob(job.job_id, fx.nodeIds[0], 'engine_error');
  await stream.until((s) => s.aborted, 'socket closed');
  assert.equal(stream.state.text.includes('error'), false);
});

test('a body over 8 MiB is refused with job_request_too_large', async (t) => {
  const fx = await setup(t);
  const { token } = activeLease(fx.scheduler);
  const big = Buffer.alloc(8 * 1024 * 1024 + 1, 0x20);
  const answer = await send(fx.port, { headers: authHeaders(token), body: big });
  assert.equal(answer.status, 413);
  assert.equal(JSON.parse(answer.text).error.reason, 'job_request_too_large');
  assert.equal(fx.scheduler.listJobs().length, 0);
});

test('an image part on a lease whose model has no vision is refused; one with vision runs', async (t) => {
  const fx = await setup(t, { nodes: [{ models: [model('alpha'), model('seer', { vision: true })] }] });
  const image = { messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT_MARKER },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] };
  const plain = activeLease(fx.scheduler, { conversationKey: 'conv:p:1', model: 'alpha' });
  const refused = await send(fx.port, { headers: authHeaders(plain.token), body: chatBody(image) });
  assert.equal(refused.status, 400);
  assert.equal(JSON.parse(refused.text).error.reason, 'model_lacks_vision');
  assert.equal(fx.scheduler.listJobs().length, 0);
  const seer = activeLease(fx.scheduler, { conversationKey: 'conv:p:2', model: 'seer', wantsVision: true });
  const stream = openStream(fx.port, authHeaders(seer.token), chatBody(image));
  const job = await claimFor(fx, fx.nodeIds[0], seer.lease.lease_id, 1);
  assert.equal(JSON.parse(fx.scheduler.jobRequest(job.job_id, fx.nodeIds[0]).request).messages[0].content[1].type,
    'image_url');
  fx.scheduler.acceptChunk(job.job_id, fx.nodeIds[0], 0, DONE_LINE, true);
  await stream.until((s) => s.ended, 'end');
});

test('thinking fields are dropped for a model without thinking and kept for one with it', async (t) => {
  const fx = await setup(t, { nodes: [{ models: [model('plain'), model('thinker', { thinking: true })] }] });
  const extra = { reasoning_effort: 'high', thinking_budget_tokens: 2048,
    chat_template_kwargs: { enable_thinking: true, reasoning_effort: 'high', other: 1 }, temperature: 0.2 };
  const seen = {};
  for (const [key, name] of [['plain', 'plain'], ['thinker', 'thinker']]) {
    const { lease, token } = activeLease(fx.scheduler, { conversationKey: `conv:p:${key}`, model: name });
    const stream = openStream(fx.port, authHeaders(token), chatBody(extra));
    const job = await claimFor(fx, fx.nodeIds[0], lease.lease_id, key === 'plain' ? 1 : 2);
    seen[key] = JSON.parse(fx.scheduler.jobRequest(job.job_id, fx.nodeIds[0]).request);
    fx.scheduler.acceptChunk(job.job_id, fx.nodeIds[0], 0, DONE_LINE, true);
    await stream.until((s) => s.ended, 'end');
  }
  assert.equal('reasoning_effort' in seen.plain, false);
  assert.equal('thinking_budget_tokens' in seen.plain, false);
  assert.deepEqual(seen.plain.chat_template_kwargs, { other: 1 });
  assert.equal(seen.plain.temperature, 0.2);
  assert.equal(seen.thinker.reasoning_effort, 'high');
  assert.equal(seen.thinker.thinking_budget_tokens, 2048);
  assert.deepEqual(seen.thinker.chat_template_kwargs, { enable_thinking: true, reasoning_effort: 'high', other: 1 });
});

test('stop() closes every socket and timer, including an open stream', async (t) => {
  const fx = await setup(t);
  const { token } = activeLease(fx.scheduler);
  const stream = openStream(fx.port, authHeaders(token), chatBody());
  await stream.until((s) => s.status === 200, 'headers');
  assert.ok(fx.gateway.resources().sockets >= 1);
  assert.ok(fx.gateway.resources().timers >= 1);
  await fx.gateway.stop();
  assert.deepEqual(fx.gateway.resources(), { listening: false, sockets: 0, timers: 0 });
  await stream.until((s) => s.aborted || s.ended, 'client sees the close');
  await fx.gateway.stop();
});

test('nothing from a request or response body, nor the key or token, appears in any log call', async (t) => {
  const fx = await setup(t);
  const { lease, token } = activeLease(fx.scheduler);
  const stream = openStream(fx.port, authHeaders(token), chatBody());
  const job = await claimFor(fx, fx.nodeIds[0], lease.lease_id, 1);
  fx.scheduler.acceptChunk(job.job_id, fx.nodeIds[0], 0, sseData(`"${REPLY_MARKER}"`), false);
  fx.scheduler.acceptChunk(job.job_id, fx.nodeIds[0], 1, DONE_LINE, true);
  await stream.until((s) => s.ended, 'end');
  await send(fx.port, { headers: { authorization: 'Bearer wrong' }, body: chatBody() });
  const logged = fx.logger.text();
  assert.ok(fx.logger.calls.length > 0, 'the gateway logs ids and byte counts');
  for (const secret of [PROMPT_MARKER, REPLY_MARKER, BOOT_KEY, token]) {
    assert.equal(logged.includes(secret), false, `log leaked ${secret.slice(0, 6)}`);
  }
});

test('construction refuses a missing scheduler or a short boot key', () => {
  const { scheduler } = createScheduler();
  assert.throws(() => createPoolGateway({ scheduler, bootKey: 'short' }), /boot key/u);
  assert.throws(() => createPoolGateway({ bootKey: BOOT_KEY }), /scheduler/u);
});

// ---------------------------------------------------------------------------
// Review round: faults A1, A2, A6 and the gaps in A8.

function sendChunked(port, headers, pieces) {
  return new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', agent: false,
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked',
        ...headers },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve({ closed: false, status: response.statusCode }));
      response.on('error', () => resolve({ closed: true }));
    });
    request.on('error', () => resolve({ closed: true }));
    for (const piece of pieces) request.write(piece);
    request.end();
  });
}

// Sends the headers with a declared length and never the body.
function sendDeclaredOnly(port, headers, declared) {
  return new Promise((resolve) => {
    let timer = null;
    const request = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', agent: false,
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': declared, ...headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(timer);
        request.destroy();
        resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() });
      });
    });
    request.on('error', () => { clearTimeout(timer); resolve({ status: 0, text: '' }); });
    request.flushHeaders();
    timer = setTimeout(() => { request.destroy(); resolve({ status: 0, text: '', timedOut: true }); }, 2000);
  });
}

test('A1: a non-stream request is relayed as JSON, with no keepalive and no early status line', async (t) => {
  const fx = await setup(t);
  const node = fx.nodeIds[0];
  const { lease, token } = activeLease(fx.scheduler);
  const stream = openStream(fx.port, authHeaders(token), chatBody({ stream: false }));
  const job = await claimFor(fx, node, lease.lease_id, 1);
  await new Promise((resolve) => { setTimeout(resolve, 40); });
  assert.equal(stream.state.status, 0, 'no status line before the first byte');
  fx.scheduler.acceptChunk(job.job_id, node, 0, Buffer.from('{"choices":'), false);
  fx.scheduler.acceptChunk(job.job_id, node, 1, Buffer.from('[]}'), true);
  await stream.until((s) => s.ended, 'end');
  assert.equal(stream.state.status, 200);
  assert.equal(stream.state.headers['content-type'], 'application/json');
  assert.equal(stream.state.text, '{"choices":[]}');
  assert.equal(fx.scheduler.getJob(job.job_id).state, 'done');
  assert.equal(fx.scheduler.getLease(lease.lease_id).state, 'active');
});

test('A1: a non-stream job that fails before any byte answers 502, or 504 on a timeout', async (t) => {
  const fx = await setup(t);
  const node = fx.nodeIds[0];
  const first = activeLease(fx.scheduler, { conversationKey: 'conv:p:1' });
  const failed = openStream(fx.port, authHeaders(first.token), chatBody({ stream: false }));
  const failedJob = await claimFor(fx, node, first.lease.lease_id, 1);
  fx.scheduler.failJob(failedJob.job_id, node, 'engine_error');
  await failed.until((s) => s.ended || s.aborted, 'end');
  assert.equal(failed.state.status, 502);
  assert.equal(failed.state.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(failed.state.text).error.reason, 'engine_error');

  const second = activeLease(fx.scheduler, { conversationKey: 'conv:p:2' });
  const slow = openStream(fx.port, authHeaders(second.token), chatBody({ stream: false }));
  await claimFor(fx, node, second.lease.lease_id, 2);
  fx.clock.advance(100_000);
  fx.scheduler.touchNode(node);
  fx.scheduler.sweep(fx.clock() + 20_000);
  await slow.until((s) => s.ended || s.aborted, 'end');
  assert.equal(slow.state.status, 504);
  assert.equal(JSON.parse(slow.state.text).error.reason, 'first_byte_timeout');
});

test('A2: a client that closes after [DONE] leaves the lease active for the next request', async (t) => {
  const fx = await setup(t);
  const node = fx.nodeIds[0];
  const { lease, token } = activeLease(fx.scheduler);
  const first = openStream(fx.port, authHeaders(token), chatBody());
  const job = await claimFor(fx, node, lease.lease_id, 1);
  fx.scheduler.acceptChunk(job.job_id, node, 0, Buffer.concat([sseData('"a"'), DONE_LINE]), false);
  await first.until((s) => s.text.includes('[DONE]'), 'the done line');
  first.request.destroy();
  await waitFor(() => fx.scheduler.getJob(job.job_id).state !== 'streaming', 'the job settles');
  assert.equal(fx.scheduler.getJob(job.job_id).state, 'done');
  assert.equal(fx.scheduler.getLease(lease.lease_id).state, 'active');
  const next = openStream(fx.port, authHeaders(token), chatBody());
  const nextJob = await claimFor(fx, node, lease.lease_id, 2);
  fx.scheduler.acceptChunk(nextJob.job_id, node, 0, DONE_LINE, true);
  await next.until((s) => s.ended, 'end');
  assert.equal(next.state.status, 200);
});

test('A6: a failed listen leaves the gateway startable', async (t) => {
  const { scheduler } = createScheduler();
  const gateway = createPoolGateway({ scheduler, bootKey: BOOT_KEY });
  t.after(() => gateway.stop());
  const original = http.Server.prototype.listen;
  http.Server.prototype.listen = function failOnce() {
    http.Server.prototype.listen = original;
    process.nextTick(() => this.emit('error', Object.assign(new Error('listen failed'), { code: 'EADDRINUSE' })));
    return this;
  };
  try {
    await assert.rejects(gateway.start(), /listen failed/u);
  } finally {
    http.Server.prototype.listen = original;
  }
  assert.equal(gateway.resources().listening, false);
  assert.ok(await gateway.start() > 0);
});

test('A8: a valid route token with a missing or wrong boot key is 401', async (t) => {
  const fx = await setup(t);
  const { token } = activeLease(fx.scheduler);
  const headerSets = [{ [ROUTE_TOKEN_HEADER]: token },
    { authorization: `Bearer ${BOOT_KEY.replace('b', 'c')}`, [ROUTE_TOKEN_HEADER]: token }];
  for (const headers of headerSets) {
    // Read the status line only, so a wrongly admitted stream fails here instead of hanging.
    const answer = openStream(fx.port, headers, chatBody());
    await answer.until((s) => s.status !== 0 || s.aborted, 'the status line');
    assert.equal(answer.state.status, 401);
    await answer.until((s) => s.ended || s.aborted, 'the body');
    assert.equal(JSON.parse(answer.state.text).error.reason, 'route_token_required');
  }
  assert.equal(fx.scheduler.listJobs().length, 0);
});

test('A8: a second concurrent request on one lease is 409 lease_busy', async (t) => {
  const fx = await setup(t);
  const { lease, token } = activeLease(fx.scheduler);
  const first = openStream(fx.port, authHeaders(token), chatBody());
  await claimFor(fx, fx.nodeIds[0], lease.lease_id, 1);
  const second = await send(fx.port, { headers: authHeaders(token), body: chatBody() });
  assert.equal(second.status, 409);
  assert.equal(JSON.parse(second.text).error.reason, 'lease_busy');
  assert.equal(first.state.ended || first.state.aborted, false, 'the first request keeps streaming');
});

test('A8: a declared body over the cap is refused 413 without being read', async (t) => {
  const fx = await setup(t, { schedulerLimits: { maxRequestBytes: 1024 } });
  const { token } = activeLease(fx.scheduler);
  const answer = await sendDeclaredOnly(fx.port, authHeaders(token), 4096);
  assert.equal(answer.status, 413);
  assert.equal(JSON.parse(answer.text).error.reason, 'job_request_too_large');
});

test('A8: a chunked body over twice the cap closes the socket', async (t) => {
  const fx = await setup(t, { schedulerLimits: { maxRequestBytes: 1024 } });
  const { token } = activeLease(fx.scheduler);
  const piece = Buffer.alloc(1024, 0x20);
  const answer = await sendChunked(fx.port, authHeaders(token), [piece, piece, piece]);
  assert.equal(answer.closed, true);
  assert.equal(fx.scheduler.listJobs().length, 0);
});
