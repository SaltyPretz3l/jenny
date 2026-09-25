'use strict';

const { RuntimeStoreError, isoNow } = require('./store-control');
const { validateWorkRecord, cloneJson } = require('./contracts');
const { TOMBSTONE_KIND, RETENTION_MS, TERMINAL, isTerminalTombstone, retainedMetadata } = require('./terminal-retention-contract');

function compactTerminalDetail(store, { limit = 8, afterSequence = 0, canCompact } = {}) {
  store._assertWritable();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32
    || !Number.isSafeInteger(afterSequence) || afterSequence < 0
    || typeof canCompact !== 'function') throw new RuntimeStoreError('retention_request_invalid');
  const at = isoNow(store.now);
  const cutoff = Date.parse(at) - RETENTION_MS;
  const candidates = store.index.summaries.filter(row => row.submission_sequence > afterSequence);
  const batch = candidates.slice(0, limit);
  let compacted = 0;
  let savedBytes = 0;
  for (const summary of batch) {
    if (!TERMINAL.has(summary.status) || Date.parse(summary.updated_at) > cutoff) continue;
    const work = store.get(summary.work_id);
    if (isTerminalTombstone(work.input) || work.checkpoint_ref
      || Date.parse(work.transition.at) > cutoff || (!work.attempt && work.status !== 'cancelled')) continue;
    // The application owns canonical/physical evidence. Failure or an async
    // answer is not proof; keep every byte and move to the next bounded record.
    let confirmed = false;
    try { confirmed = canCompact(cloneJson(work)) === true; } catch (_error) { /* Retain evidence. */ }
    if (!confirmed) continue;
    const current = store.get(work.work_id);
    if (current.revision !== work.revision) throw new RuntimeStoreError('revision_conflict');
    const input = { schema_version: 1, kind: TOMBSTONE_KIND, compacted_at: at,
      original_input_bytes: work.input_bytes,
      canonical_result_ref: work.attempt ? { session_id: work.session_id, turn_id: work.turn_id } : null,
      ...retainedMetadata(work.input) };
    const next = { ...work, input, input_bytes: Buffer.byteLength(JSON.stringify(input), 'utf8'),
      revision: work.revision + 1 };
    const checked = validateWorkRecord(next);
    if (!checked.ok) throw new RuntimeStoreError(checked.reason);
    store._commit(checked.record);
    compacted += 1;
    savedBytes += Math.max(0, work.input_bytes - next.input_bytes);
  }
  return Object.freeze({ scanned: batch.length, compacted, saved_bytes: savedBytes,
    next_sequence: candidates.length > batch.length ? batch.at(-1).submission_sequence : 0 });
}

module.exports = { compactTerminalDetail };
