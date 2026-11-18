'use strict';

// The member's HTTP client over the member bridge's loopback port (slice 1f-1):
// the 40-byte member preamble is the first thing on every socket, the Host header
// is the team constant, no query string, bounded answers and a timeout. A reset
// with no answer is told apart from an answer.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const test = require('node:test');

const { TEAM_ERROR_CODES } = require('../services/backend/error-codes');
const { CEILINGS, TEAM_HOST: CLIENT_TEAM_HOST, createTeamHttp } = require('../services/team/http-client');
const { parseInvite } = require('../server/team/invites');
const { TEAM_HOST } = require('../server/team/team-http-server');
const { encodeMemberPreamble, MEMBER_PREAMBLE_BYTES } = require('../server/team/transport/preamble');
const { createMemberBridge } = require('../services/team/transport/member-bridge');
const { COMMAND_LIMITS, createTeamSession } = require('../services/team/team-session');
const { BATCH_MAX_BYTES } = require('../server/team/boards/board-commands');
const { createTeamClientHost } = require('./helpers/team-client-host');

const launchSecret = new Uint8Array(crypto.randomBytes(32));

// A loopback server that records every socket's bytes and answers with `respond`.
async function rawServer(t, respond) {
  const sockets = [];
  const server = net.createServer((socket) => {
    const record = { chunks: [], socket };
    sockets.push(record);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      record.chunks.push(chunk);
      const text = Buffer.concat(record.chunks).toString('latin1');
      if (text.includes('\r\n\r\n') && respond) respond(socket, record);
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => {
    for (const record of sockets) record.socket.destroy();
    server.close(() => resolve());
  }));
  return { port: server.address().port, sockets };
}

function answer(socket, status, body) {
  const text = JSON.stringify(body);
  socket.end(`HTTP/1.1 ${status} OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n`
    + `Connection: close\r\n\r\n${text}`);
}

test('the client host constant is the host listener constant', () => {
  assert.equal(CLIENT_TEAM_HOST, TEAM_HOST);
});

test('the member preamble is the first 40 bytes on the socket, then a plain request to the team host', async (t) => {
  const server = await rawServer(t, (socket) => answer(socket, 200, { ok: true, value: 1 }));
  const http = createTeamHttp({ port: server.port, launchSecret });
  const result = await http.request('POST', '/api/v1/team/hello', { body: { protocol_version: 1, app_version: '1.6.1' } });
  assert.deepEqual(result, { status: 200, json: { ok: true, value: 1 } });
  const bytes = Buffer.concat(server.sockets[0].chunks);
  assert.deepEqual(bytes.subarray(0, MEMBER_PREAMBLE_BYTES), encodeMemberPreamble(launchSecret));
  const head = bytes.subarray(MEMBER_PREAMBLE_BYTES).toString('latin1');
  assert.match(head, /^POST \/api\/v1\/team\/hello HTTP\/1\.1\r\n/);
  assert.match(head, /\r\nHost: jenny-team\.invalid\r\n/i);
  assert.match(head, /\r\nContent-Type: application\/json\r\n/i);
});

test('a bodyless call sends no body and a zero length', async (t) => {
  const server = await rawServer(t, (socket) => answer(socket, 200, { ok: true }));
  const http = createTeamHttp({ port: server.port, launchSecret });
  await http.request('POST', '/api/v1/team/status');
  const head = Buffer.concat(server.sockets[0].chunks).subarray(MEMBER_PREAMBLE_BYTES).toString('latin1');
  assert.doesNotMatch(head, /transfer-encoding/i);
  assert.match(head, /\r\ncontent-length: 0\r\n/i);
});

test('a path with a query string or an absolute form is refused before any socket opens', async (t) => {
  const server = await rawServer(t, (socket) => answer(socket, 200, { ok: true }));
  const http = createTeamHttp({ port: server.port, launchSecret });
  for (const bad of ['/api/v1/team/status?x=1', 'http://x/api', '//x', 'api', '/a#b']) {
    await assert.rejects(http.request('POST', bad), (error) => error.code === TEAM_ERROR_CODES.CONNECTION_FAILED
      && error.reason === 'team_path_invalid');
  }
  assert.equal(server.sockets.length, 0);
});

test('a socket closed with no answer is a reset, distinct from an answer', async (t) => {
  const server = await rawServer(t, (socket) => socket.destroy());
  const http = createTeamHttp({ port: server.port, launchSecret });
  await assert.rejects(http.request('POST', '/api/v1/team/leave'), (error) => error.reset === true
    && error.code === TEAM_ERROR_CODES.CONNECTION_FAILED && error.reason === 'team_connection_reset');
});

test('an answer that never comes times out as a reset', async (t) => {
  const server = await rawServer(t, () => {});
  const http = createTeamHttp({ port: server.port, launchSecret, timeoutMs: 150 });
  await assert.rejects(http.request('POST', '/api/v1/team/status'), (error) => error.reset === true
    && error.reason === 'team_request_timeout');
  assert.equal(http.openSockets(), 0);
});

