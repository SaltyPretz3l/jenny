'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  DEFAULT_MAX_BYTES,
  asBuffer,
  boundedMaxBytes,
  getPartialCacheEntry,
  discardPartialCacheEntry,
  pruneExpiredPartials,
  putPartialCacheEntry,
  putVerifiedCacheEntry,
  readCacheIndex,
  validateIndex,
} = require('../../../services/plugins/store/package-cache');

const SOURCE = 'a'.repeat(64);

test('verified cache requires a full digest and records exact byte size', async () => {
  const facade = createMemoryFsFacade();
  const stored = await putVerifiedCacheEntry(facade, '', {
    bytes: Buffer.from('verified'), sourceIdentityDigest: SOURCE,
    verifiedAt: '2026-08-04T20:00:00Z',
  }, { maxBytes: 32 });
  assert.equal(stored.ok, true);
  assert.equal(stored.entry.size, Buffer.byteLength('verified'));
  const index = (await readCacheIndex(facade, '')).index;
  assert.equal(index.entries.some((entry) => entry.digest === stored.digest), true);
  assert.equal(index.index_digest.length, 64);
});

test('cache limit overrides can tighten but never raise the hard cap', () => {
  assert.equal(boundedMaxBytes(128), 128);
  assert.equal(boundedMaxBytes(DEFAULT_MAX_BYTES + 1), DEFAULT_MAX_BYTES);
  assert.equal(boundedMaxBytes(-1), DEFAULT_MAX_BYTES);
  assert.equal(asBuffer(null), null);
  assert.equal(validateIndex({
    cache_index_schema_version: 1,
    entries: [
      { digest: '1'.repeat(64), source_identity_digest: SOURCE, size: DEFAULT_MAX_BYTES,
        verified_at: '2026-08-04T20:00:00Z', last_accessed_at: '2026-08-04T20:00:00Z',
        leased: false, evidentiary: false },
      { digest: '2'.repeat(64), source_identity_digest: SOURCE, size: 1,
        verified_at: '2026-08-04T20:00:00Z', last_accessed_at: '2026-08-04T20:00:00Z',
        leased: false, evidentiary: false },
    ],
    index_digest: '0'.repeat(64),
  }), false);
});

test('malformed cache byte values return structured refusals', async () => {
  const facade = createMemoryFsFacade();
  const result = await putVerifiedCacheEntry(facade, '', {
    bytes: null, sourceIdentityDigest: SOURCE, verifiedAt: '2026-08-04T20:00:00Z',
  });
  assert.equal(result.reason, 'cache_entry_invalid');
  assert.equal((await putPartialCacheEntry(facade, '', {
    operationId: 'download-1', bytes: null, createdAt: '2026-08-04T20:00:00Z',
  })).reason, 'cache_partial_invalid');
});

test('cache eviction is oldest-first and never removes leased evidence', async () => {
  const facade = createMemoryFsFacade();
  const first = await putVerifiedCacheEntry(facade, '', {
    bytes: 'aaaa', sourceIdentityDigest: SOURCE, verifiedAt: '2026-08-04T20:00:00Z',
  }, { maxBytes: 8 });
  const protectedEntry = await putVerifiedCacheEntry(facade, '', {
    bytes: 'bbbb', sourceIdentityDigest: SOURCE, verifiedAt: '2026-08-04T20:01:00Z', leased: true,
  }, { maxBytes: 8 });
  const third = await putVerifiedCacheEntry(facade, '', {
    bytes: 'cccc', sourceIdentityDigest: SOURCE, verifiedAt: '2026-08-04T20:02:00Z',
  }, { maxBytes: 8 });
  assert.deepEqual(third.evicted, [first.digest]);
  const entries = (await readCacheIndex(facade, '')).index.entries;
  assert.equal(entries.some((entry) => entry.digest === first.digest), false);
  assert.equal(entries.some((entry) => entry.digest === protectedEntry.digest), true);

  const blocked = await putVerifiedCacheEntry(facade, '', {
    bytes: '12345', sourceIdentityDigest: SOURCE, verifiedAt: '2026-08-04T20:03:00Z',
  }, { maxBytes: 4 });
  assert.equal(blocked.reason, 'cache_entry_invalid');
});

test('partial cache entries expire after 24 hours and malformed metadata is pruned', async () => {
  const facade = createMemoryFsFacade();
  assert.equal((await putPartialCacheEntry(facade, '', {
    operationId: 'download-1', bytes: 'part', createdAt: '2026-08-03T19:00:00Z',
  })).ok, true);
  const result = await pruneExpiredPartials(facade, '', '2026-08-04T20:00:01Z');
  assert.deepEqual(result.removed, ['download-1']);
});

test('partial cache removes committed bytes when metadata publication fails', async () => {
  const facade = createMemoryFsFacade();
  const originalWriteFile = facade.writeFile.bind(facade);
  let writes = 0;
  facade.writeFile = async (filePath, contents) => {
    writes += 1;
    if (writes === 2) throw new Error('metadata write failed');
    return originalWriteFile(filePath, contents);
  };

  await assert.rejects(() => putPartialCacheEntry(facade, '', {
    operationId: 'download-failed', bytes: 'part', createdAt: '2026-08-04T20:00:00Z',
  }), /metadata write failed/);
  assert.deepEqual(await facade.list('distribution/cache/partials'), []);
});

test('partial cache persists only a strong validator and source identity', async () => {
  const facade = createMemoryFsFacade();
  assert.equal((await putPartialCacheEntry(facade, '', { operationId: 'download-2', bytes: 'part', createdAt: '2026-08-04T20:00:00Z', etag: '"v1"', sourceIdentityDigest: SOURCE })).ok, true);
  const read = await getPartialCacheEntry(facade, '', 'download-2');
  assert.equal(read.partial.etag, '"v1"'); assert.equal(read.partial.bytes.toString(), 'part');
  await discardPartialCacheEntry(facade, '', 'download-2');
  assert.equal((await getPartialCacheEntry(facade, '', 'download-2')).partial, null);
});

test('partial cache validates metadata before writing and detects byte corruption', async () => {
  const facade = createMemoryFsFacade();
  const invalid = await putPartialCacheEntry(facade, '', { operationId: 'download-3', bytes: 'part',
    createdAt: '2026-08-04T20:00:00Z', etag: 'W/"weak"', sourceIdentityDigest: SOURCE });
  assert.equal(invalid.reason, 'cache_partial_invalid');
  assert.equal((await facade.stat('distribution/cache/partials/download-3.partial')).exists, false);
  await putPartialCacheEntry(facade, '', { operationId: 'download-4', bytes: 'part',
    createdAt: '2026-08-04T20:00:00Z', etag: '"strong"', sourceIdentityDigest: SOURCE });
  await facade.writeFile('distribution/cache/partials/download-4.partial', 'evil');
  assert.equal((await getPartialCacheEntry(facade, '', 'download-4')).reason, 'cache_partial_digest_mismatch');
});

test('cache corruption fails closed and is not treated as a miss', async () => {
  const facade = createMemoryFsFacade();
  await facade.mkdir('distribution/cache');
  await facade.writeFile('distribution/cache/index.json', '{');
  assert.equal((await readCacheIndex(facade, '')).reason, 'cache_index_corrupted');
});
