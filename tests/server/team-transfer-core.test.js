'use strict';

// Slice 3-8a, T3: the transfer core on a real temporary directory with an
// injected clock. The core knows nothing about projects: an opaque owner id,
// a manifest, staging files named by index, a streamed hash check.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { TRANSFER_LIMITS } = require('../../server/team/transfer-manifest');
const { createTransferCore } = require('../../server/team/transfer-core');
const {
  OTHER, OWNER, begun, createTransferFixture, manifestOf, opened, received, refused, put, sendAll, sequenceRandom,
} = require('./helpers/transfer-fixture');

// ------------------------------------------------------------------ the happy path

test('a whole upload of several files in parts is committed, taken once and discarded', async (t) => {
  const fx = await opened(t, { limits: { maxPartBytes: 4 } });
  const contents = {
    'src/a.js': Buffer.from('console.log(1);\n'),
    'src/lib/b.txt': Buffer.from('0123456789'),
    'empty.txt': Buffer.alloc(0),
    'README.md': Buffer.from('# hi'),
  };
  const begin = await fx.core.begin({ ownerId: OWNER, files: manifestOf(contents) });
  assert.equal(begin.ok, true);
  assert.equal(begin.partSize, 4);
  assert.match(begin.uploadId, /^upload_[A-Za-z0-9_-]{22}$/u);
  const { uploadId } = begin;
  const list = Object.values(contents);
  for (const [index, bytes] of list.entries()) await sendAll(fx, uploadId, index, bytes, 4);
  assert.deepEqual(received(fx, uploadId), list.map((bytes) => bytes.length));
  assert.equal(fx.core.resources().stagedBytes, 30);

  const commit = await fx.core.commit({ uploadId, ownerId: OWNER });
  assert.equal(commit.ok, true, JSON.stringify(commit));
  const manifest = manifestOf(contents);
  // The client-driven answer carries no host path: staged paths come only from take.
  assert.deepEqual(commit.files, manifest.map((entry, index) => ({ index, ...entry })));
  assert.equal(fx.core.status({ uploadId, ownerId: OWNER }).verified, true);
  refused(await put(fx, uploadId, 0, 0, Buffer.from('xxxx')), 'conflict', 'team_upload_stale');

  const taken = fx.core.take(uploadId, OWNER);
  assert.equal(taken.ok, true);
  assert.deepEqual(taken.files.map(({ stagedPath: _s, ...rest }) => rest), commit.files);
  for (const [index, entry] of taken.files.entries()) {
    assert.deepEqual(fs.readFileSync(entry.stagedPath), list[index]);
    assert.equal(path.dirname(entry.stagedPath), path.join(fx.stagingRoot, uploadId));
    assert.equal(path.basename(entry.stagedPath).includes('.js'), false, 'named by index, never by client path');
  }
  refused(fx.core.take(uploadId, OWNER), 'conflict', 'team_upload_stale');
  refused(fx.core.take(uploadId, OTHER), 'forbidden', 'team_not_found');

  assert.equal((await fx.core.discard({ uploadId, ownerId: OWNER })).ok, true);
  assert.deepEqual(fx.stagingEntries(), []);
  assert.deepEqual(fx.core.resources(), { uploads: 0, stagedBytes: 0, reservedBytes: 0, openHandles: 0 });
});

test('a client resumes from status after losing its place', async (t) => {
  const fx = await opened(t, { limits: { maxPartBytes: 3 } });
  const bytes = Buffer.from('abcdefghij');
  const uploadId = await begun(fx, { 'f.bin': bytes });
  await put(fx, uploadId, 0, 0, bytes.subarray(0, 3));
  await put(fx, uploadId, 0, 3, bytes.subarray(3, 6));
  // The client forgot how far it got and asks.
  const [offset] = received(fx, uploadId);
  assert.equal(offset, 6);
  refused(await put(fx, uploadId, 0, 3, bytes.subarray(3, 6)), 'conflict', 'team_upload_stale');
  for (let at = offset; at < bytes.length; at += 3) {
    const part = bytes.subarray(at, at + 3);
    assert.equal((await put(fx, uploadId, 0, at, part)).ok, true);
  }
  assert.deepEqual(received(fx, uploadId), [10]);
  assert.equal((await fx.core.commit({ uploadId, ownerId: OWNER })).ok, true);
  assert.deepEqual(fs.readFileSync(fx.core.take(uploadId, OWNER).files[0].stagedPath), bytes);
});

