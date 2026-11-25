'use strict';

// new-test-file: tests/server/team-http.test.js is at 575 lines, so these cases for the hello table (review H9)
// live beside it. The team HTTP layer over stand-in directory, store and router, driven through real sockets.

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { TEAM_HOST, createTeamHttpServer } = require('../../server/team/team-http-server');

const FORBIDDEN = 403;
// Keys from this index on belong to an unredeemed invite (role `invite`); the rest are active members.
const INVITE_FROM = 1000;

function stubContext() {
  const deviceOf = (key) => Buffer.from(key, 'base64url').readUInt32BE(0);
  const actorOf = (id) => ({ member_id: id < INVITE_FROM ? `m_${id}` : null, device_id: `d_${id}`,
    role: id < INVITE_FROM ? 'member' : 'invite', state: id < INVITE_FROM ? 'active' : 'invited' });
  const idOf = (deviceId) => Number(deviceId.slice(2));
  return {
    resourceLimits: { maxConcurrentRequests: 8 }, logger: () => {}, addresses: () => [], isReady: () => true,
    bootEpoch: 'boot', clients: {}, events: { heartbeat() {} }, router: {}, assetRoutes: null,
    authorize: () => ({ ok: true }), dropKey: () => 0,
    directory: { resolveActor: (key) => actorOf(deviceOf(key)), liveActor: (id) => actorOf(idOf(id)),
      isDeviceActive: () => true },
    store: { teamId: () => 'team_x', teamName: () => 'x', onMembershipChange: () => () => {} },
  };
}

async function openLayer(t) {
  const layer = createTeamHttpServer(stubContext());
  const keys = [];
  layer.server.on('connection', (socket) => {
    Object.defineProperty(socket, 'teamKey', { value: keys.shift(), writable: false });
  });
  await new Promise((resolve) => { layer.server.listen(0, '127.0.0.1', resolve); });
  t.after(() => layer.close());
  const { port } = layer.server.address();
  const keyFor = (index) => { const bytes = Buffer.alloc(32); bytes.writeUInt32BE(index, 0); return bytes.toString('base64url'); };
  const hello = JSON.stringify({ protocol_version: 1, app_version: 'a' }).padEnd(40);
  return (index, path) => new Promise((resolve, reject) => {
    keys.push(keyFor(index));
    const isHello = path.endsWith('hello');
    const request = http.request({ agent: false, host: '127.0.0.1', port, method: 'POST', path,
      headers: { Host: TEAM_HOST, 'Content-Type': 'application/json', 'Content-Length': isHello ? 40 : 0 } },
    (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.end(isHello ? hello : undefined);
  });
}

test('a greeted member is not pushed out of the hello table by 130 unredeemed invites', async (t) => {
  const call = await openLayer(t);
  assert.equal(await call(1, '/api/v1/team/hello'), 200);
  for (let index = INVITE_FROM; index < INVITE_FROM + 130; index += 1) {
    assert.equal(await call(index, '/api/v1/team/hello'), 200);
  }
  assert.equal(await call(1, '/api/v1/team/status'), 200, 'the member is still greeted');
  assert.equal(await call(INVITE_FROM, '/api/v1/team/status'), FORBIDDEN, 'the oldest invite was the one evicted');
  assert.equal(await call(INVITE_FROM + 129, '/api/v1/team/status'), 200);
});

test('a request from a greeted device refreshes its place, so the oldest idle one is evicted instead', async (t) => {
  const call = await openLayer(t);
  for (let index = 1; index <= 128; index += 1) assert.equal(await call(index, '/api/v1/team/hello'), 200);
  assert.equal(await call(1, '/api/v1/team/status'), 200, 'the oldest device is active again');
  assert.equal(await call(129, '/api/v1/team/hello'), 200);
  assert.equal(await call(1, '/api/v1/team/status'), 200, 'the active device kept its hello');
  assert.equal(await call(2, '/api/v1/team/status'), FORBIDDEN, 'the idle one was evicted');
});
