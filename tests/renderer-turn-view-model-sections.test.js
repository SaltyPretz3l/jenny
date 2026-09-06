'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTurnViewModel } = require('../renderer/chat/renderer-turn-view-model');

function event(kind, sequence, payload, status) {
  return {
    event_id: `event-${sequence}`,
    turn_id: 'turn-approval-terminal',
    kind,
    tool_call_id: 'call-approval-terminal',
    primary_message_id: `message-${sequence}`,
    source_message_ids: [`message-${sequence}`],
    sort_key: [sequence, 0, 0],
    status,
    payload,
  };
}

test('error-shaped denied and cancelled results preserve approval terminal states', () => {
  for (const terminalState of ['denied', 'cancelled']) {
    const viewModel = buildTurnViewModel({
      turn_id: 'turn-approval-terminal',
      events: [
        event('tool_use', 1, {
          tool_name: 'write_file',
          input: {},
        }, 'pending_approval'),
        event('approval_resolved', 2, {
          approval_state: terminalState,
        }, terminalState),
        event('tool_result', 3, {
          tool_name: 'write_file',
          output_text: terminalState,
          is_error: true,
          error_code: 'CMP-TOOL-0001',
          approval_state: terminalState,
        }, terminalState),
      ],
    });
    const toolCall = viewModel.toolCalls[0];

    assert.equal(toolCall.state, terminalState);
    assert.equal(toolCall.rawTerminal, terminalState);
    assert.equal(toolCall.resultIsError, true);
    assert.equal(viewModel.phaseHint, terminalState);
  }
});