test('parts sent concurrently are serialized per upload', async (t) => {
  const fx = await opened(t, { limits: { maxPartBytes: 4 } });
  const bytes = Buffer.from('0123456789ab');
  const uploadId = await begun(fx, { 'f.bin': bytes });
  const results = await Promise.all([0, 4, 8].map((offset) => fx.core.writePart({
    uploadId, ownerId: OWNER, index: 0, offset, bytes: bytes.subarray(offset, offset + 4),
  })));
  assert.deepEqual(results.map((item) => item.ok), [true, true, true]);
  const racing = await Promise.all([1, 2].map(() => fx.core.commit({ uploadId, ownerId: OWNER })));
  assert.deepEqual(racing.map((item) => item.ok).sort(), [false, true]);
  refused(racing.find((item) => !item.ok), 'conflict', 'team_upload_stale');
});

test('two parts at the same offset: one lands, the other is stale', async (t) => {
  const fx = await opened(t, { limits: { maxPartBytes: 4 } });
  const bytes = Buffer.from('abcdefgh');
  const uploadId = await begun(fx, { 'f.bin': bytes });
  const results = await Promise.all([1, 2].map(() => fx.core.writePart({
    uploadId, ownerId: OWNER, index: 0, offset: 0, bytes: bytes.subarray(0, 4),
  })));
  assert.deepEqual(results.map((item) => item.ok), [true, false]);
  refused(results[1], 'conflict', 'team_upload_stale');
  assert.deepEqual(received(fx, uploadId), [4]);
});

// ------------------------------------------------------------------ refusals that write nothing

test('another owner, an unknown id and a malformed id answer exactly alike and write nothing', async (t) => {
  const fx = await opened(t);
  const uploadId = await begun(fx, { 'a.txt': Buffer.from('hello') });
  const part = { index: 0, offset: 0, bytes: Buffer.from('hello') };
  const forged = await fx.core.writePart({ uploadId, ownerId: OTHER, ...part });
  const unknown = await fx.core.writePart({ uploadId: 'upload_AAAAAAAAAAAAAAAAAAAAAA', ownerId: OWNER, ...part });
  const malformed = await fx.core.writePart({ uploadId: '../escape', ownerId: OWNER, ...part });
  refused(forged, 'forbidden', 'team_not_found');
  assert.deepEqual(unknown, forged);
  assert.deepEqual(malformed, forged);
  assert.deepEqual(fx.core.status({ uploadId, ownerId: OTHER }), forged);
  assert.deepEqual(await fx.core.commit({ uploadId, ownerId: OTHER }), forged);
  assert.deepEqual(await fx.core.discard({ uploadId, ownerId: OTHER }), forged);
  assert.deepEqual(fx.core.take(uploadId, OTHER), forged);
  assert.deepEqual(fx.uploadEntries(uploadId), []);
  assert.deepEqual(received(fx, uploadId), [0]);
  assert.deepEqual(fx.stagingEntries(), [uploadId]);
});

test('a file index outside the manifest is refused and writes nothing', async (t) => {
  const fx = await opened(t);
  const uploadId = await begun(fx, { 'a.txt': Buffer.from('a'), 'b.txt': Buffer.from('b') });
  for (const index of [2, 99, -1, 1.5, '0', null]) {
    refused(await fx.core.writePart({ uploadId, ownerId: OWNER, index, offset: 0, bytes: Buffer.from('a') }),
      'forbidden', 'team_not_found');
  }
  assert.deepEqual(fx.uploadEntries(uploadId), []);
  assert.deepEqual(received(fx, uploadId), [0, 0]);
});

test('an out-of-order part is stale and writes nothing', async (t) => {
  const fx = await opened(t, { limits: { maxPartBytes: 4 } });
  const bytes = Buffer.from('abcdefgh');
  const uploadId = await begun(fx, { 'f.bin': bytes });
  refused(await put(fx, uploadId, 0, 4, bytes.subarray(4)), 'conflict', 'team_upload_stale');
  assert.deepEqual(fx.uploadEntries(uploadId), []);
  await sendAll(fx, uploadId, 0, bytes.subarray(0, 4), 4);
  refused(await put(fx, uploadId, 0, 0, bytes.subarray(0, 4)), 'conflict', 'team_upload_stale');
  assert.equal(fs.readFileSync(path.join(fx.stagingRoot, uploadId, fx.uploadEntries(uploadId)[0])).length, 4);
  assert.deepEqual(received(fx, uploadId), [4]);
});