test('an oversized or non-JSON answer is refused as a reset: a sent change may have happened', async (t) => {
  const big = await rawServer(t, (socket) => answer(socket, 200, { ok: true, pad: 'x'.repeat(5000) }));
  await assert.rejects(createTeamHttp({ port: big.port, launchSecret, maxResponseBytes: 1024 })
    .request('POST', '/api/v1/team/status'), (error) => error.reason === 'team_response_too_large' && error.reset === true);
  const garbage = await rawServer(t, (socket) => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc'));
  await assert.rejects(createTeamHttp({ port: garbage.port, launchSecret }).request('POST', '/api/v1/team/status'),
    (error) => error.reason === 'team_response_invalid' && error.reset === true);
});

test('caller headers cannot replace the fixed ones, and a bad header value is a TeamError', async (t) => {
  const server = await rawServer(t, (socket) => answer(socket, 200, { ok: true }));
  const http = createTeamHttp({ port: server.port, launchSecret });
  await http.request('POST', '/api/v1/commands', { body: { a: 1 },
    headers: { Host: 'evil.example', 'Content-Length': '0', Connection: 'keep-alive', 'X-Client-Token': 'tok' } });
  const head = Buffer.concat(server.sockets[0].chunks).subarray(MEMBER_PREAMBLE_BYTES).toString('latin1');
  assert.match(head, /\r\nHost: jenny-team\.invalid\r\n/i);
  assert.doesNotMatch(head, /evil\.example/);
  assert.match(head, /\r\nContent-Length: 7\r\n/i);
  assert.match(head, /\r\nConnection: close\r\n/i);
  assert.match(head, /\r\nX-Client-Token: tok\r\n/i);
  // A host-supplied token with a line break: refused before anything is sent, as a TeamError.
  const sockets = server.sockets.length;
  let thrown = null;
  let pending = null;
  try {
    pending = http.request('POST', '/api/v1/commands', { body: {}, headers: { 'X-Client-Token': 'a\r\nb' } });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown, null, 'no synchronous throw');
  await assert.rejects(pending, (error) => error.name === 'TeamError' && error.reason === 'team_request_invalid');
  await assert.rejects(http.openStream('/api/v1/events', { 'X-Client-Token': 'a\nb' }),
    (error) => error.name === 'TeamError' && error.reason === 'team_request_invalid');
  assert.equal(server.sockets.length, sockets);
});

test('a refused loopback connection is a reset', async () => {
  const probe = net.createServer();
  await new Promise((resolve) => { probe.listen(0, '127.0.0.1', resolve); });
  const { port } = probe.address();
  await new Promise((resolve) => { probe.close(resolve); });
  await assert.rejects(createTeamHttp({ port, launchSecret }).request('POST', '/api/v1/team/status'),
    (error) => error.reset === true);
});

test('through the member bridge: the preamble reaches the host, a socket without it gets nothing', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  // A live invite key is admitted, so the bridge comes online and carries the client's sockets.
  const { invite } = await host.invite({ actor: owner.member_id });
  const parsed = parseInvite(invite);
  const bridge = createMemberBridge({ spawnChild: host.memberSpawner,
    secretKey: Buffer.from(parsed.invite_secret_key, 'base64url'),
    hostPublicKey: Buffer.from(parsed.host_public_key, 'base64url'), addresses: parsed.hints, launchSecret });
  t.after(() => bridge.stop());
  assert.equal((await bridge.start()).state, 'online');
  const http = createTeamHttp({ port: bridge.port(), launchSecret });
  const hello = await http.request('POST', '/api/v1/team/hello', { body: { protocol_version: 1, app_version: '1.6.1' } });
  assert.equal(hello.status, 200);
  assert.equal(hello.json.team_id, parsed.team_id);

  const bare = net.connect({ host: '127.0.0.1', port: bridge.port() });
  const got = [];
  bare.on('data', (chunk) => got.push(chunk));
  bare.on('error', () => {});
  bare.write('POST /api/v1/team/hello HTTP/1.1\r\nHost: jenny-team.invalid\r\nContent-Length: 0\r\n\r\n');
  await new Promise((resolve) => { bare.on('close', resolve); });
  assert.equal(Buffer.concat(got).length, 0);
});

// Slice 4b member half: the streaming request that carries the team engine. The
// body is bounded, the answer body is handed back as raw bytes, and an idle
// limit, a head timeout, an abort signal and close() each end the socket.

function readAll(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', () => resolve({ bytes: Buffer.concat(chunks), failed: true }));
    stream.on('end', () => resolve({ bytes: Buffer.concat(chunks), failed: false }));
  });
}

