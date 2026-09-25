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

const TOOL_EXECUTION_KINDS = new Set(['tool_executing', 'tool_result']);

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

module.exports = { backfillCancelledPausedTurnEvents, isCancelledPausedWork, repairCancelledPausedTurns };
