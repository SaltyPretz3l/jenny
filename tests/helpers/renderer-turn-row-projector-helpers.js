const { normalizeChatMessages } = require('../../renderer/chat/chat-message-utils');
const { projectTurnTree } = require('../../renderer/chat/renderer-turn-tree-projector');
const { projectTurnRows, projectTurn } = require('../../renderer/chat/renderer-turn-row-projector');

function projectRows(messages, options) {
  const tree = projectTurnTree({ messages: normalizeChatMessages(messages) });
  return {
    turn: tree.turns[0],
    rows: projectTurnRows(tree.turns[0].events, options),
  };
}

function createTraceEvent(overrides = {}) {
  return {
    event_id: 'event-default',
    event_seq: 0,
    turn_id: 'turn_trace',
    kind: 'tool_use',
    primary_message_id: 'assistant_trace',
    source_message_ids: ['assistant_trace'],
    tool_call_id: 'call_trace',
    status: 'running',
    sort_key: [0, 0, 0],
    payload: {},
    ...overrides,
  };
}

module.exports = {
  createTraceEvent,
  projectRows,
  projectTurn,
  projectTurnRows,
};
