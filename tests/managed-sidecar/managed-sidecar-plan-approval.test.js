const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleToolNotification,
  waitForToolApproval,
} = require('../../services/backend/chat-stream-tool-handling');
const {
  CanonicalTurnEventCollector,
} = require('../../services/backend/canonical-turn-event-collector');
const { createManagedChatServiceStub } = require('../helpers/managed-sidecar-chat-lifecycle-helpers');

const UNRENDERABLE_PLAN_MESSAGE = 'The plan proposal was missing a title or steps, so it could not be '
  + 'shown for review. Resubmit exit_plan_mode with a non-empty title and at least one step.';
const DUPLICATE_PLAN_MESSAGE = 'A plan is already pending or approved for this turn. Continue with the approved '
  + 'plan, or ask the user before proposing a replacement.';

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

function createPlanHarness(t, { streamId, sessionId = `session-${streamId}` }) {
  const service = createManagedChatServiceStub();
  const preferencePatches = [];
  const controller = new AbortController();
  const turnEventCollector = new CanonicalTurnEventCollector({
    turnId: streamId,
    sessionId,
  });
  service.sessionStore.createSessionWithId(sessionId, { preferences: { plan_mode: true } });
  service.setSessionPreferences = async (patchedSessionId, preferences) => {
    preferencePatches.push({ sessionId: patchedSessionId, preferences });
    return service.sessionStore.setSessionPreferences(patchedSessionId, preferences);
  };
  t.after(() => controller.abort());
  return {
    controller,
    preferencePatches,
    service,
    sessionId,
    streamId,
    turnEventCollector,
  };
}

function requestPlanApproval(harness, { callId, input }) {
  return waitForToolApproval(
    harness.service,
    harness.streamId,
    harness.sessionId,
    `request-${harness.streamId}`,
    {
      tool_name: 'exit_plan_mode',
      tool_call_id: callId,
      tool_input: input,
    },
    harness.controller,
    harness.turnEventCollector
  );
}

function recordPlanToolResult(harness, { callId, decision, feedback = '', planModeCleared }) {
  return handleToolNotification(harness.service, {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: harness.service.currentModel,
    resolvedSessionId: harness.sessionId,
    streamId: harness.streamId,
    eventBase: {
      streamId: harness.streamId,
      sessionId: harness.sessionId,
      model: harness.service.currentModel,
    },
    turnEventCollector: harness.turnEventCollector,
  }, {
    method: 'tool.result',
    params: {
      tool_call_id: callId,
      tool_name: 'exit_plan_mode',
      tool_input: { title: ' Build ', steps: [' Write the file '] },
      success: true,
      output: decision === 'rejected' ? feedback : 'Plan approved.',
      metadata: {
        result_kind: 'plan_mode_transition',
        plan_mode_cleared: planModeCleared,
        plan_decision: decision,
        plan_feedback: feedback,
      },
    },
  });
}

function planMessages(service) {
  return service.sessionMessages.filter((message) => message.kind === 'plan_document');
}

function planEvents(turnEventCollector) {
  return turnEventCollector.capturedEvents.filter((event) => event.kind === 'plan_document');
}

