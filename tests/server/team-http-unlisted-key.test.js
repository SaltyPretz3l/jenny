'use strict';

// new-test-file: the unlisted-key cases run the real preamble listener over a real member store, a lane
// apart from team-http.test.js's stubbed layer.

// A key that is no longer on the member list gets
// no byte from the team HTTP layer, even when the request capacity is full, and the
// first request on its connection closes every connection of that key (the bridge's
// drop). The real preamble listener and team HTTP layer over a real member store.

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { TEAM_HOST } = require('../../server/team/team-http-server');
const { createTeamHttpFixture, pause, waitUntil } = require('./helpers/team-http-fixture');

// Counts every byte the client's current socket receives from now on.
function countBytes(client) {
  const counter = { bytes: 0, closed: false };
  client.socket.on('data', (chunk) => { counter.bytes += chunk.length; });
  client.socket.once('close', () => { counter.closed = true; });
  return counter;
}

// One request on the client's admitted connection; answers 'closed' when the socket closes with no answer.
function requestOutcome(client) {
  return client.request('POST', '/api/v1/team/status', { body: {} })
    .then((response) => response.status, () => 'closed');
}

test('a key revoked after the preamble gets zero bytes and a closed socket while the request capacity is full', async (t) => {
  const env = await createTeamHttpFixture(t, { resourceLimits: { maxConcurrentRequests: 1 } });
  const { owner, member } = await env.seed();
  const memberClient = env.client(member.key);
  assert.equal((await memberClient.hello()).status, 200, 'the member connection is admitted');
  const holder = env.client(owner.key);
  assert.equal((await holder.hello()).status, 200);
  // The owner holds the only request slot with a body that never completes.
  const held = http.request({ agent: holder.agent, host: '127.0.0.1', port: env.port, method: 'POST',
    path: '/api/v1/commands', headers: { Host: TEAM_HOST, 'Content-Type': 'application/json', 'Content-Length': 100 } });
  held.on('error', () => {});
  held.write('{');
  await pause(80);
  const revoked = await env.store.revokeMember({ actorMemberId: owner.member_id, memberId: member.member_id });
  assert.equal(revoked.ok, true);
  const counter = countBytes(memberClient);
  assert.equal(await requestOutcome(memberClient), 'closed');
  assert.equal(await waitUntil(() => counter.closed), true);
  assert.equal(counter.bytes, 0, 'no 429 body, no byte at all');
  assert.ok(env.dropped.includes(member.key), 'the revoked key loses its connections');
  held.destroy();
});

test('a revoked invite key and an expired invite key are dropped at their first request', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { owner } = await env.seed();
  const revokedInvite = await env.newInvite({ actor: owner.member_id });
  const expiringInvite = await env.newInvite({ actor: owner.member_id, ttlMs: 60_000 });
  const revokedClient = env.client(revokedInvite.key);
  const expiringClient = env.client(expiringInvite.key);
  assert.equal((await revokedClient.hello()).status, 200);
  assert.equal((await expiringClient.hello()).status, 200);
  const cancelled = await env.store.revokeInvite({ actorMemberId: owner.member_id, inviteId: revokedInvite.inviteId });
  assert.equal(cancelled.ok, true);
  env.clock.advance(61_000);
  assert.equal(env.dropped.length, 0, 'neither change emits a membership event that drops the key');
  for (const [client, key] of [[revokedClient, revokedInvite.key], [expiringClient, expiringInvite.key]]) {
    const counter = countBytes(client);
    assert.equal(await requestOutcome(client), 'closed');
    assert.equal(counter.bytes, 0);
    assert.ok(env.dropped.includes(key));
  }
});

test('a dropKey that throws still closes the socket without a byte', async (t) => {
  const env = await createTeamHttpFixture(t, { dropKeyFails: true });
  const { owner, member } = await env.seed();
  const memberClient = env.client(member.key);
  assert.equal((await memberClient.hello()).status, 200);
  await env.store.revokeMember({ actorMemberId: owner.member_id, memberId: member.member_id });
  // The revoke itself has no fan-out in this fixture, so the request is the first to see the key gone.
  const before = env.dropped.length;
  const counter = countBytes(memberClient);
  assert.equal(await requestOutcome(memberClient), 'closed');
  assert.equal(await waitUntil(() => counter.closed), true);
  assert.equal(counter.bytes, 0);
  assert.equal(env.dropped.length, before + 1, 'the drop was attempted');
  assert.equal(env.dropped.at(-1), member.key, 'for the revoked key');
});
