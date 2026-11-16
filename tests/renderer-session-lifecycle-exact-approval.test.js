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

// Switching back to a chat whose live stream waits on
// ask_user must not replay 'started' into that stream (it resets the stream's
// segment and phase state); a reload, where no stream is live here, still does.
test('switching back to a chat whose live stream waits on a question replays nothing into it', async () => {
  const { createMultiStreamController } = require('../renderer/chat/renderer-multi-stream-utils');
  const run = async (alreadyLive) => {
    const state = { currentSessionId: 'other', sessionMessageAccessOrder: new Map(),
      pendingToolApprovals: new Map(), messagesBySession: new Map() };
    const multiStream = createMultiStreamController({ getState: () => state });
    if (alreadyLive) multiStream.registerStream('asked', 'live');
    const replays = [];
    const controller = createSessionLifecycleController({ state,
      getMultiStreamController: () => multiStream,
      sessionCacheController: { async evictColdSessionCaches() {} },
      thinkingController: { resumeAutoScroll() {} },
      jennyShell: {
        sessions: { async getMessages() { return { data: [], turn_events: [] }; } },
        chat: { async getActiveTurnState() { return { stream_id: 'live', turn_id: 'live', state: 'streaming',
          pending_user_questions: [{ question_id: 'q1', question_ref: 'ref1', call_id: 'call_q', tool_name: 'ask_user',
            questions: [{ id: 'season', prompt: 'Which season?' }] }] }; } },
      },
      callbacks: {
        setSessionMessages: (id, messages) => state.messagesBySession.set(id, messages),
        rehydrateLiveTurnState: (id, options) => { if (options?.pendingPayloads) replays.push(options.pendingPayloads.map((p) => p.type)); },
      },
    });
    await controller.openSession('asked', { silent: true });
    return { replays, streamId: multiStream.getStreamIdForSession('asked') };
  };
  const switchedBack = await run(true);
  assert.deepEqual(switchedBack.replays, [], 'the live stream keeps its own state');
  assert.equal(switchedBack.streamId, 'live');
  const reloaded = await run(false);
  assert.deepEqual(reloaded.replays, [['started', 'user_questions_requested']], 'a reload still brings the card back');
  assert.equal(reloaded.streamId, 'live');
});
