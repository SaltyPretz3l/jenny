'use strict';

// The member-side team engine port (row 123, slice 4b member half): a loopback
// OpenAI-compatible server that the member's own sidecar calls as an ordinary
// engine. Real sockets on 127.0.0.1 and a scripted forwarder stand in for the
// team connection: no host route exists in this slice.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createTeamEnginePort } = require('../services/team/engine-port');
const { TeamError } = require('../services/team/team-errors');

const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/u;
// A fault that hangs a request fails its own test by name instead of stalling the file.
const it = (name, fn) => test(name, { timeout: 15_000 }, fn);

// One scripted upstream answer: a status, headers and a body the test writes to.
function upstream(status = 200, headers = { 'content-type': 'text/event-stream' }) {
  const body = new PassThrough();
  const handle = { status, headers, body, closed: false };
  handle.close = () => { handle.closed = true; body.destroy(); };
  body.on('close', () => { handle.closed = true; });
  return handle;
}

function answered() {
  const reply = upstream(200, { 'content-type': 'application/json' });
  reply.body.end('{}');
  return reply;
}

// A stop that leaves a socket open never settles: bound the wait so the test fails by name.
function bounded(promise, ms = 3000) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
}

function scripted(answer) {
  const calls = [];
  const forward = (request) => { calls.push(request); return answer(request, calls.length); };
  return { forward, calls };
}

async function startPort(t, options) {
  const records = [];
  const port = createTeamEnginePort({ logger: (...args) => records.push(args), ...options });
  await port.start();
  t.after(() => bounded(port.stop()));
  const { port: number } = new URL(port.getBaseUrl());
  return { port, records, number: Number(number) };
}

// A raw request; resolves { status, headers, body, complete } or { error } on a reset.
function call(number, { method = 'POST', path = '/v1/chat/completions', headers = {}, body, onResponse } = {}) {
  return new Promise((resolve) => {
    const request = http.request({ host: '127.0.0.1', port: number, method, path, headers, setHost: false, agent: false });
    request.on('error', (error) => resolve({ error }));
    request.on('response', (response) => {
      if (onResponse) onResponse(response, request);
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', () => {});
      response.on('close', () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks), complete: response.complete }));
    });
    if (body === undefined) request.end();
    else request.end(body);
  });
}

function goodHeaders(port, number, extra = {}) {
  return { Host: `127.0.0.1:${number}`, Authorization: `Bearer ${port.getApiKey()}`, 'Content-Type': 'application/json', ...extra };
}

function waitFor(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) { resolve(); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error('condition not met')); return; }
      setTimeout(tick, 10);
    };
    tick();
  });
}

it('start serves on an IP-literal loopback URL with a 43-character per-launch key; stop forgets both', async (t) => {
  const port = createTeamEnginePort({ forward: async () => upstream() });
  assert.equal(port.getBaseUrl(), '');
  assert.equal(port.getApiKey(), '');
  assert.deepEqual(port.getStatus(), { state: 'stopped', alias: '' });
  await port.start();
  t.after(() => port.stop());
  assert.match(port.getBaseUrl(), /^http:\/\/127\.0\.0\.1:\d{2,5}\/v1$/u);
  assert.match(port.getApiKey(), KEY_SHAPE);
  assert.deepEqual(port.getStatus(), { state: 'ready', alias: '' });
  await port.stop();
  assert.equal(port.getBaseUrl(), '');
  assert.equal(port.getApiKey(), '');
  assert.deepEqual(port.getStatus(), { state: 'stopped', alias: '' });
});

it('the key is the injected random bytes as unpadded base64url, and the affinity key is a second draw', async (t) => {
  const draws = [Buffer.alloc(32, 7), Buffer.alloc(32, 9)];
  const sizes = [];
  const randomBytes = (size) => { sizes.push(size); return draws.shift(); };
  const { forward, calls } = scripted(async () => upstream(200, { 'content-type': 'application/json' }));
  const { port, number } = await startPort(t, { forward, randomBytes });
  assert.deepEqual(sizes, [32, 32]);
  assert.equal(port.getApiKey(), Buffer.alloc(32, 7).toString('base64url'));
  const pending = call(number, { method: 'GET', path: '/v1/models', headers: goodHeaders(port, number) });
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].engineKey, Buffer.alloc(32, 9).toString('base64url'));
  calls.length = 0;
  pending.catch(() => {});
});

