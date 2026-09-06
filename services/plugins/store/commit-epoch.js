'use strict';

// Pure commit_epoch arithmetic (PLUG-D14, PLUG-D19, invariants 16/22). No I/O,
// no ambient clock: every function here takes its inputs as plain values so
// the authority-critical epoch math can be unit-tested exhaustively and reused
// unchanged by whatever later wave wires it to real receipts/journal/generation
// evidence.
//
// Two distinct paths:
//   - mintNextEpoch: the active pointer is intact and readable. The next epoch
//     is simply currentEpoch + 1 (or 0 for the very first commit). Because the
//     base is always the CURRENT pointer's epoch -- never the epoch a
//     candidate generation happened to carry the last time it was active --
//     reusing old generation bytes on rollback still produces a fresh epoch
//     (PLUG-D14's A -> B -> A defense: rolling back from epoch 5 to generation
//     A, last seen at epoch 2, mints epoch 6, not 3).
//   - recoverEpoch: the active pointer is lost or corrupted, so "the current
//     epoch" cannot be read directly. PLUG-D19 requires deriving the next
//     epoch from the maximum durable epoch across every durable evidence
//     source (operation receipts, journal entries, retained generation/pointer
//     history) PLUS a recorded safety increment, so a recovered epoch can
//     never collide with one minted before the loss even if some evidence is
//     itself missing or stale. Gathering the evidence arrays from real
//     receipts/journal/history is a caller responsibility (Stage 3B wiring);
//     this module only owns the arithmetic and its monotonicity guarantees.

const MIN_EPOCH = 0;
const MAX_EPOCH = 9007199254740991; // matches the shared commit_epoch contract bound
const DEFAULT_SAFETY_INCREMENT = 1;

function isValidEpoch(value) {
  return Number.isSafeInteger(value) && value >= MIN_EPOCH && value <= MAX_EPOCH;
}

function assertValidEpoch(value, label) {
  if (!isValidEpoch(value)) {
    throw new Error(`commit-epoch: ${label} must be a safe integer in [${MIN_EPOCH}, ${MAX_EPOCH}], got ${JSON.stringify(value)}`);
  }
}

// currentEpoch is null/undefined only for the very first-ever commit (no
// active pointer has ever existed). Any other falsy-but-defined value (e.g.
// a caller accidentally passing '' or NaN) is a programmer error, not "no
// epoch yet" -- fail loudly rather than silently minting 0 for a bug.
function mintNextEpoch(currentEpoch) {
  if (currentEpoch === null || currentEpoch === undefined) {
    return MIN_EPOCH;
  }
  assertValidEpoch(currentEpoch, 'currentEpoch');
  const next = currentEpoch + 1;
  if (next > MAX_EPOCH) {
    throw new Error('commit-epoch: epoch space exhausted (would exceed the safe-integer ceiling)');
  }
  return next;
}

// PLUG-D19 recovery. `evidenceEpochs` is every commit_epoch value the caller
// could durably gather from operation receipts, journal entries, and retained
// generation/pointer history -- as many sources as are actually reachable;
// gaps in evidence collection are exactly why the safety increment exists.
// Non-finite/negative/out-of-range entries are ignored rather than thrown on,
// since evidence gathered from partially-corrupt sources must not crash
// recovery itself.
function recoverEpoch({ evidenceEpochs = [], safetyIncrement = DEFAULT_SAFETY_INCREMENT } = {}) {
  if (!Number.isSafeInteger(safetyIncrement) || safetyIncrement < 1) {
    throw new Error('commit-epoch: safetyIncrement must be a positive safe integer');
  }
  let maxSeen = -1;
  for (const candidate of evidenceEpochs) {
    if (isValidEpoch(candidate) && candidate > maxSeen) {
      maxSeen = candidate;
    }
  }
  const next = maxSeen + 1 + safetyIncrement;
  if (next > MAX_EPOCH) {
    throw new Error('commit-epoch: recovered epoch would exceed the safe-integer ceiling');
  }
  return next;
}

// Guard used immediately before every active-pointer commit: the candidate
// epoch must be strictly greater than whatever epoch is currently recorded.
// Returns a result object (never throws) so active-pointer.js can fail the
// commit closed instead of crashing on a caller bug.
function validateEpochMonotonic(candidateEpoch, currentEpoch) {
  if (!isValidEpoch(candidateEpoch)) {
    return { ok: false, reason: 'invalid_candidate_epoch' };
  }
  if (currentEpoch !== null && currentEpoch !== undefined) {
    if (!isValidEpoch(currentEpoch)) {
      return { ok: false, reason: 'invalid_current_epoch' };
    }
    if (candidateEpoch <= currentEpoch) {
      return { ok: false, reason: 'epoch_not_strictly_increasing' };
    }
  }
  return { ok: true };
}

module.exports = {
  MIN_EPOCH,
  MAX_EPOCH,
  mintNextEpoch,
  recoverEpoch,
  validateEpochMonotonic,
};
