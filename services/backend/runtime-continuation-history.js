'use strict';

const { createHash } = require('node:crypto');
const { stableJson } = require('../session-runtime/contracts');
const { normalizeCompactionSnapshot } = require('./session-compaction-snapshot');
const { fingerprintRuntimeHistory, normalizeHistorySelector } = require('./runtime-continuation-records');

// Capture after frame fitting, before provider dispatch. This contains only
// canonical boundaries/digests; it cannot become a second transcript owner.
function captureRuntimeContinuationHistory({ canonicalSessionMessages, contextPreferences,
  frameOutcome, compactedHistory, sessionSummary } = {}) {
  if (!Array.isArray(canonicalSessionMessages) || frameOutcome?.fitsBudget !== true
    || typeof compactedHistory?.applied !== 'boolean') {
    throw new TypeError('runtime_continuation_history_unavailable');
  }
  const scope = frameOutcome.historyScopeFallback ?? contextPreferences?.history_scope;
  let compactionRef = null;
  if (compactedHistory.applied) {
    const snapshot = normalizeCompactionSnapshot(sessionSummary?.compaction_snapshot);
    if (!snapshot) throw new TypeError('runtime_continuation_compaction_unavailable');
    compactionRef = { boundary_message_id: snapshot.boundary_message_id,
      boundary_message_count: snapshot.boundary_message_count,
      sha256: createHash('sha256').update(stableJson(snapshot)).digest('hex') };
  }
  const selector = normalizeHistorySelector({ schema_version: 1, history_scope: scope,
    canonical_cutoff: { boundary_message_id: canonicalSessionMessages.at(-1)?.id ?? null,
      boundary_message_count: canonicalSessionMessages.length,
      sha256: fingerprintRuntimeHistory(canonicalSessionMessages) }, compaction_ref: compactionRef });
  Object.freeze(selector.canonical_cutoff);
  if (selector.compaction_ref) Object.freeze(selector.compaction_ref);
  return Object.freeze(selector);
}

module.exports = { captureRuntimeContinuationHistory };