test('the streaming POST writes the preamble first, then the body bytes unchanged', { timeout: 15_000 }, async (t) => {
  const server = await rawServer(t, (socket, record) => {
    const text = Buffer.concat(record.chunks).toString('latin1');
    if (record.answered || !text.endsWith('}]}')) return;
    record.answered = true;
    socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: x\n\n');
  });
  const http = createTeamHttp({ port: server.port, launchSecret });
  const body = Buffer.from('{"messages":[{"content":"héllo"}]}');
  const answer = await http.openRequestStream('POST', '/api/v1/team/engine/v1/chat/completions',
    { body, headers: { 'X-Client-Id': 'c1', Host: 'evil.example' } });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers['content-type'], 'text/event-stream');
  assert.equal((await readAll(answer.body)).bytes.toString('latin1'), 'data: x\n\n');
  await answer.closed;
  const bytes = Buffer.concat(server.sockets[0].chunks);
  assert.deepEqual(bytes.subarray(0, MEMBER_PREAMBLE_BYTES), encodeMemberPreamble(launchSecret));
  const wire = bytes.subarray(MEMBER_PREAMBLE_BYTES);
  const split = wire.indexOf('\r\n\r\n');
  const head = wire.subarray(0, split).toString('latin1');
  assert.match(head, /^POST \/api\/v1\/team\/engine\/v1\/chat\/completions HTTP\/1\.1\r\n/);
  assert.match(head, /\r\nHost: jenny-team\.invalid(\r\n|$)/i);
  assert.doesNotMatch(head, /evil\.example/);
  assert.match(head, new RegExp(`\\r\\nContent-Length: ${body.length}(\\r\\n|$)`, 'i'));
  assert.match(head, /\r\nContent-Type: application\/json(\r\n|$)/i);
  assert.match(head, /\r\nX-Client-Id: c1(\r\n|$)/i);
  assert.deepEqual(wire.subarray(split + 4), body);
  assert.equal(http.openSockets(), 0);
});

test('the streaming request refuses a body over its cap, a bad path or a bad method before any socket opens', { timeout: 15_000 }, async (t) => {
  const server = await rawServer(t, () => {});
  const http = createTeamHttp({ port: server.port, launchSecret });
  await assert.rejects(http.openRequestStream('POST', '/api/v1/team/engine/v1/chat/completions',
    { body: Buffer.alloc(8 * 1024 * 1024 + 1) }), (error) => error.reason === 'team_request_too_large' && error.reset !== true);
  await assert.rejects(http.openRequestStream('POST', '/api/v1/team/engine/v1/chat/completions',
    { body: Buffer.alloc(101), maxBodyBytes: 100 }), (error) => error.reason === 'team_request_too_large');
  await assert.rejects(http.openRequestStream('POST', '/api/v1/x?y=1', { body: Buffer.alloc(1) }),
    (error) => error.reason === 'team_path_invalid');
  await assert.rejects(http.openRequestStream('PUT', '/api/v1/x', { body: Buffer.alloc(1) }),
    (error) => error.reason === 'team_request_invalid');
  await assert.rejects(http.openRequestStream('GET', '/api/v1/x', { body: Buffer.alloc(1) }),
    (error) => error.reason === 'team_request_invalid');
  assert.equal(server.sockets.length, 0);
});

test('the answer body passes through as raw bytes, chunked framing removed and nothing parsed', { timeout: 15_000 }, async (t) => {
  const payload = Buffer.concat([Buffer.from('data: {"a":1}\n\n: comment\n'), Buffer.from([0x00, 0xff, 0xfe, 0x0a]),
    Buffer.from('{not json')]);
  const server = await rawServer(t, (socket, record) => {
    if (record.answered) return;
    record.answered = true;
    socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n\r\n');
    socket.write(Buffer.concat([Buffer.from('a\r\n'), payload.subarray(0, 10), Buffer.from('\r\n')]));
    const rest = payload.subarray(10);
    socket.end(Buffer.concat([Buffer.from(`${rest.length.toString(16)}\r\n`), rest, Buffer.from('\r\n0\r\n\r\n')]));
  });
  const http = createTeamHttp({ port: server.port, launchSecret });
  const answer = await http.openRequestStream('GET', '/api/v1/team/engine/v1/models');
  assert.equal(answer.status, 502);
  const read = await readAll(answer.body);
  assert.equal(read.failed, false);
  assert.deepEqual(read.bytes, payload);
  const head = Buffer.concat(server.sockets[0].chunks).subarray(MEMBER_PREAMBLE_BYTES).toString('latin1');
  assert.match(head, /^GET \/api\/v1\/team\/engine\/v1\/models HTTP\/1\.1\r\n/);
});

test('a silent answer body is closed by the idle limit and reads as a failure, never a clean end', { timeout: 15_000 }, async (t) => {
  const server = await rawServer(t, (socket, record) => {
    if (record.answered) return;
    record.answered = true;
    socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n');
  });
  const http = createTeamHttp({ port: server.port, launchSecret });
  const answer = await http.openRequestStream('POST', '/api/v1/team/engine/v1/chat/completions',
    { body: Buffer.from('{}'), idleTimeoutMs: 120 });
  const read = await readAll(answer.body);
  assert.equal(read.bytes.toString('latin1'), 'hello');
  assert.equal(read.failed, true);
  await answer.closed;
  assert.equal(http.openSockets(), 0);
});

