'use strict';

// Slice 4c host: the two raw node routes (node protocol spec N6), the job's request
// fetch and the chunk upload, on a real team host with a pool, the real team HTTP
// layer and the real authorizer; the node is registered and claims through the
// command route. No sidecar, no model, no engine, no window.

const assert = require('node:assert/strict');
const nodeTest = require('node:test');

const { createNodeRates } = require('../../server/team/node-commands');
const { MARKER, countedRates, requestBody, startNodeHost, until } = require('./helpers/team-node-fixture');

// A hang fails its own test instead of the whole file.
const test = (name, fn) => nodeTest(name, { timeout: 30_000 }, fn);
const MIB = 1024 * 1024;
const sse = (text) => Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
const DONE = Buffer.from('data: [DONE]\n\n');
const reasonOf = (answer) => answer.json?.error?.reason ?? null;

test('only the claiming device reads the request, as often as it likes, until the first chunk is accepted', async (t) => {
  const h = await startNodeHost(t);
  await h.register(h.seats.member);
  const { job } = h.queueJob();
  const claimed = await h.claimed(h.seats.member);
  assert.equal(claimed.job_id, job.job_id);
  const node = await h.as(h.seats.member);
  for (let i = 0; i < 2; i += 1) {
    const fetched = await node.fetchRequest(job.job_id);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.text, requestBody().toString('utf8'));
  }
  const other = await h.as(h.seats.second);
  assert.equal(reasonOf(await other.fetchRequest(job.job_id)), 'job_not_found', 'a device without a node');
  await h.register(h.seats.second);
  assert.equal(reasonOf(await other.fetchRequest(job.job_id)), 'job_not_found', 'another node');
  const owner = await h.as(h.seats.owner);
  assert.equal(reasonOf(await owner.fetchRequest(job.job_id)), 'job_not_found', 'not even the owner');
  assert.equal((await node.chunk(job.job_id, { seq: 0, body: sse('hi') })).status, 200);
  assert.equal(reasonOf(await node.fetchRequest(job.job_id)), 'job_not_found', 'gone after the first chunk');
});

test('a request just under 8 MiB is served whole', async (t) => {
  const h = await startNodeHost(t);
  await h.register(h.seats.member, { slots: 2 });
  const filler = 'x'.repeat(8 * MIB - 2048);
  const big = requestBody(filler);
  assert.ok(big.length < 8 * MIB);
  const { job } = h.queueJob(big);
  await h.claimed(h.seats.member);
  const fetched = await (await h.as(h.seats.member)).fetchRequest(job.job_id);
  assert.equal(fetched.status, 200);
  assert.equal(Buffer.byteLength(fetched.text), big.length);
});

test('every request read takes a claim token: over the limit it answers node_rate_limit', async (t) => {
  let claims = 0;
  const rates = { take: (kind) => kind !== 'claim' || (claims += 1) <= 3, forget() {}, size: () => 0 };
  const h = await startNodeHost(t, { rates });
  await h.register(h.seats.member);
  const { job } = h.queueJob();
  await h.claimed(h.seats.member);
  const node = await h.as(h.seats.member);
  for (let i = 0; i < 2; i += 1) assert.equal((await node.fetchRequest(job.job_id)).status, 200);
  const limited = await node.fetchRequest(job.job_id);
  assert.deepEqual([limited.status, reasonOf(limited)], [429, 'node_rate_limit']);
});