test('an oversize part is refused and writes nothing', async (t) => {
  const fx = await opened(t, { limits: { maxPartBytes: 4 } });
  const uploadId = await begun(fx, { 'f.bin': Buffer.from('abcdefgh') });
  refused(await put(fx, uploadId, 0, 0, Buffer.from('abcde')), 'limit', 'team_upload_size_limit');
  refused(await put(fx, uploadId, 0, 0, Buffer.alloc(0)), 'invalid', 'team_upload_manifest_invalid');
  refused(await put(fx, uploadId, 0, 0, 'abcd'), 'invalid', 'team_upload_manifest_invalid');
  assert.deepEqual(fx.uploadEntries(uploadId), []);
  assert.deepEqual(received(fx, uploadId), [0]);
});

test('bytes past the declared size are refused and write nothing', async (t) => {
  const fx = await opened(t, { limits: { maxPartBytes: 4 } });
  const uploadId = await begun(fx, { 'f.bin': Buffer.from('abcdef') });
  const short = await begun(fx, { 'g.bin': Buffer.from('ab') });
  refused(await put(fx, short, 0, 0, Buffer.from('abc')), 'limit', 'team_upload_size_limit');
  assert.deepEqual(fx.uploadEntries(short), []);
  assert.equal((await put(fx, uploadId, 0, 0, Buffer.from('abcd'))).ok,
    true);
  assert.deepEqual(received(fx, uploadId), [4]);
  refused(await put(fx, uploadId, 0, 4, Buffer.from('efgh')), 'limit', 'team_upload_size_limit');
  assert.deepEqual(received(fx, uploadId), [4]);
  const [name] = fx.uploadEntries(uploadId);
  assert.equal(fs.readFileSync(path.join(fx.stagingRoot, uploadId, name)).toString(), 'abcd');
});

test('a part that does not end its file must be exactly partSize', async (t) => {
  const fx = await opened(t, { limits: { maxPartBytes: 4 } });
  const uploadId = await begun(fx, { 'f.bin': Buffer.from('abcdefghij') });
  for (const bytes of [Buffer.from('a'), Buffer.from('abc')]) {
    refused(await fx.core.writePart({ uploadId, ownerId: OWNER, index: 0, offset: 0, bytes }),
      'invalid', 'team_upload_manifest_invalid');
  }
  assert.deepEqual(fx.uploadEntries(uploadId), []);
  await sendAll(fx, uploadId, 0, Buffer.from('abcdefghij'), 4);
  assert.deepEqual(received(fx, uploadId), [10], 'the last part may be shorter');
});

test('at most four parts wait per upload; one more is refused before it is copied', async (t) => {
  const fx = await opened(t, { limits: { maxPartBytes: 4 } });
  const bytes = Buffer.from('0123456789abcdefghij');
  const uploadId = await begun(fx, { 'f.bin': bytes });
  const parts = [0, 4, 8, 12, 16].map((offset) => fx.core.writePart({
    uploadId, ownerId: OWNER, index: 0, offset, bytes: bytes.subarray(offset, offset + 4),
  }));
  const results = await Promise.all(parts);
  assert.deepEqual(results.slice(0, 4).map((item) => item.ok), [true, true, true, true]);
  refused(results[4], 'limit', 'team_upload_limit');
  assert.equal(results[4].error.retryable, true);
  assert.deepEqual(received(fx, uploadId), [16]);
  assert.equal((await put(fx, uploadId, 0, 16, bytes.subarray(16))).ok,
    true, 'the slot is free again once the queue drains');
});

test('commit before every file is complete is stale and keeps the upload', async (t) => {
  const fx = await opened(t);
  const uploadId = await begun(fx, { 'a.txt': Buffer.from('abc'), 'b.txt': Buffer.from('d') });
  await sendAll(fx, uploadId, 0, Buffer.from('abc'), 4);
  refused(await fx.core.commit({ uploadId, ownerId: OWNER }), 'conflict', 'team_upload_stale');
  await sendAll(fx, uploadId, 1, Buffer.from('d'), 4);
  assert.equal((await fx.core.commit({ uploadId, ownerId: OWNER })).ok, true);
});

