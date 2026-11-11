'use strict';

// Team slice 1c-2a: the team HTTP layer behind the preamble listener. The real
// listener over a real member store, a fake backend and a raw preamble client.

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');

const { deriveTeamId } = require('../../server/team/ids');
const { TEAM_HOST, createTeamHttpServer } = require('../../server/team/team-http-server');
const { PROTOCOL_RANGE } = require('../../server/team/team-routes');
const { command } = require('../helpers/command-router-fixture');
const { createTeamHttpFixture, pause, randomPublicKey, waitUntil } = require('./helpers/team-http-fixture');
const { createTeamHostFixture } = require('./helpers/team-host-fixture');
const packageJson = require('../../package.json');

const FORBIDDEN = 403;

function reasonOf(response) {
  return response.json?.error?.reason;
}

test('a valid key says hello and gets the team id, the supported range and the host addresses', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { owner } = await env.seed();
  const client = env.client(owner.key);
  const response = await client.hello();
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    ok: true, api_version: 1, protocol: { min: 1, max: 1 }, team_id: deriveTeamId(env.fx.hostPublicKey),
    app_version: packageJson.version, addresses: ['192.0.2.7:4242'],
  });
  assert.deepEqual(PROTOCOL_RANGE, { min: 1, max: 1 });
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
});

test('every other route answers team_hello_required before hello', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { owner } = await env.seed();
  const routes = [
    ['POST', '/api/v1/team/status'], ['POST', '/api/v1/team/join'], ['POST', '/api/v1/team/leave'],
    ['GET', '/api/v1/team/bootstrap'], ['POST', '/api/v1/clients'], ['POST', '/api/v1/commands'],
    ['GET', '/api/v1/events'], ['GET', '/healthz'], ['GET', '/'],
  ];
  const client = env.client(owner.key);
  for (const [method, path] of routes) {
    const response = await client.request(method, path);
    assert.equal(response.status, FORBIDDEN, `${method} ${path}`);
    assert.equal(reasonOf(response), 'team_hello_required', `${method} ${path}`);
  }
  assert.equal((await client.hello()).status, 200);
  assert.equal((await client.request('POST', '/api/v1/team/status')).status, 200);
});

test('hello below the supported range answers team_client_too_old and the socket closes', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { owner } = await env.seed();
  const client = env.client(owner.key);
  const response = await client.hello(0);
  assert.equal(response.status, 409);
  assert.equal(reasonOf(response), 'team_client_too_old');
  assert.equal(await waitUntil(() => client.socket.destroyed), true);
  assert.deepEqual(env.dropped, [owner.key]);
});

test('hello above the supported range answers team_server_too_old and the socket closes', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { member } = await env.seed();
  const client = env.client(member.key);
  const response = await client.hello(2);
  assert.equal(response.status, 409);
  assert.equal(reasonOf(response), 'team_server_too_old');
  assert.equal(await waitUntil(() => client.socket.destroyed), true);
  assert.deepEqual(env.dropped, [member.key]);
  const again = env.client(member.key);
  assert.equal((await again.request('POST', '/api/v1/team/status')).status, FORBIDDEN, 'a refused hello does not count');
});