test('close() ends the socket, and so does an abort before the answer head', { timeout: 15_000 }, async (t) => {
  const server = await rawServer(t, (socket, record) => {
    if (record.answered || record.hold) return;
    if (Buffer.concat(record.chunks).toString('latin1').includes('X-Hold: 1')) { record.hold = true; return; }
    record.answered = true;
    socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n');
  });
  const http = createTeamHttp({ port: server.port, launchSecret });
  const answer = await http.openRequestStream('POST', '/api/v1/team/engine/v1/chat/completions', { body: Buffer.from('{}') });
  answer.close();
  await answer.closed;
  const first = server.sockets[0].socket;
  await new Promise((resolve) => { if (first.destroyed) resolve(); else first.on('close', resolve); });
  assert.equal(http.openSockets(), 0);

  const controller = new AbortController();
  const pending = http.openRequestStream('POST', '/api/v1/team/engine/v1/chat/completions',
    { body: Buffer.from('{}'), headers: { 'X-Hold': '1' }, signal: controller.signal });
  while (!server.sockets[1]?.hold) await new Promise((resolve) => { setTimeout(resolve, 10); });
  controller.abort();
  await assert.rejects(pending, (error) => error.reason === 'team_request_aborted' && error.reset === true);
  assert.equal(http.openSockets(), 0);
  const aborted = new AbortController();
  aborted.abort();
  const before = server.sockets.length;
  await assert.rejects(http.openRequestStream('POST', '/api/v1/x', { body: Buffer.from('{}'), signal: aborted.signal }),
    (error) => error.reason === 'team_request_aborted');
  assert.equal(server.sockets.length, before);
});

test('an answer head that never comes times out as a reset', { timeout: 15_000 }, async (t) => {
  const server = await rawServer(t, () => {});
  const http = createTeamHttp({ port: server.port, launchSecret });
  await assert.rejects(http.openRequestStream('POST', '/api/v1/team/engine/v1/chat/completions',
    { body: Buffer.from('{}'), headTimeoutMs: 120 }), (error) => error.reason === 'team_request_timeout' && error.reset === true);
  assert.equal(http.openSockets(), 0);
});

test('the session sends the engine calls with the event stream client headers and a well-formed affinity key only', { timeout: 15_000 }, async () => {
  const calls = [];
  const fakeHttp = { openRequestStream: async (...args) => { calls.push(args); return { status: 200 }; } };
  const session = createTeamSession({ http: fakeHttp, appVersion: '1.7.0' });
  const client = { client_id: 'cid', client_token: 'ctok' };
  const engineKey = Buffer.alloc(32, 3).toString('base64url');
  const body = Buffer.from('{"stream":true}');
  const signal = new AbortController().signal;
  await session.engineChat(client, body, { engineKey, signal });
  await session.engineModels(client, { engineKey });
  await session.engineChat(client, body, { engineKey: 'short' });
  await session.engineModels(client);
  assert.equal(calls[0][0], 'POST');
  assert.equal(calls[0][1], '/api/v1/team/engine/v1/chat/completions');
  assert.deepEqual(calls[0][2].headers, { 'X-Client-Id': 'cid', 'X-Client-Token': 'ctok', 'X-Engine-Key': engineKey });
  assert.equal(calls[0][2].body, body);
  assert.equal(calls[0][2].signal, signal);
  assert.equal(calls[1][0], 'GET');
  assert.equal(calls[1][1], '/api/v1/team/engine/v1/models');
  assert.equal(calls[1][2].body, undefined);
  assert.deepEqual(calls[1][2].headers, { 'X-Client-Id': 'cid', 'X-Client-Token': 'ctok', 'X-Engine-Key': engineKey });
  assert.deepEqual(calls[2][2].headers, { 'X-Client-Id': 'cid', 'X-Client-Token': 'ctok' });
  assert.deepEqual(calls[3][2].headers, { 'X-Client-Id': 'cid', 'X-Client-Token': 'ctok' });
});

test('close() after a short answer has fully arrived and not been read raises no uncaught error', { timeout: 15_000 }, async (t) => {
  const server = await rawServer(t, (socket, record) => {
    if (record.answered) return;
    record.answered = true;
    socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
  });
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));
  const http = createTeamHttp({ port: server.port, launchSecret });
  const answer = await http.openRequestStream('GET', '/api/v1/team/engine/v1/models');
  // The whole answer is buffered and the internal pipeline has finished before close().
  const socket = server.sockets[0].socket;
  await new Promise((resolve) => { if (socket.destroyed) resolve(); else socket.on('close', resolve); });
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  answer.close();
  await answer.closed;
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(uncaught, []);
  assert.equal(http.openSockets(), 0);
});

