'use strict';

const { executeRuntimeChildTool } = require('../../session-runtime/child-capabilities');
const { manifestSchema } = require('./tool-result');

module.exports = ['session_spawn', 'session_wait', 'session_result'].map(name => ({
  name, ...manifestSchema(name),
  summarize() { return name === 'session_spawn' ? 'Start child task' : 'Read child task'; },
  async execute(input, context) {
    return executeRuntimeChildTool(context.executionAuthority, name, input, context.callId);
  },
}));
