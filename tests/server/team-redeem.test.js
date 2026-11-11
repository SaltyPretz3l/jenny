'use strict';

// Team slice 1c-2a: joining and leaving over the team HTTP layer. The invite
// principal redeems once; the store's own failures pass through; leave goes
// through the guard and the store.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createClock, createTeamHttpFixture, randomPublicKey, waitUntil } = require('./helpers/team-http-fixture');

const JOIN = '/api/v1/team/join';

function reasonOf(response) {
  return response.json?.error?.reason;
}

function joinBody(overrides = {}) {
  return { device_public_key: randomPublicKey(), display_name: 'Nora Newcomer', label: 'Phone', ...overrides };
}

test('a new-member invite redeems to a pending member and the parent hears ids only', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { invite } = await env.seed();
  const deviceKey = randomPublicKey();
  const joiner = env.client(invite.key);
  assert.equal((await joiner.hello()).status, 200);
  const joined = await joiner.request('POST', JOIN, { body: joinBody({ device_public_key: deviceKey }) });
  assert.equal(joined.status, 200);
  assert.deepEqual(Object.keys(joined.json), ['ok', 'member_id', 'device_id', 'state']);
  assert.equal(joined.json.state, 'pending');
  assert.deepEqual(env.notified, [{ kind: 'member_joined', member_id: joined.json.member_id }]);
  // The answer is sent first; then the socket closes and the invite key is dropped from the transport.
  assert.equal(await waitUntil(() => joiner.socket.destroyed), true);
  assert.deepEqual(env.dropped, [invite.key]);
  // The same invite key cannot be used again: a new connection with it is a stranger.
  const again = env.client(invite.key);
  await assert.rejects(again.hello());
  // The joiner's device key now finds a pending member (the "redeem answer was lost" path).
  const device = env.client(deviceKey);
  assert.equal((await device.hello()).status, 200);
  const status = await device.request('POST', '/api/v1/team/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.state, 'pending');
  assert.equal(status.json.role, 'member');
  assert.equal(status.json.member_id, joined.json.member_id);
  assert.equal(status.json.device_id, joined.json.device_id);
});

test('an expired invite answers invite_not_valid from the store', async (t) => {
  const clock = createClock();
  let expireNow = false;
  const env = await createTeamHttpFixture(t, { clock, beforeRedeem: () => { if (expireNow) clock.advance(120_000); } });
  const owner = await env.redeemDirect({ kind: 'owner_first', name: 'Olive Owner' });
  const invite = await env.newInvite({ actor: owner.member_id, ttlMs: 60_000 });
  const joiner = env.client(invite.key);
  assert.equal((await joiner.hello()).status, 200);
  // The invite is live when the request arrives and expires before the store looks at it.
  expireNow = true;
  const response = await joiner.request('POST', JOIN, { body: joinBody() });
  assert.equal(response.status, 403);
  assert.equal(reasonOf(response), 'invite_not_valid');
  assert.equal(env.redeemCalls.length, 1);
  assert.deepEqual(env.notified, []);
  assert.deepEqual(env.dropped, []);
});

test('an owner-first invite on an empty store redeems to an active owner', async (t) => {
  const env = await createTeamHttpFixture(t);
  const invite = await env.newInvite({ kind: 'owner_first' });
  const deviceKey = randomPublicKey();
  const joiner = env.client(invite.key);
  assert.equal((await joiner.hello()).status, 200);
  const joined = await joiner.request('POST', JOIN, { body: joinBody({ device_public_key: deviceKey, display_name: 'Olive Owner' }) });
  assert.equal(joined.status, 200);
  assert.equal(joined.json.state, 'active');
  const device = env.client(deviceKey);
  await device.hello();
  const status = await device.request('POST', '/api/v1/team/status');
  assert.equal(status.json.role, 'owner');
  assert.equal(status.json.state, 'active');
  assert.equal((await device.request('GET', '/api/v1/team/bootstrap')).status, 200);
});

test("a store failure is answered with its own kind and reason and leaves the connection open", async (t) => {
  const env = await createTeamHttpFixture(t);
  const { invite } = await env.seed();
  const joiner = env.client(invite.key);
  await joiner.hello();
  const blankName = await joiner.request('POST', JOIN, { body: joinBody({ display_name: '' }) });
  assert.equal(blankName.status, 400);
  assert.equal(reasonOf(blankName), 'team_display_name_invalid');
  const badKey = await joiner.request('POST', JOIN, { body: joinBody({ device_public_key: 'short' }) });
  assert.equal(badKey.status, 400);
  assert.equal(reasonOf(badKey), 'team_public_key_invalid');
  assert.equal(joiner.socket.destroyed, false);
  assert.deepEqual(env.notified, []);
  assert.deepEqual(env.dropped, []);
  // The invite is still unspent: the same principal can still join.
  const joined = await joiner.request('POST', JOIN, { body: joinBody() });
  assert.equal(joined.status, 200);
});

test('a join body must be exactly three strings', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { invite } = await env.seed();
  const joiner = env.client(invite.key);
  await joiner.hello();
  const bodies = [{}, { ...joinBody(), extra: 'x' }, joinBody({ label: 7 }), { device_public_key: 'a', display_name: 'b' }];
  for (const body of bodies) {
    const response = await joiner.request('POST', JOIN, { body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(reasonOf(response), 'request_failed', JSON.stringify(body));
  }
  assert.equal(env.redeemCalls.length, 0);
});

test('a member who leaves is revoked and the next request on its connection is dropped', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { member } = await env.seed();
  const client = env.client(member.key);
  await client.hello();
  const left = await client.request('POST', '/api/v1/team/leave');
  assert.equal(left.status, 200);
  assert.deepEqual(left.json, { ok: true });
  assert.equal(env.store.getMember(member.member_id).state, 'revoked');
  await assert.rejects(client.request('POST', '/api/v1/team/status'));
});

test('a pending member may leave; the owner is refused by the guard and the store is untouched', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { owner, pending } = await env.seed();
  const ownerClient = env.client(owner.key);
  await ownerClient.hello();
  const refused = await ownerClient.request('POST', '/api/v1/team/leave');
  assert.equal(refused.status, 403);
  assert.equal(reasonOf(refused), 'role_forbidden');
  assert.equal(env.store.getMember(owner.member_id).state, 'active');
  const pendingClient = env.client(pending.key);
  await pendingClient.hello();
  assert.equal((await pendingClient.request('POST', '/api/v1/team/leave')).status, 200);
  assert.equal(env.store.getMember(pending.member_id).state, 'revoked');
});

test('leave and status take no request body', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { member } = await env.seed();
  const client = env.client(member.key);
  await client.hello();
  const withBody = await client.request('POST', '/api/v1/team/leave', { body: { x: 1 } });
  assert.equal(withBody.status, 400);
  assert.equal(reasonOf(withBody), 'request_failed');
  assert.equal(env.store.getMember(member.member_id).state, 'active');
});