it('an Origin header is refused before the forwarder runs', async (t) => {
  const { forward, calls } = scripted(async () => answered());
  const { port, number } = await startPort(t, { forward });
  for (const origin of ['http://evil.example', 'null', `http://127.0.0.1:${number}`]) {
    const result = await call(number, { headers: goodHeaders(port, number, { Origin: origin }), body: '{}' });
    assert.equal(result.status, 403, origin);
    assert.equal(JSON.parse(result.body).error.code, 'team_engine_origin_refused');
  }
  assert.equal(calls.length, 0);
});

it('a wrong or missing Host header is refused before the forwarder runs (DNS rebinding)', async (t) => {
  const { forward, calls } = scripted(async () => answered());
  const { port, number } = await startPort(t, { forward });
  for (const host of [`localhost:${number}`, `127.0.0.1:${number + 1}`, '127.0.0.1', `evil.example:${number}`, `127.0.0.1:${number}.evil`]) {
    const result = await call(number, { headers: goodHeaders(port, number, { Host: host }), body: '{}' });
    assert.equal(result.status, 403, host);
    assert.equal(JSON.parse(result.body).error.code, 'team_engine_host_refused');
  }
  const headers = goodHeaders(port, number);
  delete headers.Host;
  const bare = await call(number, { headers, body: '{}' });
  assert.ok(bare.error || bare.status === 403 || bare.status === 400);
  assert.equal(calls.length, 0);
});

it('a missing or wrong key is refused before the forwarder runs', async (t) => {
  const { forward, calls } = scripted(async () => answered());
  const { port, number } = await startPort(t, { forward });
  const key = port.getApiKey();
  const flipped = (key[0] === 'A' ? 'B' : 'A') + key.slice(1);
  for (const authorization of [undefined, '', 'Bearer', `Bearer ${flipped}`, `Bearer ${key}x`, `Basic ${key}`, `bearer ${key}`, key]) {
    const headers = goodHeaders(port, number);
    if (authorization === undefined) delete headers.Authorization;
    else headers.Authorization = authorization;
    const result = await call(number, { headers, body: '{}' });
    assert.equal(result.status, 401, String(authorization).slice(0, 12));
    assert.equal(JSON.parse(result.body).error.code, 'team_engine_key_refused');
  }
  assert.equal(calls.length, 0);
});

