'use strict';

// The one mutable authority pointer: `active-generation.json`
// (PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md invariant 3, PLUG-D01, PLUG-D14,
// "Durable generation commit" step 5). Only `commitActivePointer` may change
// which generation is authoritative; every other module reads through
// `readActivePointer` and treats the file as read-only.
//
// commitActivePointer implements, as separately awaited facade calls so a
// crash-injecting facade (W4) can land between any two of them:
//   1. Re-read the current pointer and compare it to the caller's expected
//      value (optimistic CAS -- "only the pointer flip commits authority").
//   2. Validate the candidate pointer's shape, epoch monotonicity
//      (commit-epoch.js), and revision contiguity.
//   3. Retain the current pointer's exact bytes as `active-generation.prior.json`
//      *before* touching the real file ("retain a validated prior pointer for
//      recovery").
//   4. Atomically replace `active-generation.json` (temp write + fsync + same-
//      volume rename via json-file-io.js).
//   5. Best-effort fsync the containing directory.
//   6. Reread the file and byte-for-byte verify it matches what was intended,
//      catching a torn write or corrupted rename immediately rather than
//      trusting the write blindly.
// Windows cannot durably fsync a directory the way POSIX can, so step 5 is
// defense in depth, never the sole guarantee; steps 1-4 are what make the
// replace crash-safe (either the old or the new complete pointer is ever
// observable, never a mix).

const { joinPath } = require('./fs-facade');
const {
  readJsonFile,
  writeJsonFileAtomic,
  stageJsonFile,
  commitStagedFile,
  discardStagedFile,
} = require('./json-file-io');
const { validate } = require('../contracts/generated-plugin-contracts');
const { validateEpochMonotonic } = require('./commit-epoch');

const CONTRACT_NAME = 'PluginRegistryV1';
const POINTER_FILE = 'active-generation.json';
const PRIOR_POINTER_FILE = 'active-generation.prior.json';

async function readPointerFile(facade, baseDir, fileName) {
  const read = await readJsonFile(facade, joinPath(baseDir, fileName));
  if (read.status === 'missing') {
    return { status: 'missing' };
  }
  if (read.status === 'corrupted') {
    return { status: 'corrupted', error: read.error };
  }
  const validated = validate(CONTRACT_NAME, read.value);
  if (!validated.ok) {
    return { status: 'corrupted', error: `${validated.error.path}: ${validated.error.reason}` };
  }
  return { status: 'ok', pointer: validated.value };
}

function readActivePointer(facade, baseDir) {
  return readPointerFile(facade, baseDir, POINTER_FILE);
}

function readPriorPointer(facade, baseDir) {
  return readPointerFile(facade, baseDir, PRIOR_POINTER_FILE);
}

// Pure helper: constructs and validates a candidate pointer value so callers
// never hand-assemble raw objects that might drift from the schema's field
// names. Throws on a structurally invalid input (programmer error).
function buildPointer({ revision, commitEpoch, generationId, generationDigest, committedAt }) {
  const candidate = {
    registry_schema_version: 1,
    revision,
    commit_epoch: commitEpoch,
    generation_id: generationId,
    generation_digest: generationDigest,
    committed_at: committedAt,
  };
  const validated = validate(CONTRACT_NAME, candidate);
  if (!validated.ok) {
    throw new Error(`active-pointer: candidate pointer failed validation at ${validated.error.path}: ${validated.error.reason}`);
  }
  return validated.value;
}

function casCheck(currentRead, expectedCurrent) {
  if (currentRead.status === 'corrupted') {
    return { ok: false, reason: 'active_pointer_corrupted', detail: currentRead.error };
  }
  const expected = expectedCurrent || null;
  if (currentRead.status === 'missing') {
    return expected === null
      ? { ok: true }
      : { ok: false, reason: 'stale_active_pointer' };
  }
  // currentRead.status === 'ok'
  if (expected === null) {
    return { ok: false, reason: 'stale_active_pointer' };
  }
  const matches =
    expected.revision === currentRead.pointer.revision
    && expected.commit_epoch === currentRead.pointer.commit_epoch
    && expected.generation_id === currentRead.pointer.generation_id;
  return matches ? { ok: true } : { ok: false, reason: 'stale_active_pointer' };
}