for (const [decision, streamId, callId, expectedPlanId] of [
  ['approved', 'stream-approved', 'call-approved', 'plan_51244e0efcde156fcd3b'],
  ['approved_auto', 'stream-approved-auto', 'call-approved-auto', 'plan_1fc1d5de252fd67944a3'],
]) {
  test(`managed sidecar records ${decision} plan approval through tool.result`, async (t) => {
    const harness = createPlanHarness(t, { streamId });
    const approvalPromise = requestPlanApproval(harness, {
      callId,
      input: { title: ' Build ', steps: [' Write the file '] },
    });

    assert.equal(planMessages(harness.service).length, 1);
    assert.deepEqual(planMessages(harness.service)[0].plan_document, {
      plan_id: expectedPlanId,
      tool_call_id: callId,
      state: 'pending',
      title: 'Build',
      summary: '',
      steps: ['Write the file'],
      notes: '',
      verification: '',
      feedback: '',
      files_read: [],
      parent_stream_id: streamId,
      plan_edited: false,
    });
    assert.equal(planEvents(harness.turnEventCollector).length, 1);
    assert.deepEqual(planEvents(harness.turnEventCollector)[0].payload, {
      plan_id: expectedPlanId,
      tool_call_id: callId,
      transition: 'pending',
      title: 'Build',
      summary: '',
      steps: ['Write the file'],
      notes: '',
      verification: '',
      feedback: '',
      files_read: [],
      plan_edited: false,
      render_collapsed: false,
    });
    const approvalEvent = harness.service.emittedEvents.find(
      (event) => event.payload?.type === 'tool_approval_needed'
    );
    assert.deepEqual(approvalEvent.payload.planDocument, {
      plan_id: expectedPlanId,
      tool_call_id: callId,
      approval_id: `approval_${harness.sessionId}_${streamId}_${callId}`,
      state: 'pending',
      title: 'Build',
      summary: '',
      steps: ['Write the file'],
      notes: '',
      verification: '',
      files_read: [],
      parent_stream_id: streamId,
    });

    const pending = findPendingApproval(harness.service.pendingToolApprovals, { callId, streamId });
    assert.ok(pending);
    pending.resolve(true, decision);
    assert.deepEqual(await approvalPromise, {
      approved: true,
      decision,
      feedback: '',
    });

    assert.equal(recordPlanToolResult(harness, {
      callId,
      decision,
      planModeCleared: true,
    }), true);
    assert.equal(planMessages(harness.service)[0].plan_document.state, decision);
    assert.equal(planMessages(harness.service)[0].plan_document.feedback, '');
    assert.equal(planEvents(harness.turnEventCollector).length, 2);
    assert.equal(planEvents(harness.turnEventCollector)[1].status, decision);
    assert.equal(planEvents(harness.turnEventCollector)[1].payload.transition, decision);
    assert.equal(planEvents(harness.turnEventCollector)[1].payload.render_collapsed, true);
    const toolResult = harness.service.sessionMessages.find(
      (message) => message.kind === 'tool_result' && message.tool_result?.call_id === callId
    );
    assert.equal(toolResult.tool_result.metadata.plan_decision, decision);
    assert.equal(toolResult.tool_result.metadata.plan_mode_cleared, true);
  });
}

test('managed sidecar rejection executes exit_plan_mode and retains bounded feedback', async (t) => {
  const harness = createPlanHarness(t, { streamId: 'stream-rejected' });
  const callId = 'call-rejected';
  const feedback = 'r'.repeat(900);
  const expectedFeedback = 'r'.repeat(800);
  const approvalPromise = requestPlanApproval(harness, {
    callId,
    input: { title: 'Revise', steps: ['Try again'] },
  });
  const pending = findPendingApproval(harness.service.pendingToolApprovals, {
    callId,
    streamId: harness.streamId,
  });

  assert.ok(pending);
  pending.resolve(true, 'rejected', feedback);
  assert.deepEqual(await approvalPromise, {
    approved: true,
    decision: 'rejected',
    feedback: expectedFeedback,
  });
  assert.equal(recordPlanToolResult(harness, {
    callId,
    decision: 'rejected',
    feedback,
    planModeCleared: false,
  }), true);

  assert.equal(planMessages(harness.service)[0].plan_document.state, 'rejected');
  assert.equal(planMessages(harness.service)[0].plan_document.feedback, expectedFeedback);
  assert.equal(planEvents(harness.turnEventCollector)[1].status, 'rejected');
  assert.equal(planEvents(harness.turnEventCollector)[1].payload.transition, 'rejected');
  assert.equal(planEvents(harness.turnEventCollector)[1].payload.feedback, expectedFeedback);
  assert.equal(planEvents(harness.turnEventCollector)[1].payload.render_collapsed, true);
  assert.deepEqual(harness.preferencePatches, []);
  assert.equal(harness.service.sessionStore.getSession(harness.sessionId).plan_mode, true);
});