it('a declared body over twice the cap is refused unread', async (t) => {
  const { forward, calls } = scripted(async () => answered());
  // A short idle limit: a port that waited for the declared body would close silently instead of answering 413.
  const { port, number } = await startPort(t, { forward, limits: { idleTimeoutMs: 1000 } });
  const declared = await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: number });
    const got = [];
    socket.on('data', (chunk) => got.push(chunk));
    socket.on('error', () => {});
    socket.on('close', () => resolve(Buffer.concat(got).toString('latin1')));
    socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${number}\r\nAuthorization: Bearer ${port.getApiKey()}\r\n`
      + `Content-Length: ${2 * 8 * 1024 * 1024 + 1}\r\n\r\n{"model":`);
  });
  assert.match(declared, /^HTTP\/1\.1 413 /u);
  assert.match(declared, /team_engine_request_too_large/u);
  assert.equal(calls.length, 0);
});

it('a body over the cap, declared or streamed, is drained unkept and answered 413; the forwarder never runs', async (t) => {
  const { forward, calls } = scripted(async () => answered());
  const { port, number } = await startPort(t, { forward });
  // A 12 MiB body (over the cap, under twice it) is written whole: answering while 4 MiB
  // still arrive would reset the connection and lose the 413.
  const whole = await call(number, { headers: goodHeaders(port, number), body: Buffer.alloc(12 * 1024 * 1024, 0x61) });
  assert.equal(whole.status, 413, whole.error ? `reset: ${whole.error.code}` : '');
  assert.equal(JSON.parse(whole.body).error.code, 'team_engine_request_too_large');

  const small = await startPort(t, { forward, limits: { maxBodyBytes: 1024 } });
  const chunked = await call(small.number, {
    headers: { ...goodHeaders(small.port, small.number), 'Transfer-Encoding': 'chunked' }, body: Buffer.alloc(1500, 0x61),
  });
  assert.equal(chunked.status, 413);
  const declared = await call(small.number, { headers: goodHeaders(small.port, small.number), body: Buffer.alloc(1025, 0x61) });
  assert.equal(declared.status, 413);
  // Past twice the cap a streamed body is cut off.
  const huge = await call(small.number, {
    headers: { ...goodHeaders(small.port, small.number), 'Transfer-Encoding': 'chunked' }, body: Buffer.alloc(4096, 0x61),
  });
  assert.ok(huge.error || huge.status === 413);
  assert.equal(calls.length, 0);
});

it('a body of exactly the cap is forwarded, declared or streamed', async (t) => {
  const { forward, calls } = scripted(async () => answered());
  const { port, number } = await startPort(t, { forward, limits: { maxBodyBytes: 1024 } });
  const body = Buffer.alloc(1024, 0x62);
  assert.equal((await call(number, { headers: goodHeaders(port, number), body })).status, 200);
  const chunked = await call(number, { headers: { ...goodHeaders(port, number), 'Transfer-Encoding': 'chunked' }, body });
  assert.equal(chunked.status, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, body);
  assert.deepEqual(calls[1].body, body);
});

it('Expect: 100-continue is refused with 417 before any body is invited', async (t) => {
  const { forward, calls } = scripted(async () => answered());
  const { port, number } = await startPort(t, { forward });
  const text = await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: number });
    const got = [];
    socket.on('data', (chunk) => got.push(chunk));
    socket.on('error', () => {});
    socket.on('close', () => resolve(Buffer.concat(got).toString('latin1')));
    socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${number}\r\nAuthorization: Bearer ${port.getApiKey()}\r\n`
      + 'Content-Length: 2\r\nExpect: 100-continue\r\n\r\n');
  });
  assert.doesNotMatch(text, /100 Continue/u);
  assert.match(text, /^HTTP\/1\.1 417 /u);
  assert.match(text, /team_engine_expect_refused/u);
  assert.equal(calls.length, 0);
});

it('a streamed reply with a tool call reaches the caller byte for byte, with the body and affinity key forwarded', async (t) => {
  const reply = upstream(200, { 'content-type': 'text/event-stream', 'x-upstream-private': 'dropped' });
  const { forward, calls } = scripted(async () => reply);
  const { port, number } = await startPort(t, { forward });
  const body = Buffer.from(JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'héllo ✓' }] }));
  const frames = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"Let me look"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\": \\"a.txt\\"}"}}]}}]}\n\n',
    ': keep-alive comment\n\n',
    'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":5}}\n\n',
    'data: [DONE]\n\n',
  ];
  const expected = Buffer.from(frames.join(''));
  const pending = call(number, { headers: goodHeaders(port, number), body });
  await waitFor(() => calls.length === 1);
  // Split mid-character and mid-frame: the port must not re-chunk by meaning.
  const cut = [0, 7, 100, 101, 250, expected.length];
  for (let i = 0; i < cut.length - 1; i += 1) {
    reply.body.write(expected.subarray(cut[i], cut[i + 1]));
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  reply.body.end();
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal(result.complete, true);
  assert.equal(result.headers['content-type'], 'text/event-stream');
  assert.equal(result.headers['x-upstream-private'], undefined);
  assert.deepEqual(result.body, expected);
  assert.equal(calls[0].route, 'chat');
  assert.deepEqual(calls[0].body, body);
  assert.match(calls[0].engineKey, KEY_SHAPE);
  assert.notEqual(calls[0].engineKey, port.getApiKey());
});