test('chunks in order with a final end the job; a repeated or skipped seq changes nothing; an empty body is a ping', async (t) => {
  const h = await startNodeHost(t);
  await h.register(h.seats.member);
  const { job, lease } = h.queueJob();
  await h.claimed(h.seats.member);
  const node = await h.as(h.seats.member);
  const ping = await node.chunk(job.job_id, { seq: 0 });
  assert.deepEqual(ping.json, { ok: true, next_seq: 1, cancel: false });
  assert.equal(h.m.scheduler.getJob(job.job_id).state, 'claimed', 'a ping is not the first byte');
  const first = await node.chunk(job.job_id, { seq: 1, body: sse(`${MARKER} one`) });
  assert.deepEqual(first.json, { ok: true, next_seq: 2, cancel: false });
  for (const seq of [1, 3]) {
    const wrong = await node.chunk(job.job_id, { seq, body: sse('dup') });
    assert.deepEqual([wrong.status, reasonOf(wrong), wrong.json.next_seq], [400, 'node_chunk_seq_invalid', 2], String(seq));
  }
  assert.equal(h.m.scheduler.getJob(job.job_id).next_seq, 2);
  const last = await node.chunk(job.job_id, { seq: 2, final: true, body: Buffer.concat([sse(`${MARKER} two`), DONE]) });
  assert.deepEqual(last.json, { ok: true, next_seq: 3, cancel: false });
  assert.equal(h.m.scheduler.getJob(job.job_id).state, 'done');
  assert.equal(h.m.scheduler.getLease(lease.lease_id).state, 'active', 'the lease outlives its job');
  assert.equal(h.logText().includes(MARKER), false, 'no prompt or reply text in a log line');
});

test('a missing or malformed chunk header is node_protocol_invalid and a body over 64 KiB is refused', async (t) => {
  const h = await startNodeHost(t);
  await h.register(h.seats.member);
  const { job } = h.queueJob();
  await h.claimed(h.seats.member);
  const node = await h.as(h.seats.member);
  for (const headers of [{}, { 'X-Chunk-Seq': '-1' }, { 'X-Chunk-Seq': '01' }, { 'X-Chunk-Seq': '1.5' },
    { 'X-Chunk-Seq': '0', 'X-Chunk-Final': 'yes' }, { 'X-Chunk-Seq': '0', 'X-Chunk-Final': '' }]) {
    const answer = await node.chunk(job.job_id, { headers });
    assert.deepEqual([answer.status, reasonOf(answer)], [400, 'node_protocol_invalid'], JSON.stringify(headers));
  }
  const big = await node.chunk(job.job_id, { seq: 0, body: Buffer.alloc(64 * 1024 + 1, 0x61) });
  assert.equal(big.status, 400);
  assert.equal(reasonOf(big), 'node_chunk_too_large');
  assert.equal(h.m.scheduler.getJob(job.job_id).next_seq, 0, 'nothing was accepted');
  const fits = await node.chunk(job.job_id, { seq: 0, body: Buffer.alloc(64 * 1024, 0x61) });
  assert.equal(fits.status, 200);
});

test('after the gateway side cancels, the next chunk answers cancel', async (t) => {
  const h = await startNodeHost(t);
  await h.register(h.seats.member);
  const { job } = h.queueJob();
  await h.claimed(h.seats.member);
  const node = await h.as(h.seats.member);
  assert.equal((await node.chunk(job.job_id, { seq: 0, body: sse('a') })).json.cancel, false);
  assert.equal(h.m.scheduler.cancelJob(job.job_id).ok, true);
  const answer = await node.chunk(job.job_id, { seq: 1, body: sse('b') });
  assert.deepEqual([answer.status, answer.json.ok, answer.json.cancel], [200, true, true]);
  assert.equal(h.m.scheduler.getJob(job.job_id).state, 'cancelled');
});

test('H14: after the caller closed on [DONE], the final chunk of the node is acknowledged, not job_not_found', async (t) => {
  const h = await startNodeHost(t);
  await h.register(h.seats.member);
  const { job } = h.queueJob();
  await h.claimed(h.seats.member);
  const node = await h.as(h.seats.member);
  assert.equal((await node.chunk(job.job_id, { seq: 0, body: Buffer.concat([sse('a'), DONE]) })).json.cancel, false);
  assert.equal(h.m.scheduler.cancelJob(job.job_id).ok, true);
  assert.equal(h.m.scheduler.getJob(job.job_id).state, 'done', 'a close after [DONE] completes the job');
  const final = await node.chunk(job.job_id, { seq: 1, final: true });
  assert.deepEqual([final.status, final.json.ok, final.json.next_seq], [200, true, 1]);
  const stray = await node.chunk(job.job_id, { seq: 2, body: sse('late') });
  assert.deepEqual([stray.status, stray.json.ok, stray.json.cancel], [200, true, true], 'more output is told to stop');
});

