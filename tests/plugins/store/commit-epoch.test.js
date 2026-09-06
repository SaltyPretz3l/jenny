'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MIN_EPOCH,
  MAX_EPOCH,
  mintNextEpoch,
  recoverEpoch,
  validateEpochMonotonic,
} = require('../../../services/plugins/store/commit-epoch');

test('mintNextEpoch returns MIN_EPOCH for the very first commit (null/undefined current)', () => {
  assert.equal(mintNextEpoch(null), MIN_EPOCH);
  assert.equal(mintNextEpoch(undefined), MIN_EPOCH);
});

test('mintNextEpoch increments by exactly one from an intact current epoch', () => {
  assert.equal(mintNextEpoch(0), 1);
  assert.equal(mintNextEpoch(41), 42);
});

test('mintNextEpoch rejects a malformed current epoch rather than silently minting 0', () => {
  assert.throws(() => mintNextEpoch(-1), /safe integer/);
  assert.throws(() => mintNextEpoch(1.5), /safe integer/);
  assert.throws(() => mintNextEpoch('3'), /safe integer/);
});

test('mintNextEpoch: rollback to previously used generation bytes still mints a fresh epoch (PLUG-D14 ABA defense)', () => {
  // Epoch 5 is current; rolling back to a generation whose bytes were last
  // active at epoch 2 must NOT reuse epoch 3 (which is already-minted history)
  // -- the base for the next mint is always the CURRENT epoch, never the
  // epoch the target generation happened to carry historically.
  const currentEpoch = 5;
  const next = mintNextEpoch(currentEpoch);
  assert.equal(next, 6);
  assert.notEqual(next, 3);
});

test('recoverEpoch derives the next epoch from the maximum durable evidence plus the safety increment', () => {
  const next = recoverEpoch({ evidenceEpochs: [2, 7, 4], safetyIncrement: 3 });
  assert.equal(next, 7 + 1 + 3);
});

test('recoverEpoch with no evidence at all still starts safely above MIN_EPOCH via the safety increment', () => {
  const next = recoverEpoch({ evidenceEpochs: [], safetyIncrement: 1 });
  assert.equal(next, MIN_EPOCH + 1);
});

test('recoverEpoch ignores malformed evidence entries instead of crashing recovery', () => {
  const next = recoverEpoch({ evidenceEpochs: [3, -1, NaN, 1.5, 'x', null, 9], safetyIncrement: 1 });
  assert.equal(next, 9 + 1 + 1);
});

test('recoverEpoch rejects a non-positive safetyIncrement', () => {
  assert.throws(() => recoverEpoch({ evidenceEpochs: [1], safetyIncrement: 0 }), /safetyIncrement/);
  assert.throws(() => recoverEpoch({ evidenceEpochs: [1], safetyIncrement: -2 }), /safetyIncrement/);
});

test('recoverEpoch never collides with a previously minted epoch even when evidence sources disagree', () => {
  // Receipts saw up to epoch 10, journal only up to 6 (it was pruned/lagging),
  // retained-generation history saw 8. The recovered epoch must exceed ALL of
  // them, not just the largest single source naively assumed complete.
  const receiptsEpochs = [9, 10, 8];
  const journalEpochs = [4, 5, 6];
  const retainedGenerationEpochs = [7, 8];
  const next = recoverEpoch({
    evidenceEpochs: [...receiptsEpochs, ...journalEpochs, ...retainedGenerationEpochs],
    safetyIncrement: 2,
  });
  assert.ok(next > 10);
  assert.equal(next, 10 + 1 + 2);
});

test('validateEpochMonotonic accepts a strictly greater candidate and rejects equal/lesser/invalid', () => {
  assert.deepEqual(validateEpochMonotonic(5, 4), { ok: true });
  assert.deepEqual(validateEpochMonotonic(4, 4), { ok: false, reason: 'epoch_not_strictly_increasing' });
  assert.deepEqual(validateEpochMonotonic(3, 4), { ok: false, reason: 'epoch_not_strictly_increasing' });
  assert.deepEqual(validateEpochMonotonic(-1, 4), { ok: false, reason: 'invalid_candidate_epoch' });
  assert.deepEqual(validateEpochMonotonic(5, null), { ok: true });
});

test('MAX_EPOCH is the shared safe-integer ceiling used by the generated contract', () => {
  assert.equal(MAX_EPOCH, 9007199254740991);
});
