'use strict';

// Propose run mode (row 35, plan C1): Electron derives it from the stored session
// record, never from renderer send flags. A Propose request is read-only, never
// auto-runs, and carries the live suggestions the sidecar must not overlap.

function isProposeRunMode(record) {
  return String(record?.run_mode || '').trim().toLowerCase() === 'propose';
}

function buildProposeSendFields(service, sessionId, record) {
  if (!isProposeRunMode(record)) return {};
  return {
    propose_mode: true,
    suggested_changes_context: service?.suggestedChanges?.liveContext?.(sessionId)
      || { schema_version: 1, live: [] },
  };
}

module.exports = { buildProposeSendFields, isProposeRunMode };