test('a hash mismatch removes the staging directory', async (t) => {
  const fx = await opened(t, { limits: { maxPartBytes: 4 } });
  const files = manifestOf({ 'a.txt': Buffer.from('right'), 'b.txt': Buffer.from('also') });
  const begin = await fx.core.begin({ ownerId: OWNER, files });
  const { uploadId } = begin;
  await sendAll(fx, uploadId, 0, Buffer.from('wrong'), 4);
  await sendAll(fx, uploadId, 1, Buffer.from('also'), 4);
  refused(await fx.core.commit({ uploadId, ownerId: OWNER }), 'invalid', 'team_upload_hash_mismatch');
  assert.deepEqual(fx.stagingEntries(), []);
  assert.deepEqual(fx.core.resources(), { uploads: 0, stagedBytes: 0, reservedBytes: 0, openHandles: 0 });
  refused(fx.core.status({ uploadId, ownerId: OWNER }), 'forbidden', 'team_not_found');
});

test('a staging file changed behind the core fails the commit and removes the upload', async (t) => {
  const fx = await opened(t);
  const bytes = Buffer.from('abcd');
  const uploadId = await begun(fx, { 'a.txt': bytes });
  await sendAll(fx, uploadId, 0, bytes, 4);
  const [name] = fx.uploadEntries(uploadId);
  fs.appendFileSync(path.join(fx.stagingRoot, uploadId, name), 'x');
  const result = await fx.core.commit({ uploadId, ownerId: OWNER });
  assert.equal(result.ok, false);
  assert.deepEqual(fx.stagingEntries(), []);
});

// ------------------------------------------------------------------ expiry and caps

test('an upload idle for the expiry answers like an unknown id and is swept by the clock', async (t) => {
  const fx = await opened(t, { limits: { idleMs: 1000, maxPartBytes: 1 } });
  const keep = await begun(fx, { 'a.txt': Buffer.from('ab') });
  const lapse = await begun(fx, { 'b.txt': Buffer.from('cd') }, OTHER);
  fx.clock.advance(500);
  // Polling and refused parts do not refresh the idle time.
  assert.equal(fx.core.status({ uploadId: lapse, ownerId: OTHER }).ok, true);
  refused(await fx.core.writePart({ uploadId: lapse, ownerId: OTHER, index: 0, offset: 1, bytes: Buffer.from('d') }),
    'conflict', 'team_upload_stale');
  fx.clock.advance(499);
  assert.equal((await put(fx, keep, 0, 0, Buffer.from('a'))).ok,
    true, 'a successful part refreshes the idle time');
  fx.clock.advance(1);
  const unknown = fx.core.status({ uploadId: 'upload_AAAAAAAAAAAAAAAAAAAAAA', ownerId: OTHER });
  assert.deepEqual(fx.core.status({ uploadId: lapse, ownerId: OTHER }), unknown);
  const swept = await fx.core.sweep(fx.clock());
  assert.deepEqual(swept, { ok: true, expired: 1 });
  assert.deepEqual(fx.stagingEntries(), [keep]);
  fx.clock.advance(1000);
  assert.deepEqual(await fx.core.sweep(fx.clock()), { ok: true, expired: 1 });
  assert.deepEqual(fx.stagingEntries(), []);
  assert.deepEqual(fx.core.resources(), { uploads: 0, stagedBytes: 0, reservedBytes: 0, openHandles: 0 });
});

test('two uploads in flight per owner, and a bound on uploads overall', async (t) => {
  const fx = await opened(t, { limits: { maxUploads: 3 } });
  const one = { 'a.txt': Buffer.from('a') };
  const first = await begun(fx, one);
  await begun(fx, one);
  refused(await fx.core.begin({ ownerId: OWNER, files: manifestOf(one) }), 'limit', 'team_upload_limit');
  await begun(fx, one, OTHER);
  refused(await fx.core.begin({ ownerId: 'member_carol', files: manifestOf(one) }), 'limit', 'team_upload_limit');
  // Both slot checks run before the manifest pass: validation first would answer the path refusal.
  const traversal = [{ path: '../x', size: 1, sha256: 'a'.repeat(64) }];
  refused(await fx.core.begin({ ownerId: OWNER, files: traversal }), 'limit', 'team_upload_limit');
  refused(await fx.core.begin({ ownerId: 'member_carol', files: traversal }), 'limit', 'team_upload_limit');
  assert.equal(fx.stagingEntries().length, 3);
  await fx.core.discard({ uploadId: first, ownerId: OWNER });
  await begun(fx, one);
  assert.equal(fx.core.resources().uploads, 3);
});

