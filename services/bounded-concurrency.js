'use strict';

async function mapWithConcurrency(items, limit, iteratee) {
  const numericLimit = Number(limit);
  const concurrency = Number.isFinite(numericLimit)
    ? Math.max(1, Math.floor(numericLimit))
    : 1;
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await iteratee(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

module.exports = { mapWithConcurrency };
