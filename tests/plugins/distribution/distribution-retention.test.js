'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { MemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { writeGeneration, readGeneration } = require('../../../services/plugins/store/generation-store');
const { enforceGenerationRetention } = require('../../../services/plugins/distribution/distribution-retention');
const { buildPointer, commitActivePointer } = require('../../../services/plugins/store/active-pointer');
const { mintNextEpoch } = require('../../../services/plugins/store/commit-epoch');
const d = (v) => v.repeat(64);
test('retention keeps the active-sized window and removes oldest unprotected generations', async () => {
  const fs = new MemoryFsFacade();
  for (let index = 1; index <= 4; index += 1) await writeGeneration(fs, 's', { generationId: `g${index}`, createdAt: `2026-08-0${index}T00:00:00Z`, plugins: [],
    policyGrantRef: { policy_snapshot_digest: d('a'), policy_revision: 1, grant_set_digest: d('b') }, dataSchemaRefs: [] });
  const result = await enforceGenerationRetention(fs, 's'); assert.deepEqual(result.removed, ['g1']);
  assert.equal((await readGeneration(fs, 's', 'g1')).reason, 'generation_not_found');
});

async function seedGenerations(fs, count) {
  for (let index = 1; index <= count; index += 1) {
    await writeGeneration(fs, 's', { generationId: `g${index}`, createdAt: `2026-08-0${index}T00:00:00Z`, plugins: [],
      policyGrantRef: { policy_snapshot_digest: d('a'), policy_revision: 1, grant_set_digest: d('b') }, dataSchemaRefs: [] });
  }
}

// The single retention test above runs with NO active pointer and NO protected
// ids, so `keep - (activeId ? 1 : 0)` and the `protectedIds` loop -- the two
// things standing between an in-use generation and removeTree -- never execute.
test('retention reserves a window slot for the ACTIVE generation even when it is oldest', async () => {
  const fs = new MemoryFsFacade();
  await seedGenerations(fs, 4);
  const pointer = buildPointer({ revision: 1, commitEpoch: mintNextEpoch(null), generationId: 'g1',
    generationDigest: d('c'), committedAt: '2026-08-01T00:00:00Z' });
  assert.equal((await commitActivePointer(fs, 's', { expectedCurrent: null, nextPointer: pointer })).ok, true);

  const result = await enforceGenerationRetention(fs, 's');
  // keep=3 with g1 active leaves 2 slots for the newest non-active generations
  // (g4, g3), so g2 is the eviction and the ACTIVE oldest generation survives.
  assert.deepEqual(result.removed, ['g2']);
  assert.deepEqual(result.retained, ['g1', 'g3', 'g4']);
  assert.equal((await readGeneration(fs, 's', 'g1')).ok, true, 'the active generation must never be removed');
});

test('retention preserves an explicitly protected generation past the window', async () => {
  const fs = new MemoryFsFacade();
  await seedGenerations(fs, 4);
  const result = await enforceGenerationRetention(fs, 's', { protectedGenerationIds: new Set(['g1']) });
  assert.deepEqual(result.removed, [], 'a protected generation must survive even as the oldest');
  assert.deepEqual(result.retained, ['g1', 'g2', 'g3', 'g4']);
  assert.equal((await readGeneration(fs, 's', 'g1')).ok, true);
});
