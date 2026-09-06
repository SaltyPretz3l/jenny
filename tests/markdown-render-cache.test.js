const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildKey,
  createMarkdownRenderCache,
} = require('../renderer/shared/markdown-render-cache');

test('structured cache keys cannot collide with embedded separators', () => {
  assert.notEqual(buildKey(['plain', 'x']), buildKey(['', 'plain\u0000x']));
  assert.notEqual(buildKey(['a\u0000b', 'c']), buildKey(['a', 'b\u0000c']));
});

test('cache is bounded LRU with additive diagnostics', () => {
  const cache = createMarkdownRenderCache({ maxEntries: 2 });
  cache.set(['a'], 'A');
  cache.set(['b'], 'B');
  assert.equal(cache.get(['a']).value, 'A');
  cache.set(['c'], 'C');
  assert.equal(cache.get(['b']).hit, false);
  cache.noteBypass();
  assert.deepEqual(cache.stats(), {
    size: 2,
    max: 2,
    bytes: 12,
    maxBytes: 16 * 1024 * 1024,
    hits: 1,
    misses: 1,
    bypasses: 1,
    evictions: 1,
    byteEvictions: 0,
    entryEvictions: 1,
  });
});

test('clear removes entries and resets diagnostics', () => {
  const cache = createMarkdownRenderCache({ maxEntries: 1 });
  cache.set(['a'], 'A');
  cache.get(['a']);
  cache.noteBypass();
  cache.clear();
  assert.deepEqual(cache.stats(), {
    size: 0,
    max: 1,
    bytes: 0,
    maxBytes: 16 * 1024 * 1024,
    hits: 0,
    misses: 0,
    bypasses: 0,
    evictions: 0,
    byteEvictions: 0,
    entryEvictions: 0,
  });
});
