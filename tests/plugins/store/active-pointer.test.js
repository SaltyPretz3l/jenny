'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  POINTER_FILE,
  buildPointer,
  readActivePointer,
  readPriorPointer,
  commitActivePointer,
} = require('../../../services/plugins/store/active-pointer');
const { mintNextEpoch } = require('../../../services/plugins/store/commit-epoch');

const NOW = '2026-07-31T00:00:00Z';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

test('buildPointer produces a schema-valid pointer and throws on a malformed one', () => {
  const pointer = buildPointer({ revision: 1, commitEpoch: 0, generationId: 'gen-1', generationDigest: DIGEST_A, committedAt: NOW });
  assert.equal(pointer.registry_schema_version, 1);
  assert.equal(pointer.revision, 1);
  assert.throws(() => buildPointer({ revision: 1, commitEpoch: 0, generationId: 'gen 1', generationDigest: DIGEST_A, committedAt: NOW }));
});

test('readActivePointer reports missing when nothing has ever been committed', async () => {
  const facade = createMemoryFsFacade();
  assert.deepEqual(await readActivePointer(facade, 'plugins'), { status: 'missing' });
});

test('readActivePointer reports corrupted for malformed JSON without throwing', async () => {
  const facade = createMemoryFsFacade();
  await facade.mkdir('plugins');
  await facade.writeFile(`plugins/${POINTER_FILE}`, '{not json');
  const read = await readActivePointer(facade, 'plugins');
  assert.equal(read.status, 'corrupted');
});

test('the first commit succeeds with expectedCurrent=null and mints epoch 0', async () => {
  const facade = createMemoryFsFacade();
  const pointer = buildPointer({ revision: 1, commitEpoch: mintNextEpoch(null), generationId: 'gen-1', generationDigest: DIGEST_A, committedAt: NOW });
  const result = await commitActivePointer(facade, 'plugins', { expectedCurrent: null, nextPointer: pointer });
  assert.equal(result.ok, true);
  assert.equal(result.pointer.commit_epoch, 0);
  assert.equal(result.pointer.revision, 1);
});

test('a second commit against the correct expectedCurrent succeeds and retains the prior pointer', async () => {
  const facade = createMemoryFsFacade();
  const p1 = buildPointer({ revision: 1, commitEpoch: 0, generationId: 'gen-1', generationDigest: DIGEST_A, committedAt: NOW });
  const c1 = await commitActivePointer(facade, 'plugins', { expectedCurrent: null, nextPointer: p1 });

  const p2 = buildPointer({ revision: 2, commitEpoch: mintNextEpoch(c1.pointer.commit_epoch), generationId: 'gen-2', generationDigest: DIGEST_B, committedAt: NOW });
  const c2 = await commitActivePointer(facade, 'plugins', { expectedCurrent: c1.pointer, nextPointer: p2 });
  assert.equal(c2.ok, true);
  assert.equal(c2.pointer.commit_epoch, 1);

  const prior = await readPriorPointer(facade, 'plugins');
  assert.equal(prior.status, 'ok');
  assert.deepEqual(prior.pointer, c1.pointer);

  const current = await readActivePointer(facade, 'plugins');
  assert.deepEqual(current.pointer, c2.pointer);
});

test('a stale expectedCurrent is rejected and never touches the real pointer file', async () => {
  const facade = createMemoryFsFacade();
  const p1 = buildPointer({ revision: 1, commitEpoch: 0, generationId: 'gen-1', generationDigest: DIGEST_A, committedAt: NOW });
  const c1 = await commitActivePointer(facade, 'plugins', { expectedCurrent: null, nextPointer: p1 });

  const p2 = buildPointer({ revision: 2, commitEpoch: 1, generationId: 'gen-2', generationDigest: DIGEST_B, committedAt: NOW });
  await commitActivePointer(facade, 'plugins', { expectedCurrent: c1.pointer, nextPointer: p2 });

  // Retry the same stale expectedCurrent a second time -- it must be
  // rejected, and the pointer must still read as p2, not some mix.
  const staleAttempt = await commitActivePointer(facade, 'plugins', { expectedCurrent: c1.pointer, nextPointer: p2 });
  assert.equal(staleAttempt.ok, false);
  assert.equal(staleAttempt.reason, 'stale_active_pointer');
  const current = await readActivePointer(facade, 'plugins');
  assert.equal(current.pointer.revision, 2);
});

