'use strict';

// new-test-file: the 6-3 fix list's route cases (server/team/model-routes.js): the per-member and host-wide
// bounds, one body read per transfer, the stream's stall and liveness checks, the exact waiting durations and every
// PUT path, on fake requests and a fake clock. team-model-routes.test.js (the base rules and the HTTP flows) is
// near its line cap.

const assert = require('node:assert/strict');
const test = require('node:test');

const { TEAM_MAX_CONCURRENT_REQUESTS } = require('../../server/config');
const { createAuthorizer } = require('../../server/team/authorize');
const { HOST_PART_REQUESTS } = require('../../server/team/model-routes');
const { createRouteGuard } = require('../../server/team/route-guard');
const { SMALL } = require('./helpers/model-relay-fixture');
const { PATH, fakeRequest, fakeResponse, makeSharing, manifest, put, reasonOf, routeCtx, settle, transfer } = require('./helpers/team-model-fixture');

const BIG = Object.freeze({ ...SMALL, partBytes: 1024 * 1024 }); // one part is 16 stream writes of 64 KiB
const UNKNOWN = `mxfer_${'C'.repeat(22)}`;

// `count` GET waits by `who` on `ids`, two per transfer, all parked on the relay.
async function parkGets(env, who, ids, count) {
  const calls = [];
  for (let i = 0; i < count; i += 1) calls.push(routeCtx(env, who, 'GET', PATH(ids[Math.floor(i / 2)], 0, i % 2)));
  await settle();
  return calls;
}
async function release(calls) {
  for (const call of calls) call.response.destroy();
  await Promise.all(calls.map((call) => call.done));
}

// ---- Bounds ---------------------------------------------------------------------------------------------------

test('a member holds at most 8 part requests across its devices; one more is busy before anything else', async (t) => {
  const env = makeSharing({ t });
  const { member, memberSecondDevice, otherMember } = env.actors;
  const ids = [1, 2, 3, 4].map((i) => transfer(env, { requestId: `req_${i}` }));
  const parked = await parkGets(env, member, ids, 8);
  assert.equal(env.sharing.resources().routes.waits, 8);
  // Member a's other device: busy, even for an unknown id; another member is not bounded by it.
  const second = routeCtx(env, memberSecondDevice, 'PUT', PATH(UNKNOWN, 0, 0), { length: 4 });
  second.request.feed(Buffer.alloc(4));
  await second.done;
  assert.deepEqual([second.response.json().error.reason, second.response.json().error.retryable], ['team_model_relay_busy', true]);
  assert.equal(second.request.bytesRead, 0);
  const other = routeCtx(env, otherMember, 'GET', PATH(UNKNOWN, 0, 0));
  await other.done;
  assert.equal(other.response.json().error.reason, 'team_not_found');
  await release(parked);
  const after = routeCtx(env, memberSecondDevice, 'GET', PATH(UNKNOWN, 0, 0));
  await after.done;
  assert.equal(after.response.json().error.reason, 'team_not_found', 'the slots are free again');
});

test('the host serves at most half its concurrent requests as model parts; one more is busy', async (t) => {
  assert.equal(HOST_PART_REQUESTS, Math.floor(TEAM_MAX_CONCURRENT_REQUESTS / 2));
  assert.equal(HOST_PART_REQUESTS, 32);
  const env = makeSharing({ t, hostPartRequests: 3 });
  const ids = [1, 2].map((i) => transfer(env, { requestId: `req_${i}` }));
  const parked = await parkGets(env, env.actors.member, ids, 3);
  const extra = routeCtx(env, env.actors.otherMember, 'GET', PATH(UNKNOWN, 0, 0));
  await extra.done;
  assert.equal(extra.response.json().error.reason, 'team_model_relay_busy');
  await release(parked);
  const after = routeCtx(env, env.actors.otherMember, 'GET', PATH(UNKNOWN, 0, 0));
  await after.done;
  assert.equal(after.response.json().error.reason, 'team_not_found');
});

