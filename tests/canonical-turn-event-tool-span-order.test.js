// A call's persisted events keep their canonical order even when the sidecar's own
// approval_requested is captured before Electron notes the call's tool_use (owner live
// check 2026-11-01: after a reload "Allowed once" drew above its tool row).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');
const { orderToolSpansCanonically } = require('../services/backend/canonical-turn-event-collector-normalize');

function toolEvent(kind, callId, extra = {}) {
  return {
    kind,
    turn_id: 'turn-1',
    event_id: `${kind}:${callId}`,
    tool_call_id: callId,
    status: 'completed',
    payload: { tool_name: 'run_command' },
    ...extra,
  };
}

test('finalized events put a call\'s tool_use before an approval captured first', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1', canonicalPrimary: true });
  collector.noteEvent(toolEvent('approval_requested', 'call-a'));
  collector.noteEvent(toolEvent('tool_use', 'call-a'));
  collector.noteEvent(toolEvent('approval_resolved', 'call-a'));
  collector.noteEvent(toolEvent('tool_result', 'call-a'));

  const kinds = collector.buildFinalizedTurnEvents('turn-1', [])
    .filter((event) => event.tool_call_id === 'call-a')
    .map((event) => event.kind);
  assert.deepEqual(kinds, ['tool_use', 'approval_requested', 'approval_resolved', 'tool_result']);
});

test('reordering stays inside a call\'s own slots', () => {
  const text = { kind: 'assistant_text_segment', event_id: 'text-1' };
  const events = [
    toolEvent('approval_requested', 'call-a'),
    text,
    toolEvent('tool_use', 'call-b'),
    toolEvent('tool_use', 'call-a'),
    toolEvent('tool_result', 'call-a'),
    toolEvent('approval_requested', 'call-b'),
  ];
  const out = orderToolSpansCanonically(events).map((event) => event.event_id);
  assert.deepEqual(out, [
    'tool_use:call-a',
    'text-1',
    'tool_use:call-b',
    'approval_requested:call-a',
    'tool_result:call-a',
    'approval_requested:call-b',
  ]);
  assert.equal(events[0].event_id, 'approval_requested:call-a', 'the input list is left untouched');
});

test('events without a call id or with unranked kinds keep their place', () => {
  const events = [
    { kind: 'approval_requested', event_id: 'no-call' },
    toolEvent('reasoning', 'call-a', { event_id: 'reasoning-a' }),
    toolEvent('tool_use', 'call-a'),
  ];
  assert.deepEqual(orderToolSpansCanonically(events).map((event) => event.event_id),
    ['no-call', 'reasoning-a', 'tool_use:call-a']);
  assert.deepEqual(orderToolSpansCanonically(null), []);
});