it('the caller going away ends the upstream, before and after the answer head', async (t) => {
  const reply = upstream();
  const { forward } = scripted(async () => reply);
  const { port, number } = await startPort(t, { forward });
  const gone = call(number, { headers: goodHeaders(port, number), body: '{}', onResponse: (response, request) => {
    response.once('data', () => request.destroy());
  } });
  reply.body.write('data: {"choices":[]}\n\n');
  await gone;
  await waitFor(() => reply.closed);
  await waitFor(() => port.resources().upstreams === 0 && port.resources().sockets === 0);

  // Still waiting for the forwarder: the abort signal fires, and a late answer is closed at once.
  let resolveLate;
  const late = upstream();
  const signals = [];
  const pendingPort = await startPort(t, { forward: ({ signal }) => { signals.push(signal); return new Promise((resolve) => { resolveLate = resolve; }); } });
  const req = http.request({ host: '127.0.0.1', port: pendingPort.number, method: 'POST', path: '/v1/chat/completions',
    headers: goodHeaders(pendingPort.port, pendingPort.number), setHost: false, agent: false });
  req.on('error', () => {});
  req.end('{}');
  await waitFor(() => signals.length === 1);
  req.destroy();
  await waitFor(() => signals[0].aborted);
  resolveLate(late);
  await waitFor(() => late.closed);
  await waitFor(() => pendingPort.port.resources().upstreams === 0);
});

// R16-F04: a chat answer never carries a status the sidecar's provider retry retries (5xx, 408, 409, 425,
// 429; tests/team-engine.test.js reads that table from the sidecar): 424 with the reason instead.
it('an upstream failure before any byte answers 424 with only a reason; a secret-bearing error is not echoed', async (t) => {
  let mode = 'team';
  const { forward } = scripted(async () => {
    if (typeof mode === 'number') { const reply = upstream(mode, { 'content-type': 'application/json' }); reply.body.end('{}'); return reply; }
    if (mode === 'team') throw new TeamError('CONNECTION_FAILED', 'team_connection_reset', { reset: true });
    throw new Error('Bearer secret-token-value at 10.0.0.5:4242 prompt text');
  });
  const { port, number } = await startPort(t, { forward });
  const first = await call(number, { headers: goodHeaders(port, number), body: '{}' });
  assert.equal(first.status, 424);
  assert.deepEqual(JSON.parse(first.body), { error: { message: 'team_connection_reset', type: 'team_engine_error', code: 'team_connection_reset' } });
  mode = 'other';
  const second = await call(number, { headers: goodHeaders(port, number), body: '{}' });
  assert.equal(second.status, 424);
  assert.deepEqual(JSON.parse(second.body), { error: { message: 'team_engine_unreachable', type: 'team_engine_error', code: 'team_engine_unreachable' } });
  for (const [status, shown] of [[502, 424], [504, 424], [429, 424], [409, 424], [500, 424], [404, 404], [400, 400]]) {
    mode = status;
    assert.equal((await call(number, { headers: goodHeaders(port, number), body: '{}' })).status, shown, `host ${status}`);
  }
});

it('an upstream failure mid-stream truncates the caller, never a clean end', async (t) => {
  const reply = upstream();
  const { forward } = scripted(async () => reply);
  const { port, number } = await startPort(t, { forward });
  const pending = call(number, { headers: goodHeaders(port, number), body: '{}' });
  reply.body.write('data: {"choices":[{"delta":{"content":"par"}}]}\n\n');
  setTimeout(() => reply.body.destroy(new Error('upstream lost')), 50);
  const result = await pending;
  assert.ok(result.error || result.complete === false, 'the caller must see a truncated stream');
});

it('GET /v1/models is forwarded with no body; its JSON passes through unchanged', async (t) => {
  const reply = upstream(200, { 'content-type': 'application/json' });
  const { forward, calls } = scripted(async () => reply);
  const { port, number } = await startPort(t, { forward });
  const pending = call(number, { method: 'GET', path: '/v1/models', headers: goodHeaders(port, number) });
  await waitFor(() => calls.length === 1);
  const text = '{"object":"list","data":[{"id":"qwen3.8","object":"model"}]}';
  reply.body.end(text);
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal(result.body.toString('utf8'), text);
  assert.equal(calls[0].route, 'models');
  assert.equal(calls[0].body, null);
});

it('an unknown path or method is 404 and never forwarded', async (t) => {
  const { forward, calls } = scripted(async () => answered());
  const { port, number } = await startPort(t, { forward });
  for (const [method, path] of [['POST', '/v1/embeddings'], ['GET', '/v1/chat/completions'], ['POST', '/v1/models'],
    ['GET', '/props'], ['POST', '/v1/chat/completions/'], ['POST', '/v1/chat/completions?x=1'], ['GET', '/v1/models/x']]) {
    const result = await call(number, { method, path, headers: goodHeaders(port, number), body: method === 'POST' ? '{}' : undefined });
    assert.equal(result.status, 404, `${method} ${path}`);
  }
  assert.equal(calls.length, 0);
});