test('PUT: one body read per transfer at a time; a second PUT of the same part is busy unread, then the slot frees', async (t) => {
  const env = makeSharing({ t });
  const { owner } = env.actors;
  const transferId = transfer(env, { sizes: [40] });
  const first = routeCtx(env, owner, 'PUT', PATH(transferId, 0, 0), { length: 4 });
  await settle();
  assert.equal(env.sharing.resources().routes.reading, 1);
  const second = routeCtx(env, owner, 'PUT', PATH(transferId, 0, 0), { length: 4 });
  second.request.feed(Buffer.alloc(4, 2));
  await second.done;
  assert.equal(second.response.json().error.reason, 'team_model_relay_busy');
  assert.deepEqual([second.request.bytesRead, second.request.socket.destroyed], [0, true]);
  first.request.feed(Buffer.alloc(4, 1));
  first.request.finish();
  await first.done;
  assert.deepEqual(first.response.json(), { ok: true, ready: true });
  assert.equal(first.request.bytesRead, 4, 'one body read');
  assert.equal(env.sharing.resources().routes.reading, 0);
  assert.deepEqual((await put(env, transferId, 1, Buffer.alloc(4))).response.json(), { ok: true, ready: true });
});

test('PUT: a transfer cancelled mid-body stops the read at the next tick', async (t) => {
  const env = makeSharing({ t });
  const transferId = transfer(env, { sizes: [40] });
  const reading = routeCtx(env, env.actors.owner, 'PUT', PATH(transferId, 0, 0), { length: 4 });
  reading.request.feed(Buffer.alloc(2));
  await settle();
  env.send(env.actors.member, 'team.model.cancel', { transfer_id: transferId });
  env.timers.advance(1000);
  await reading.done;
  assert.equal(reading.response.json().error.reason, 'team_model_transfer_stale');
  assert.equal(env.sharing.resources().routes.bodyBytes, 0);
});

// ---- The stream -------------------------------------------------------------------------------------------------

test('GET: a stream the client never drains ends at the stall limit; a slowly draining one survives', async (t) => {
  const env = makeSharing({ t, limits: BIG });
  const transferId = transfer(env, { sizes: [BIG.partBytes] });
  const bytes = Buffer.alloc(BIG.partBytes, 7);
  await put(env, transferId, 0, bytes);
  const stuck = routeCtx(env, env.actors.member, 'GET', PATH(transferId, 0, 0), { pace: true, holdFinish: true });
  await settle();
  assert.deepEqual([stuck.response.status, stuck.response.socket.bytesWritten], [200, 64 * 1024]);
  env.timers.advance(9000);
  assert.equal(stuck.response.destroyed, false, 'not at 9 s');
  env.timers.advance(1000);
  await stuck.done;
  assert.equal(stuck.response.destroyed, true, 'cut at 10 s without progress');
  assert.ok(env.logs.some((line) => line[1] === 'team_model.part_ended' && line[2].reason === 'stalled'));
  // A client that reads one 64 KiB write every 5 s makes progress: it runs well past the stall limit.
  const slow = routeCtx(env, env.actors.member, 'GET', PATH(transferId, 0, 0), { pace: true });
  await settle();
  for (let i = 0; i < 15; i += 1) {
    env.timers.advance(5000);
    assert.equal(slow.response.destroyed, false, `alive at ${(i + 1) * 5} s`);
    slow.response.emit('drain');
  }
  await slow.done;
  assert.equal(slow.response.destroyed, false);
  assert.deepEqual(slow.response.body, bytes);
});

test('GET: a transfer cancelled mid-stream ends the stream within a second', async (t) => {
  const env = makeSharing({ t, limits: BIG });
  const transferId = transfer(env, { sizes: [BIG.partBytes] });
  await put(env, transferId, 0, Buffer.alloc(BIG.partBytes));
  const stream = routeCtx(env, env.actors.member, 'GET', PATH(transferId, 0, 0), { pace: true, holdFinish: true });
  await settle();
  env.send(env.actors.owner, 'team.model.cancel', { transfer_id: transferId });
  env.timers.advance(1000);
  await stream.done;
  assert.equal(stream.response.destroyed, true);
});

