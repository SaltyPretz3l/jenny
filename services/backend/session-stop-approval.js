'use strict';

// The `session_stop` approval card's trusted target (row 69 Q11, owner 2026-10-20). The model names
// the chat to stop only by id; the card shows the app's own title, project and live state for that
// id, read from the caller-scoped session directory, so a chat outside the caller's scope is never
// described. Any failure leaves the card without a target, and it never shows the raw id.
const TOOL_NAME = 'session_stop';
// The chip the card and the "Needs you" row show for this tool (the sidecar's family maps it to
// "Local computer", which says nothing about what a stop touches).
const SESSION_STOP_SCOPE = 'Another chat';
const LABEL_MAX_BYTES = 512;

function bounded(value, maxBytes) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && Buffer.byteLength(text, 'utf8') <= maxBytes ? text : null;
}

function stateOf(status) {
  if (status === 'running' || status === 'waiting_approval' || status === 'queued') return status;
  return 'idle';
}

/** `{ session_stop_approval }` for a `session_stop` request's input, `{}` on any failure. */
async function sessionStopApprovalFields(service, callerSessionId, input) {
  const targetId = typeof input?.session_id === 'string' ? input.session_id.trim() : '';
  if (!targetId || targetId.length > 256 || typeof callerSessionId !== 'string' || !callerSessionId) return {};
  try {
    const directory = service?.getSessionDirectory?.() || null;
    if (typeof directory?.digest !== 'function') return {};
    const answer = await directory.digest({ callerSessionId, sessionId: targetId,
      includeTranscriptTail: false, includeChanges: false });
    if (answer?.ok !== true) {
      return answer?.reason === 'not_found'
        ? { session_stop_approval: { schema_version: 1, target: null, state: 'not_found' } } : {};
    }
    const session = answer.session || {};
    return { session_stop_approval: {
      schema_version: 1,
      target: { session_id: targetId, title: bounded(session.title, LABEL_MAX_BYTES),
        project_label: bounded(session.project?.name, LABEL_MAX_BYTES) },
      state: stateOf(session.status),
    } };
  } catch (_error) {
    return {};
  }
}

module.exports = { SESSION_STOP_SCOPE, TOOL_NAME, sessionStopApprovalFields };