// `leaseGuard` is an optional async predicate re-checked immediately before the
// authoritative write. The CAS above is read-then-write, and several awaits sit
// between the two: if the caller's mutation lease expires inside that window
// and another operation legitimately reclaims it and commits, the CAS has
// already passed and this function would happily overwrite the winner --
// observed producing two DIFFERENT generations at the same commit_epoch, which
// breaks PLUG-D14. It is optional so W3's existing pure-pointer tests keep
// calling this with two arguments.
//
// Placing the guard before `writeJsonFileAtomic` was NOT enough: that helper is
// itself mkdir + write + fsync + rename + fsyncDir, so a competitor could still
// land in the middle of it and be overwritten (reproduced by interleaving at the
// pointer's own writeFile and fsyncFile boundaries -- both operations returned
// ok at the same epoch). The bytes are therefore STAGED first, and the guard
// plus a CAS re-read now sit immediately before the rename, which is the single
// atomic call that actually publishes authority. After the rename the lease is
// verified once more: if it was lost inside that last window this call reports
// `lease_lost_during_commit` rather than returning a success the store cannot
// stand behind.
async function commitActivePointer(facade, baseDir, { expectedCurrent, nextPointer, leaseGuard = null }) {
  const currentRead = await readActivePointer(facade, baseDir);
  const cas = casCheck(currentRead, expectedCurrent);
  if (!cas.ok) {
    return { ok: false, reason: cas.reason, detail: cas.detail, current: currentRead };
  }

  const validatedNext = validate(CONTRACT_NAME, nextPointer);
  if (!validatedNext.ok) {
    return { ok: false, reason: 'invalid_next_pointer', detail: validatedNext.error };
  }
  const candidate = validatedNext.value;

  const currentPointer = currentRead.status === 'ok' ? currentRead.pointer : null;
  const epochCheck = validateEpochMonotonic(candidate.commit_epoch, currentPointer ? currentPointer.commit_epoch : null);
  if (!epochCheck.ok) {
    return { ok: false, reason: epochCheck.reason };
  }
  const expectedRevision = currentPointer ? currentPointer.revision + 1 : 1;
  if (candidate.revision !== expectedRevision) {
    return {
      ok: false,
      reason: 'revision_not_contiguous',
      detail: { expected: expectedRevision, actual: candidate.revision },
    };
  }

  if (currentPointer) {
    await writeJsonFileAtomic(facade, baseDir, PRIOR_POINTER_FILE, currentPointer);
  }

  const staged = await stageJsonFile(facade, baseDir, POINTER_FILE, candidate);

  if (leaseGuard) {
    const guard = await leaseGuard();
    if (!guard || !guard.ok) {
      await discardStagedFile(facade, staged);
      return { ok: false, reason: (guard && guard.reason) || 'lease_guard_failed' };
    }
  }

  // Same instant, same reason: a competitor that committed while this call was
  // staging bytes must not be silently overwritten, even when no lease guard is
  // supplied.
  const preCommitRead = await readActivePointer(facade, baseDir);
  const preCommitCas = casCheck(preCommitRead, expectedCurrent);
  if (!preCommitCas.ok) {
    await discardStagedFile(facade, staged);
    return { ok: false, reason: preCommitCas.reason, detail: preCommitCas.detail, current: preCommitRead };
  }

  await commitStagedFile(facade, baseDir, staged);

  if (leaseGuard) {
    const afterGuard = await leaseGuard();
    if (!afterGuard || !afterGuard.ok) {
      return { ok: false, reason: 'lease_lost_during_commit', detail: { guard: (afterGuard && afterGuard.reason) || null } };
    }
  }

  const reread = await readActivePointer(facade, baseDir);
  if (reread.status !== 'ok') {
    return { ok: false, reason: 'post_commit_reread_failed', detail: reread };
  }
  if (JSON.stringify(reread.pointer) !== JSON.stringify(candidate)) {
    return { ok: false, reason: 'post_commit_verification_mismatch', detail: reread.pointer };
  }

  return { ok: true, pointer: reread.pointer };
}

