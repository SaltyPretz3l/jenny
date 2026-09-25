'use strict';

const { executeRuntimeChildTool } = require('../../session-runtime/child-capabilities');

module.exports = ['session_spawn', 'session_wait', 'session_result'].map(name => ({
  name, description: 'Operate on a child task within the current approved run.',
  summarize() { return name === 'session_spawn' ? 'Start child task' : 'Read child task'; },
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute(input, context) {
    return executeRuntimeChildTool(context.executionAuthority, name, input, context.callId);
  },
}));