test('the caps hold against concurrent begins', async (t) => {
  const fx = await opened(t, { limits: { maxUploads: 3 } });
  const files = manifestOf({ 'a.txt': Buffer.from('a') });
  const sameOwner = await Promise.all([1, 2, 3].map(() => fx.core.begin({ ownerId: OWNER, files })));
  assert.equal(sameOwner.filter((item) => item.ok).length, 2);
  assert.equal(sameOwner.filter((item) => item.error?.reason === 'team_upload_limit').length, 1);
  await fx.core.close();

  const other = await opened(t, { limits: { maxUploads: 3 } });
  const owners = ['member_a', 'member_b', 'member_c', 'member_d'];
  const overall = await Promise.all(owners.map((ownerId) => other.core.begin({ ownerId, files })));
  assert.equal(overall.filter((item) => item.ok).length, 3);
  assert.equal(overall.filter((item) => item.error?.reason === 'team_upload_limit').length, 1);
  assert.equal(other.stagingEntries().length, 3);
});

test('declared bytes are reserved across uploads and given back on removal', async (t) => {
  const fx = await opened(t, { limits: { maxReservedBytes: 10 } });
  const first = await begun(fx, { 'a.txt': Buffer.alloc(6) });
  assert.equal(fx.core.resources().reservedBytes, 6);
  const over = await fx.core.begin({ ownerId: OTHER, files: manifestOf({ 'b.txt': Buffer.alloc(5) }) });
  refused(over, 'limit', 'team_upload_limit');
  assert.equal(over.error.retryable, true);
  assert.deepEqual(fx.stagingEntries(), [first]);
  await begun(fx, { 'c.txt': Buffer.alloc(4) }, OTHER);
  assert.equal(fx.core.resources().reservedBytes, 10);
  await fx.core.discard({ uploadId: first, ownerId: OWNER });
  assert.equal(fx.core.resources().reservedBytes, 4);
  await begun(fx, { 'b.txt': Buffer.alloc(5) });
  assert.equal(fx.core.resources().reservedBytes, 9);
});

test('begin does not wait for a lapsed upload to finish being removed', async (t) => {
  const fx = await opened(t, { limits: { idleMs: 1000 } });
  await begun(fx, { 'a.txt': Buffer.from('a') }, OTHER);
  fx.clock.advance(1000);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const originalRm = fs.promises.rm;
  t.mock.method(fs.promises, 'rm', async (...args) => {
    await gate;
    return originalRm.apply(fs.promises, args);
  });
  let timer;
  const blocked = new Promise((resolve) => { timer = setTimeout(() => resolve('blocked'), 5000); });
  const result = await Promise.race([
    fx.core.begin({ ownerId: OTHER, files: manifestOf({ 'b.txt': Buffer.from('b') }) }), blocked,
  ]);
  clearTimeout(timer);
  release();
  assert.notEqual(result, 'blocked', 'begin waited behind the removal');
  assert.equal(result.ok, true);
  assert.equal(fx.core.resources().uploads, 1);
  await fx.core.close();
  t.mock.restoreAll();
  assert.deepEqual(fx.stagingEntries(), []);
});

test('a staged file with a second hard link fails the commit and removes the upload', async (t) => {
  const fx = await opened(t);
  const bytes = Buffer.from('abcd');
  const uploadId = await begun(fx, { 'a.txt': bytes });
  await sendAll(fx, uploadId, 0, bytes, 4);
  const [name] = fx.uploadEntries(uploadId);
  try {
    fs.linkSync(path.join(fx.stagingRoot, uploadId, name), path.join(fx.base, 'alias'));
  } catch (error) {
    if (['EPERM', 'ENOTSUP', 'EXDEV'].includes(error.code)) { t.skip(`hard links unavailable: ${error.code}`); return; }
    throw error;
  }
  refused(await fx.core.commit({ uploadId, ownerId: OWNER }), 'persistence', 'team_upload_staging_failed');
  assert.deepEqual(fx.stagingEntries(), []);
});

test('the caller may lower the total for a quota, never raise it', async (t) => {
  const fx = await opened(t, { limits: { maxUploadBytes: 10 } });
  const files = manifestOf({ 'a.txt': Buffer.alloc(8) });
  refused(await fx.core.begin({ ownerId: OWNER, files, maxTotalBytes: 7 }), 'limit', 'team_upload_size_limit');
  assert.equal((await fx.core.begin({ ownerId: OWNER, files, maxTotalBytes: 8 })).ok, true);
  const bigger = manifestOf({ 'b.txt': Buffer.alloc(11) });
  refused(await fx.core.begin({ ownerId: OWNER, files: bigger, maxTotalBytes: 1_000_000 }), 'limit',
    'team_upload_size_limit');
  refused(await fx.core.begin({ ownerId: OWNER, files, maxTotalBytes: -1 }), 'invalid', 'team_upload_manifest_invalid');
});