test('a malformed hello body is invalid and does not count as a hello', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { owner } = await env.seed();
  const client = env.client(owner.key);
  const bodies = [
    {}, { protocol_version: 1 }, { protocol_version: '1', app_version: '1.0' }, { protocol_version: 1.5, app_version: '1' },
    { protocol_version: 65536, app_version: '1' }, { protocol_version: -1, app_version: '1' },
    { protocol_version: 1, app_version: '' }, { protocol_version: 1, app_version: 'x'.repeat(33) },
    { protocol_version: 1, app_version: '1', extra: true },
  ];
  for (const body of bodies) {
    const response = await client.request('POST', '/api/v1/team/hello', { body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(reasonOf(response), 'request_failed', JSON.stringify(body));
  }
  const notJson = await client.request('POST', '/api/v1/team/hello', { rawBody: '[1]' });
  assert.equal(notJson.status, 400);
  assert.equal(reasonOf(await client.request('POST', '/api/v1/team/status')), 'team_hello_required');
});

test('a valid preamble carrying a key that is not in the store gets no answer and a closed socket', async (t) => {
  const env = await createTeamHttpFixture(t);
  await env.seed();
  const stranger = env.client(randomPublicKey());
  await assert.rejects(stranger.hello());
  assert.equal(await waitUntil(() => stranger.socket.destroyed), true);
  assert.equal(env.listener.port, env.port);
});

test('a wrong Host header is refused', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { owner } = await env.seed();
  for (const host of ['example.com', 'jenny-team.invalid:80', 'JENNY-TEAM.INVALID']) {
    const response = await env.client(owner.key, { host }).hello();
    assert.equal(response.status, FORBIDDEN, host);
    assert.equal(reasonOf(response), 'authentication_failed', host);
  }
  assert.equal(TEAM_HOST, 'jenny-team.invalid');
});

test('the URL rules of the single-owner server apply', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { owner } = await env.seed();
  const client = env.client(owner.key);
  const query = await client.request('POST', '/api/v1/team/status?x=1');
  assert.equal(query.status, 400);
  assert.equal(reasonOf(query), 'query_not_supported');
  const doubleSlash = await client.request('GET', '//evil.example/x');
  assert.equal(doubleSlash.status, 400);
  assert.equal(reasonOf(doubleSlash), 'invalid_route');
  const long = await client.request('GET', `/${'a'.repeat(2100)}`);
  assert.equal(reasonOf(long), 'invalid_route');
});

// The five principals against the routes that are not destructive: a number is the
// expected status, a string the guard's reason on a 403, null a route covered elsewhere.
const MATRIX = {
  owner: { status: 200, join: 'role_forbidden', leave: 'role_forbidden', bootstrap: 200, clients: 200, commands: null, events: null },
  member: { status: 200, join: 'role_forbidden', leave: null, bootstrap: 200, clients: 200, commands: null, events: null },
  readOnly: { status: 200, join: 'role_forbidden', leave: null, bootstrap: 200, clients: 200, commands: null, events: null },
  pending: { status: 200, join: 'member_pending', leave: null, bootstrap: 'member_pending', clients: 'member_pending',
    commands: 'member_pending', events: 'member_pending' },
  invite: { status: 'role_forbidden', join: null, leave: 'role_forbidden', bootstrap: 'role_forbidden',
    clients: 'role_forbidden', commands: 'role_forbidden', events: 'role_forbidden' },
};
const ROUTES = {
  status: ['POST', '/api/v1/team/status', undefined],
  join: ['POST', '/api/v1/team/join', { device_public_key: 'x', display_name: 'x', label: 'x' }],
  leave: ['POST', '/api/v1/team/leave', undefined],
  bootstrap: ['GET', '/api/v1/team/bootstrap', undefined],
  clients: ['POST', '/api/v1/clients', undefined],
  commands: ['POST', '/api/v1/commands', { operation: 'sessions.list' }],
  events: ['GET', '/api/v1/events', undefined],
};

test('the matrix over owner, member, read-only, pending member and invite principal', async (t) => {
  const env = await createTeamHttpFixture(t);
  const seeded = await env.seed();
  const keys = { owner: seeded.owner.key, member: seeded.member.key, readOnly: seeded.readOnly.key,
    pending: seeded.pending.key, invite: seeded.invite.key };
  for (const [principal, expectations] of Object.entries(MATRIX)) {
    const client = env.client(keys[principal]);
    assert.equal((await client.hello()).status, 200, `${principal} hello`);
    for (const [name, expected] of Object.entries(expectations)) {
      if (expected === null) continue;
      const [method, path, body] = ROUTES[name];
      const response = await client.request(method, path, { body });
      const label = `${principal} ${name}`;
      if (typeof expected === 'number') {
        assert.equal(response.status, expected, label);
      } else {
        assert.equal(response.status, FORBIDDEN, label);
        assert.equal(reasonOf(response), expected, label);
      }
    }
  }
  // Every guarded denial was answered without touching the store.
  assert.equal(env.redeemCalls.length, 0);
});

