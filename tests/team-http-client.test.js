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
const { TEAM_HOST: CLIENT_TEAM_HOST, createTeamHttp } = require('../services/team/http-client');
const { parseInvite } = require('../server/team/invites');
const { TEAM_HOST } = require('../server/team/team-http-server');
const { encodeMemberPreamble, MEMBER_PREAMBLE_BYTES } = require('../server/team/transport/preamble');
const { createMemberBridge } = require('../services/team/transport/member-bridge');
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