test('limits above the E26 defaults are refused at construction', (t) => {
  const fx = createTransferFixture(t);
  for (const key of Object.keys(TRANSFER_LIMITS)) {
    assert.throws(() => fx.make({ limits: { [key]: TRANSFER_LIMITS[key] + 1 } }), RangeError, key);
    assert.throws(() => fx.make({ limits: { [key]: 0 } }), RangeError, key);
  }
  assert.throws(() => fx.make({ limits: { unknown: 1 } }), RangeError);
});

test('a manifest refused by validation creates no staging directory', async (t) => {
  const fx = await opened(t);
  for (const bad of ['../x', `src/${'字'.repeat(86)}`]) {
    refused(await fx.core.begin({ ownerId: OWNER, files: [{ path: bad, size: 1, sha256: 'a'.repeat(64) }] }),
      'invalid', 'team_project_path_invalid');
  }
  assert.deepEqual(fx.stagingEntries(), []);
});

test('an upload id that is not the core own pattern never reaches a path join', async (t) => {
  const fx = await opened(t, { randomBytes: () => Buffer.alloc(15) });
  refused(await fx.core.begin({ ownerId: OWNER, files: manifestOf({ 'a.txt': Buffer.from('a') }) }),
    'unavailable', 'host_unavailable');
  assert.deepEqual(fx.stagingEntries(), []);
});

test('an id collision never reuses an existing directory', async (t) => {
  const fx = await opened(t, { randomBytes: () => Buffer.alloc(16, 7) });
  const files = manifestOf({ 'a.txt': Buffer.from('a') });
  const first = await fx.core.begin({ ownerId: OWNER, files });
  assert.equal(first.ok, true);
  refused(await fx.core.begin({ ownerId: OTHER, files }), 'persistence', 'team_upload_staging_failed');
  assert.deepEqual(fx.stagingEntries(), [first.uploadId]);
  assert.equal(fx.core.status({ uploadId: first.uploadId, ownerId: OWNER }).ok, true);
});

// ------------------------------------------------------------------ open and close

