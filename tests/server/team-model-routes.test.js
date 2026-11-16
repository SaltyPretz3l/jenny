'use strict';

// new-test-file: slice 6-3's two raw part routes (server/team/model-routes.js) are a new surface: the PUT and GET
// rules on fake requests and a fake clock, then the whole flow over the real team HTTP server. The bounds, the
// stall and the durations are in team-model-routes-cases.test.js; the role matrix, the closed schemas, real-socket
// endings and redaction through refusals in team-model-wire.test.js.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { connectMember, waitUntil } = require('./helpers/team-http-fixture');
const { modelFrames, modelHttpEnv, partRequest } = require('./helpers/team-model-http');
const {
  MARK, PATH, clean, idle, makeSharing, manifest, put, reasonOf, routeCtx, settle, transfer,
} = require('./helpers/team-model-fixture');

test('PUT: a wrong or missing Content-Length is refused before any body byte is read, and the socket closes', async () => {
  const env = makeSharing();
  const transferId = transfer(env);
  for (const [length, reason] of [[5, 'team_model_size_limit'], [3, 'team_model_transfer_stale'],
    [undefined, 'team_model_request_invalid']]) {
    const call = routeCtx(env, env.actors.owner, 'PUT', PATH(transferId, 0, 0), { length });
    call.request.feed(Buffer.alloc(4));
    assert.equal(await call.done, true);
    assert.equal(call.response.json().error.reason, reason);
    assert.equal(call.request.bytesRead, 0, `${reason}: nothing read`);
    assert.equal(call.response.headers.connection, 'close');
    assert.equal(call.request.socket.destroyed, true);
  }
  idle(env);
});

test('PUT: a full window waits without reading, answers window_full at 20 s, and a take lets it in', async () => {
  const env = makeSharing();
  const transferId = transfer(env, { sizes: [40] });
  for (let n = 0; n < 4; n += 1) assert.equal((await put(env, transferId, n, Buffer.alloc(4, n))).response.json().ok, true);
  const waiting = routeCtx(env, env.actors.owner, 'PUT', PATH(transferId, 0, 4), { length: 4 });
  waiting.request.feed(Buffer.alloc(4, 4));
  await settle();
  assert.equal(env.sharing.resources().routes.waits, 1);
  env.timers.advance(19_000);
  assert.equal(waiting.request.bytesRead, 0, 'never read while the window is full');
  env.timers.advance(1000);
  await waiting.done;
  assert.deepEqual(waiting.response.json(), { ok: true, ready: false, wait: 'window_full' });
  assert.equal(waiting.request.bytesRead, 0);
  assert.equal(waiting.request.socket.destroyed, true);
  idle(env);
  // A second wait is woken by the receiver taking parts 0 and 1 (part 0 leaves the window).
  const again = routeCtx(env, env.actors.owner, 'PUT', PATH(transferId, 0, 4), { length: 4 });
  await settle();
  for (const n of [0, 1]) await routeCtx(env, env.actors.member, 'GET', PATH(transferId, 0, n)).done;
  again.request.feed(Buffer.alloc(4, 4));
  again.request.finish();
  await again.done;
  assert.deepEqual(again.response.json(), { ok: true, ready: true });
  idle(env);
});

test('PUT: a stalled body ends at the stall limit; a disconnect mid-body or mid-wait leaves nothing', async () => {
  const env = makeSharing();
  const transferId = transfer(env, { sizes: [40] });
  const stalled = routeCtx(env, env.actors.owner, 'PUT', PATH(transferId, 0, 0), { length: 4 });
  stalled.request.feed(Buffer.alloc(2));
  await settle();
  assert.equal(env.sharing.resources().routes.bodyBytes, 4);
  env.timers.advance(10_000);
  await stalled.done;
  assert.equal(stalled.request.socket.destroyed, true);
  assert.equal(env.sharing.resources().relay.windowBytes, 0);
  idle(env);
  const cut = routeCtx(env, env.actors.owner, 'PUT', PATH(transferId, 0, 0), { length: 4 });
  cut.request.feed(Buffer.alloc(1));
  cut.request.emit('close');
  await cut.done;
  idle(env);
  for (let n = 0; n < 4; n += 1) await put(env, transferId, n, Buffer.alloc(4));
  const gone = routeCtx(env, env.actors.owner, 'PUT', PATH(transferId, 0, 4), { length: 4 });
  await settle();
  gone.response.destroy();
  await gone.done;
  idle(env);
});

