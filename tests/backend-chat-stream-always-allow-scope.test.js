'use strict';

// F15: "Always allow" on a path-bearing call persists a tool + path_prefix
// rule instead of flipping the whole tool. Lives beside, not inside,
// backend-service-lifecycle.test.js, which sits at the file-size cap.

const test = require('node:test');
const assert = require('node:assert/strict');

const { approveToolCall } = require('../services/backend/backend-chat-stream');
test('backend always allow grants the pending tool input and logs path scope', () => {
  const toolInput = { path: 'docs/a.md', content: 'hello' };
  const grants = [];
  const logs = [];
  const service = {
    toolPermissionStore: {
      grantAlwaysAllow(toolName, input) {
        grants.push({ toolName, input });
        return {
          scope: 'path',
          toolName: 'write_file',
          pathPrefix: 'docs/a.md',
          ruleId: 'always-allow:write_file:abc123',
        };
      },
    },
    pendingToolApprovals: new Map([[
      'approval-scoped-write',
      {
        approvalId: 'approval-scoped-write',
        callId: 'call-scoped-write',
        streamId: 'stream-scoped-write',
        toolName: 'Write',
        toolInput,
        resolve() {},
      },
    ]]),
    _emitServiceLog(level, event, fields) {
      logs.push({ level, event, fields });
    },
  };

  assert.equal(approveToolCall(service, 'approval-scoped-write', { alwaysAllow: true }), true);
  assert.deepEqual(grants, [{ toolName: 'Write', input: toolInput }]);
  assert.deepEqual(logs, [{
    level: 'INFO',
    event: 'tool_permission.always_allow_scoped',
    fields: {
      toolName: 'Write',
      pathPrefix: 'docs/a.md',
      ruleId: 'always-allow:write_file:abc123',
    },
  }]);
});
