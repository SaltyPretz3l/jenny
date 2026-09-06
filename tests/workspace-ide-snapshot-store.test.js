'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const { createWorkspaceIdeSnapshotStore } = require('../services/workspace-ide-snapshot-store');
const {
  normalizeDiffInputText,
  sha256Text,
} = require('../services/tools/structured-diff');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function listSnapshots(rootDir) {
  return fs.readdirSync(rootDir).filter((name) => name.endsWith('.snap')).sort();
}

// LRU order comes from each .snap file's mtime, which `capture` stamps with
// `new Date()`. Sleeping between captures to separate those stamps makes the
// eviction assertions depend on filesystem timestamp resolution and on the
// scheduler actually honouring the sleep. Setting the mtime outright is exact
// and costs no wall time.
function ageSnapshot(rootDir, hash, secondsAgo) {
  const when = new Date(Date.UTC(2026, 0, 1) + (1000 - secondsAgo) * 1000);
  fs.utimesSync(path.join(rootDir, `${hash.slice('sha256:'.length)}.snap`), when, when);
}

function expectedBeforeHash(text) {
  return sha256Text(normalizeDiffInputText(text));
}

test('snapshot store round-trips content keyed by the structured-diff before_hash', async () => {
  const rootDir = path.join(createTrackedTempDir('jenny-snap-'), 'store');
  const store = createWorkspaceIdeSnapshotStore({ rootDir });

  // CRLF input: the key must match the EOL-normalized hash the change
  // ledger carries, and the stored content is the normalized text.
  const original = 'line one\r\nline two\r\n';
  const captured = await store.capture({ pathHint: 'src/app.js', content: original });
  assert.equal(captured.stored, true);

  const beforeHash = expectedBeforeHash(original);
  assert.equal(captured.hash, beforeHash);

  const readBack = await store.read(beforeHash);
  assert.equal(readBack.found, true);
  assert.equal(readBack.content, 'line one\nline two\n');
});

test('snapshot store dedupes identical content and reports misses as data', async () => {
  const rootDir = path.join(createTrackedTempDir('jenny-snap-'), 'store');
  const store = createWorkspaceIdeSnapshotStore({ rootDir });

  const first = await store.capture({ pathHint: 'a.txt', content: 'same text' });
  const second = await store.capture({ pathHint: 'b.txt', content: 'same text' });
  assert.equal(first.stored, true);
  assert.equal(second.stored, true);
  assert.equal(second.deduped, true);
  assert.equal(listSnapshots(rootDir).length, 1);

  const missing = await store.read(expectedBeforeHash('never captured'));
  assert.deepEqual(missing, { found: false, reason: 'missing' });
  const invalid = await store.read('not-a-hash');
  assert.deepEqual(invalid, { found: false, reason: 'invalid_hash' });
  // Path-traversal shaped input never reaches the filesystem layer.
  const hostile = await store.read('sha256:../../../etc/passwd');
  assert.deepEqual(hostile, { found: false, reason: 'invalid_hash' });
});

test('snapshot store skips oversize content and prunes LRU past the caps', async () => {
  const rootDir = path.join(createTrackedTempDir('jenny-snap-'), 'store');
  const store = createWorkspaceIdeSnapshotStore({
    rootDir,
    maxEntries: 2,
    maxSnapshotBytes: 64,
  });

  const tooLarge = await store.capture({ pathHint: 'big.txt', content: 'x'.repeat(65) });
  assert.equal(tooLarge.stored, false);
  assert.equal(tooLarge.reason, 'too_large');
  assert.equal(fs.existsSync(rootDir) ? listSnapshots(rootDir).length : 0, 0);

  const first = await store.capture({ pathHint: 'one.txt', content: 'one' });
  ageSnapshot(rootDir, first.hash, 300);
  const second = await store.capture({ pathHint: 'two.txt', content: 'two' });
  ageSnapshot(rootDir, second.hash, 200);
  const third = await store.capture({ pathHint: 'three.txt', content: 'three' });
  ageSnapshot(rootDir, third.hash, 100);

  // maxEntries 2: the oldest snapshot is evicted.
  assert.equal(listSnapshots(rootDir).length, 2);
  const evicted = await store.read(first.hash);
  assert.equal(evicted.found, false);
  const kept = await store.read(third.hash);
  assert.equal(kept.found, true);
});

test('snapshot store prunes by total bytes', async () => {
  const rootDir = path.join(createTrackedTempDir('jenny-snap-'), 'store');
  const store = createWorkspaceIdeSnapshotStore({ rootDir, maxTotalBytes: 50 });

  const older = await store.capture({ pathHint: 'one.txt', content: 'a'.repeat(30) });
  ageSnapshot(rootDir, older.hash, 300);
  const second = await store.capture({ pathHint: 'two.txt', content: 'b'.repeat(30) });

  // 60 bytes total > 50: only the newest survives.
  assert.equal(listSnapshots(rootDir).length, 1);
  assert.equal((await store.read(second.hash)).found, true);
});

test('snapshot store detects corrupt snapshots and deletes them', async () => {
  const rootDir = path.join(createTrackedTempDir('jenny-snap-'), 'store');
  const store = createWorkspaceIdeSnapshotStore({ rootDir });

  const captured = await store.capture({ pathHint: 'a.txt', content: 'intact' });
  const fileName = `${captured.hash.slice('sha256:'.length)}.snap`;
  fs.writeFileSync(path.join(rootDir, fileName), 'tampered', 'utf8');

  const result = await store.read(captured.hash);
  assert.deepEqual(result, { found: false, reason: 'corrupt' });
  assert.equal(listSnapshots(rootDir).length, 0);
});

test('snapshot store is fail-open: capture and read never throw on a broken fs', async () => {
  const brokenFs = {
    mkdir: async () => { throw new Error('disk on fire'); },
    readFile: async () => { throw new Error('disk on fire'); },
  };
  const store = createWorkspaceIdeSnapshotStore({ rootDir: 'Z:/nope', fs: brokenFs });

  const captured = await store.capture({ pathHint: 'a.txt', content: 'text' });
  assert.equal(captured.stored, false);
  assert.equal(captured.reason, 'error');
  // The hash still comes back so callers can log/correlate.
  assert.equal(captured.hash, expectedBeforeHash('text'));

  const read = await store.read(captured.hash);
  assert.equal(read.found, false);
  assert.equal(read.reason, 'error');

  const unconfigured = createWorkspaceIdeSnapshotStore({ rootDir: '' });
  assert.deepEqual(
    await unconfigured.capture({ pathHint: 'a.txt', content: 'text' }),
    { stored: false, hash: '', reason: 'unconfigured' }
  );
  assert.equal((await unconfigured.capture({ pathHint: 'a.txt' })).reason, 'unconfigured');
});

test('snapshot store rejects non-string content without touching disk', async () => {
  const rootDir = path.join(createTrackedTempDir('jenny-snap-'), 'store');
  const store = createWorkspaceIdeSnapshotStore({ rootDir });
  const result = await store.capture({ pathHint: 'a.bin', content: Buffer.from('x') });
  assert.deepEqual(result, { stored: false, hash: '', reason: 'not_text' });
  assert.equal(fs.existsSync(rootDir), false);
});
