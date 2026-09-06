'use strict';

// Shared harness for the external-mode tool-loop tests. Extracted verbatim
// from tests/tool-loop.test.js to keep that file under the 1015-line ceiling.

function makeToolCallChunk({ id, name, argumentsText }) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              type: 'function',
              function: {
                name,
                arguments: argumentsText,
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

function makeFinishChunk(reason = 'stop') {
  return {
    choices: [
      {
        delta: {},
        finish_reason: reason,
      },
    ],
  };
}

function makeTextChunk(content) {
  return {
    choices: [
      {
        delta: { content },
        finish_reason: null,
      },
    ],
  };
}

function makeServiceHarness({
  responses,
  executeResult,
  getToolPolicy,
  registryTool,
}) {
  const requestBodies = [];
  const streamEvents = [];
  const serviceLogs = [];
  const shadowAppends = [];
  const shadowUpdates = [];
  const executeCalls = [];
  const getToolPolicyCalls = [];

  const toolExecutor = {
    registry: {
      getTool(name) {
        if (typeof registryTool === 'function') {
          return registryTool(name);
        }
        return {
          name,
          readOnly: true,
          summarize(input) {
            return `${name} ${input.file_path || ''}`.trim();
          },
        };
      },
    },
    getToolPolicy(toolName, input, context) {
      getToolPolicyCalls.push({ toolName, input, context });
      if (typeof getToolPolicy === 'function') {
        return getToolPolicy(toolName, input, context);
      }
      const policies = {
        Read: 'auto',
        Glob: 'auto',
        Grep: 'auto',
        Write: 'ask',
        Edit: 'ask',
        Bash: 'ask',
      };
      return policies[toolName] || 'ask';
    },
    _permissionStore: {
      getAllPolicies() {
        return {
          Read: 'auto',
          Glob: 'auto',
          Grep: 'auto',
          Write: 'ask',
          Edit: 'ask',
          Bash: 'ask',
        };
      },
    },
    async execute(call) {
      executeCalls.push(call);
      return executeResult || {
        callId: call.callId,
        toolName: call.toolName,
        content: 'mock tool output',
        summary: 'mock tool output',
        isError: false,
        approvalState: 'auto',
        durationMs: 12,
        metadata: {},
      };
    },
  };

  const service = {
    featureFlags: {},
    toolExecutor,
    shadowStore: {
      appendLocalMessage(sessionId, message, options) {
        shadowAppends.push({ sessionId, message, options });
      },
      updateMessage(sessionId, messageId, patch) {
        shadowUpdates.push({ sessionId, messageId, patch });
      },
    },
    emit(eventName, payload) {
      if (eventName === 'chat-stream') {
        streamEvents.push(payload);
      }
    },
    _emitServiceLog(level, event, details) {
      serviceLogs.push({ level, event, details });
    },
    async _streamChatCompletion(body, _controller, onPayload) {
      requestBodies.push(JSON.parse(JSON.stringify(body)));
      const response = responses[requestBodies.length - 1];
      if (!response) {
        throw new Error(`Unexpected stream call ${requestBodies.length}`);
      }
      for (const payload of response) {
        onPayload(payload);
      }
    },
  };

  return {
    service,
    requestBodies,
    streamEvents,
    serviceLogs,
    shadowAppends,
    shadowUpdates,
    executeCalls,
    getToolPolicyCalls,
  };
}

function makeLoopArgs(overrides = {}) {
  return {
    requestBody: {
      model: 'mock:model',
      messages: [{ role: 'user', content: 'Read the file.' }],
      tools: [{ type: 'function', function: { name: 'Read', parameters: {} } }],
    },
    controller: new AbortController(),
    eventBase: {
      sessionId: 'sess_1',
      streamId: 'stream_1',
    },
    streamId: 'stream_1',
    sessionId: 'sess_1',
    model: 'mock:model',
    interactiveTraceEnabled: false,
    normalizedPreferences: {
      plan_mode: false,
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    ...overrides,
  };
}
module.exports = {
  makeToolCallChunk,
  makeFinishChunk,
  makeTextChunk,
  makeServiceHarness,
  makeLoopArgs,
};
