'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { mapWithConcurrency } = require('../services/bounded-concurrency');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('mapWithConcurrency preserves input order when work completes out of order', async () => {
  const waits = [30, 10, 1];
  const results = await mapWithConcurrency(['slow', 'medium', 'fast'], 3, async (item, index) => {
    await delay(waits[index]);
    return `${index}:${item}`;
  });

  assert.deepEqual(results, ['0:slow', '1:medium', '2:fast']);
});

test('mapWithConcurrency respects the concurrency ceiling', async () => {
  let inFlight = 0;
  let observedMaximum = 0;
  await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
    inFlight += 1;
    observedMaximum = Math.max(observedMaximum, inFlight);
    await delay(5);
    inFlight -= 1;
  });

  assert.equal(observedMaximum, 2);
});

test('mapWithConcurrency treats invalid non-positive limits as one', async () => {
  for (const limit of [0, -3, 'not-a-number']) {
    let inFlight = 0;
    let observedMaximum = 0;
    await mapWithConcurrency([1, 2, 3], limit, async () => {
      inFlight += 1;
      observedMaximum = Math.max(observedMaximum, inFlight);
      await delay(2);
      inFlight -= 1;
    });
    assert.equal(observedMaximum, 1, `limit ${limit}`);
  }
});

test('mapWithConcurrency resolves empty input without calling the iteratee', async () => {
  let calls = 0;
  const results = await mapWithConcurrency([], 4, async () => { calls += 1; });

  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});

test('mapWithConcurrency propagates iteratee rejection', async () => {
  const rejection = new Error('iteration failed');
  await assert.rejects(
    mapWithConcurrency(['bad'], 2, async () => { throw rejection; }),
    (error) => error === rejection
  );
});