// ---- Durations --------------------------------------------------------------------------------------------------

test('durations: a waiting PUT answers at 20 s (not 19.9 s), a waiting GET at 25 s (not 24.9 s)', async (t) => {
  const env = makeSharing({ t });
  const transferId = transfer(env, { sizes: [40] });
  for (let n = 0; n < 4; n += 1) await put(env, transferId, n, Buffer.alloc(4));
  const waitingPut = routeCtx(env, env.actors.owner, 'PUT', PATH(transferId, 0, 4), { length: 4 });
  const getId = transfer(env, { requestId: 'req_get', from: env.actors.otherMember, to: env.actors.owner });
  const waitingGet = routeCtx(env, env.actors.owner, 'GET', PATH(getId, 0, 0));
  await settle();
  env.timers.advance(19_900);
  assert.equal(waitingPut.response.status, null, 'PUT still waiting at 19.9 s');
  env.timers.advance(100);
  await waitingPut.done;
  assert.deepEqual(waitingPut.response.json(), { ok: true, ready: false, wait: 'window_full' });
  env.timers.advance(4900);
  assert.equal(waitingGet.response.status, null, 'GET still waiting at 24.9 s');
  env.timers.advance(100);
  await waitingGet.done;
  assert.equal(waitingGet.response.status, 204);
});

test('durations: a body with progress every 9 s survives 30 s; a silent one ends at 10 s, not at 9 s', async (t) => {
  const env = makeSharing({ t, limits: { ...SMALL, partBytes: 16 } });
  const transferId = transfer(env, { sizes: [32] });
  const trickle = routeCtx(env, env.actors.owner, 'PUT', PATH(transferId, 0, 0), { length: 16 });
  await settle();
  for (let i = 0; i < 3; i += 1) {
    env.timers.advance(9000);
    trickle.request.feed(Buffer.alloc(1));
  }
  env.timers.advance(3000);
  assert.equal(trickle.request.socket.destroyed, false, 'alive at 30 s');
  trickle.request.feed(Buffer.alloc(13));
  trickle.request.finish();
  await trickle.done;
  assert.deepEqual(trickle.response.json(), { ok: true, ready: true });
  const silent = routeCtx(env, env.actors.owner, 'PUT', PATH(transferId, 0, 1), { length: 16 });
  await settle();
  env.timers.advance(9000);
  assert.equal(silent.request.socket.destroyed, false, 'not at 9 s');
  env.timers.advance(1000);
  await silent.done;
  assert.equal(silent.request.socket.destroyed, true, 'ended at 10 s');
});

// ---- PUT paths --------------------------------------------------------------------------------------------------