// PLUG-D19 recovery door. `commitActivePointer` cannot serve pointer loss: its
// contiguity rule demands `revision === 1` whenever no pointer is readable, so
// recovering after a lost pointer through the normal path would reset revision
// to 1 and re-mint epochs that were already handed out. That is precisely the
// collision PLUG-D19 forbids ("pointer corruption never resets epoch
// monotonicity"), so recovery gets its own narrowly-guarded entry point rather
// than a bypass -- this module stays the ONLY writer of the authority pointer.
//
// Three preconditions, all fail-closed:
//   1. The current pointer must be unreadable (missing or corrupted). Recovery
//      may never overwrite an intact pointer; if one is readable, the caller
//      wanted commitActivePointer.
//   2. The candidate epoch must be at least the epoch recovery derived from
//      durable evidence + safety increment (commit-epoch.js recoverEpoch).
//   3. The candidate revision must exceed every revision seen in evidence, so
//      an expected-revision CAS from a stale in-flight operation cannot match.
async function commitRecoveredPointer(facade, baseDir, { nextPointer, recoveredEpoch, maxKnownRevision = 0 }) {
  const currentRead = await readActivePointer(facade, baseDir);
  if (currentRead.status === 'ok') {
    return { ok: false, reason: 'pointer_intact_recovery_refused', current: currentRead.pointer };
  }

  const validatedNext = validate(CONTRACT_NAME, nextPointer);
  if (!validatedNext.ok) {
    return { ok: false, reason: 'invalid_next_pointer', detail: validatedNext.error };
  }
  const candidate = validatedNext.value;

  if (!Number.isSafeInteger(recoveredEpoch) || candidate.commit_epoch < recoveredEpoch) {
    return {
      ok: false,
      reason: 'recovered_epoch_too_low',
      detail: { required: recoveredEpoch, actual: candidate.commit_epoch },
    };
  }
  if (candidate.revision <= maxKnownRevision) {
    return {
      ok: false,
      reason: 'recovered_revision_not_advancing',
      detail: { required: maxKnownRevision + 1, actual: candidate.revision },
    };
  }

  // Retain the RECOVERED pointer as the prior pointer, and do it BEFORE
  // publishing it as active. The prior slot is one of the durable epoch
  // witnesses recovery reads (PLUG-D19), so leaving it at its pre-recovery
  // value lets a SECOND pointer loss derive a high-water below an epoch this
  // recovery already minted -- observed regressing 5 -> 4 across a double loss,
  // which is precisely the collision PLUG-D19 forbids. Writing it first means a
  // crash between the two writes leaves the witness HIGH, which is always safe:
  // the next recovery over-estimates rather than under-estimates.
  await writeJsonFileAtomic(facade, baseDir, PRIOR_POINTER_FILE, candidate);
  await writeJsonFileAtomic(facade, baseDir, POINTER_FILE, candidate);

  const reread = await readActivePointer(facade, baseDir);
  if (reread.status !== 'ok') {
    return { ok: false, reason: 'post_commit_reread_failed', detail: reread };
  }
  if (JSON.stringify(reread.pointer) !== JSON.stringify(candidate)) {
    return { ok: false, reason: 'post_commit_verification_mismatch', detail: reread.pointer };
  }
  return { ok: true, pointer: reread.pointer };
}

module.exports = {
  CONTRACT_NAME,
  POINTER_FILE,
  PRIOR_POINTER_FILE,
  buildPointer,
  readActivePointer,
  readPriorPointer,
  commitActivePointer,
  commitRecoveredPointer,
};
