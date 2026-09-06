const test = require('node:test');
const assert = require('node:assert/strict');

const { createComposerV2FlowController } = require('../renderer/chat/renderer-composer-v2-flow');

const INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE = 'structured_active';

function createContinuationToken(batchId = 'batch-1') {
  return {
    token_id: 'token-composer',
    session_id: 'session-1',
    session_incarnation: 'incarnation-composer',
    batch_id: batchId,
    prior_generation: 5,
    consumed: false,
    issued_at: '2026-07-13T10:00:00.000Z',
  };
}

function createBatch(batchId = 'batch-1', continuationToken = null) {
  return {
    batch_id: batchId,
    round_index: 2,
    questions: [{
      id: 'question-1',
      prompt: 'Pick one',
      options: [{ id: 'option-1', label: 'Option 1' }],
    }],
    ...(continuationToken ? { continuation_token: continuationToken } : {}),
  };
}

function createFlowHarness(options = {}) {
  const batch = options.batch === undefined ? createBatch() : options.batch;
  const session = {
    id: 'session-1',
    conversation_mode: 'interactive',
    pending_question_batch: batch,
    interactive_sequence_state: INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
    interactive_round_count: Number(batch?.round_index || 0),
  };
  const state = {
    activeStreamId: options.activeStreamId || '',
    currentSessionId: 'session-1',
    sessions: [session],
    interactiveDraftsBySession: new Map(options.drafts || []),
  };
  const calls = {
    logs: [],
    patches: [],
    preferences: [],
    sends: [],
    statusNotices: [],
  };
  const sessionsBridge = options.omitSetPreferences ? {} : {
    async setPreferences(sessionId, preferences) {
      calls.preferences.push({ sessionId, preferences });
      return { id: sessionId, ...preferences };
    },
  };
  const controller = createComposerV2FlowController({
    INTERACTIVE_GUARDRAIL_PROMPT: '',
    INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback_requested',
    appendClientLog(level, event, details) {
      calls.logs.push({ level, event, details });
    },
    isInteractiveQuestionAnswered() { return true; },
    buildInteractiveAnswerPrompt() { return ''; },
    buildInteractiveSelectedAnswers() { return []; },
    chatInput: { value: '' },
    clearComposerStatusNotice() {},
    setComposerStatusNotice(message, options) {
      calls.statusNotices.push({ message, options });
    },
    composerInteractivePanel: null,
    ensureInteractiveDraft(nextBatch) {
      const normalized = nextBatch || batch;
      const existing = state.interactiveDraftsBySession.get('session-1');
      if (existing && existing.batchId === normalized.batch_id) {
        return existing;
      }
      const draft = {
        batchId: normalized.batch_id,
        selections: {},
        customModeByQuestionId: {},
        customTextByQuestionId: {},
        activeQuestionIndex: 0,
        skippedByQuestionId: {},
        createdAtMs: options.nowMs || 0,
        lastTouchedAtMs: options.nowMs || 0,
      };
      state.interactiveDraftsBySession.set('session-1', draft);
      return draft;
    },
    escapeSelectorValue(value) { return String(value || ''); },
    getInteractiveDraft(nextBatch) {
      const draft = state.interactiveDraftsBySession.get('session-1') || null;
      if (!draft || draft.batchId !== String(nextBatch?.batch_id || '')) {
        return draft;
      }
      return draft;
    },
    getInteractiveQuestionOptions(question) { return question.options || []; },
    getPendingQuestionBatch() { return batch; },
    isSendBusy() { return options.isSendBusy === true; },
    isInteractiveOtherTrigger() { return false; },
    normalizeConversationMode(value) { return value; },
    normalizePendingQuestionBatch(value) { return value || null; },
    patchSessionSummary(sessionId, patch) {
      calls.patches.push({ sessionId, patch });
      Object.assign(session, patch);
    },
    persistRuntimePreferences: async () => {},
    queueInteractiveComposerFocus() {},
    renderComposerInteractivePanel() {},
    startPromptSend: async (prompt, settings) => {
      calls.sends.push({ prompt, settings });
      return null;
    },
    state,
    windowRef: {
      jennyShell: {
        sessions: sessionsBridge,
      },
    },
    now: () => Number(options.nowMs || 0),
  });

  return { controller, state, calls, session };
}

