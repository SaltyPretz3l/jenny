// HB-007: a mid-turn context compaction paints its "Context compacted" hairline
// in the live row-model timeline, in place, and a reload/terminal reconcile
// keeps exactly one such row at the same spot.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('./helpers/renderer-stream-handler-harness');
const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const {
  createTurnReducerState,
  applyTurnStreamEvent,
  buildTurnEventFromStreamPayload,
} = require('../renderer/chat/renderer-turn-reducer');
const { reconcileTurnRows } = require('../renderer/chat/renderer-row-identity-utils');

const SESSION = 'session-hb7';
const STREAM = 'stream-hb7';

// Wire shape emitted by chat-stream-managed-runtime-notifications.js on context.compacted.
function compactedPayload(overrides = {}) {
  return {
    type: 'context_compacted',
    sessionId: SESSION,
    streamId: STREAM,
    strategy: 'summary',
    tokensBefore: 28070,
    tokensAfter: 15612,
    compactionPhase: 'midturn',
    summaryStatus: 'created',
    ...overrides,
  };
}

function rowLabel(row) {
  return row.kind === 'system_notice' ? `system_notice/${row.payload.subkind}` : row.kind;
}

function enableRowModel(harness) {
  if (!(harness.state.ui.chatTimelineRowModelBySession instanceof Map)) {
    harness.state.ui.chatTimelineRowModelBySession = new Map();
  }
  harness.state.ui.chatTimelineRowModelBySession.set(SESSION, true);
}

test('live: a mid-turn compaction adds one context_compacted row in place', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());
  enableRowModel(harness);

  await harness.emit({ type: 'started', sessionId: SESSION, streamId: STREAM });
  await harness.emit({ type: 'delta', sessionId: SESSION, streamId: STREAM, content: 'Checking.', aggregate: 'Checking.' });
  await harness.emit({
    type: 'tool_use', sessionId: SESSION, streamId: STREAM, callId: 'c1', toolName: 'read_file', status: 'running',
  });
  await harness.emit({
    type: 'tool_result', sessionId: SESSION, streamId: STREAM, callId: 'c1', toolName: 'read_file', content: 'ok',
  });
  await harness.emit(compactedPayload());
  await harness.emit({ type: 'delta', sessionId: SESSION, streamId: STREAM, content: 'Done.', aggregate: 'Checking.Done.' });

  const turn = harness.state.ui.chatTimelineLiveStateBySession.get(SESSION).turns_by_id[STREAM];
  const labels = turn.rows.map(rowLabel);
  const noticeIndex = labels.indexOf('system_notice/context_compacted');
  assert.equal(labels.filter((label) => label === 'system_notice/context_compacted').length, 1);
  assert.ok(noticeIndex > labels.indexOf('tool_call'), `notice must follow the tool call: ${labels}`);
  assert.equal(labels.lastIndexOf('assistant_text'), labels.length - 1, `post-compaction text follows the notice: ${labels}`);
  assert.ok(noticeIndex < labels.lastIndexOf('assistant_text'));

  const notice = turn.rows[noticeIndex];
  assert.equal(notice.payload.context_compacted.tokensBefore, 28070);
  assert.equal(notice.payload.context_compacted.tokensAfter, 15612);
  assert.equal(notice.payload.context_compacted.phase, 'midturn');
  // Anchored on the pending segment message the hairline renderer reads.
  const messages = harness.state.messagesBySession.get(SESSION);
  const anchor = messages.find((message) => message.id === notice.primary_message_id);
  assert.ok(anchor, 'notice must anchor on a live session message');
  assert.equal(anchor.context_compactions.length, 1);
});

test('live: a second compaction on the same segment refreshes the one row', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());
  enableRowModel(harness);

  await harness.emit({ type: 'started', sessionId: SESSION, streamId: STREAM });
  await harness.emit(compactedPayload({ tokensBefore: 30000, tokensAfter: 20000 }));
  await harness.emit(compactedPayload({ tokensBefore: 28070, tokensAfter: 15612 }));

  const turn = harness.state.ui.chatTimelineLiveStateBySession.get(SESSION).turns_by_id[STREAM];
  const notices = turn.rows.filter((row) => row.kind === 'system_notice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].payload.context_compacted.tokensAfter, 15612);
});

test('live: a legacy (non row-model) session builds no reducer state', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());
  harness.state.ui.chatTimelineRowModelBySession = new Map([[SESSION, false]]);

  await harness.emit({ type: 'started', sessionId: SESSION, streamId: STREAM });
  await harness.emit(compactedPayload());

  assert.equal(harness.state.ui.chatTimelineLiveStateBySession?.get(SESSION) == null, true);
  const message = harness.state.messagesBySession.get(SESSION).find((entry) => entry.streamId === STREAM);
  assert.equal(message.context_compacted.tokensAfter, 15612, 'legacy bubble path still records the compaction');
});

