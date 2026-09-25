'use strict';

// Existing application text projections have stable attempt-local IDs but no
// wire sequence. Select their exact durable IDs; never invent a sidecar sequence.
function isContinuationTextProjection(event) {
  if (event?.payload?.canonical_seq !== undefined) return false;
  if (event?.kind === 'plan_document') {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127}):plan_document:(plan_[0-9a-f]{20}):(pending|approved|approved_auto|accepted|rejected|abandoned|superseded)$/u
      .exec(String(event.event_id || ''));
    // These are application-owned transcript projections, never consent or
    // execution proof. Resume still verifies the completed tool-result bytes.
    return Boolean(match && event.payload?.plan_id === match[2]
      && event.payload.transition === match[3] && event.status === match[3]
      && event.payload.tool_call_id === event.tool_call_id);
  }
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127}):(assistant_text_segment|reasoning_phase):live:[0-9]+$/u
    .exec(String(event?.event_id || ''));
  return Boolean(match && event.kind === match[2]);
}
function isContinuationEvent(event) {
  return (Number.isSafeInteger(event?.payload?.canonical_seq) && event.payload.canonical_seq > 0)
    || isContinuationTextProjection(event);
}
function isDecisionProjection(event, { decision, sessionId, turnId, streamId, pendingCalls = [] } = {}) {
  if (decision?.kind !== 'approval' || event?.payload?.canonical_seq !== undefined
    || event.kind !== 'tool_use' || event.status !== 'pending_approval'
    || event.turn_id !== turnId || event.tool_call_id !== decision.call_id) return false;
  const call = pendingCalls.find(item => item.call_id === decision.call_id);
  const prefix = `${turnId}:tool_use:`;
  const suffix = `:${streamId}`;
  const id = String(event.event_id || '');
  return Boolean(call && id.startsWith(prefix) && id.endsWith(suffix)
    && /^[0-9]+$/u.test(id.slice(prefix.length, -suffix.length))
    && event.payload?.approval_id === `approval_${sessionId}_${streamId}_${decision.call_id}`
    && event.payload.parent_stream_id === streamId && event.payload.tool_name === call.tool_id);
}
module.exports = { isContinuationTextProjection, isContinuationEvent, isDecisionProjection };
