'use strict';

// Team slice 1c-2a: the fixed-window rate limiter, and the join limits it
// enforces in the team HTTP layer (5 per invite key and 20 overall per minute).

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRateLimiter } = require('../../server/team/rate-limit');
const { createClock, createTeamHttpFixture, randomPublicKey } = require('./helpers/team-http-fixture');

test('the limiter counts attempts up to the limit and then refuses', () => {
  const clock = createClock(1000);
  const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, maxKeys: 4, clock });
  assert.deepEqual([1, 2, 3, 4, 5].map(() => limiter.take('a')), [true, true, true, false, false]);
  assert.equal(limiter.take('b'), true, 'another key has its own count');
  assert.equal(limiter.size(), 2);
});

test('the window rolls over after windowMs and the count restarts', () => {
  const clock = createClock(1000);
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, maxKeys: 2, clock });
  assert.deepEqual([limiter.take('a'), limiter.take('a'), limiter.take('a')], [true, true, false]);
  clock.advance(999);
  assert.equal(limiter.take('a'), false, 'one millisecond before the window ends');
  clock.advance(1);
  assert.deepEqual([limiter.take('a'), limiter.take('a'), limiter.take('a')], [true, true, false]);
});

test('the key cap drops expired windows first and refuses a new key when still full', () => {
  const clock = createClock(0);
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 2, clock });
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('b'), true);
  assert.equal(limiter.take('c'), false, 'full of live keys');
  assert.equal(limiter.size(), 2);
  assert.equal(limiter.take('a'), false, 'a flood of new keys did not reset a live count');
  clock.advance(1000);
  assert.equal(limiter.take('c'), true, 'the expired keys made room');
  assert.equal(limiter.size(), 1);
});

test('the limiter rejects bad options and unusable keys', () => {
  assert.throws(() => createRateLimiter({ limit: 0, windowMs: 1, maxKeys: 1 }), TypeError);
  assert.throws(() => createRateLimiter({ limit: 1, windowMs: 1.5, maxKeys: 1 }), TypeError);
  assert.throws(() => createRateLimiter({ limit: 1, windowMs: 1, maxKeys: -1 }), TypeError);
  assert.throws(() => createRateLimiter(), TypeError);
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 1 });
  assert.equal(limiter.take(''), false);
  assert.equal(limiter.take(undefined), false);
  assert.equal(limiter.size(), 0);
});

function failingJoin(overrides = {}) {
  return { device_public_key: randomPublicKey(), display_name: '', label: 'Phone', ...overrides };
}

test('the sixth join attempt for one invite key in a minute answers team_rate_limit and skips the store', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { invite } = await env.seed();
  const joiner = env.client(invite.key);
  await joiner.hello();
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await joiner.request('POST', '/api/v1/team/join', { body: failingJoin() });
    assert.equal(response.json.error.reason, 'team_display_name_invalid', `attempt ${attempt}`);
  }
  assert.equal(env.redeemCalls.length, 5);
  const sixth = await joiner.request('POST', '/api/v1/team/join', { body: failingJoin({ display_name: 'Nora' }) });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.json.error.reason, 'team_rate_limit');
  assert.equal(env.redeemCalls.length, 5, 'the store was not called');
  assert.deepEqual(env.notified, []);
});

test('twenty join attempts per minute over all invite keys, then the next key is refused', async (t) => {
  const env = await createTeamHttpFixture(t);
  const owner = await env.redeemDirect({ kind: 'owner_first', name: 'Olive Owner' });
  const joiners = [];
  for (let index = 0; index < 5; index += 1) {
    const invite = await env.newInvite({ actor: owner.member_id });
    const joiner = env.client(invite.key);
    await joiner.hello();
    joiners.push(joiner);
  }
  for (const joiner of joiners.slice(0, 4)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await joiner.request('POST', '/api/v1/team/join', { body: failingJoin() });
      assert.equal(response.json.error.reason, 'team_display_name_invalid');
    }
  }
  assert.equal(env.redeemCalls.length, 20);
  const refused = await joiners[4].request('POST', '/api/v1/team/join', { body: failingJoin({ display_name: 'Nora' }) });
  assert.equal(refused.status, 429);
  assert.equal(refused.json.error.reason, 'team_rate_limit');
  assert.equal(env.redeemCalls.length, 20);
});