test('a body of exactly the cap is sent', { timeout: 15_000 }, async (t) => {
  const server = await rawServer(t, (socket, record) => {
    if (record.answered || Buffer.concat(record.chunks).length < MEMBER_PREAMBLE_BYTES + 100) return;
    const text = Buffer.concat(record.chunks).toString('latin1');
    if (!text.endsWith('a'.repeat(100))) return;
    record.answered = true;
    socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  const http = createTeamHttp({ port: server.port, launchSecret });
  const answer = await http.openRequestStream('POST', '/api/v1/team/engine/v1/chat/completions',
    { body: Buffer.alloc(100, 0x61), maxBodyBytes: 100 });
  assert.equal(answer.status, 200);
  await readAll(answer.body);
});

test('a consumer that holds the answer back past the idle limit and then reads gets every byte, no idle error', { timeout: 15_000 }, async (t) => {
  const payload = Buffer.alloc(512 * 1024, 0x63);
  const server = await rawServer(t, (socket, record) => {
    if (record.answered) return;
    record.answered = true;
    socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`), payload]));
  });
  const http = createTeamHttp({ port: server.port, launchSecret });
  const answer = await http.openRequestStream('POST', '/api/v1/team/engine/v1/chat/completions',
    { body: Buffer.from('{}'), idleTimeoutMs: 100 });
  // Nobody reads for four idle periods: the stream is held back, not silent.
  await new Promise((resolve) => { setTimeout(resolve, 400); });
  const read = await readAll(answer.body);
  assert.equal(read.failed, false);
  assert.equal(read.bytes.length, payload.length);
});

// Slice 3-9: the command envelope. With none the body is byte for byte what it was; each field alone goes in its place;
// a bad value or an unknown field is refused and nothing is sent.
test('the command body without an envelope is unchanged; each envelope field is sent alone; a bad one sends nothing', async () => {
  const bodies = [];
  const fakeHttp = { request: async (method, path, options) => { bodies.push(JSON.stringify(options.body)); return { json: { ok: true } }; } };
  const session = createTeamSession({ http: fakeHttp, appVersion: '1.7.0' });
  const client = { client_id: 'cid', client_token: 'ctok' };
  const base = { client, bootEpoch: 'boot_1', requestId: 'req_1' };
  const today = '{"api_version":1,"operation":"team.members.list","request_id":"req_1","client_id":"cid","boot_epoch":"boot_1","params":{"a":1}}';
  await session.command('team.members.list', { a: 1 }, base);
  await session.command('team.members.list', { a: 1 }, { ...base, envelope: null });
  await session.command('team.members.list', { a: 1 }, { ...base, envelope: {} });
  assert.deepEqual(bodies, [today, today, today]);
  bodies.length = 0;
  for (const [name, value] of [['session_id', 'sess_1'], ['control_generation', 2], ['expected_revision', 'boot_1:4']]) {
    await session.command('team.members.list', { a: 1 }, { ...base, envelope: { [name]: value } });
    assert.equal(bodies.at(-1), today.replace(',"params"', `,${JSON.stringify(name)}:${JSON.stringify(value)},"params"`), name);
  }
  bodies.length = 0;
  for (const envelope of [{ session_id: 'a b' }, { session_id: 'x'.repeat(129) }, { control_generation: 0 }, { control_generation: 1.5 },
    { control_generation: '2' }, { expected_revision: 'x'.repeat(161) }, { expected_revision: 4 }, { params: {} },
    { session_id: 'sess_1', operation: 'x' }, [], 'sess_1', Object.create({ session_id: 'sess_1' })]) {
    const answer = await session.command('team.members.list', {}, { ...base, envelope });
    assert.deepEqual(answer, { ok: false, error: { code: 'invalid_request', reason: 'team_envelope_invalid' } }, JSON.stringify(envelope));
  }
  assert.deepEqual(bodies, [], 'nothing sent');
});

// Slice 3-9: PUT only to an upload's part route with at most one part of raw bytes; a download part read as raw
// bytes of at most one part; per-call limits clamped to their ceilings; every other route keeps its old rules.
const UPLOAD_PART = `/api/v1/projects/project_${'a'.repeat(128)}/uploads/upload_${'b'.repeat(40)}/files/3/parts/7`;
const DOWNLOAD_PART = `/api/v1/projects/project_alpha/downloads/manifest_${'c'.repeat(22)}/files/0/parts/0`;

test('a PUT goes only to an upload part route with raw bytes; anything else is refused before a socket opens', async (t) => {
  const server = await rawServer(t, (socket) => answer(socket, 200, { ok: true, index: 3, received: 4, complete: true }));
  const http = createTeamHttp({ port: server.port, launchSecret });
  const refused = (error) => ['team_request_invalid', 'team_path_invalid', 'team_request_too_large'].includes(error.reason);
  await assert.rejects(http.request('PUT', '/api/v1/commands', { body: {} }), refused);
  await assert.rejects(http.request('PUT', UPLOAD_PART, { body: {} }), refused);
  await assert.rejects(http.request('GET', DOWNLOAD_PART), refused);
  await assert.rejects(http.putPart(DOWNLOAD_PART, Buffer.from('x')), refused);
  await assert.rejects(http.putPart(UPLOAD_PART.replace('/parts/7', '/parts/07'), Buffer.from('x')), refused);
  await assert.rejects(http.putPart(UPLOAD_PART.replace('project_', 'project_../'), Buffer.from('x')), refused);
  await assert.rejects(http.putPart(UPLOAD_PART, Buffer.alloc(0)), refused);
  await assert.rejects(http.putPart(UPLOAD_PART, Buffer.alloc(4 * 1024 * 1024 + 1)), refused);
  await assert.rejects(http.putPart(UPLOAD_PART, 'text'), refused);
  await assert.rejects(http.getPart(UPLOAD_PART), refused);
  await assert.rejects(http.openRequestStream('GET', DOWNLOAD_PART), refused);
  await assert.rejects(http.openStream(DOWNLOAD_PART), refused);
  assert.equal(server.sockets.length, 0, 'no socket opened');
  const sent = await http.putPart(UPLOAD_PART, Buffer.from('abcd'), { headers: { 'X-Client-Id': 'c' } });
  assert.deepEqual(sent, { status: 200, json: { ok: true, index: 3, received: 4, complete: true } });
  const bytes = Buffer.concat(server.sockets[0].chunks).subarray(MEMBER_PREAMBLE_BYTES).toString('latin1');
  assert.ok(bytes.startsWith(`PUT ${UPLOAD_PART} HTTP/1.1\r\n`));
  assert.match(bytes, /\r\nContent-Type: application\/octet-stream\r\n/i);
  assert.match(bytes, /\r\nContent-Length: 4\r\n/i);
  assert.ok(bytes.endsWith('\r\n\r\nabcd'));
});

test('a download part is raw bytes of at most one part; a JSON refusal is read as JSON', async (t) => {
  let mode = 'bytes';
  const server = await rawServer(t, (socket) => {
    if (mode === 'json') { answer(socket, 409, { ok: false, error: { code: 'CMP-HOST-0004', reason: 'team_download_changed' } }); return; }
    const body = mode === 'big' ? Buffer.alloc(9) : Buffer.from('hello');
    socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${body.length}\r\n`
      + 'Connection: close\r\n\r\n', 'latin1'), body]));
  });
  const http = createTeamHttp({ port: server.port, launchSecret });
  const got = await http.getPart(DOWNLOAD_PART, { maxBytes: 8 });
  assert.equal(got.status, 200);
  assert.equal(got.bytes.toString(), 'hello');
  mode = 'big';
  await assert.rejects(http.getPart(DOWNLOAD_PART, { maxBytes: 8 }), (error) => error.reason === 'team_response_too_large');
  mode = 'json';
  assert.deepEqual(await http.getPart(DOWNLOAD_PART), { status: 409,
    json: { ok: false, error: { code: 'CMP-HOST-0004', reason: 'team_download_changed' } } });
});