test('managed sidecar auto-denies an unrenderable plan without prompting', async (t) => {
  const harness = createPlanHarness(t, { streamId: 'stream-unrenderable' });
  const result = await requestPlanApproval(harness, {
    callId: 'call-unrenderable',
    input: { steps: [] },
  });

  assert.equal(result, false);
  assert.equal(harness.service.pendingToolApprovals.size, 0);
  assert.equal(planMessages(harness.service).length, 0);
  assert.equal(planEvents(harness.turnEventCollector).length, 0);
  assert.equal(harness.service.emittedEvents.some(
    (event) => event.payload?.type === 'tool_approval_needed'
  ), false);
  const persisted = harness.service.sessionMessages.find(
    (message) => message.kind === 'tool_result'
  );
  assert.equal(persisted.tool_result.approval_state, 'denied');
  assert.equal(persisted.tool_result.output_text, UNRENDERABLE_PLAN_MESSAGE);
});

test('managed sidecar user denial abandons a renderable plan', async (t) => {
  const harness = createPlanHarness(t, { streamId: 'stream-denied' });
  const callId = 'call-denied';
  const approvalPromise = requestPlanApproval(harness, {
    callId,
    input: { title: 'Denied plan', steps: ['Do not run'] },
  });
  const pending = findPendingApproval(harness.service.pendingToolApprovals, {
    callId,
    streamId: harness.streamId,
  });

  assert.ok(pending);
  pending.resolve(false, 'denied');
  assert.equal(await approvalPromise, false);
  assert.equal(planMessages(harness.service)[0].plan_document.state, 'abandoned');
  assert.equal(planEvents(harness.turnEventCollector)[1].status, 'abandoned');
  assert.equal(planEvents(harness.turnEventCollector)[1].payload.transition, 'abandoned');
  assert.equal(planEvents(harness.turnEventCollector)[1].payload.render_collapsed, true);
});

for (const previousState of ['pending', 'approved']) {
  test(`managed sidecar denies a duplicate proposal after a ${previousState} plan`, async (t) => {
    const harness = createPlanHarness(t, { streamId: `stream-duplicate-${previousState}` });
    const firstCallId = 'call-first';
    const firstPromise = requestPlanApproval(harness, {
      callId: firstCallId,
      input: { title: 'First plan', steps: ['First step'] },
    });
    const firstPending = findPendingApproval(harness.service.pendingToolApprovals, {
      callId: firstCallId,
      streamId: harness.streamId,
    });
    assert.ok(firstPending);

    if (previousState === 'approved') {
      firstPending.resolve(true, 'approved');
      assert.deepEqual(await firstPromise, {
        approved: true,
        decision: 'approved',
        feedback: '',
      });
      assert.equal(recordPlanToolResult(harness, {
        callId: firstCallId,
        decision: 'approved',
        planModeCleared: true,
      }), true);
      assert.equal(planMessages(harness.service)[0].plan_document.state, 'approved');
    }

    // C5: the duplicate case gets its own accurate deny copy (not the unrenderable text)
    const duplicateResult = await requestPlanApproval(harness, {
      callId: 'call-duplicate',
      input: { title: 'Second plan', steps: ['Second step'] },
    });
    assert.equal(duplicateResult, false);
    assert.equal(findPendingApproval(harness.service.pendingToolApprovals, {
      callId: 'call-duplicate',
      streamId: harness.streamId,
    }), null);
    const duplicateMessage = harness.service.sessionMessages.find(
      (message) => message.kind === 'tool_result'
        && message.tool_result?.call_id === 'call-duplicate'
    );
    assert.equal(duplicateMessage.tool_result.approval_state, 'denied');
    assert.equal(duplicateMessage.tool_result.output_text, DUPLICATE_PLAN_MESSAGE);

    if (previousState === 'pending') {
      firstPending.resolve(false, 'denied');
      assert.equal(await firstPromise, false);
    }
  });
}