test('PUT paths: revoked mid-body, demoted while waiting, revoked after the body, duplicate, stale, queued', async (t) => {
  const env = makeSharing({ t });
  const { owner, member, otherMember } = env.actors;
  // Revoked mid-body: the guard inside the read.
  const mid = transfer(env, { sizes: [40], requestId: 'req_mid' });
  const midPut = routeCtx(env, owner, 'PUT', PATH(mid, 0, 0), { length: 4 });
  midPut.request.feed(Buffer.alloc(1));
  await settle();
  env.dir.setState(owner.device_id, 'revoked');
  env.timers.advance(1000);
  await midPut.done;
  assert.equal(midPut.response.json().error.reason, 'member_revoked');
  assert.equal(midPut.request.socket.destroyed, true);
  env.dir.setState(owner.device_id, 'active');
  // Demoted while waiting on a full window: the guard in the wait; nothing read.
  const full = transfer(env, { sizes: [40], requestId: 'req_full', from: otherMember, to: owner });
  for (let n = 0; n < 4; n += 1) await put(env, full, n, Buffer.alloc(4), { who: otherMember });
  const waiting = routeCtx(env, otherMember, 'PUT', PATH(full, 0, 4), { length: 4 });
  waiting.request.feed(Buffer.alloc(4));
  await settle();
  env.timers.advance(3000);
  assert.ok(waiting.request.socket.refreshed >= 3, 'the waiting PUT refreshes its socket idle timer each second');
  env.dir.setRole(otherMember.device_id, 'read_only');
  env.timers.advance(1000);
  await waiting.done;
  assert.deepEqual([waiting.response.json().error.reason, waiting.request.bytesRead], ['role_forbidden', 0]);
  env.dir.setRole(otherMember.device_id, 'member');
  // Revoked after the whole body arrived, before the relay took it: the post-read guard; the part is not stored.
  const late = routeCtx(env, owner, 'PUT', PATH(mid, 0, 0), { length: 4 });
  await settle();
  late.request.feed(Buffer.alloc(4));
  env.dir.setState(owner.device_id, 'revoked');
  late.request.finish();
  await late.done;
  assert.equal(late.response.json().error.reason, 'member_revoked');
  env.dir.setState(owner.device_id, 'active');
  assert.deepEqual((await put(env, mid, 0, Buffer.alloc(4))).response.json(), { ok: true, ready: true }, 'not stored before');
  // A duplicate: answered unread, socket closed.
  const again = routeCtx(env, owner, 'PUT', PATH(mid, 0, 0), { length: 4 });
  again.request.feed(Buffer.alloc(4));
  await again.done;
  assert.deepEqual(again.response.json(), { ok: true, ready: true, duplicate: true });
  assert.deepEqual([again.request.bytesRead, again.request.socket.destroyed], [0, true]);
  // A part ahead of the next one the relay expects (part 1): the relay's stale, unread.
  const past = routeCtx(env, owner, 'PUT', PATH(mid, 0, 2), { length: 4 });
  await past.done;
  assert.deepEqual([reasonOf(past.response.json()), past.request.bytesRead], ['team_model_transfer_stale', 0]);
  // A part past the file: the relay's size limit, unread.
  const beyond = routeCtx(env, owner, 'PUT', PATH(mid, 0, 99), { length: 4 });
  await beyond.done;
  assert.deepEqual([reasonOf(beyond.response.json()), beyond.request.bytesRead], ['team_model_size_limit', 0]);
  // A transfer accepted but queued for a flowing slot (one incoming per member): busy at once, unread.
  const queuedOffer = env.send(otherMember, 'team.model.offer', manifest({ to: member, requestId: 'req_queued' }));
  const queued = env.send(member, 'team.model.accept', { offer_id: queuedOffer.offer.offer_id });
  assert.equal(queued.transfer.queued, true);
  const early = routeCtx(env, otherMember, 'PUT', PATH(queued.transfer.transfer_id, 0, 0), { length: 4 });
  await early.done;
  assert.deepEqual([reasonOf(early.response.json()), early.request.bytesRead], ['team_model_relay_busy', 0]);
});

test('PUT as a ninth request of its member is busy unread; once the eight end, the same PUT is stored', async (t) => {
  const env = makeSharing({ t });
  const { owner, member, otherMember, memberSecondDevice } = env.actors;
  const incoming = [[member, 1], [member, 2], [otherMember, 3], [memberSecondDevice, 4]]
    .map(([from, i]) => transfer(env, { requestId: `req_in_${i}`, from, to: owner }));
  const parked = await parkGets(env, owner, incoming, 8);
  const outgoing = transfer(env, { requestId: 'req_out' });
  const ninth = routeCtx(env, owner, 'PUT', PATH(outgoing, 0, 0), { length: 4 });
  ninth.request.feed(Buffer.alloc(4));
  await ninth.done;
  assert.deepEqual([ninth.response.json().error.reason, ninth.request.bytesRead], ['team_model_relay_busy', 0]);
  await release(parked);
  assert.deepEqual((await put(env, outgoing, 0, Buffer.alloc(4))).response.json(), { ok: true, ready: true });
});