test('status and bootstrap describe the caller from the live store', async (t) => {
  const env = await createTeamHttpFixture(t);
  const seeded = await env.seed();
  const pending = env.client(seeded.pending.key);
  await pending.hello();
  const status = await pending.request('POST', '/api/v1/team/status');
  assert.deepEqual(status.json, { ok: true, team_id: deriveTeamId(env.fx.hostPublicKey), team_name: env.fx.teamName,
    member_id: seeded.pending.member_id, device_id: seeded.pending.device_id, role: 'member', state: 'pending' });
  const owner = env.client(seeded.owner.key);
  await owner.hello();
  const boot = await owner.request('GET', '/api/v1/team/bootstrap');
  assert.deepEqual(boot.json, { ok: true, api_version: 1, boot_epoch: env.context.bootEpoch, ready: true,
    team: { team_id: deriveTeamId(env.fx.hostPublicKey), name: env.fx.teamName },
    member: { member_id: seeded.owner.member_id, role: 'owner', state: 'active' }, tools: { execution: false } });
  env.setReady(false);
  assert.equal((await owner.request('GET', '/api/v1/team/bootstrap')).json.ready, false);
});

test('a registered client of an active member gets an answer from sessions.list through commands', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { member, owner } = await env.seed();
  const memberClient = env.client(member.key);
  const ownerClient = env.client(owner.key);
  await memberClient.hello();
  await ownerClient.hello();
  const auth = await memberClient.registerClient();
  const otherAuth = await ownerClient.registerClient();
  const body = { ...command(auth, 'sessions.list'), boot_epoch: env.context.bootEpoch };
  const answer = await memberClient.request('POST', '/api/v1/commands',
    { body, headers: { 'X-Client-Token': auth.client_token } });
  assert.equal(answer.status, 200);
  assert.equal(answer.json.ok, true);
  const foreign = await memberClient.request('POST', '/api/v1/commands',
    { body, headers: { 'X-Client-Token': otherAuth.client_token } });
  assert.equal(foreign.status, 401);
  assert.equal(reasonOf(foreign), 'client_unauthorized');
});

test('client registration answers client_capacity when the device is full', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { member } = await env.seed();
  const client = env.client(member.key);
  await client.hello();
  for (let index = 0; index < 4; index += 1) assert.equal((await client.request('POST', '/api/v1/clients')).status, 200);
  const full = await client.request('POST', '/api/v1/clients');
  assert.equal(full.status, 429);
  assert.equal(reasonOf(full), 'client_capacity');
});

test('request capacity is enforced before anything else', async (t) => {
  const env = await createTeamHttpFixture(t, { resourceLimits: { maxConcurrentRequests: 1 } });
  const { owner, member } = await env.seed();
  const holder = env.client(owner.key);
  assert.equal((await holder.hello()).status, 200);
  const held = http.request({ agent: holder.agent, host: '127.0.0.1', port: env.port, method: 'POST',
    path: '/api/v1/commands', headers: { Host: TEAM_HOST, 'Content-Type': 'application/json', 'Content-Length': 100 } });
  held.on('error', () => {});
  held.write('{');
  await pause(80);
  const refused = await env.client(member.key).hello();
  assert.equal(refused.status, 429);
  assert.equal(reasonOf(refused), 'request_capacity');
  held.destroy();
});