it('the concurrency cap refuses a request over it and admits again once one finishes', async (t) => {
  const replies = [];
  const { forward, calls } = scripted(async () => { const reply = upstream(); replies.push(reply); return reply; });
  const { port, number } = await startPort(t, { forward, limits: { maxConcurrent: 1 } });
  const first = call(number, { headers: goodHeaders(port, number), body: '{}' });
  await waitFor(() => calls.length === 1);
  const second = await call(number, { headers: goodHeaders(port, number), body: '{}' });
  assert.equal(second.status, 424);
  assert.equal(JSON.parse(second.body).error.code, 'team_engine_busy');
  assert.equal(calls.length, 1);
  replies[0].body.end('data: [DONE]\n\n');
  assert.equal((await first).status, 200);
  const third = call(number, { headers: goodHeaders(port, number), body: '{}' });
  await waitFor(() => calls.length === 2);
  replies[1].body.end('ok');
  assert.equal((await third).status, 200);
});

it('a client that never finishes its headers is closed by the header timeout', async (t) => {
  const { forward, calls } = scripted(async () => upstream());
  const { port, number } = await startPort(t, { forward, limits: { headersTimeoutMs: 100 } });
  const started = Date.now();
  await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: number });
    socket.on('error', () => {});
    socket.on('close', resolve);
    socket.write('POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1');
  });
  assert.ok(Date.now() - started < 2000);
  assert.equal(calls.length, 0);
  await waitFor(() => port.resources().timers === 0 && port.resources().sockets === 0);
});