test('per-call limits rise only to their ceilings; the defaults are unchanged', async (t) => {
  const big = await rawServer(t, (socket) => answer(socket, 200, { ok: true, pad: 'x'.repeat(2 * 1024 * 1024) }));
  const http = createTeamHttp({ port: big.port, launchSecret });
  await assert.rejects(http.request('POST', '/api/v1/commands'), (error) => error.reason === 'team_response_too_large');
  assert.equal((await http.request('POST', '/api/v1/commands', { maxResponseBytes: 4 * 1024 * 1024 })).json.ok, true);
  const huge = await rawServer(t, (socket) => answer(socket, 200, { ok: true, pad: 'x'.repeat(9 * 1024 * 1024) }));
  await assert.rejects(createTeamHttp({ port: huge.port, launchSecret }).request('POST', '/api/v1/commands',
    { maxResponseBytes: 1024 * 1024 * 1024 }), (error) => error.reason === 'team_response_too_large', 'clamped to 8 MiB');
  const sink = await rawServer(t, (socket) => answer(socket, 200, { ok: true }));
  const client = createTeamHttp({ port: sink.port, launchSecret });
  await assert.rejects(client.request('POST', '/api/v1/commands', { body: { pad: 'x'.repeat(70 * 1024) } }),
    (error) => error.reason === 'team_request_too_large', 'the 64 KiB default holds');
  assert.equal((await client.request('POST', '/api/v1/commands', { body: { pad: 'x'.repeat(70 * 1024) },
    maxRequestBytes: 128 * 1024 })).json.ok, true);
  await assert.rejects(client.request('POST', '/api/v1/commands', { body: { pad: 'x'.repeat(1024 * 1024 + 1) },
    maxRequestBytes: 64 * 1024 * 1024 }), (error) => error.reason === 'team_request_too_large', 'clamped to 1 MiB');
  assert.deepEqual(CEILINGS, { timeoutMs: 130_000, maxResponseBytes: 8 * 1024 * 1024, maxRequestBytes: 1024 * 1024 });
});