test('an owner and a member hold event streams; a revoked member receives nothing after the revoke', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { owner, member } = await env.seed();
  const ownerClient = env.client(owner.key);
  const memberClient = env.client(member.key);
  await ownerClient.hello();
  await memberClient.hello();
  const ownerStream = await ownerClient.openStream(await ownerClient.registerClient());
  const memberStream = await memberClient.openStream(await memberClient.registerClient());
  assert.equal(ownerStream.status, 200);
  assert.equal(memberStream.status, 200);
  env.core.events.publish('probe_one', {});
  assert.equal(await waitUntil(() => ownerStream.frames.join('').includes('probe_one')
    && memberStream.frames.join('').includes('probe_one')), true);
  // The owner's device revokes the member through the store.
  const revoked = await env.store.revokeMember({ actorMemberId: owner.member_id, memberId: member.member_id });
  assert.equal(revoked.ok, true);
  env.core.events.publish('probe_two', {});
  assert.equal(await waitUntil(() => ownerStream.frames.join('').includes('probe_two')), true);
  assert.equal(await waitUntil(() => memberStream.closed), true);
  assert.equal(memberStream.frames.join('').includes('probe_two'), false);
  await assert.rejects(memberClient.request('POST', '/api/v1/team/status'));
  assert.equal(await waitUntil(() => memberClient.socket.destroyed), true);
});

test('a member demoted to read-only keeps the event stream', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { owner, member } = await env.seed();
  const memberClient = env.client(member.key);
  await memberClient.hello();
  const stream = await memberClient.openStream(await memberClient.registerClient());
  const demoted = await env.store.setRole({ actorMemberId: owner.member_id, memberId: member.member_id, role: 'read_only' });
  assert.equal(demoted.ok, true);
  env.core.events.publish('after_demotion', {});
  assert.equal(await waitUntil(() => stream.frames.join('').includes('after_demotion')), true);
  assert.equal(stream.closed, false);
});

test('a device revoked mid-connection is dropped on its next request', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { owner, member } = await env.seed();
  const memberClient = env.client(member.key);
  await memberClient.hello();
  const revoked = await env.store.revokeDevice({ actorMemberId: owner.member_id, deviceId: member.device_id });
  assert.equal(revoked.ok, true);
  await assert.rejects(memberClient.request('POST', '/api/v1/team/status'));
});

test('the log lines carry no key, invite string, display name, label, team name or address', async (t) => {
  const env = await createTeamHttpFixture(t);
  const seeded = await env.seed();
  const invite = env.client(seeded.invite.key);
  await invite.hello();
  const newKey = randomPublicKey();
  const joined = await invite.request('POST', '/api/v1/team/join',
    { body: { device_public_key: newKey, display_name: 'Nora Newcomer', label: 'Office Phone' } });
  assert.equal(joined.status, 200);
  const stranger = env.client(randomPublicKey());
  await assert.rejects(stranger.hello());
  const owner = env.client(seeded.owner.key);
  await owner.hello();
  await owner.request('POST', '/api/v1/commands', { rawBody: '{' });
  const text = env.logText();
  const secrets = [newKey, seeded.invite.key, seeded.owner.key, seeded.member.key, 'Nora Newcomer', 'Office Phone',
    'Olive Owner', 'Mika Member', 'Laptop', env.fx.teamName, '192.0.2.7', env.bootSecret.toString('base64url'),
    env.bootSecret.toString('hex')];
  for (const secret of secrets) assert.equal(text.includes(secret), false, `log leaks ${secret.slice(0, 6)}`);
});

// A directory of stand-ins to reach the hello table without eight-member limits.
function stubContext() {
  const listeners = [];
  const everyone = (deviceId) => ({ member_id: `m_${deviceId}`, device_id: deviceId, role: 'member', state: 'active' });
  const deviceOf = (key) => `d_${Buffer.from(key, 'base64url').readUInt32BE(0)}`;
  return {
    listeners,
    context: {
      resourceLimits: { maxConcurrentRequests: 8 }, logger: () => {}, addresses: () => [], isReady: () => true,
      bootEpoch: 'boot', clients: {}, events: { heartbeat() {} }, router: {}, assetRoutes: null,
      authorize: () => ({ ok: true }),
      directory: { resolveActor: (key) => everyone(deviceOf(key)), liveActor: (id) => everyone(id), isDeviceActive: () => true },
      store: { teamId: () => 'team_x', teamName: () => 'x',
        onMembershipChange: (listener) => { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1); } },
    },
  };
}

