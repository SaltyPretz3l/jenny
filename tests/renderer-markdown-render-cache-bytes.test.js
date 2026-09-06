'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMarkdownRenderCache } = require('../renderer/shared/markdown-render-cache');

test('byte budget evicts large entries before the entry cap', () => {
  const cache = createMarkdownRenderCache({ maxEntries: 100, maxBytes: 150 });
  cache.set(['first', 'x'.repeat(40)], 'A'.repeat(40));
  cache.set(['second', 'y'.repeat(40)], 'B'.repeat(40));

  assert.equal(cache.stats().size, 1);
  assert.equal(cache.get(['first', 'x'.repeat(40)]).hit, false);
  assert.equal(cache.get(['second', 'y'.repeat(40)]).value, 'B'.repeat(40));
  assert.equal(cache.stats().byteEvictions, 1);
  assert.equal(cache.stats().entryEvictions, 0);
  assert.equal(cache.stats().evictions, 1);
});

test('tiny entries still evict at maxEntries with the correct reason', () => {
  const cache = createMarkdownRenderCache({ maxEntries: 2, maxBytes: 10_000 });
  cache.set(['a'], 'A');
  cache.set(['b'], 'B');
  cache.set(['c'], 'C');

  assert.equal(cache.get(['a']).hit, false);
  assert.equal(cache.stats().entryEvictions, 1);
  assert.equal(cache.stats().byteEvictions, 0);
  assert.equal(cache.stats().evictions, 1);
});

test('get refreshes recency under byte eviction', () => {
  const cache = createMarkdownRenderCache({ maxEntries: 10, maxBytes: 35 });
  cache.set(['a'], 'A'.repeat(10));
  cache.set(['b'], 'B'.repeat(10));
  assert.equal(cache.get(['a']).hit, true);
  cache.set(['c'], 'C'.repeat(10));

  assert.equal(cache.get(['a']).hit, true);
  assert.equal(cache.get(['b']).hit, false);
  assert.equal(cache.get(['c']).hit, true);
  assert.equal(cache.stats().byteEvictions, 1);
});

test('clear resets byte accounting and both eviction counters', () => {
  const cache = createMarkdownRenderCache({ maxEntries: 10, maxBytes: 40 });
  cache.set(['first'], 'x'.repeat(20));
  cache.set(['second'], 'x'.repeat(20));
  assert.ok(cache.stats().byteEvictions > 0);
  cache.clear();

  assert.equal(cache.stats().size, 0);
  assert.equal(cache.stats().bytes, 0);
  assert.equal(cache.stats().byteEvictions, 0);
  assert.equal(cache.stats().entryEvictions, 0);
  assert.equal(cache.stats().evictions, 0);
});

test('an oversize value is not inserted and does not flush reusable entries', () => {
  const cache = createMarkdownRenderCache({ maxEntries: 10, maxBytes: 30 });
  cache.set(['kept'], 'ok');
  const before = cache.stats();

  cache.set(['huge'], 'x'.repeat(30));

  assert.equal(cache.get(['kept']).value, 'ok');
  assert.equal(cache.get(['huge']).hit, false);
  assert.equal(cache.stats().size, 1);
  assert.equal(cache.stats().bytes, before.bytes);
  assert.equal(cache.stats().evictions, 0);
});

test('byte diagnostics are enumerable and survive JSON serialization', () => {
  const cache = createMarkdownRenderCache({ maxEntries: 2, maxBytes: 100 });
  cache.set(['a'], 'A');
  const stats = cache.stats();

  assert.deepEqual(Object.keys(stats), [
    'size', 'max', 'bytes', 'maxBytes', 'hits', 'misses', 'bypasses',
    'evictions', 'byteEvictions', 'entryEvictions',
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(stats)), stats);
});