test('the timeout rises only to its ceiling, a bad one is the default; a part answer never exceeds one part', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let heard = 0;
  const silent = await rawServer(t, () => { heard += 1; });
  const http = createTeamHttp({ port: silent.port, launchSecret, timeoutMs: 150 });
  const outcome = (promise) => {
    const seen = { error: null };
    promise.then(() => { seen.error = 'resolved'; }, (error) => { seen.error = error.reason; });
    return seen;
  };
  const settleIo = async (count) => { const before = heard; while (heard < before + count) await new Promise((r) => setImmediate(r)); };
  const long = outcome(http.request('POST', '/api/v1/commands', { timeoutMs: 10 ** 9 }));
  const bad = outcome(http.request('POST', '/api/v1/commands', { timeoutMs: -5 }));
  await settleIo(2);
  t.mock.timers.tick(150);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([long.error, bad.error], [null, 'team_request_timeout'], 'a bad timeout is the 150 ms default');
  t.mock.timers.tick(CEILINGS.timeoutMs - 151);
  await new Promise((r) => setImmediate(r));
  assert.equal(long.error, null, 'still waiting 1 ms before the ceiling');
  t.mock.timers.tick(1);
  await new Promise((r) => setImmediate(r));
  assert.equal(long.error, 'team_request_timeout', 'clamped to 130 s');
  t.mock.timers.reset();
  const body = Buffer.alloc(4 * 1024 * 1024 + 1);
  const big = await rawServer(t, (socket) => socket.end(Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\n'
    + `Content-Type: application/octet-stream\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`, 'latin1'), body])));
  await assert.rejects(createTeamHttp({ port: big.port, launchSecret }).getPart(DOWNLOAD_PART, { maxBytes: 10 ** 12 }),
    (error) => error.reason === 'team_response_too_large', 'clamped to one 4 MiB part');
});

test('the session gives each heavy command its limits and nothing else any', async () => {
  const calls = [];
  const fakeHttp = { request: async (method, path, options) => { calls.push(options); return { json: { ok: true } }; } };
  const session = createTeamSession({ http: fakeHttp, appVersion: '1.7.0' });
  const base = { client: { client_id: 'cid', client_token: 't' }, bootEpoch: 'b', requestId: 'r' };
  for (const operation of ['team.members.list', 'team.project.upload.begin', 'team.project.upload.commit',
    'team.project.download.manifest', 'sessions.snapshot', 'sessions.list', 'team.board.apply', 'team.project.files.read']) await session.command(operation, {}, base);
  const limits = calls.map(({ timeoutMs, maxResponseBytes, maxRequestBytes }) => ({ timeoutMs, maxResponseBytes, maxRequestBytes }));
  assert.deepEqual(limits, [
    { timeoutMs: undefined, maxResponseBytes: undefined, maxRequestBytes: undefined },
    { timeoutMs: 60_000, maxResponseBytes: undefined, maxRequestBytes: 1024 * 1024 },
    { timeoutMs: 130_000, maxResponseBytes: undefined, maxRequestBytes: undefined },
    { timeoutMs: 130_000, maxResponseBytes: 2 * 1024 * 1024, maxRequestBytes: undefined },
    { timeoutMs: 30_000, maxResponseBytes: 8 * 1024 * 1024, maxRequestBytes: undefined },
    { timeoutMs: 30_000, maxResponseBytes: 8 * 1024 * 1024, maxRequestBytes: undefined },
    { timeoutMs: undefined, maxResponseBytes: undefined, maxRequestBytes: 256 * 1024 + 4096 },
    { timeoutMs: 45_000, maxResponseBytes: 6 * 1024 * 1024, maxRequestBytes: undefined }]); // row 175: a file read, up to a 4 MiB picture
  assert.deepEqual(Object.keys(COMMAND_LIMITS).sort(), ['sessions.list', 'sessions.snapshot', 'team.board.apply',
    'team.project.download.manifest', 'team.project.files.list', 'team.project.files.read', 'team.project.upload.begin', 'team.project.upload.commit']);
  // Row 151: a board batch as large as the host takes can be sent, with the longest envelope around it.
  const pad = { batch_id: `b-${crypto.randomUUID()}`, ops: [{ op: 'card.edit', id: crypto.randomUUID(), content_rev: 0, data: { text: '' } }] };
  pad.ops[0].data.text = 'x'.repeat(BATCH_MAX_BYTES - Buffer.byteLength(JSON.stringify(pad)));
  await session.command('team.board.apply', { project_id: `project_${'p'.repeat(128)}`, board_id: `board_${crypto.randomUUID()}`, batch: pad },
    { client: { client_id: 'c'.repeat(128), client_token: 't' }, bootEpoch: 'e'.repeat(128), requestId: crypto.randomUUID() });
  assert.deepEqual([Buffer.byteLength(JSON.stringify(pad)), Buffer.byteLength(JSON.stringify(calls.at(-1).body)) <= calls.at(-1).maxRequestBytes],
    [BATCH_MAX_BYTES, true]);
});