test('PUT and GET: a ninth concurrent part request of one device is refused busy; the eight end cleanly', async () => {
  const env = makeSharing();
  const ids = [1, 2, 3, 4].map((index) => transfer(env, { requestId: `req_${index}` }));
  const waits = ids.flatMap((transferId) => [0, 1].map((n) => routeCtx(env, env.actors.member, 'GET', PATH(transferId, 0, n))));
  await settle();
  assert.equal(env.sharing.resources().routes.waits, 8);
  // An unknown id: past the bound the device's own limit answers busy before the relay could answer not-found.
  const ninth = routeCtx(env, env.actors.member, 'GET', PATH(`mxfer_${'C'.repeat(22)}`, 0, 0));
  await ninth.done;
  assert.equal(ninth.response.json().error.reason, 'team_model_relay_busy');
  assert.equal(ninth.response.json().error.retryable, true);
  for (const call of waits) call.response.destroy();
  await Promise.all(waits.map((call) => call.done));
  idle(env);
});

test('GET: waits and answers 204 at 25 s; a ready part has the exact headers and bytes; a retry gets the same', async () => {
  const env = makeSharing();
  const transferId = transfer(env);
  const polling = routeCtx(env, env.actors.member, 'GET', PATH(transferId, 0, 0));
  await settle();
  env.timers.advance(25_000);
  await polling.done;
  assert.equal(polling.response.status, 204);
  assert.equal(polling.response.headers['cache-control'], 'no-store');
  idle(env);
  const bytes = Buffer.from([1, 2, 3, 4]);
  const waiting = routeCtx(env, env.actors.member, 'GET', PATH(transferId, 0, 0));
  await settle();
  await put(env, transferId, 0, Buffer.from(bytes));
  await waiting.done;
  assert.equal(waiting.response.status, 200);
  assert.deepEqual(waiting.response.headers, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'content-length': 4 });
  assert.deepEqual(waiting.response.body, bytes);
  const retry = routeCtx(env, env.actors.member, 'GET', PATH(transferId, 0, 0));
  await retry.done;
  assert.deepEqual(retry.response.body, bytes);
  idle(env);
});

test('GET: a demotion and a revoke each end a wait and a stream within a second', async () => {
  for (const change of ['demote', 'revoke']) {
    const env = makeSharing();
    const transferId = transfer(env);
    const apply = () => (change === 'demote' ? env.dir.setRole(env.actors.member.device_id, 'read_only')
      : env.dir.setState(env.actors.member.device_id, 'revoked'));
    const waiting = routeCtx(env, env.actors.member, 'GET', PATH(transferId, 0, 1));
    await put(env, transferId, 0, Buffer.alloc(4));
    const streaming = routeCtx(env, env.actors.member, 'GET', PATH(transferId, 0, 0), { holdFinish: true });
    await settle();
    assert.equal(streaming.response.status, 200);
    apply();
    env.timers.advance(1000);
    await Promise.all([waiting.done, streaming.done]);
    assert.equal(waiting.response.json().error.reason, change === 'demote' ? 'role_forbidden' : 'member_revoked', change);
    assert.equal(streaming.response.destroyed, true, `${change}: the stream ends`);
    idle(env);
  }
});

test('switches: setting 0, a switch-off mid-wait and dispose answer only their fixed reason; nothing is held', async () => {
  const off = makeSharing({ flowing: 0 });
  for (const method of ['PUT', 'GET']) {
    const call = routeCtx(off, off.actors.owner, method, PATH(`mxfer_${'A'.repeat(22)}`, 0, 0), { length: 4 });
    await call.done;
    assert.equal(call.response.json().error.reason, 'team_model_sharing_off', method);
    assert.equal(call.request.bytesRead, 0);
  }
  assert.equal(off.timers.count(), 0);
  assert.equal(off.published.length, 0);
  const env = makeSharing();
  const transferId = transfer(env);
  const waiting = routeCtx(env, env.actors.member, 'GET', PATH(transferId, 0, 0));
  await settle();
  env.sharing.setFlowingLimit(0);
  await waiting.done;
  assert.equal(waiting.response.json().error.reason, 'team_model_sharing_off');
  idle(env);
  env.sharing.dispose();
  const after = routeCtx(env, env.actors.owner, 'PUT', PATH(transferId, 0, 0), { length: 4 });
  await after.done;
  assert.equal(after.response.json().error.reason, 'host_unavailable');
  assert.equal(env.timers.count(), 0);
});