test('R14-F03: parts a receiver is still being sent count against the 4-part window (at the bound and one past)', async (t) => {
  const env = makeSharing({ t });
  const { owner, member } = env.actors;
  const transferId = transfer(env, { sizes: [64] }); // 16 parts of 4 bytes
  const alive = () => { const relay = env.sharing.resources().relay; return relay.windowParts + (relay.streamParts ?? 0); };
  let putN = 0;
  const fill = async () => {
    while (putN < 16 && alive() < 4) {
      assert.equal((await put(env, transferId, putN, Buffer.alloc(4, putN))).response.json().ok, true);
      putN += 1;
    }
  };
  await fill();
  // The receiver asks for part after part and reads each answer slowly: every response stays in flight.
  const open = [];
  for (let n = 0; n < 4; n += 1) {
    open.push(routeCtx(env, member, 'GET', PATH(transferId, 0, n), { holdFinish: true, pace: true }));
    await settle();
    assert.equal(open[n].response.status, 200, `part ${n} is being streamed`);
    await fill();
  }
  const held = env.sharing.resources().relay;
  assert.deepEqual([held.windowParts, held.streamParts, held.streamBytes, putN], [1, 3, 12, 4], 'four parts alive: at the bound');
  const waiting = routeCtx(env, owner, 'PUT', PATH(transferId, 0, 4), { length: 4 });
  waiting.request.feed(Buffer.alloc(4, 4));
  await settle();
  assert.deepEqual([waiting.response.status, waiting.request.bytesRead], [null, 0], 'the fifth part waits unread: one past');
  // The first stream ends: its place is free and the waiting PUT is let in.
  open[0].response.emit('finish');
  await settle();
  waiting.request.finish();
  await waiting.done;
  assert.equal(waiting.response.json().ok, true);
  const fifth = routeCtx(env, member, 'GET', PATH(transferId, 0, 4));
  await fifth.done;
  assert.deepEqual([fifth.response.status, alive() <= 4], [200, true]);
  for (const call of open.slice(1)) call.response.emit('finish');
  await Promise.all(open.map((call) => call.done));
});

// ---- A response that cannot be written to (H18) ------------------------------------------------------------------

// A GET on a part that is ready, with the response set up by `tweak(response)` before the route sees it.
function readyGet(env, transferId, tweak) {
  const request = fakeRequest('GET');
  const response = fakeResponse();
  tweak(response);
  const { authorize } = createAuthorizer({ directory: env.dir.directory });
  const who = env.actors.member;
  const actor = { member_id: who.member_id, device_id: who.device_id };
  const ctx = { request, response, pathname: PATH(transferId, 0, 0), deviceId: who.device_id, requestId: 'req_route', actor,
    authorized: () => true, guard: createRouteGuard({ authorize, actor }) };
  return { response, done: env.sharing.routes(ctx) };
}

test('H18: a response that throws on writeHead frees the interval, the part\'s buffer and its flowing slot', async (t) => {
  const env = makeSharing({ t });
  const transferId = transfer(env);
  await put(env, transferId, 0, Buffer.alloc(4, 3));
  const call = readyGet(env, transferId, (response) => { response.writeHead = () => { throw new Error('headers_failed'); }; });
  await call.done;
  const held = env.sharing.resources();
  assert.deepEqual([held.routes.timers, held.relay.streamParts, held.relay.streamBytes], [0, 0, 0], JSON.stringify(held));
  assert.equal(call.response.destroyed, true, 'the broken response is cut');
});

test('H18: a response that is already gone when the part is ready is not streamed to, and nothing stays held', async (t) => {
  const env = makeSharing({ t });
  const transferId = transfer(env);
  await put(env, transferId, 0, Buffer.alloc(4, 3));
  const call = readyGet(env, transferId, (response) => { response.destroyed = true; });
  const outcome = await Promise.race([call.done.then(() => 'done'), settle().then(() => 'still held')]);
  assert.equal(outcome, 'done', 'the request ended without waiting for a timer tick');
  assert.equal(call.response.status, null, 'no header was written to a gone response');
  const held = env.sharing.resources();
  assert.deepEqual([held.routes.timers, held.relay.streamParts], [0, 0]);
});