// Slice 6-5: the model part routes (server/team/model-routes.js) are raw part calls with the same 4 MiB cap: PUT raw
// bytes (1 byte to 4 MiB inclusive), GET raw bytes or a 204 that means "no part yet, ask again".
const MODEL_PART = `/api/v1/team/models/transfers/mxfer_${'a'.repeat(22)}/files/2/parts/9`;

test('model parts: PUT 4 MiB is sent, empty and 4 MiB + 1 are refused, a GET 204 is a wait, other shapes refused', async (t) => {
  let mode = 'json';
  const server = await rawServer(t, (socket, record) => {
    if (mode === 'empty') { socket.end('HTTP/1.1 204 No Content\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n'); return; }
    if (mode === 'bytes') {
      socket.end(Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 3\r\n'
        + 'Connection: close\r\n\r\n', 'latin1'), Buffer.from('abc')]));
      return;
    }
    const length = Number(/content-length: (\d+)/iu.exec(Buffer.concat(record.chunks).toString('latin1'))?.[1] || 0);
    if (Buffer.concat(record.chunks).length >= length) answer(socket, 200, { ok: true, ready: true });
  });
  const http = createTeamHttp({ port: server.port, launchSecret });
  const refused = (error) => ['team_request_invalid', 'team_path_invalid', 'team_request_too_large'].includes(error.reason);
  await assert.rejects(http.putPart(MODEL_PART, Buffer.alloc(0)), refused);
  await assert.rejects(http.putPart(MODEL_PART, Buffer.alloc(4 * 1024 * 1024 + 1)), refused);
  await assert.rejects(http.putPart(MODEL_PART.replace('mxfer_', 'mxfer_x'), Buffer.from('x')), refused);
  await assert.rejects(http.putPart(MODEL_PART.replace('/files/2', '/files/8'), Buffer.from('x')), refused);
  await assert.rejects(http.request('PUT', MODEL_PART, { body: {} }), refused);
  await assert.rejects(http.request('GET', MODEL_PART), refused);
  await assert.rejects(http.openStream(MODEL_PART), refused);
  await assert.rejects(http.openRequestStream('POST', MODEL_PART, { body: '{}' }), refused);
  assert.equal(server.sockets.length, 0, 'no socket opened');
  const sent = await http.putPart(MODEL_PART, Buffer.alloc(4 * 1024 * 1024, 7));
  assert.deepEqual(sent, { status: 200, json: { ok: true, ready: true } });
  mode = 'bytes';
  assert.equal((await http.getPart(MODEL_PART)).bytes.toString(), 'abc');
  mode = 'empty';
  assert.deepEqual(await http.getPart(MODEL_PART), { status: 204, empty: true });
  await assert.rejects(http.getPart(DOWNLOAD_PART), (error) => error.reason === 'team_response_invalid', 'a 204 elsewhere stays invalid');
});

test('model parts through the session: ids checked before a socket, the 204 answers a wait, one hello retry', async () => {
  const calls = [];
  const replies = [{ status: 204, empty: true }, { status: 200, bytes: Buffer.from('xy') }, { status: 200, json: { ok: true, ready: true } }];
  const fakeHttp = {
    getPart: async (path, options) => { calls.push(['GET', path, options.headers]); return replies.shift(); },
    putPart: async (path, bytes) => { calls.push(['PUT', path, bytes.length]); return replies.shift(); },
  };
  const session = createTeamSession({ http: fakeHttp, appVersion: '1.7.0' });
  const client = { client_id: 'cid', client_token: 'tok' };
  const transferId = `mxfer_${'b'.repeat(22)}`;
  assert.deepEqual(await session.getModelPart(client, { transferId: 'mxfer_bad', index: 0, n: 0 }),
    { ok: false, error: { code: 'invalid_request', reason: 'team_request_invalid' } });
  assert.deepEqual(await session.putModelPart(client, { transferId, index: 8, n: 0, bytes: Buffer.from('x') }),
    { ok: false, error: { code: 'invalid_request', reason: 'team_request_invalid' } });
  assert.equal(calls.length, 0);
  assert.deepEqual(await session.getModelPart(client, { transferId, index: 1, n: 3 }), { ok: true, ready: false, wait: 'not_ready' });
  assert.equal((await session.getModelPart(client, { transferId, index: 1, n: 3 })).bytes.toString(), 'xy');
  assert.deepEqual(await session.putModelPart(client, { transferId, index: 0, n: 0, bytes: Buffer.from('p') }), { ok: true, ready: true });
  assert.deepEqual(calls[0], ['GET', `/api/v1/team/models/transfers/${transferId}/files/1/parts/3`, { 'X-Client-Id': 'cid', 'X-Client-Token': 'tok' }]);
  assert.deepEqual(calls[2], ['PUT', `/api/v1/team/models/transfers/${transferId}/files/0/parts/0`, 1]);
});