test('a member demoted while the chunk body arrives is refused and the chunk changes nothing', async (t) => {
  const rates = countedRates();
  const h = await startNodeHost(t, { rates });
  await h.register(h.seats.member);
  const { job } = h.queueJob();
  await h.claimed(h.seats.member);
  const node = await h.as(h.seats.member);
  const body = sse(`${MARKER} late`);
  const sending = node.chunkInParts(job.job_id, { seq: 0, first: body.subarray(0, 8), rest: body.subarray(8) });
  await until(() => rates.taken.chunk === 1, 'the route is reading the body');
  assert.equal((await h.m.store.setRole({ actorMemberId: h.seats.owner.member_id, memberId: h.seats.member.member_id,
    role: 'read_only' })).ok, true);
  const answer = await sending.finish();
  assert.deepEqual([answer.status, answer.json.error?.reason], [403, 'role_forbidden']);
  assert.equal(h.m.scheduler.getJob(job.job_id).next_seq, 0, 'nothing was accepted');
});

for (const [label, change] of [
  ['is revoked', (h, who) => h.m.store.revokeMember({ actorMemberId: h.seats.owner.member_id, memberId: who.member_id })],
  ['leaves', (h, who) => h.m.store.leave({ memberId: who.member_id })],
  ['is set to read-only', (h, who) => h.m.store.setRole({ actorMemberId: h.seats.owner.member_id, memberId: who.member_id,
    role: 'read_only' })],
  ['loses the device', (h, who) => h.m.store.revokeDevice({ actorMemberId: h.seats.owner.member_id, deviceId: who.device_id })],
]) {
  test(`a member who ${label} loses the node at once; another member's node and their other device's stay`, async (t) => {
    const h = await startNodeHost(t);
    const phone = await h.spareDevice(h.seats.member);
    await h.register(h.seats.member);
    const phoneNode = await h.register(phone);
    const secondNode = await h.register(h.seats.second);
    const before = h.m.scheduler.listNodes().length;
    assert.equal(before, 3);
    assert.equal((await change(h, h.seats.member)).ok, true);
    const left = h.m.scheduler.listNodes().map((view) => view.node_id).sort();
    const expected = label === 'loses the device' ? [phoneNode, secondNode] : [secondNode];
    assert.deepEqual(left, expected.sort());
  });
}

test('a waiting claim of a node whose member was set to read-only ends refused and claims nothing', async (t) => {
  const rates = countedRates();
  const h = await startNodeHost(t, { rates });
  await h.register(h.seats.member);
  const node = await h.as(h.seats.member);
  const waiting = node.send('team.node.claim', { claim_seq: 1, wait_ms: 25_000 });
  await until(() => rates.taken.claim === 1, 'the claim waits');
  assert.equal((await h.m.store.setRole({ actorMemberId: h.seats.owner.member_id, memberId: h.seats.member.member_id,
    role: 'read_only' })).ok, true);
  const answer = await waiting;
  assert.deepEqual([answer.ok, answer.error?.code], [false, 'CMP-HOST-0003']);
  assert.deepEqual(h.m.scheduler.listNodes(), []);
});

test('the chunk rate limit answers node_rate_limit', async (t) => {
  const h = await startNodeHost(t, { rates: createNodeRates({ chunkPerSlot: 3 }) });
  await h.register(h.seats.member);
  const { job } = h.queueJob();
  await h.claimed(h.seats.member);
  const node = await h.as(h.seats.member);
  for (let seq = 0; seq < 3; seq += 1) assert.equal((await node.chunk(job.job_id, { seq })).status, 200);
  const limited = await node.chunk(job.job_id, { seq: 3 });
  assert.deepEqual([limited.status, reasonOf(limited)], [429, 'node_rate_limit']);
  assert.equal(h.m.scheduler.getJob(job.job_id).next_seq, 3);
});

