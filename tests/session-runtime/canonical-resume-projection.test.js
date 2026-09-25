'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CanonicalTurnEventCollector } = require('../../services/backend/canonical-turn-event-collector');

test('resumed settlement does not synthesize another durably captured tool request', () => {
  for (const priorTurn of ['turn-1', 'another-turn']) {
    const saved = [{ turn_id: priorTurn, kind: 'tool_use',
      tool_call_id: 'call-resume', payload: { canonical_event_type: 'tool_call_requested' } }];
    const store = { getSessionTurnEvents: () => saved };
    const collector = new CanonicalTurnEventCollector({ store, sessionId: 'session',
      turnId: 'turn-1', attemptId: 'stream-resume', canonicalPrimary: true });
    collector.noteEvent({ event_id: 'executing', turn_id: 'turn-1', kind: 'tool_executing', tool_call_id: 'call-resume',
      primary_message_id: 'tool_use_stream-resume_call-resume',
      payload: { tool_name: 'read_file', canonical_event_type: 'tool_execution_started' } });
    const events = collector.buildFinalizedTurnEvents('turn-1', [{
      id: 'tool_use_stream-resume_call-resume', role: 'assistant', kind: 'tool_use',
      turn_id: 'turn-1', parent_stream_id: 'stream-resume', content: '',
      tool_call: { call_id: 'call-resume', tool_name: 'read_file', input: { path: 'sentinel.txt' }, status: 'completed' },
    }]);
    assert.equal(events.filter(event => event.kind === 'tool_use').length, priorTurn === 'turn-1' ? 0 : 1);
    assert.equal(events.filter(event => event.kind === 'tool_executing').length, 1);
    assert.equal(store.getSessionTurnEvents('session').length, 1, 'saved history stays unchanged');
  }
});
