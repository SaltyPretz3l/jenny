const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startManagedSidecarChatStream,
  waitForToolApproval,
} = require('../../services/backend/managed-sidecar-chat');
const { createManagedChatServiceStub } = require('../helpers/managed-sidecar-chat-lifecycle-helpers');

function findPendingApproval(pendingToolApprovals, { callId = '', streamId = '' } = {}) {
  for (const pending of pendingToolApprovals.values()) {
    if (
      (!callId || String(pending?.callId || '') === String(callId))
      && (!streamId || String(pending?.streamId || '') === String(streamId))
    ) {
      return pending;
    }
  }
  return null;
}

test('managed sidecar tool approvals remove abort listeners after resolution', async () => {
  const previousAddEventListener = AbortSignal.prototype.addEventListener;
  const previousRemoveEventListener = AbortSignal.prototype.removeEventListener;
  const listenerCounts = new WeakMap();

  AbortSignal.prototype.addEventListener = function addTrackedListener(type, listener, options) {
    if (type === 'abort') {
      listenerCounts.set(this, (listenerCounts.get(this) || 0) + 1);
    }
    return previousAddEventListener.call(this, type, listener, options);
  };
  AbortSignal.prototype.removeEventListener = function removeTrackedListener(type, listener, options) {
    if (type === 'abort') {
      listenerCounts.set(this, Math.max((listenerCounts.get(this) || 0) - 1, 0));
    }
    return previousRemoveEventListener.call(this, type, listener, options);
  };

  const service = {
    currentModel: 'mock-v1',
    pendingToolApprovals: new Map(),
    sessionStore: {
      appendMessage() {},
      updateMessage() {},
    },
    emit() {},
  };
  const controller = new AbortController();

  try {
    for (const [callId, approved] of [['call-approve', true], ['call-deny', false]]) {
      const promise = waitForToolApproval(
        service,
        'stream-1',
        'session-1',
        'request-1',
        {
          tool_name: 'write_file',
          tool_call_id: callId,
          tool_input: { path: `${callId}.txt` },
        },
        controller
      );
      const pending = findPendingApproval(service.pendingToolApprovals, {
        callId,
        streamId: 'stream-1',
      });
      assert.ok(pending);
      assert.equal(listenerCounts.get(controller.signal) || 0, 1);

      pending.resolve(approved, approved ? 'approved' : 'denied');
      assert.equal(await promise, approved);
      assert.equal(listenerCounts.get(controller.signal) || 0, 0);
    }
  } finally {
    AbortSignal.prototype.addEventListener = previousAddEventListener;
    AbortSignal.prototype.removeEventListener = previousRemoveEventListener;
    controller.abort();
  }
});

test('managed sidecar timeout during pending approval clears approval state once', async () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  let timeoutCallback = null;
  const sequence = [];
  const service = createManagedChatServiceStub();

  global.setTimeout = (fn) => {
    timeoutCallback = fn;
    return { unref() {} };
  };
  global.clearTimeout = () => {};
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      const approvalPromise = options.onApprovalRequest({
        tool_name: 'write_file',
        tool_call_id: 'call_timeout',
        tool_input: { path: 'notes.txt' },
      });
      sequence.push('approval_requested');
      return new Promise((_, reject) => {
        const rejectOnAbort = async () => {
          const approved = await approvalPromise;
          sequence.push(`approval_${approved}`);
          reject(options.signal?.reason || new Error('aborted'));
        };
        options.signal.addEventListener('abort', () => {
          void rejectOnAbort();
        }, { once: true });
        timeoutCallback();
      });
    },
  };

  try {
    const stream = await startManagedSidecarChatStream(service, {
      sessionId: 'session_approval_timeout',
      prompt: 'Need approval then timeout',
      visiblePrompt: 'Need approval then timeout',
      attachments: [],
      runtimePreferredModel: 'mock-v1',
      normalizedInteractiveResponse: null,
      normalizedPreferences: {
        preferred_model: 'mock-v1',
        reasoning_effort: 'default',
        conversation_mode: 'chat',
        pending_question_batch: null,
        interactive_sequence_state: 'idle',
        interactive_round_count: 0,
        plan_mode: false,
      },
    });

    const controller = service.activeStreams.get(stream.streamId);
    await controller._pendingPromise;

    assert.deepEqual(sequence, ['approval_requested', 'approval_false']);
    assert.equal(service.pendingToolApprovals.size, 0);
    const timeoutToolUse = service.emittedEvents.find(
      (entry) =>
        entry.eventName === 'chat-stream'
        && entry.payload?.type === 'tool_use'
        && entry.payload?.callId === 'call_timeout'
        && entry.payload?.status === 'timeout'
    );
    assert.ok(timeoutToolUse);
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
});

test('managed sidecar preserves preempted terminal metadata after approval resume', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      const approvalPromise = options.onApprovalRequest({
        tool_name: 'write_file',
        tool_call_id: 'call_plan_drift',
        tool_input: { path: 'notes.txt' },
      });
      const pending = findPendingApproval(service.pendingToolApprovals, {
        callId: 'call_plan_drift',
      });
      assert.ok(pending);
      pending.resolve(true, 'approved');
      const approved = await approvalPromise;
      assert.equal(approved, true);
      return {
        status: 'preempted',
        terminal_subcode: 'plan_drift',
      };
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_plan_drift',
    prompt: 'Need approval then drift',
    visiblePrompt: 'Need approval then drift',
    attachments: [],
    runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      pending_question_batch: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      plan_mode: false,
    },
  });

  const controller = service.activeStreams.get(stream.streamId);
  await controller._pendingPromise;

  const errorEvent = service.emittedEvents.find(
    (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'error'
  );
  assert.ok(errorEvent);
  assert.equal(errorEvent.payload.status, 'preempted');
  assert.equal(errorEvent.payload.terminal_subcode, 'plan_drift');
  assert.equal(errorEvent.payload.message, 'Turn settled with terminal status preempted.');
  assert.equal(service.pendingToolApprovals.size, 0);
});