test('a read-only member cannot PUT or GET; a malformed id is the relay\'s one not-found', async () => {
  const env = makeSharing();
  const transferId = transfer(env);
  for (const method of ['PUT', 'GET']) {
    const call = routeCtx(env, env.actors.read_only, method, PATH(transferId, 0, 0), { length: 4 });
    await call.done;
    assert.equal(call.response.json().error.reason, 'role_forbidden', method);
  }
  const malformed = routeCtx(env, env.actors.owner, 'GET', PATH('mxfer_short', 0, 0));
  await malformed.done;
  const unknown = routeCtx(env, env.actors.owner, 'GET', PATH(`mxfer_${'B'.repeat(22)}`, 0, 0));
  await unknown.done;
  assert.deepEqual(malformed.response.json(), unknown.response.json());
  assert.equal(unknown.response.json().error.reason, 'team_not_found');
  assert.equal(await env.sharing.routes({ pathname: '/api/v1/team/models/other', request: { method: 'GET' } }), false);
});

// ---- End to end over the real team HTTP server ------------------------------------------------------------

test('end to end: offer, list, read, accept, three parts through the window, hash, complete; events to the parties only', async (t) => {
  const { env, seeded, other } = await modelHttpEnv(t);
  const owner = await connectMember(env, seeded.owner.key);
  const member = await connectMember(env, seeded.member.key);
  const outsider = await connectMember(env, other.key);
  const bytes = crypto.randomBytes(10);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const body = { ...manifest({ to: { member_id: seeded.member.member_id } }) };
  body.files = [{ name: MARK.file, size: 10, sha256: hash, segments: [hash] }];
  const offered = await owner.send('team.model.offer', body);
  assert.equal(offered.ok, true, JSON.stringify(offered));
  const listed = await member.send('team.model.offers');
  assert.deepEqual(listed.offers.map((o) => o.offer_id), [offered.offer.offer_id]);
  assert.equal((await member.send('team.model.offer.read', { offer_id: offered.offer.offer_id })).manifest.files[0].sha256, hash);
  const accepted = await member.send('team.model.accept', { offer_id: offered.offer.offer_id });
  const transferId = accepted.transfer.transfer_id;
  for (const n of [0, 1, 2]) {
    const answer = await partRequest(owner, 'PUT', PATH(transferId, 0, n), bytes.subarray(n * 4, n * 4 + 4));
    assert.deepEqual([answer.status, answer.json], [200, { ok: true, ready: true }], `put ${n}`);
  }
  const parts = [];
  for (const n of [0, 1, 2]) {
    const answer = await partRequest(member, 'GET', PATH(transferId, 0, n));
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['content-type'], 'application/octet-stream');
    parts.push(answer.body);
  }
  assert.equal(crypto.createHash('sha256').update(Buffer.concat(parts)).digest('hex'), hash);
  assert.equal((await member.send('team.model.complete', { transfer_id: transferId, ok: true })).transfer.state, 'done');
  assert.equal(await waitUntil(() => modelFrames(member.stream).some((f) => f.state === 'done')), true);
  assert.ok(modelFrames(owner.stream).length > 0);
  assert.deepEqual(modelFrames(outsider.stream), []);
  assert.equal(outsider.stream.frames.join('').includes(MARK.display), false);
  assert.equal(clean(env.logs), true, 'no marker text in any host log line');
});