// Persisted shape: the compaction rides the assistant segment that was pending
// when it happened (chat-transcript-phase-collector.js buildAssistantMessageFields).
const TURN = 'turn-hb7';
const COMPACTED = { strategy: 'summary', tokensBefore: 28070, tokensAfter: 15612, phase: 'midturn' };
const MESSAGES = [
  { id: 'u1', role: 'user', content: 'go', turn_id: TURN },
  { id: 'assistant_s_seg0', role: 'assistant', content: 'Checking.', turn_id: TURN, parent_stream_id: 's' },
  { id: 'tool_use_c1', role: 'assistant', kind: 'tool_use', turn_id: TURN, tool_call: { call_id: 'c1', tool_name: 'read_file' } },
  {
    id: 'tool_result_c1', role: 'tool', kind: 'tool_result', turn_id: TURN,
    tool_result: { call_id: 'c1', tool_name: 'read_file', output_text: 'ok' },
  },
  {
    id: 'assistant_s_seg1', role: 'assistant', content: 'Done.', turn_id: TURN, parent_stream_id: 's',
    context_compacted: COMPACTED, context_compactions: [COMPACTED],
  },
];

function finalizeCanonicalTurn() {
  const collector = new CanonicalTurnEventCollector({ turnId: TURN, canonicalPrimary: true });
  collector.noteEvent({ kind: 'assistant_text_segment', turn_id: TURN, event_id: 'e-t0', primary_message_id: 'assistant_s_seg0', payload: { text: 'Checking.' } });
  collector.noteEvent({ kind: 'tool_use', turn_id: TURN, event_id: 'e-tu', tool_call_id: 'c1', primary_message_id: 'tool_use_c1', payload: { tool_name: 'read_file' } });
  collector.noteEvent({
    kind: 'tool_result', turn_id: TURN, event_id: 'e-tr', tool_call_id: 'c1', status: 'completed',
    primary_message_id: 'tool_use_c1', source_message_ids: ['tool_use_c1', 'tool_result_c1'],
    payload: { tool_name: 'read_file', output_text: 'ok' },
  });
  collector.noteEvent({ kind: 'assistant_text_segment', turn_id: TURN, event_id: 'e-t1', primary_message_id: 'assistant_s_seg1', payload: { text: 'Done.' } });
  // The store stamps event_seq in append order (session-turn-events.js).
  return collector.buildFinalizedTurnEvents(TURN, MESSAGES).map((event, index) => ({ ...event, event_seq: index + 1 }));
}

function eventLabel(event) {
  return event.kind === 'system_notice' ? `system_notice/${event.payload.subkind}` : event.kind;
}

test('reload: the persisted notice rehydrates before its own segment, not at the turn top', () => {
  const persisted = finalizeCanonicalTurn();
  assert.equal(persisted.filter((event) => event.kind === 'system_notice').length, 1);
  const tree = projectTurnTree({ messages: MESSAGES, turn_events: persisted, turn_event_log_version: 4 });
  const labels = tree.turns.find((turn) => turn.turn_id === TURN).events.map(eventLabel);
  assert.deepEqual(labels, [
    'user_prompt',
    'assistant_text_segment',
    'tool_use',
    'tool_result',
    'system_notice/context_compacted',
    'assistant_text_segment',
  ]);
});

test('reconcile: live provisional rows fold onto the hydrated notice without a duplicate', () => {
  const state = createTurnReducerState({ deterministicRowId: true });
  let ordinal = 0;
  const apply = (payload, context = {}) => {
    const events = buildTurnEventFromStreamPayload(payload, {
      turn_id: TURN, ordinal, intra_message_order: ordinal, ...context,
    });
    ordinal += 1;
    applyTurnStreamEvent(state, events);
  };
  apply({ type: 'started', streamId: STREAM });
  apply({ type: 'delta', content: 'Checking.' }, { primary_assistant_message_id: 'assistant_s_seg0' });
  apply(compactedPayload({ contextCompacted: COMPACTED }), { primary_assistant_message_id: 'assistant_s_seg1' });
  const provisional = state.turns_by_id[TURN].rows;
  assert.equal(provisional.filter((row) => row.kind === 'system_notice').length, 1);

  const tree = projectTurnTree({ messages: MESSAGES, turn_events: finalizeCanonicalTurn(), turn_event_log_version: 4 });
  const hydrated = projectTurnRows(tree.turns.find((turn) => turn.turn_id === TURN).events, { deterministicRowId: true });
  const { finalRows } = reconcileTurnRows(provisional, hydrated, { deterministicRowId: true });
  const notices = finalRows.filter((row) => row.kind === 'system_notice' && row.payload.subkind === 'context_compacted');
  assert.equal(notices.length, 1, 'reconcile must keep exactly one compaction hairline');
  assert.equal(notices[0].primary_message_id, 'assistant_s_seg1');
});
