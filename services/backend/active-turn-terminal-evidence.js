// CTL-007 shared evidence check: both active-turn reconcile paths (managed
// sidecar + external/shadow) must confirm a stale active_turn's assistant row
// hasn't already durably settled before fabricating a sidecar_crash failure.
// The crash window this guards against: the assistant row persists, then the
// process dies before active_turn is cleared (or before a previous reconcile
// finishes clearing it) -- a blind append would duplicate the message id
// and/or overwrite a succeeded turn with a fabricated failure. Message-level
// evidence is sufficient on its own; turn-event presence is not required.

// Statuses that mean the row is still LIVE (mid-stream), never actually
// persisted terminal content. Everything else -- including a status-less row,
// which is how a normal completed assistant message is stored (see
// chat-stream-managed-runtime.js's default persistAssistantMessage callback,
// which appends no `status` field at all) -- counts as terminal evidence.
const LIVE_MESSAGE_STATUSES = new Set([
  'streaming',
  'pending',
  'awaiting_assistant',
  'in_progress',
  'thinking',
]);

// tool_call.status values that mean the invocation never finished -- a stream
// with one of these dangling is a turn that crashed mid-tool-loop, not a
// settled turn, no matter what text segments persisted before the boundary.
const NON_TERMINAL_TOOL_STATUSES = new Set([
  'running',
  'executing',
  'pending',
  'pending_approval',
]);

function isTerminalMessageStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return !LIVE_MESSAGE_STATUSES.has(normalized);
}

// A message "belongs" to a stream when it is the stream's canonical assistant
// row (id === assistant_<streamId>) or carries a top-level stream association
// field pointing at it. Nested per-tool-call fields (tool_call.parent_stream_id)
// are deliberately out of scope -- those identify a tool invocation's parent
// stream, not the turn's own settled assistant content.
function messageMatchesStream(message, streamId) {
  const normalizedStreamId = String(streamId || '').trim();
  if (!normalizedStreamId || !message || typeof message !== 'object') {
    return false;
  }
  if (String(message.id || '').trim() === `assistant_${normalizedStreamId}`) {
    return true;
  }
  if ([
    `question_batch_${normalizedStreamId}`,
    `plan_proposal_${normalizedStreamId}`,
  ].includes(String(message.id || '').trim())) {
    return true;
  }
  return [message.streamId, message.stream_id, message.parent_stream_id].some(
    (candidate) => String(candidate || '').trim() === normalizedStreamId
  );
}

// The stream's tool rows (excluded from messageMatchesStream on purpose) are
// still needed as ORDERING context: a tool_use/tool_result row is identified
// by its production id prefix or its nested tool_call/tool_result stream
// association (chat-stream-tool-handling.js writes both).
function isStreamToolRow(message, streamId) {
  if (!message || typeof message !== 'object') {
    return false;
  }
  const id = String(message.id || '').trim();
  if (id.startsWith(`tool_use_${streamId}_`) || id.startsWith(`tool_result_${streamId}_`)) {
    return true;
  }
  return [
    message.tool_call?.streamId,
    message.tool_call?.parent_stream_id,
    message.tool_result?.parent_stream_id,
  ].some((candidate) => String(candidate || '').trim() === streamId);
}

// True when at least one persisted message for this stream already carries
// terminal status. Callers must still clear the stale active_turn but must
// NOT append another failure row when this returns true.
//
// Two evidence tiers (code-review hardening, 2026-07-10):
// 1. The canonical `assistant_<streamId>` row with terminal status is
//    sufficient alone -- the non-segmented settle path and reconcile failure
//    rows both use the exact id, and neither ever coexists with a crash that
//    needs repair.
// 2. Segment rows (assistant_<streamId>_seg<N>) also carry top-level
//    parent_stream_id and no status, but a boundary segment persists MID-turn
//    at every tool hand-off, so a segment alone proves nothing about how the
//    turn ended. Segment evidence therefore counts only when the turn's tool
//    trail reads as finished: no dangling tool invocation (a tool_use still
//    non-terminal with no tool_result for the same call), AND the LAST
//    stream-associated row is a terminal assistant row rather than a tool
//    row. A crash mid-tool-loop leaves a dangling tool_use; a crash while
//    streaming the final answer leaves a trailing tool_result; both keep the
//    full repair. Known residuals (accepted): a crash inside the few
//    synchronous statements between a boundary-segment persist and its
//    tool_use persist reads as settled, and a completed tool-rows-only turn
//    (no final text/reasoning segment) that crashes in the settle-to-clear
//    window gains a phantom crash row -- both windows are orders of magnitude
//    narrower than the tool-loop/final-answer windows this tier repairs.
function hasTerminalMessageEvidence(messages, streamId) {
  if (!Array.isArray(messages)) {
    return false;
  }
  const normalizedStreamId = String(streamId || '').trim();
  if (!normalizedStreamId) {
    return false;
  }
  const exactAssistantId = `assistant_${normalizedStreamId}`;
  const danglingToolCallIds = new Set();
  let lastStreamRowIsTerminalAssistant = false;
  let sawStreamRow = false;
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue;
    }
    const id = String(message.id || '').trim();
    if (id === exactAssistantId && isTerminalMessageStatus(message.status)) {
      return true;
    }
    if (isStreamToolRow(message, normalizedStreamId)) {
      const callId = String(message.tool_call?.call_id
        || message.tool_result?.call_id
        || id.replace(/^tool_(use|result)_/, '')
      ).trim();
      if (id.startsWith(`tool_use_${normalizedStreamId}_`) || message.tool_call) {
        const toolStatus = String(message.tool_call?.status || '').trim().toLowerCase();
        if (NON_TERMINAL_TOOL_STATUSES.has(toolStatus)) {
          danglingToolCallIds.add(callId);
        } else {
          danglingToolCallIds.delete(callId);
        }
      } else {
        // A result row settles its call even if the tool_use patch never landed.
        danglingToolCallIds.delete(callId);
      }
      lastStreamRowIsTerminalAssistant = false;
      sawStreamRow = true;
      continue;
    }
    if (messageMatchesStream(message, normalizedStreamId)) {
      lastStreamRowIsTerminalAssistant = isTerminalMessageStatus(message.status);
      sawStreamRow = true;
    }
  }
  return sawStreamRow
    && danglingToolCallIds.size === 0
    && lastStreamRowIsTerminalAssistant;
}

module.exports = {
  isTerminalMessageStatus,
  messageMatchesStream,
  hasTerminalMessageEvidence,
};
