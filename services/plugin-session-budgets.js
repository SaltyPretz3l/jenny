'use strict';

const ledger = require('../config/plugins/session-provider-v1-budgets.json');

const REQUIRED_LIMITS = Object.freeze([
  'state_bytes', 'invoke_arguments_bytes', 'transcript_page_messages',
  'transcript_page_bytes', 'message_operation_metadata_bytes',
  'session_operation_metadata_bytes', 'attachment_ticket_ttl_ms', 'artifact_bytes',
  'operation_frames', 'poll_frame_batch', 'operation_frame_bytes',
  'poll_interval_ms', 'poll_backoff_max_ms',
]);

function validLimits(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== REQUIRED_LIMITS.length) return false;
  if (!REQUIRED_LIMITS.every((key) => (
    Number.isSafeInteger(value[key]) && value[key] > 0
  ))) return false;
  return value.message_operation_metadata_bytes <= value.session_operation_metadata_bytes
    && value.poll_interval_ms <= value.poll_backoff_max_ms
    && value.operation_frame_bytes <= value.transcript_page_bytes
    && value.poll_frame_batch <= value.operation_frames;
}

if (ledger?.budget_schema_version !== 1 || ledger.frozen !== true || !validLimits(ledger.limits)) {
  throw new Error('Session-provider budget ledger is invalid.');
}

module.exports = Object.freeze({
  PLUGIN_SESSION_LIMITS: Object.freeze({ ...ledger.limits }),
  REQUIRED_LIMITS,
  validLimits,
});