it('an idle socket in the middle of a body is closed by the idle timeout', async (t) => {
  const { forward, calls } = scripted(async () => upstream());
  const { port, number } = await startPort(t, { forward, limits: { idleTimeoutMs: 150 } });
  await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: number });
    socket.on('error', () => {});
    socket.on('close', resolve);
    socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${number}\r\nAuthorization: Bearer ${port.getApiKey()}\r\n`
      + 'Content-Length: 100\r\n\r\n{"a":');
  });
  assert.equal(calls.length, 0);
});

it('stop() during a live stream ends every socket and upstream, leaves nothing behind, and is safe twice', async (t) => {
  const reply = upstream();
  const { forward } = scripted(async () => reply);
  const { port, number } = await startPort(t, { forward, limits: { headersTimeoutMs: 5000 } });
  let streaming = null;
  const pending = call(number, { headers: goodHeaders(port, number), body: '{}', onResponse: (_response, request) => { streaming = request; } });
  reply.body.write('data: {}\n\n');
  await waitFor(() => port.resources().upstreams === 1 && port.resources().sockets >= 1);
  // A second socket still sending its headers holds a header timer.
  const idle = net.connect({ host: '127.0.0.1', port: number });
  idle.on('error', () => {});
  idle.write('GET /v1/models HTTP/1.1\r\n');
  await waitFor(() => port.resources().timers === 1);
  await bounded(port.stop());
  const afterStop = port.resources();
  const severed = reply.closed;
  const result = await bounded(pending, 2000);
  // The test's own client sockets close only after the snapshot: a port that kept its
  // sockets is caught above, and the file can still exit.
  streaming?.destroy();
  idle.destroy();
  assert.deepEqual(afterStop, { listening: false, sockets: 0, upstreams: 0, timers: 0, turns: 0 });
  assert.equal(severed, true);
  assert.ok(result && (result.error || result.complete === false), 'the caller sees the stream cut');
  await bounded(port.stop());
  assert.deepEqual(port.resources(), { listening: false, sockets: 0, upstreams: 0, timers: 0, turns: 0 });
});

it('a stopped port can start again with a new key', async () => {
  const port = createTeamEnginePort({ forward: async () => upstream() });
  await port.start();
  const first = port.getApiKey();
  await port.stop();
  await port.start();
  assert.match(port.getApiKey(), KEY_SHAPE);
  assert.notEqual(port.getApiKey(), first);
  await port.stop();
});

it('two ports have different keys and different affinity keys', async (t) => {
  const seen = [];
  const forward = async (request) => { seen.push(request.engineKey); const reply = upstream(200, {}); reply.body.end('{}'); return reply; };
  const a = await startPort(t, { forward });
  const b = await startPort(t, { forward });
  assert.notEqual(a.port.getApiKey(), b.port.getApiKey());
  await call(a.number, { method: 'GET', path: '/v1/models', headers: goodHeaders(a.port, a.number) });
  await call(b.number, { method: 'GET', path: '/v1/models', headers: goodHeaders(b.port, b.number) });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
});

it('no log record carries the key, the affinity key, a body, a reply, the port or an address', async (t) => {
  const marker = `PROMPT-${crypto.randomUUID()}`;
  const replyMarker = `REPLY-${crypto.randomUUID()}`;
  let engineKey = '';
  const { forward } = scripted(async (request) => {
    engineKey = request.engineKey;
    const reply = upstream();
    reply.body.end(`data: {"choices":[{"delta":{"content":"${replyMarker}"}}]}\n\n`);
    return reply;
  });
  const { port, records, number } = await startPort(t, { forward, limits: { maxBodyBytes: 4096 } });
  const body = JSON.stringify({ messages: [{ role: 'user', content: marker }] });
  assert.equal((await call(number, { headers: goodHeaders(port, number), body })).status, 200);
  await call(number, { headers: goodHeaders(port, number, { Authorization: `Bearer ${port.getApiKey().slice(1)}x` }), body });
  await call(number, { headers: goodHeaders(port, number, { Origin: 'http://evil.example' }), body });
  await call(number, { headers: goodHeaders(port, number, { Host: `localhost:${number}` }), body });
  await call(number, { headers: goodHeaders(port, number), body: `${marker}${'x'.repeat(5000)}` });
  await call(number, { method: 'GET', path: '/nope', headers: goodHeaders(port, number) });
  const key = port.getApiKey();
  await port.stop();
  assert.ok(records.length >= 6, 'the port logs its events');
  const text = JSON.stringify(records);
  for (const secret of [key, engineKey, marker, replyMarker, String(number), '127.0.0.1', 'localhost', 'evil.example']) {
    assert.equal(text.includes(secret), false, `log leaked ${secret.slice(0, 10)}`);
  }
});

it('stop() while start() is still listening leaves no listener and no key', async () => {
  const made = [];
  const original = http.createServer;
  http.createServer = (...args) => { const server = original(...args); made.push(server); return server; };
  let port;
  try {
    port = createTeamEnginePort({ forward: async () => answered() });
    const starting = port.start();
    await port.stop();
    await starting.catch(() => {});
  } finally {
    http.createServer = original;
  }
  const leftListening = made.map((server) => server.listening);
  const resources = port.resources();
  // A server left open is closed after the snapshot, so the file can still exit.
  for (const server of made) if (server.listening) server.close();
  assert.equal(made.length, 1);
  assert.deepEqual(leftListening, [false], 'the server start() made must be closed');
  assert.deepEqual(resources, { listening: false, sockets: 0, upstreams: 0, timers: 0, turns: 0 });
  assert.equal(port.getBaseUrl(), '');
  assert.equal(port.getApiKey(), '');
  assert.deepEqual(port.getStatus(), { state: 'stopped', alias: '' });
});

it('a forward answer whose body is not a readable stream is refused 424 and frees its slot', async (t) => {
  let malformed = true;
  const { forward } = scripted(async () => (malformed ? { status: 200, headers: {}, body: { pipe() {} } } : answered()));
  const { port, number } = await startPort(t, { forward, limits: { maxConcurrent: 1 } });
  const first = await call(number, { headers: goodHeaders(port, number), body: '{}' });
  assert.equal(first.status, 424);
  assert.equal(JSON.parse(first.body).error.code, 'team_engine_answer_invalid');
  await waitFor(() => port.resources().upstreams === 0);
  malformed = false;
  assert.equal((await call(number, { headers: goodHeaders(port, number), body: '{}' })).status, 200);
});

it('stop() while forward is pending aborts its signal and closes a late answer', async (t) => {
  const signals = [];
  let resolveLate;
  const late = upstream();
  const { port, number } = await startPort(t, { forward: ({ signal }) => {
    signals.push(signal);
    return new Promise((resolve) => { resolveLate = resolve; });
  } });
  const request = http.request({ host: '127.0.0.1', port: number, method: 'POST', path: '/v1/chat/completions',
    headers: goodHeaders(port, number), setHost: false, agent: false });
  const ended = new Promise((resolve) => { request.on('error', resolve); request.on('response', resolve); });
  request.end('{}');
  await waitFor(() => signals.length === 1);
  await bounded(port.stop());
  const aborted = signals[0].aborted;
  resolveLate(late);
  const closedLate = await waitFor(() => late.closed).then(() => true, () => false);
  const cut = await bounded(ended.then(() => true), 2000);
  // The test's own socket closes only after the snapshot, so a port that kept it still lets the file exit.
  request.destroy();
  assert.equal(aborted, true);
  assert.equal(closedLate, true);
  assert.equal(cut, true, 'the caller sees its request cut');
});

it('construction refuses a missing forwarder and unknown or out-of-range limits', () => {
  assert.throws(() => createTeamEnginePort({}), TypeError);
  assert.throws(() => createTeamEnginePort({ forward: async () => {}, limits: { nope: 1 } }), RangeError);
  assert.throws(() => createTeamEnginePort({ forward: async () => {}, limits: { maxConcurrent: 0 } }), RangeError);
  assert.throws(() => createTeamEnginePort({ forward: async () => {}, limits: { maxBodyBytes: 9 * 1024 * 1024 } }), RangeError);
});

// One engine key per conversation, carried by the sidecar's existing route token.
it('a marked turn forwards its conversation\'s key: the same tag the same key, another tag another, none the port key', async (t) => {
  const { forward, calls } = scripted(() => answered());
  const { port, records, number } = await startPort(t, { forward });
  const send = (token) => call(number, { headers: goodHeaders(port, number,
    token === undefined ? {} : { 'X-Jenny-Route-Token': token }), body: '{"stream":false}' });
  const first = port.markTurn('session_alpha');
  const again = await port.turnRoute.acquire({ sessionId: 'session_alpha' });
  const other = port.markTurn('session_beta');
  assert.match(first.token, KEY_SHAPE);
  assert.notEqual(first.token, again.token, 'each turn has its own token');
  for (const token of [first.token, again.token, other.token, undefined]) assert.equal((await send(token)).status, 200);
  const keys = calls.map((entry) => entry.engineKey);
  keys.forEach((key) => assert.match(key, KEY_SHAPE));
  assert.equal(keys[0], keys[1], 'the same conversation, the same key across turns');
  assert.notEqual(keys[0], keys[2], 'another conversation, another key');
  assert.equal(new Set(keys).size, 3, 'no token: the port\'s one key, as before');
  first.release();
  first.release();
  const released = await send(first.token);
  assert.deepEqual([released.status, JSON.parse(released.body).error.code], [403, 'team_engine_route_refused']);
  assert.equal((await send('A'.repeat(43))).status, 403, 'a token never issued is refused');
  assert.equal((await send('short')).status, 403, 'a malformed token is refused');
  assert.equal(calls.length, 4, 'nothing refused reached forward');
  assert.equal(port.resources().turns, 2);
  const text = JSON.stringify(records);
  for (const secret of [first.token, again.token, other.token, ...keys, 'session_alpha']) assert.equal(text.includes(secret), false);
  await port.stop();
  assert.equal(port.resources().turns, 0, 'stop forgets every turn');
  assert.throws(() => port.markTurn('session_alpha'), { reason: 'team_engine_stopped' });
});

it('a turn tag must be printable and at most 256 characters; live turns are bounded', async (t) => {
  const { port } = await startPort(t, { forward: () => answered() });
  for (const bad of ['', 'line\nbreak', 'x'.repeat(257), 42, null]) assert.throws(() => port.markTurn(bad), { reason: 'team_engine_tag_invalid' });
  const held = Array.from({ length: 64 }, (_, i) => port.markTurn(`session_${i}`));
  assert.throws(() => port.markTurn('session_extra'), { reason: 'team_engine_busy' });
  held[0].release();
  assert.ok(port.markTurn('session_extra').token);
});
