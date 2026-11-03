'use strict';

// A chat reopened mid-approval rebuilds its pending approvals from the active-turn snapshot; the
// exact command presentation must survive, or the card can only Deny (2026-11-01 live check).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionLifecycleController } = require('../renderer/shell/renderer-session-lifecycle-utils');
const { resolveApprovalCardState } = require('../renderer/chat/renderer-approval-block');

test('a reopened chat keeps the exact command presentation, so its approval card can still Allow', async () => {
  const exactApproval = { schema_version: 1, fields: [{ name: 'command', text: 'npm test' }], bytes: 15, sha256: 'b'.repeat(64) };
  const state = {
    currentSessionId: 'session-old',
    sessionMessageAccessOrder: new Map(),
    pendingToolApprovals: new Map([['approval-1', { approvalId: 'approval-1', callId: 'call-1',
      sessionId: 'session-new', streamId: 'stream-1', toolName: 'run_command', exactApproval }]]),
    messagesBySession: new Map([['session-new', [{
      id: 'm-1', kind: 'tool_use', role: 'assistant',
      tool_call: { call_id: 'call-1', tool_name: 'run_command', status: 'pending_approval', input: { command: 'npm test' } },
    }]]]),
  };
  const controller = createSessionLifecycleController({
    state,
    sessionCacheController: { async evictColdSessionCaches() {} },
    thinkingController: { resumeAutoScroll() {} },
    jennyShell: {
      sessions: { async getMessages() { return { data: [], turn_events: [] }; } },
      chat: { async getActiveTurnState() {
        return { stream_id: 'stream-1', pending_approval: {
          call_id: 'call-1', approval_id: 'approval-1', tool_name: 'run_command', exact_approval: exactApproval,
        } };
      } },
    },
    callbacks: { appendClientLog() {} },
  });

  await controller.openSession('session-new', { silent: true });

  assert.deepEqual(state.pendingToolApprovals.get('approval-1').exactApproval, exactApproval);
  assert.deepEqual(resolveApprovalCardState(state, { callId: 'call-1' }), { state: 'live', exactApproval });
});