test('commit rejects a non-contiguous revision even when the epoch and CAS are otherwise fine', async () => {
  const facade = createMemoryFsFacade();
  const p1 = buildPointer({ revision: 1, commitEpoch: 0, generationId: 'gen-1', generationDigest: DIGEST_A, committedAt: NOW });
  const c1 = await commitActivePointer(facade, 'plugins', { expectedCurrent: null, nextPointer: p1 });

  const badRevision = buildPointer({ revision: 3, commitEpoch: 1, generationId: 'gen-2', generationDigest: DIGEST_B, committedAt: NOW });
  const result = await commitActivePointer(facade, 'plugins', { expectedCurrent: c1.pointer, nextPointer: badRevision });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'revision_not_contiguous');
});

test('commit rejects a candidate epoch that does not strictly increase', async () => {
  const facade = createMemoryFsFacade();
  const p1 = buildPointer({ revision: 1, commitEpoch: 5, generationId: 'gen-1', generationDigest: DIGEST_A, committedAt: NOW });
  const c1 = await commitActivePointer(facade, 'plugins', { expectedCurrent: null, nextPointer: p1 });

  const sameEpoch = buildPointer({ revision: 2, commitEpoch: 5, generationId: 'gen-2', generationDigest: DIGEST_B, committedAt: NOW });
  const result = await commitActivePointer(facade, 'plugins', { expectedCurrent: c1.pointer, nextPointer: sameEpoch });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'epoch_not_strictly_increasing');
});

test('commit refuses to proceed when the current pointer on disk is corrupted, rather than guessing', async () => {
  const facade = createMemoryFsFacade();
  await facade.mkdir('plugins');
  await facade.writeFile(`plugins/${POINTER_FILE}`, '{not json');
  const p1 = buildPointer({ revision: 1, commitEpoch: 0, generationId: 'gen-1', generationDigest: DIGEST_A, committedAt: NOW });
  const result = await commitActivePointer(facade, 'plugins', { expectedCurrent: null, nextPointer: p1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'active_pointer_corrupted');
});

test('a rollback that reuses an old generation id still requires a strictly greater epoch (ABA defense end to end)', async () => {
  const facade = createMemoryFsFacade();
  const genA = buildPointer({ revision: 1, commitEpoch: 0, generationId: 'gen-a', generationDigest: DIGEST_A, committedAt: NOW });
  const c1 = await commitActivePointer(facade, 'plugins', { expectedCurrent: null, nextPointer: genA });

  const genB = buildPointer({ revision: 2, commitEpoch: 1, generationId: 'gen-b', generationDigest: DIGEST_B, committedAt: NOW });
  const c2 = await commitActivePointer(facade, 'plugins', { expectedCurrent: c1.pointer, nextPointer: genB });

  // Roll back to gen-a's bytes: must mint epoch 2, never epoch 0 again.
  const rollbackToA = buildPointer({ revision: 3, commitEpoch: mintNextEpoch(c2.pointer.commit_epoch), generationId: 'gen-a', generationDigest: DIGEST_A, committedAt: NOW });
  const c3 = await commitActivePointer(facade, 'plugins', { expectedCurrent: c2.pointer, nextPointer: rollbackToA });
  assert.equal(c3.ok, true);
  assert.equal(c3.pointer.commit_epoch, 2);
  assert.equal(c3.pointer.generation_id, 'gen-a');
});

test('post-commit reread verification catches a rename that lands corrupted bytes', async () => {
  const facade = createMemoryFsFacade();
  const originalRenameFile = facade.renameFile.bind(facade);
  facade.renameFile = async (oldPath, newPath) => {
    await originalRenameFile(oldPath, newPath);
    if (newPath.endsWith(POINTER_FILE)) {
      // Simulate a torn write landing corrupted bytes at the real path right
      // after the rename that was supposed to make it authoritative.
      await facade.writeFile(newPath, '{"registry_schema_version":1,"revision":999}');
    }
  };
  const p1 = buildPointer({ revision: 1, commitEpoch: 0, generationId: 'gen-1', generationDigest: DIGEST_A, committedAt: NOW });
  const result = await commitActivePointer(facade, 'plugins', { expectedCurrent: null, nextPointer: p1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'post_commit_reread_failed');
});