test('a forged, another device\'s and a finished job id answer both routes byte for byte the same', async (t) => {
  const h = await startNodeHost(t);
  await h.register(h.seats.member);
  await h.register(h.seats.second);
  const one = h.queueJob();
  const two = h.queueJob();
  await h.claimed(h.seats.member);
  await h.claimed(h.seats.second);
  const memberNode = h.m.scheduler.nodeIdForDevice(h.seats.member.device_id);
  const mine = [one, two].find(({ job }) => h.m.scheduler.getJob(job.job_id).node_id === memberNode).job;
  const theirs = [one, two].find(({ job }) => job.job_id !== mine.job_id).job;
  const node = await h.as(h.seats.member);
  await node.chunk(mine.job_id, { seq: 0, final: true, body: Buffer.concat([sse('x'), DONE]) });
  assert.equal(h.m.scheduler.getJob(mine.job_id).state, 'done');
  for (const call of [(id) => node.fetchRequest(id), (id) => node.chunk(id, { seq: 0, body: sse('y') })]) {
    const answers = [];
    for (const jobId of ['job_AAAAAAAAAAAAAAAAAAAAAA', theirs.job_id, mine.job_id, 'not-a-job']) {
      const answer = await call(jobId);
      answers.push(`${answer.status} ${answer.text}`);
    }
    assert.equal(new Set(answers).size, 1, answers.join('\n'));
    assert.match(answers[0], /^403 .*"job_not_found"/u);
  }
  assert.equal(h.m.scheduler.getJob(theirs.job_id).next_seq, 0, 'another device\'s job is untouched');
});

test('a member set to read-only after claiming is refused as such on both routes', async (t) => {
  const h = await startNodeHost(t);
  await h.register(h.seats.member);
  const { job } = h.queueJob();
  await h.claimed(h.seats.member);
  const node = await h.as(h.seats.member);
  assert.equal((await h.m.store.setRole({ actorMemberId: h.seats.owner.member_id, memberId: h.seats.member.member_id,
    role: 'read_only' })).ok, true);
  for (const answer of [await node.fetchRequest(job.job_id), await node.chunk(job.job_id, { seq: 0, body: sse('x') })]) {
    assert.deepEqual([answer.status, reasonOf(answer)], [403, 'role_forbidden']);
  }
});

test('a second device of the same member cannot read the first device\'s job; with no pool both routes say so', async (t) => {
  const h = await startNodeHost(t);
  await h.register(h.seats.member);
  const { job } = h.queueJob();
  await h.claimed(h.seats.member);
  const phone = await h.as(await h.spareDevice(h.seats.member));
  assert.equal(reasonOf(await phone.fetchRequest(job.job_id)), 'job_not_found');
  assert.equal(reasonOf(await phone.chunk(job.job_id, { seq: 0, body: sse('x') })), 'job_not_found');
  assert.equal(h.m.scheduler.getJob(job.job_id).next_seq, 0);

  const bare = await startNodeHost(t, { withPool: false });
  const member = await bare.as(bare.seats.member);
  for (const answer of [await member.fetchRequest('job_AAAAAAAAAAAAAAAAAAAAAA'),
    await member.chunk('job_AAAAAAAAAAAAAAAAAAAAAA', { seq: 0 })]) {
    assert.deepEqual([answer.status, reasonOf(answer)], [503, 'team_pool_unavailable']);
  }
});

test('other node paths are not handled, and a query string never reaches a route', async (t) => {
  const h = await startNodeHost(t);
  await h.register(h.seats.member);
  const { job } = h.queueJob();
  await h.claimed(h.seats.member);
  const node = await h.as(h.seats.member);
  for (const [method, path] of [['GET', '/api/v1/team/node/jobs'], ['GET', `/api/v1/team/node/jobs/${job.job_id}`],
    ['POST', `/api/v1/team/node/jobs/${job.job_id}/request`], ['GET', `/api/v1/team/node/jobs/${job.job_id}/chunks`],
    ['GET', '/api/v1/team/node/anything']]) {
    const answer = await node.client.request(method, path, { headers: node.auth });
    assert.deepEqual([answer.status, reasonOf(answer)], [404, 'route_not_found'], `${method} ${path}`);
  }
  const query = await node.client.request('GET', `/api/v1/team/node/jobs/${job.job_id}/request?x=1`, { headers: node.auth });
  assert.equal(reasonOf(query), 'query_not_supported');
  const unbound = await node.client.request('GET', `/api/v1/team/node/jobs/${job.job_id}/request`);
  assert.equal(reasonOf(unbound), 'client_required', 'a request without a registered client');
});