test('hello state is bounded to 128 devices and a revoke event forgets its devices', async (t) => {
  const { context, listeners } = stubContext();
  const layer = createTeamHttpServer(context);
  const keys = [];
  layer.server.on('connection', (socket) => {
    Object.defineProperty(socket, 'teamKey', { value: keys.shift(), writable: false });
  });
  await new Promise((resolve) => { layer.server.listen(0, '127.0.0.1', resolve); });
  t.after(() => layer.close());
  const { port } = layer.server.address();
  const keyFor = (index) => { const bytes = Buffer.alloc(32); bytes.writeUInt32BE(index, 0); return bytes.toString('base64url'); };
  const call = (index, path) => new Promise((resolve, reject) => {
    keys.push(keyFor(index));
    const request = http.request({ agent: false, host: '127.0.0.1', port, method: 'POST', path,
      headers: { Host: TEAM_HOST, 'Content-Type': 'application/json', 'Content-Length': path.endsWith('hello') ? 40 : 0 } },
    (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.end(path.endsWith('hello') ? JSON.stringify({ protocol_version: 1, app_version: 'a' }).padEnd(40) : undefined);
  });
  for (let index = 1; index <= 129; index += 1) assert.equal(await call(index, '/api/v1/team/hello'), 200);
  assert.equal(await call(1, '/api/v1/team/status'), FORBIDDEN, 'the oldest entry was evicted');
  assert.equal(await call(129, '/api/v1/team/status'), 200);
  assert.equal(await call(2, '/api/v1/team/status'), 200);
  assert.equal(listeners.length, 1);
  listeners[0]({ kind: 'device_revoked', member_id: 'm', device_ids: ['d_129'], role: 'member', at: 0 });
  assert.equal(await call(129, '/api/v1/team/status'), FORBIDDEN, 'a revoke forgets the hello');
  assert.equal(await call(2, '/api/v1/team/status'), 200);
  await layer.close();
  assert.equal(listeners.length, 0, 'close unsubscribes from membership events');
  await layer.close();
});

test('a raw client without any HTTP-level answer is not served before the preamble', async (t) => {
  const env = await createTeamHttpFixture(t);
  const socket = net.connect({ host: '127.0.0.1', port: env.port });
  const received = [];
  socket.on('data', (chunk) => received.push(chunk));
  socket.on('error', () => {});
  const closed = new Promise((resolve) => socket.on('close', resolve));
  socket.write(`POST /api/v1/team/hello HTTP/1.1\r\nHost: ${TEAM_HOST}\r\nContent-Length: 2\r\nX-Pad: ${'a'.repeat(40)}\r\n\r\n{}`);
  await closed;
  assert.equal(Buffer.concat(received).length, 0);
});

test('the default listener of the start sequence serves a member through the transport bridge and stops cleanly', async (t) => {
  const fx = createTeamHostFixture(t);
  const client = fx.client();
  await fx.seedMembers(client.deviceKey);
  // `createListener: undefined` keeps the default, which is the real team listener.
  const host = await fx.start(null, { createListener: undefined });
  assert.equal(await fx.isListening(host.port), true);
  const conn = await fx.connect(client);
  const stream = await conn.openStream();
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  stream.on('error', () => {});
  const body = JSON.stringify({ protocol_version: 1, app_version: '1.6.1' });
  stream.write(`POST /api/v1/team/hello HTTP/1.1\r\nHost: ${TEAM_HOST}\r\nContent-Type: application/json\r\n`
    + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  assert.equal(await waitUntil(() => Buffer.concat(chunks).toString().includes('"team_id"')), true);
  const answer = Buffer.concat(chunks).toString();
  assert.equal(answer.startsWith('HTTP/1.1 200'), true);
  assert.equal(answer.includes(deriveTeamId(fx.hostPublicKey)), true);
  stream.destroy();
  await host.stop();
  assert.equal(await fx.isListening(host.port), false);
});

// The layer never listens, so Node's own request timers and the connection list
// behind closeAllConnections() do not run for it. Sockets arrive the way the
// preamble listener hands them over: emitted, with the key already bound.
async function handOff(t, layer, deviceIndex = 7) {
  const keyBytes = Buffer.alloc(32);
  keyBytes.writeUInt32BE(deviceIndex, 0);
  const opened = [];
  const front = net.createServer((socket) => {
    Object.defineProperty(socket, 'teamKey', { value: keyBytes.toString('base64url'), writable: false });
    layer.server.emit('connection', socket);
  });
  await new Promise((resolve) => { front.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    for (const state of opened) state.socket.destroy();
    await layer.close();
    await new Promise((resolve) => { front.close(resolve); });
  });
  return (payload = '') => {
    const state = { socket: net.connect({ host: '127.0.0.1', port: front.address().port }), closed: false, text: '' };
    opened.push(state);
    state.socket.on('error', () => {});
    state.socket.on('data', (chunk) => { state.text += chunk; });
    state.socket.on('close', () => { state.closed = true; });
    if (payload) state.socket.write(payload);
    return state;
  };
}

const HELLO_BODY = JSON.stringify({ protocol_version: 1, app_version: 'a' });
const post = (route, body = '') => `POST ${route} HTTP/1.1\r\nHost: ${TEAM_HOST}\r\nContent-Type: application/json\r\n`
  + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

test('a socket that stalls before, during or without a request is closed, and its request slot is freed', async (t) => {
  const { context } = stubContext();
  context.resourceLimits = { maxConcurrentRequests: 2, requestTimeoutMs: 150 };
  const open = await handOff(t, createTeamHttpServer(context));
  const silent = open();
  const partialHeaders = open(`POST /api/v1/team/hello HTTP/1.1\r\nHost: ${TEAM_HOST}\r\n`);
  const stalledBody = open(`${post('/api/v1/team/hello', 'x'.repeat(100)).slice(0, -100)}{`);
  // Never idle, never complete: only the deadline for receiving a request ends this one.
  const trickle = open(`${post('/api/v1/team/hello', 'x'.repeat(100)).slice(0, -100)}{`);
  const drip = setInterval(() => { if (!trickle.closed) trickle.socket.write(' '); }, 40);
  t.after(() => clearInterval(drip));
  const all = [silent, partialHeaders, stalledBody, trickle];
  assert.equal(await waitUntil(() => all.every((state) => state.closed)), true);
  for (const state of all) assert.equal(state.text, '', 'a stalled socket gets no answer');
  // Both request slots were held by the two stalled bodies; they are free again.
  const first = open(post('/api/v1/team/hello', HELLO_BODY));
  const second = open(post('/api/v1/team/hello', HELLO_BODY));
  assert.equal(await waitUntil(() => first.text.includes('"team_id"') && second.text.includes('"team_id"')), true);
  assert.equal(first.text.startsWith('HTTP/1.1 200'), true);
});

test('a handler that works longer than the idle limit still answers', async (t) => {
  const { context } = stubContext();
  context.resourceLimits = { maxConcurrentRequests: 2, requestTimeoutMs: 100 };
  context.router = { dispatch: async () => { await pause(350); return { ok: true, slow: true }; } };
  const open = await handOff(t, createTeamHttpServer(context));
  const hello = open(post('/api/v1/team/hello', HELLO_BODY));
  assert.equal(await waitUntil(() => hello.text.includes('"team_id"')), true);
  const slow = open(post('/api/v1/commands', '{}'));
  assert.equal(await waitUntil(() => slow.text.includes('"slow":true')), true);
  assert.equal(slow.text.startsWith('HTTP/1.1 200'), true);
});

test('closing the layer ends every socket it was handed, also one that never sent a request', async (t) => {
  const { context } = stubContext();
  const layer = createTeamHttpServer(context);
  const open = await handOff(t, layer);
  const lingering = open(`POST /api/v1/team/hello HTTP/1.1\r\nHost: ${TEAM_HOST}\r\n`);
  const idle = open();
  await pause(50);
  assert.equal(lingering.closed || idle.closed, false);
  await layer.close();
  assert.equal(await waitUntil(() => lingering.closed && idle.closed), true);
});