test('end to end: pause, resume, cancel, a withdrawn offer and a declined direct offer', async (t) => {
  const { env, seeded } = await modelHttpEnv(t);
  const owner = await connectMember(env, seeded.owner.key);
  const member = await connectMember(env, seeded.member.key);
  const offer = async (requestId) => (await owner.send('team.model.offer',
    manifest({ to: { member_id: seeded.member.member_id }, requestId }))).offer.offer_id;
  const first = await offer('req_a');
  const transferId = (await member.send('team.model.accept', { offer_id: first })).transfer.transfer_id;
  assert.equal((await member.send('team.model.pause', { transfer_id: transferId })).transfer.state, 'paused');
  assert.equal(reasonOf(await owner.send('team.model.resume', { transfer_id: transferId })), 'team_model_transfer_stale');
  assert.equal((await member.send('team.model.resume', { transfer_id: transferId })).transfer.state, 'accepted');
  assert.equal((await owner.send('team.model.cancel', { transfer_id: transferId })).transfer.state, 'cancelled');
  assert.deepEqual(await owner.send('team.model.withdraw', { offer_id: first }), { ok: true });
  assert.equal(reasonOf(await member.send('team.model.offer.read', { offer_id: first })), 'team_not_found');
  const second = await offer('req_b');
  assert.deepEqual(await member.send('team.model.decline', { offer_id: second }), { ok: true });
  assert.deepEqual((await owner.send('team.model.offers')).offers, []);
});

test('lifecycle through the real store and streams: role change, leave, revoke, the sender\'s last stream; nothing left', async (t) => {
  const { env, seeded, other } = await modelHttpEnv(t);
  const owner = await connectMember(env, seeded.owner.key);
  const member = await connectMember(env, seeded.member.key);
  const outsider = await connectMember(env, other.key);
  const offer = async (from, to, requestId) => (await from.send('team.model.offer',
    manifest({ to: { member_id: to }, requestId }))).offer.offer_id;
  const accept = async (peer, offerId) => (await peer.send('team.model.accept', { offer_id: offerId })).transfer.transfer_id;
  // The relay's payload is flat in the frame (no `payload` key).
  const last = (id) => modelFrames(owner.stream).filter((f) => f.transfer_id === id || f.offer_id === id).at(-1);
  const ended = (frame) => [frame?.state, frame?.reason];
  const ownerId = seeded.owner.member_id;
  // A role change to read-only ends the member's transfer; back to member, nothing else changes.
  const first = await accept(member, await offer(owner, seeded.member.member_id, 'req_1'));
  await env.store.setRole({ actorMemberId: ownerId, memberId: seeded.member.member_id, role: 'read_only' });
  assert.equal(await waitUntil(() => ended(last(first))[1] === 'role_changed'), true, 'step 1');
  await env.store.setRole({ actorMemberId: ownerId, memberId: seeded.member.member_id, role: 'member' });
  // A member who leaves: their offer ends as member_gone.
  const left = await offer(outsider, ownerId, 'req_2');
  await env.store.leave({ memberId: other.member_id });
  assert.equal(await waitUntil(() => ended(last(left))[1] === 'member_gone'), true, 'step 2');
  // The offering device's last event stream closes: an accept meets the sender offline; back, it is accepted.
  const away = await offer(owner, seeded.member.member_id, 'req_3');
  const devices = env.models.resources().devices;
  owner.stream.response.destroy();
  assert.equal(await waitUntil(() => env.models.resources().devices === devices - 1), true, 'step 3');
  assert.equal(reasonOf(await member.send('team.model.accept', { offer_id: away })), 'team_model_sender_offline');
  const back = await connectMember(env, seeded.owner.key);
  assert.equal(await waitUntil(() => env.models.resources().devices === devices), true, 'step 4');
  const resumed = await accept(member, away);
  // A revoked member: their transfer is cancelled as member_gone.
  await env.store.revokeMember({ actorMemberId: ownerId, memberId: seeded.member.member_id });
  assert.equal(await waitUntil(() => modelFrames(back.stream).some((f) => f.transfer_id === resumed
    && f.reason === 'member_gone')), true, 'step 5');
  // Nothing left in the routes; host stop (dispose) leaves no relay and no timer.
  assert.deepEqual(env.models.resources().routes, { requests: 0, waits: 0, timers: 0, bodyBytes: 0, reading: 0 });
  assert.equal(env.models.resources().sweepTimers, 1);
  env.models.dispose();
  assert.deepEqual([env.models.resources().relay, env.models.resources().sweepTimers], [null, 0]);
});
