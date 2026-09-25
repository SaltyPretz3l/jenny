'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { convertToolUseToProviderMessage } = require('../services/backend/chat-stream-reasoning');

// Gate C1 (F4): history replays a tool call's arguments to the model, so the
// replay must not hand back the redacted display preview when a model-facing
// copy exists.
test('tool use replay prefers model input JSON and preserves input JSON fallback', () => {
  const baseMessage = {
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call-replay',
      tool_name: 'list_dir',
      input_json: '{"path":"[redacted:path]\\\\sandbox"}',
    },
  };

  assert.equal(
    convertToolUseToProviderMessage({
      ...baseMessage,
      tool_call: {
        ...baseMessage.tool_call,
        model_input_json: '{"path":".\\\\sandbox"}',
      },
    }).tool_calls[0].function.arguments,
    '{"path":".\\\\sandbox"}'
  );
  assert.equal(
    convertToolUseToProviderMessage(baseMessage).tool_calls[0].function.arguments,
    '{"path":"[redacted:path]\\\\sandbox"}'
  );
});