function createPasteEvent(text) {
  return {
    defaultPrevented: false,
    clipboardData: text === null ? null : {
      getData(type) {
        return type === 'text/plain' ? text : '';
      },
    },
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

test('composer flow interactive selection ignores background scalar stream snapshots when current session is idle', () => {
  const draft = {
    selections: {},
    customModeByQuestionId: {},
    customTextByQuestionId: {},
    activeQuestionIndex: 0,
  };
  const batch = {
    batch_id: 'batch-1',
    questions: [{
      id: 'question-1',
      prompt: 'Pick one',
      options: [{ id: 'option-1', label: 'Option 1' }],
    }],
  };
  const controller = createComposerV2FlowController({
    INTERACTIVE_GUARDRAIL_PROMPT: '',
    INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback_requested',
    appendClientLog() {},
    isInteractiveQuestionAnswered() { return true; },
    buildInteractiveAnswerPrompt() { return ''; },
    buildInteractiveSelectedAnswers() { return []; },
    chatInput: { value: '' },
    clearComposerStatusNotice() {},
    composerInteractivePanel: null,
    ensureInteractiveDraft() { return draft; },
    escapeSelectorValue(value) { return String(value || ''); },
    getInteractiveDraft() { return draft; },
    getInteractiveQuestionOptions(question) { return question.options || []; },
    getPendingQuestionBatch() { return batch; },
    isSendBusy() { return false; },
    isInteractiveOtherTrigger() { return false; },
    normalizeConversationMode(value) { return value; },
    normalizePendingQuestionBatch(value) { return value; },
    patchSessionSummary() {},
    persistRuntimePreferences: async () => {},
    queueInteractiveComposerFocus() {},
    renderComposerInteractivePanel() {},
    startPromptSend: async () => null,
    state: {
      activeStreamId: 'background-stream',
      currentSessionId: 'session-1',
    },
    windowRef: { jennyShell: { sessions: { setPreferences: async () => {} } } },
  });

  controller.handleInteractiveOptionSelect('batch-1', 'question-1', 'option-1');

  assert.equal(draft.selections['question-1'], 'option-1');
});

test('composer responses carry canonical continuation metadata for answer, skip, and guardrail sends', async () => {
  const continuationToken = createContinuationToken();
  const batch = createBatch('batch-1', continuationToken);
  const harness = createFlowHarness({ batch });

  await harness.controller.handleInteractiveSubmit('batch-1');
  await harness.controller.handleInteractiveSkip('batch-1');
  await harness.controller.requestInteractiveGuardrailAnswer('session-1', batch);

  assert.equal(harness.calls.sends.length, 3);
  for (const send of harness.calls.sends) {
    assert.deepEqual(send.settings.interactiveResponse.continuation_token, continuationToken);
    assert.deepEqual(
      send.settings.interactiveResponse.batch_snapshot.continuation_token,
      continuationToken
    );
  }
});

test('composer paste guard allows ordinary text without warning', () => {
  const harness = createFlowHarness();
  const event = createPasteEvent('short paste');

  const result = harness.controller.handleComposerPaste(event);

  assert.deepEqual(result, { accepted: true, sizeBytes: 11, warned: false });
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(harness.calls.logs, []);
  assert.deepEqual(harness.calls.statusNotices, []);
});

test('composer paste guard warns for large text while allowing the paste', () => {
  const harness = createFlowHarness();
  const event = createPasteEvent('x'.repeat(200 * 1024));

  const result = harness.controller.handleComposerPaste(event);

  assert.equal(result.accepted, true);
  assert.equal(result.warned, true);
  assert.equal(event.defaultPrevented, false);
  assert.equal(harness.calls.logs.length, 1);
  assert.equal(harness.calls.logs[0].level, 'WARN');
  assert.equal(harness.calls.logs[0].event, 'composer.paste_large');
  assert.equal(harness.calls.logs[0].details.sizeBytes, 200 * 1024);
  assert.equal(Object.prototype.hasOwnProperty.call(harness.calls.logs[0].details, 'text'), false);
  assert.match(harness.calls.statusNotices[0].message, /large paste/i);
});

test('composer paste guard measures UTF-8 bytes for multibyte text', () => {
  const harness = createFlowHarness();
  const event = createPasteEvent('é'.repeat(60 * 1024));

  const result = harness.controller.handleComposerPaste(event);

  assert.equal(result.accepted, true);
  assert.equal(result.warned, true);
  assert.equal(result.sizeBytes, 120 * 1024);
  assert.equal(harness.calls.logs[0].details.sizeBytes, 120 * 1024);
  assert.equal(event.defaultPrevented, false);
});

test('composer paste guard rejects one megabyte or larger text without logging content', () => {
  const harness = createFlowHarness();
  const event = createPasteEvent('x'.repeat(1024 * 1024));

  const result = harness.controller.handleComposerPaste(event);

  assert.equal(result.accepted, false);
  assert.equal(event.defaultPrevented, true);
  assert.equal(harness.calls.logs.length, 1);
  assert.equal(harness.calls.logs[0].level, 'WARN');
  assert.equal(harness.calls.logs[0].event, 'composer.paste_rejected');
  assert.equal(harness.calls.logs[0].details.sizeBytes, 1024 * 1024);
  assert.equal(Object.prototype.hasOwnProperty.call(harness.calls.logs[0].details, 'text'), false);
  assert.match(harness.calls.statusNotices[0].message, /too large/i);
});

test('composer paste guard ignores malformed clipboard events', () => {
  const harness = createFlowHarness();
  const event = createPasteEvent(null);

  const result = harness.controller.handleComposerPaste(event);

  assert.deepEqual(result, { accepted: true, sizeBytes: 0, warned: false });
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(harness.calls.logs, []);
});
