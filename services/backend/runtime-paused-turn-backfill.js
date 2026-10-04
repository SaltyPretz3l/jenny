'use strict';

// A paused continuation persists its canonical prefix (reasoning,
// tool_executing, tool_result) and leaves the tool_use backfill to terminal
// finalization. A paused turn that is cancelled instead never finalizes, so
// every reopen projected its tool rows as orphan_tool_executing system notices
// (2026-09-22). When paused work is cancelled, backfill exactly the missing
// tool_use events from the persisted tool-call messages; the row projector
// already pairs a late tool_use with its earlier execution events. Nothing
// else is invented: no user_prompt (it would render after the assistant
// rows), no text, no terminal marker.

const { projectTurnTree } = require('../../renderer/chat/renderer-turn-tree-projector');
const { buildMessageIndex, buildPersistedTurnEvent } = require('./canonical-turn-event-collector-normalize');
const { normalizeId } = require('./canonical-turn-event-normalization');

const {
  CANCEL_REASON_USER,
  buildTerminalErrorPayload,
  createCancellationError,
  enrichTerminalErrorPayloadForEmit,
} = require('./chat-stream-terminal-utils');

const TOOL_EXECUTION_KINDS = new Set(['tool_executing', 'tool_result']);
// Stop on the paused stream and Discard from the queue strip. A session being
// cancelled or deleted has no live presentation left to end.
const USER_CANCEL_REASONS = new Set(['user', CANCEL_REASON_USER]);

function isCancelledPausedWork(work) {
  return work?.status === 'cancelled' && Boolean(work.checkpoint_ref)
    && ['paused', 'pending'].includes(work.transition?.from);
}

function backfillCancelledPausedTurnEvents(conversationStore, work) {
  if (!isCancelledPausedWork(work)) return 0;
  const sessionId = normalizeId(work.session_id);
  const turnId = normalizeId(work.turn_id);
  if (!sessionId || !turnId || typeof conversationStore?.getSessionTurnEvents !== 'function'
    || typeof conversationStore.getSessionMessages !== 'function'
    || typeof conversationStore.appendTurnEvents !== 'function') return 0;
  const turnEvents = (conversationStore.getSessionTurnEvents(sessionId) || [])
    .filter((event) => normalizeId(event?.turn_id) === turnId);
  const requested = new Set(turnEvents.filter((event) => event.kind === 'tool_use')
    .map((event) => normalizeId(event.tool_call_id)));
  const orphaned = new Set(turnEvents.filter((event) => TOOL_EXECUTION_KINDS.has(event.kind))
    .map((event) => normalizeId(event.tool_call_id))
    .filter((callId) => callId && !requested.has(callId)));
  if (!orphaned.size) return 0;
  const messages = conversationStore.getSessionMessages(sessionId) || [];
  const turn = (projectTurnTree({ messages })?.turns || [])
    .find((entry) => normalizeId(entry?.turn_id) === turnId);
  const messageById = buildMessageIndex(messages);
  const events = (turn?.events || [])
    .filter((event) => event.kind === 'tool_use' && orphaned.has(normalizeId(event.tool_call_id)))
    .map((event) => buildPersistedTurnEvent(event, messageById));
  if (!events.length) return 0;
  const commit = conversationStore.appendTurnEvents(sessionId, events, { durable: true });
  return Number(commit?.appended) || 0;
}

// A paused leg gets no terminal event of its own, so when the user stops or
// discards it the chat kept the stream live (Stop shown, "Still at it…")
// until reload (dogfood HB-034). One cancelled terminal for the paused stream
// ends that presentation through the renderer's ordinary terminal path. Work
// paused by an earlier process has no live stream, so only this incarnation's
// attempts emit.
function emitCancelledPausedTurnTerminal(service, work, incarnation) {
  if (!isCancelledPausedWork(work) || !USER_CANCEL_REASONS.has(String(work.transition?.reason || ''))) return false;
  const sessionId = normalizeId(work.session_id);
  const streamId = normalizeId(work.attempt?.stream_id);
  if (!sessionId || !streamId || !incarnation || work.attempt?.incarnation !== incarnation
    || typeof service?.emit !== 'function') return false;
  service.emit('chat-stream', {
    type: 'error',
    ...enrichTerminalErrorPayloadForEmit(buildTerminalErrorPayload(createCancellationError(CANCEL_REASON_USER))),
    streamId, sessionId, requestId: streamId, turnId: normalizeId(work.turn_id),
    traceId: streamId, trace_id: streamId,
  });
  return true;
}

// Turns cancelled while paused before this backfill existed stay orphaned
// until repaired. Every cancelled row is checked (a fixed window would starve
// older turns forever); the pass is idempotent, since a repaired turn has no
// orphaned call ids left. failed counts rows the caller may retry.
function repairCancelledPausedTurns(runtimeStore, conversationStore) {
  let appended = 0;
  let failed = 0;
  for (const row of runtimeStore?.index?.summaries || []) {
    if (row.status !== 'cancelled') continue;
    try {
      appended += backfillCancelledPausedTurnEvents(conversationStore, runtimeStore.get(row.work_id));
    } catch (_error) {
      failed += 1;
    }
  }
  return { appended, failed };
}

module.exports = { backfillCancelledPausedTurnEvents, emitCancelledPausedTurnTerminal, isCancelledPausedWork,
  repairCancelledPausedTurns };