test('open() removes leftover staging directories and leaves anything unexpected', async (t) => {
  const fx = createTransferFixture(t);
  const leftover = path.join(fx.stagingRoot, 'upload_BBBBBBBBBBBBBBBBBBBBBB');
  fs.mkdirSync(path.join(leftover, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(leftover, '0.part'), 'stale');
  fs.writeFileSync(path.join(fx.stagingRoot, 'notes.txt'), 'keep');
  fs.mkdirSync(path.join(fx.stagingRoot, 'other'));
  fs.writeFileSync(path.join(fx.stagingRoot, 'upload_CCCCCCCCCCCCCCCCCCCCCC'), 'a file, not a directory');
  const result = await fx.core.open();
  assert.deepEqual(result, { ok: true, removed: 1, unexpected: 3 });
  assert.deepEqual(fx.stagingEntries().sort(), ['notes.txt', 'other', 'upload_CCCCCCCCCCCCCCCCCCCCCC']);
});

test('operations before open() answer unavailable', async (t) => {
  const fx = createTransferFixture(t);
  refused(await fx.core.begin({ ownerId: OWNER, files: manifestOf({ 'a.txt': Buffer.from('a') }) }),
    'unavailable', 'host_unavailable');
  assert.deepEqual(fx.stagingEntries(), []);
});

test('a staging root that is missing, a file, or below a moved parent is refused', async (t) => {
  const missing = createTransferFixture(t, { makeRoot: false });
  refused(await missing.core.open(), 'unavailable', 'host_unavailable');
  const asFile = createTransferFixture(t, { makeRoot: false });
  fs.writeFileSync(asFile.stagingRoot, 'x');
  refused(await asFile.core.open(), 'unavailable', 'host_unavailable');
  const relative = createTransferFixture(t);
  refused(await relative.make({ stagingRoot: 'team-uploads' }).open(), 'unavailable', 'host_unavailable');
});

test('a staging root that is a symbolic link is refused', async (t) => {
  const fx = createTransferFixture(t, { makeRoot: false });
  const target = path.join(fx.base, 'elsewhere');
  fs.mkdirSync(target);
  try {
    fs.symlinkSync(target, fx.stagingRoot, 'dir');
  } catch (error) {
    if (error.code === 'EPERM') { t.skip('symbolic links need privilege on this host'); return; }
    throw error;
  }
  refused(await fx.core.open(), 'unavailable', 'host_unavailable');
});

test('a staging root that is a junction, or sits below one, is refused (Windows)', { skip: process.platform !== 'win32' },
  async (t) => {
    const fx = createTransferFixture(t, { makeRoot: false });
    const target = path.join(fx.base, 'elsewhere');
    fs.mkdirSync(target);
    fs.symlinkSync(target, fx.stagingRoot, 'junction');
    refused(await fx.core.open(), 'unavailable', 'host_unavailable');

    const parentTarget = path.join(fx.base, 'real-parent');
    fs.mkdirSync(path.join(parentTarget, 'team-uploads'), { recursive: true });
    const linkedParent = path.join(fx.base, 'linked-parent');
    fs.symlinkSync(parentTarget, linkedParent, 'junction');
    refused(await fx.make({ stagingRoot: path.join(linkedParent, 'team-uploads') }).open(), 'unavailable',
      'host_unavailable');
  });

test('a staging root replaced after open() stops new uploads', async (t) => {
  const fx = await opened(t);
  fs.rmSync(fx.stagingRoot, { recursive: true });
  fs.mkdirSync(fx.stagingRoot);
  refused(await fx.core.begin({ ownerId: OWNER, files: manifestOf({ 'a.txt': Buffer.from('a') }) }),
    'unavailable', 'host_unavailable');
  assert.deepEqual(fx.stagingEntries(), []);
});

test('close() removes everything, leaves resources() empty and refuses later calls', async (t) => {
  const fx = await opened(t, { limits: { maxPartBytes: 4 } });
  const first = await begun(fx, { 'a.txt': Buffer.from('abcdef') });
  await put(fx, first, 0, 0, Buffer.from('abcd'));
  const second = await begun(fx, { 'b.txt': Buffer.from('xy') }, OTHER);
  await sendAll(fx, second, 0, Buffer.from('xy'), 4, OTHER);
  assert.equal((await fx.core.commit({ uploadId: second, ownerId: OTHER })).ok, true);
  assert.deepEqual(fx.core.resources(), { uploads: 2, stagedBytes: 6, reservedBytes: 8, openHandles: 0 });
  assert.deepEqual(await fx.core.close(), { ok: true });
  assert.deepEqual(fx.core.resources(), { uploads: 0, stagedBytes: 0, reservedBytes: 0, openHandles: 0 });
  assert.deepEqual(fx.stagingEntries(), []);
  refused(fx.core.status({ uploadId: first, ownerId: OWNER }), 'unavailable', 'host_unavailable');
  refused(await fx.core.begin({ ownerId: OWNER, files: manifestOf({ 'c.txt': Buffer.from('c') }) }),
    'unavailable', 'host_unavailable');
});

test('a close() landing during the root check of begin registers nothing and logs no root change', async (t) => {
  const fx = await opened(t);
  const original = fs.promises.lstat;
  let closing = null;
  // Hold begin inside its root lstat and close the core in that window.
  t.mock.method(fs.promises, 'lstat', async (...args) => {
    const result = await original.apply(fs.promises, args);
    if (!closing) closing = fx.core.close();
    return result;
  });
  const result = await fx.core.begin({ ownerId: OWNER, files: manifestOf({ 'a.txt': Buffer.from('a') }) });
  await closing;
  t.mock.restoreAll();
  assert.ok(closing, 'the window was reached');
  refused(result, 'unavailable', 'host_unavailable');
  assert.deepEqual(fx.stagingEntries(), []);
  assert.deepEqual(fx.core.resources().uploads, 0);
  assert.equal(fx.records.some(([, event]) => event === 'team_transfer.root_refused'), false);
});

test('close() during open() leaves the core closed', async (t) => {
  const fx = createTransferFixture(t);
  const pending = fx.core.open();
  assert.deepEqual(await fx.core.close(), { ok: true });
  refused(await pending, 'unavailable', 'host_unavailable');
  refused(await fx.core.begin({ ownerId: OWNER, files: manifestOf({ 'a.txt': Buffer.from('a') }) }),
    'unavailable', 'host_unavailable');
  assert.deepEqual(fx.stagingEntries(), []);
});

test('a second open() while the first runs is refused and the leftovers are swept once', async (t) => {
  const fx = createTransferFixture(t);
  fs.mkdirSync(path.join(fx.stagingRoot, 'upload_BBBBBBBBBBBBBBBBBBBBBB'));
  const first = fx.core.open();
  const second = fx.core.open();
  refused(await second, 'unavailable', 'host_unavailable');
  assert.deepEqual(await first, { ok: true, removed: 1, unexpected: 0 });
  assert.equal(fx.records.filter(([, event]) => event === 'team_transfer.opened').length, 1);
});

test('a refused open() can be retried once the root exists', async (t) => {
  const fx = createTransferFixture(t, { makeRoot: false });
  refused(await fx.core.open(), 'unavailable', 'host_unavailable');
  fs.mkdirSync(fx.stagingRoot);
  assert.equal((await fx.core.open()).ok, true);
});

test('a second close() answers only once every directory is gone', async (t) => {
  const fx = await opened(t);
  await begun(fx, { 'a.txt': Buffer.from('a') });
  await begun(fx, { 'b.txt': Buffer.from('b') }, OTHER);
  const first = fx.core.close();
  const second = fx.core.close();
  assert.deepEqual(await second, { ok: true });
  assert.deepEqual(fx.stagingEntries(), []);
  assert.deepEqual(await first, { ok: true });
});

test('a begin racing close() answers unavailable and leaves no directory', async (t) => {
  const fx = await opened(t);
  const pending = fx.core.begin({ ownerId: OWNER, files: manifestOf({ 'a.txt': Buffer.from('a') }) });
  await fx.core.close();
  refused(await pending, 'unavailable', 'host_unavailable');
  assert.deepEqual(fx.stagingEntries(), []);
  assert.deepEqual(fx.core.resources(), { uploads: 0, stagedBytes: 0, reservedBytes: 0, openHandles: 0 });
});

// ------------------------------------------------------------------ redaction

test('no path, file name, hash or staging root appears in a log record or a failure payload', async (t) => {
  const fx = await opened(t, { limits: { maxPartBytes: 4, idleMs: 1000 } });
  const contents = {
    'zebra-secret/quokka.txt': Buffer.from('hello'),
    'platypus-name.md': Buffer.from('world'),
  };
  const files = manifestOf(contents);
  const { track, core } = fx;
  const uploadId = (await core.begin({ ownerId: OWNER, files })).uploadId;
  track(await core.writePart({ uploadId, ownerId: OTHER, index: 0, offset: 0, bytes: Buffer.from('hell') }));
  track(await core.writePart({ uploadId, ownerId: OWNER, index: 5, offset: 0, bytes: Buffer.from('hell') }));
  track(await core.writePart({ uploadId, ownerId: OWNER, index: 0, offset: 2, bytes: Buffer.from('hell') }));
  track(await core.writePart({ uploadId, ownerId: OWNER, index: 0, offset: 0, bytes: Buffer.from('hello') }));
  await sendAll(fx, uploadId, 0, Buffer.from('hellx'), 4);
  await sendAll(fx, uploadId, 1, contents['platypus-name.md'], 4);
  track(await core.commit({ uploadId, ownerId: OWNER }));
  track(await core.begin({ ownerId: OWNER, files: [{ ...files[0], path: 'zebra-secret/CON' }] }));
  track(await core.begin({ ownerId: OWNER, files: [files[0], { ...files[0], path: 'Zebra-Secret/Quokka.txt' }] }));
  const lapsed = (await core.begin({ ownerId: OWNER, files })).uploadId;
  fx.clock.advance(1000);
  track(core.status({ uploadId: lapsed, ownerId: OWNER }));
  await core.sweep(fx.clock());
  await core.close();
  track(await core.begin({ ownerId: OWNER, files }));
  assert.ok(fx.failures.length >= 8);
  assert.ok(fx.records.length >= 4, 'the core logs its lifecycle');
  const text = JSON.stringify([fx.records, fx.failures]);
  const forbidden = [
    'zebra', 'quokka', 'platypus', 'CON', fx.stagingRoot, fx.stagingRoot.replaceAll('\\', '\\\\'), fx.base,
    ...files.map((entry) => entry.sha256),
  ];
  for (const needle of forbidden) assert.equal(text.includes(needle), false, `leaked: ${needle.slice(0, 12)}`);
  for (const failure of fx.failures) assert.deepEqual(Object.keys(failure.error).sort(), ['code', 'reason', 'retryable']);
});

test('createTransferCore refuses a missing clock, random source or staging root', () => {
  assert.throws(() => createTransferCore({ stagingRoot: 'x', clock: null, randomBytes: sequenceRandom() }), TypeError);
  assert.throws(() => createTransferCore({ stagingRoot: 'x', clock: () => 1, randomBytes: null }), TypeError);
  assert.throws(() => createTransferCore({ clock: () => 1, randomBytes: sequenceRandom() }), TypeError);
});
