'use strict';

// The orthogonal cleanup record (PLUG-D17, invariant 20): `cleanup_status` and
// `cleanup_target` describe best-effort physical process/file cleanup, never
// logical plugin authority. This module uses the ALREADY-LANDED
// PluginCleanupStateV1 contract (config/plugins/v1/plugin-cleanup-state.schema.json)
// rather than defining a new one.
//
// Structural guarantee, not just a comment: this module never imports
// active-pointer.js or generation-store.js. There is no code path here that
// can touch authority state, so "cleanup failure never restores authority,
// promotes a contribution, or blocks core startup" holds by construction, not
// by convention.
//
// Per-plugin storage layout matches
// PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md's `data/<publisher_id>/<plugin_id>/`
// tree: `cleanup-state.json` lives alongside that plugin's other host-owned
// data.

const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('./json-file-io');
const { validate } = require('../contracts/generated-plugin-contracts');

const CONTRACT_NAME = 'PluginCleanupStateV1';
const DATA_DIR = 'data';
const CLEANUP_STATE_FILE = 'cleanup-state.json';

function cleanupStateDir(baseDir, publisherId, pluginId) {
  return joinPath(baseDir, DATA_DIR, publisherId, pluginId);
}

function buildCleanupState({ cleanupStatus, cleanupTarget, lifecycleEpoch, commitEpoch, cleanupDetail }) {
  const candidate = {
    cleanup_status: cleanupStatus,
    cleanup_target: cleanupTarget,
    lifecycle_epoch: lifecycleEpoch,
    commit_epoch: commitEpoch,
    cleanup_detail: cleanupDetail,
  };
  const validated = validate(CONTRACT_NAME, candidate);
  if (!validated.ok) {
    throw new Error(`cleanup-state: candidate failed validation at ${validated.error.path}: ${validated.error.reason}`);
  }
  return validated.value;
}

// The monotonic guard runs HERE, on the durable path, not only inside the pure
// `transitionCleanupState` helper below. Leaving it opt-in meant a caller that
// simply forgot the helper let a delayed worker's older epoch overwrite a newer
// record and still reported success.
async function writeCleanupState(facade, baseDir, publisherId, pluginId, state) {
  const current = await readCleanupState(facade, baseDir, publisherId, pluginId);
  // A missing record is the legitimate first write; any OTHER read failure
  // (corrupt or schema-invalid bytes) is surfaced rather than overwritten,
  // because a record we cannot compare against is one we cannot prove is older.
  if (!current.ok && current.reason !== 'cleanup_state_not_found') {
    return current;
  }
  const guarded = transitionCleanupState(current.ok ? current.state : null, state);
  if (!guarded.ok) return guarded;
  await writeJsonFileAtomic(facade, cleanupStateDir(baseDir, publisherId, pluginId), CLEANUP_STATE_FILE, guarded.state);
  return { ok: true, state: guarded.state };
}

async function readCleanupState(facade, baseDir, publisherId, pluginId) {
  const read = await readJsonFile(
    facade,
    joinPath(cleanupStateDir(baseDir, publisherId, pluginId), CLEANUP_STATE_FILE)
  );
  if (read.status === 'missing') {
    return { ok: false, reason: 'cleanup_state_not_found' };
  }
  if (read.status === 'corrupted') {
    return { ok: false, reason: 'cleanup_state_corrupted', detail: read.error };
  }
  const validated = validate(CONTRACT_NAME, read.value);
  if (!validated.ok) {
    return { ok: false, reason: 'cleanup_state_invalid', detail: validated.error };
  }
  return { ok: true, state: validated.value };
}

// Pure transition guard: rejects a next state whose epochs regress relative
// to the current record. An older, stale cleanup update (e.g. a delayed
// worker reporting on a since-superseded operation) must never overwrite a
// newer one -- this is the cleanup layer's own ABA-style protection,
// independent of and in addition to authority's commit_epoch monotonicity.
function transitionCleanupState(current, next) {
  const validatedNext = validate(CONTRACT_NAME, next);
  if (!validatedNext.ok) {
    return { ok: false, reason: 'invalid_cleanup_state', detail: validatedNext.error };
  }
  if (current) {
    if (validatedNext.value.commit_epoch < current.commit_epoch) {
      return { ok: false, reason: 'commit_epoch_regression' };
    }
    if (
      validatedNext.value.commit_epoch === current.commit_epoch
      && validatedNext.value.lifecycle_epoch < current.lifecycle_epoch
    ) {
      return { ok: false, reason: 'lifecycle_epoch_regression' };
    }
  }
  return { ok: true, state: validatedNext.value };
}

module.exports = {
  CONTRACT_NAME,
  DATA_DIR,
  CLEANUP_STATE_FILE,
  cleanupStateDir,
  buildCleanupState,
  writeCleanupState,
  readCleanupState,
  transitionCleanupState,
};
