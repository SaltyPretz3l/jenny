'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const limits = require('../services/remote/remote-limits');

test('frame limits describe whole wire messages and the plaintext a frame can carry', () => {
  assert.equal(limits.FRAME_MAX_BYTES, 1_048_576);
  assert.equal(limits.FRAME_HEADER_BUDGET_BYTES, 512);
  assert.equal(
    limits.FRAME_PLAINTEXT_MAX_BYTES,
    Math.floor(((limits.FRAME_MAX_BYTES - limits.FRAME_HEADER_BUDGET_BYTES) * 3) / 4) - 16
  );
  assert.ok(limits.TRANSCRIPT_PAGE_MAX_BYTES < limits.FRAME_PLAINTEXT_MAX_BYTES);
});

test('rate limiter refills per minute and honours the burst', () => {
  let now = 0;
  const limiter = limits.createRateLimiter({ perMinute: 60, burst: 2, now: () => now });
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), false);
  now = 1000;
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), false);
  limiter.reset('a');
  assert.equal(limiter.take('a'), true);
});

test('an exhausted identity cannot regain its burst by being evicted at capacity', () => {
  let now = 0;
  const limiter = limits.createRateLimiter({ perMinute: 60, burst: 1, now: () => now });
  assert.equal(limiter.take('victim'), true);
  assert.equal(limiter.take('victim'), false);
  let admitted = 0;
  for (let index = 0; index < 300; index += 1) {
    if (limiter.take(`other_${index}`)) admitted += 1;
  }
  // Capacity is 256 keys; nothing has refilled, so no bucket may be evicted.
  assert.equal(admitted, 255);
  assert.equal(limiter.size(), 256);
  assert.equal(limiter.take('victim'), false);
  now = 60_000;
  // Every bucket has refilled: new keys are admitted again and the victim refills normally.
  assert.equal(limiter.take('late'), true);
  assert.equal(limiter.take('victim'), true);
});
