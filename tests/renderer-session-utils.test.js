const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionManager } = require('../renderer/shell/renderer-session-utils');
const { createMultiStreamController } = require('../renderer/chat/renderer-multi-stream-utils');

function createState() {
  return {
    sessions: [{ id: 'session-local', title: 'Local' }],
    messagesBySession: new Map([['session-local', [{ id: 'message-1', role: 'assistant', content: 'hello' }]]]),
    sessionMessageAccessOrder: new Map([['session-local', 1]]),
    interactiveDraftsBySession: new Map(),
    queuedSendBySession: new Map([['session-local', { sessionId: 'session-local', prompt: 'queued', attachments: [] }]]),
    sendOutboxBySession: new Map([['session-local', [
      Object.freeze({ id: 'outbox-local', revision: 1, sessionId: 'session-local', prompt: 'queued', status: 'ready' }),
    ]]]),
    ui: {
      reasoningPhaseExpansionBySession: new Map([
        ['session-local', new Map([['assistant-local::think_local', false]])],
      ]),
      interactiveRecapExpandedBySession: new Map(),
      threadBranchesCollapsedBySession: new Map([
        ['session-local', new Set(['assistant-local'])],
      ]),
      chatSendLifecycleBySession: new Map(),
      composerV2: {
        draftsBySession: new Map([
          ['session-local', { sessionId: 'session-local', prompt: 'draft' }],
        ]),
        lifecycleBySession: new Map([['session-local', 'drafting']]),
        modeListeners: new Map([['session-local', new Set([function listener() {}])]]),
      },
    },
    currentSessionId: 'session-local',
    activeStreamSessionId: 'session-local',
    sendPreflight: {
      sessionId: 'session-local',
      optimisticSessionId: 'session-local',
      previousSessionId: 'session-local',
      pending: true,
      streamId: 'stream-local',
    },
    pendingToolApprovals: new Map(),
  };
}

function createManager(state, options = {}) {
  return createSessionManager({
    state,
    constants: {
      INTERACTIVE_SEQUENCE_IDLE: 'idle',
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: 'structured_active',
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback_requested',
      MAX_INTERACTIVE_ROUNDS: 4,
      MAX_INTERACTIVE_QUESTIONS: 4,
      INTERACTIVE_BATCH_ORPHAN_TIMEOUT_MS: options.interactiveBatchOrphanTimeoutMs,
    },
    callbacks: {
      normalizeChatMessage(message) { return message; },
      normalizeChatMessages(messages) { return messages; },
      isInteractiveOtherTrigger() { return false; },
      getActiveSession() { return null; },
      patchSessionSummary(sessionId, patch) {
        state.sessions = state.sessions.map((session) =>
          String(session?.id || '').trim() === String(sessionId || '').trim()
            ? { ...session, ...(patch || {}) }
            : session
        );
      },
      rekeyDismissedMemorySession() {},
      rekeySessionArtifacts() {},
      clearProjectionContextCacheForSession() {},
      rekeyProjectionContextCache(_sourceSessionId, targetSessionId) { return targetSessionId; },
      appendClientLog: options.appendClientLog || (() => {}),
      notifySessionMessagesReplaced() {},
    },
  });
}

function makeContinuationToken(overrides = {}) {
  return {
    token_id: 'token-renderer',
    session_id: 'session-local',
    session_incarnation: 'incarnation-renderer',
    batch_id: 'batch-renderer',
    prior_generation: 4,
    consumed: false,
    issued_at: '2026-07-13T10:00:00.000Z',
    ...overrides,
  };
}

test('session manager normalizes and preserves question-batch continuation metadata', () => {
  const manager = createManager(createState());
  const batch = {
    batch_id: 'batch-renderer',
    round_index: 2,
    questions: [{
      id: 'question-1',
      prompt: 'Pick one',
      options: [{ id: 'option-1', label: 'Option 1' }],
    }],
    continuation_token: makeContinuationToken({
      token_id: ' token-renderer ',
      issued_at: '2026-07-13T05:00:00-05:00',
    }),
  };

  const normalized = manager.normalizePendingQuestionBatch(batch);

  assert.deepEqual(normalized.continuation_token, makeContinuationToken());
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      manager.normalizePendingQuestionBatch({
        ...batch,
        continuation_token: makeContinuationToken({ consumed: 'false' }),
      }),
      'continuation_token'
    ),
    false
  );
});

test('session manager rekeys controller-backed stream and preflight ownership', () => {
  const previousController = global.rendererMultiStreamController;
  const state = createState();
  const multiStreamController = createMultiStreamController({
    getState: () => state,
    appendClientLog() {},
  });
  global.rendererMultiStreamController = multiStreamController;

  try {
    const manager = createManager(state);
    const controllerPreflight = {
      pending: true,
      sessionId: 'session-local',
      optimisticSessionId: 'session-local',
      previousSessionId: 'session-local',
      streamId: 'stream-local',
    };
    multiStreamController.registerStream('session-local', 'stream-local');
    multiStreamController.registerPreflight('session-local', controllerPreflight);

    const resolvedSessionId = manager.rekeySessionState('session-local', 'session-real');

    assert.equal(resolvedSessionId, 'session-real');
    assert.equal(multiStreamController.getSessionIdForStream('stream-local'), 'session-real');
    assert.equal(multiStreamController.isStreamCurrentForSession('session-local', 'other-stream'), true);
    assert.equal(multiStreamController.isStreamCurrentForSession('session-real', 'stream-local'), true);
    assert.equal(multiStreamController.getPreflight('session-local'), null);
    assert.equal(multiStreamController.getPreflight('session-real'), controllerPreflight);
    assert.equal(controllerPreflight.sessionId, 'session-real');
    assert.equal(controllerPreflight.optimisticSessionId, 'session-real');
    assert.equal(controllerPreflight.previousSessionId, 'session-real');
    assert.equal(state.ui.reasoningPhaseExpansionBySession.has('session-local'), false);
    assert.deepEqual(
      [...state.ui.reasoningPhaseExpansionBySession.get('session-real').entries()],
      [['assistant-local::think_local', false]]
    );
    assert.equal(state.ui.threadBranchesCollapsedBySession.has('session-local'), false);
    assert.deepEqual([...state.ui.threadBranchesCollapsedBySession.get('session-real')], ['assistant-local']);
    assert.equal(state.ui.composerV2.draftsBySession.has('session-local'), false);
    assert.equal(state.ui.composerV2.draftsBySession.get('session-real').sessionId, 'session-real');
    assert.equal(state.ui.composerV2.draftsBySession.get('session-real').prompt, 'draft');
    assert.equal(state.ui.composerV2.lifecycleBySession.has('session-local'), false);
    assert.equal(state.ui.composerV2.lifecycleBySession.get('session-real'), 'drafting');
    assert.equal(state.ui.composerV2.modeListeners.has('session-local'), false);
    assert.equal(state.ui.composerV2.modeListeners.get('session-real').size, 1);
    assert.equal(state.currentSessionId, 'session-real');
    assert.equal(state.activeStreamSessionId, 'session-real');
    assert.equal(state.sendOutboxBySession.has('session-local'), false);
    assert.equal(state.sendOutboxBySession.get('session-real')[0].sessionId, 'session-real');
  } finally {
    global.rendererMultiStreamController = previousController;
  }
});

test('session manager rekey preserves existing Composer V2 target state on collisions', () => {
  const state = createState();
  state.sessions.push({ id: 'session-real', title: 'Real' });
  const targetListener = function targetListener() {};
  state.ui.composerV2.draftsBySession.set('session-real', {
    sessionId: 'session-real',
    prompt: 'target draft',
  });
  state.ui.composerV2.lifecycleBySession.set('session-real', 'sending');
  state.ui.composerV2.modeListeners.set('session-real', new Set([targetListener]));
  state.ui.threadBranchesCollapsedBySession.set('session-real', new Set(['assistant-target']));
  const manager = createManager(state);

  const resolvedSessionId = manager.rekeySessionState('session-local', 'session-real');

  assert.equal(resolvedSessionId, 'session-real');
  assert.equal(state.ui.composerV2.draftsBySession.has('session-local'), false);
  assert.equal(state.ui.composerV2.draftsBySession.get('session-real').prompt, 'target draft');
  assert.equal(state.ui.composerV2.lifecycleBySession.has('session-local'), false);
  assert.equal(state.ui.composerV2.lifecycleBySession.get('session-real'), 'sending');
  assert.equal(state.ui.composerV2.modeListeners.has('session-local'), false);
  assert.equal(state.ui.composerV2.modeListeners.get('session-real').has(targetListener), true);
  assert.equal(state.ui.composerV2.modeListeners.get('session-real').size, 2);
  assert.deepEqual(
    [...state.ui.threadBranchesCollapsedBySession.get('session-real')].sort(),
    ['assistant-local', 'assistant-target']
  );
});

test('session manager rekey repairs counterfeit thread collapse maps without invoking them', () => {
  const state = createState();
  let invoked = false;
  state.ui.threadBranchesCollapsedBySession = {
    size: 1,
    get() { invoked = true; throw new Error('get must not run'); },
    set() { invoked = true; throw new Error('set must not run'); },
    has() { invoked = true; throw new Error('has must not run'); },
    delete() { invoked = true; throw new Error('delete must not run'); },
    clear() { invoked = true; throw new Error('clear must not run'); },
    forEach() { invoked = true; throw new Error('forEach must not run'); },
    [Symbol.iterator]() { invoked = true; throw new Error('iterator must not run'); },
  };
  const manager = createManager(state);

  manager.rekeySessionState('session-local', 'session-real');

  assert.equal(invoked, false);
  assert.equal(state.ui.threadBranchesCollapsedBySession instanceof Map, true);
  assert.equal(state.ui.threadBranchesCollapsedBySession.size, 0);
});

test('session manager removeSessionState clears controller ownership and discards pending preflight', () => {
  const previousController = global.rendererMultiStreamController;
  const state = createState();
  let clearedFailedPayloadSessionId = '';
  state.sendReceiptController = {
    clearFailedPayloads(sessionId) { clearedFailedPayloadSessionId = sessionId; },
  };
  const multiStreamController = createMultiStreamController({
    getState: () => state,
    appendClientLog() {},
  });
  global.rendererMultiStreamController = multiStreamController;

  try {
    const manager = createManager(state);
    const controllerPreflight = { pending: true, sessionId: 'session-local', streamId: '' };
    multiStreamController.registerStream('session-local', 'stream-local');
    multiStreamController.registerPreflight('session-local', controllerPreflight);

    manager.removeSessionState('session-local');

    assert.equal(multiStreamController.getStreamIdForSession('session-local'), null);
    assert.equal(multiStreamController.getPreflight('session-local'), null);
    assert.equal(controllerPreflight.discarded, true);
    assert.equal(state.ui.reasoningPhaseExpansionBySession.has('session-local'), false);
    assert.equal(state.ui.threadBranchesCollapsedBySession.has('session-local'), false);
    assert.equal(state.messagesBySession.has('session-local'), false);
    assert.equal(state.queuedSendBySession.has('session-local'), false);
    assert.equal(state.sendOutboxBySession.has('session-local'), false);
    assert.equal(state.ui.composerV2.draftsBySession.has('session-local'), false);
    assert.equal(state.ui.composerV2.lifecycleBySession.has('session-local'), false);
    assert.equal(state.ui.composerV2.modeListeners.has('session-local'), false);
    assert.equal(clearedFailedPayloadSessionId, 'session-local');
  } finally {
    global.rendererMultiStreamController = previousController;
  }
});

test('session teardown repairs counterfeit thread collapse maps without invoking them', () => {
  const state = createState();
  let invoked = false;
  state.ui.threadBranchesCollapsedBySession = {
    size: 1,
    delete() { invoked = true; throw new Error('delete must not run'); },
    get() { invoked = true; throw new Error('get must not run'); },
    set() { invoked = true; throw new Error('set must not run'); },
    has() { invoked = true; throw new Error('has must not run'); },
    clear() { invoked = true; throw new Error('clear must not run'); },
    forEach() { invoked = true; throw new Error('forEach must not run'); },
    [Symbol.iterator]() { invoked = true; throw new Error('iterator must not run'); },
  };
  const manager = createManager(state);

  manager.removeSessionState('session-local');

  assert.equal(invoked, false);
  assert.equal(state.ui.threadBranchesCollapsedBySession instanceof Map, true);
  assert.equal(state.ui.threadBranchesCollapsedBySession.size, 0);
});

test('session manager rekeys hydrated projection cache ownership with the session', () => {
  const state = createState();
  const rekeyCalls = [];
  const manager = createSessionManager({
    state,
    constants: {
      INTERACTIVE_SEQUENCE_IDLE: 'idle',
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: 'structured_active',
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback_requested',
      MAX_INTERACTIVE_ROUNDS: 4,
      MAX_INTERACTIVE_QUESTIONS: 4,
    },
    callbacks: {
      normalizeChatMessage(message) { return message; },
      normalizeChatMessages(messages) { return messages; },
      isInteractiveOtherTrigger() { return false; },
      getActiveSession() { return null; },
      patchSessionSummary() {},
      rekeyDismissedMemorySession() {},
      rekeySessionArtifacts() {},
      clearProjectionContextCacheForSession() {},
      rekeyProjectionContextCache(sourceSessionId, targetSessionId) {
        rekeyCalls.push([sourceSessionId, targetSessionId]);
        return targetSessionId;
      },
      notifySessionMessagesReplaced() {},
    },
  });

  manager.rekeySessionState('session-local', 'session-real');

  assert.deepEqual(rekeyCalls, [['session-local', 'session-real']]);
});

test('session manager removeSessionState clears hydrated projection cache ownership with the session', () => {
  const state = createState();
  const clearedSessionIds = [];
  const manager = createSessionManager({
    state,
    constants: {
      INTERACTIVE_SEQUENCE_IDLE: 'idle',
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: 'structured_active',
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback_requested',
      MAX_INTERACTIVE_ROUNDS: 4,
      MAX_INTERACTIVE_QUESTIONS: 4,
    },
    callbacks: {
      normalizeChatMessage(message) { return message; },
      normalizeChatMessages(messages) { return messages; },
      isInteractiveOtherTrigger() { return false; },
      getActiveSession() { return null; },
      patchSessionSummary() {},
      rekeyDismissedMemorySession() {},
      rekeySessionArtifacts() {},
      clearProjectionContextCacheForSession(sessionId) {
        clearedSessionIds.push(sessionId);
      },
      rekeyProjectionContextCache(_sourceSessionId, targetSessionId) { return targetSessionId; },
      notifySessionMessagesReplaced() {},
    },
  });

  manager.removeSessionState('session-local');

  assert.deepEqual(clearedSessionIds, ['session-local']);
});

test('session manager clears orphaned interactive batches after the timeout', async (t) => {
  const originalWindow = global.window;
  const preferenceWrites = [];
  global.window = {
    jennyShell: {
      sessions: {
        async setPreferences(sessionId, preferences) {
          preferenceWrites.push({ sessionId, preferences });
          return { id: sessionId, ...preferences };
        },
      },
    },
  };
  t.after(() => {
    global.window = originalWindow;
  });

  const logs = [];
  const state = createState();
  state.sessions = [{
    id: 'session-local',
    title: 'Local',
    conversation_mode: 'interactive',
    pending_question_batch: {
      batch_id: 'batch-old',
      round_index: 1,
      questions: [{
        id: 'question-1',
        prompt: 'Pick one',
        options: [{ id: 'option-1', label: 'Option 1' }],
      }],
    },
    interactive_sequence_state: 'structured_active',
    interactive_round_count: 1,
  }];
  state.interactiveDraftsBySession.set('session-local', {
    batchId: 'batch-old',
    lastTouchedAtMs: Date.now() - (31 * 60 * 1000),
    createdAtMs: Date.now() - (31 * 60 * 1000),
  });
  const manager = createManager(state, {
    appendClientLog(level, event, details) {
      logs.push({ level, event, details });
    },
  });

  const cleared = await manager.clearStalePendingQuestionBatch(' session-local ');

  assert.equal(cleared, true);
  assert.equal(state.sessions[0].pending_question_batch, null);
  assert.equal(state.sessions[0].interactive_sequence_state, 'idle');
  assert.equal(state.sessions[0].interactive_round_count, 0);
  assert.equal(state.interactiveDraftsBySession.has('session-local'), false);
  assert.equal(preferenceWrites.length, 1);
  assert.equal(preferenceWrites[0].preferences.pending_question_batch, null);
  assert.equal(logs[0].level, 'WARN');
  assert.equal(logs[0].event, 'interactive.batch_orphan_cleared');
});

test('session manager orphan cleanup keeps recovery state when preferences bridge is unavailable', async (t) => {
  const originalWindow = global.window;
  global.window = { jennyShell: { sessions: {} } };
  t.after(() => {
    global.window = originalWindow;
  });

  const logs = [];
  const state = createState();
  state.sessions = [{
    id: 'session-local',
    title: 'Local',
    conversation_mode: 'interactive',
    pending_question_batch: {
      batch_id: 'batch-old',
      round_index: 1,
      questions: [{
        id: 'question-1',
        prompt: 'Pick one',
        options: [{ id: 'option-1', label: 'Option 1' }],
      }],
    },
    interactive_sequence_state: 'structured_active',
    interactive_round_count: 1,
  }];
  state.interactiveDraftsBySession.set('session-local', {
    batchId: 'batch-old',
    lastTouchedAtMs: Date.now() - (31 * 60 * 1000),
    createdAtMs: Date.now() - (31 * 60 * 1000),
  });
  const manager = createManager(state, {
    appendClientLog(level, event, details) {
      logs.push({ level, event, details });
    },
  });

  const cleared = await manager.clearStalePendingQuestionBatch(' session-local ');

  assert.equal(cleared, false);
  assert.equal(state.sessions[0].pending_question_batch.batch_id, 'batch-old');
  assert.equal(state.interactiveDraftsBySession.has('session-local'), true);
  assert.deepEqual(logs.map((entry) => entry.event), ['interactive.batch_orphan_persist_failed']);
  assert.equal(logs[0].level, 'WARN');
  assert.equal(logs[0].details.sessionId, 'session-local');
  assert.equal(Object.prototype.hasOwnProperty.call(logs[0].details, 'pending_question_batch'), false);
});

test('session manager stale interactive cleanup keeps recovery state when preferences bridge is unavailable', async (t) => {
  const originalWindow = global.window;
  global.window = { jennyShell: { sessions: {} } };
  t.after(() => {
    global.window = originalWindow;
  });

  const logs = [];
  const state = createState();
  state.sessions = [{
    id: 'session-local',
    title: 'Local',
    conversation_mode: 'interactive',
    pending_question_batch: {
      batch_id: 'batch-old',
      round_index: 1,
      questions: [{
        id: 'question-1',
        prompt: 'Pick one',
        options: [{ id: 'option-1', label: 'Option 1' }],
      }],
    },
    interactive_sequence_state: 'fallback_requested',
    interactive_round_count: 1,
  }];
  const manager = createManager(state, {
    appendClientLog(level, event, details) {
      logs.push({ level, event, details });
    },
  });

  const cleared = await manager.clearStalePendingQuestionBatch(' session-local ');

  assert.equal(cleared, false);
  assert.equal(state.sessions[0].pending_question_batch.batch_id, 'batch-old');
  assert.deepEqual(logs.map((entry) => entry.event), ['interactive.batch_stale_persist_failed']);
  assert.equal(logs[0].level, 'WARN');
  assert.equal(logs[0].details.sessionId, 'session-local');
  assert.equal(Object.prototype.hasOwnProperty.call(logs[0].details, 'pending_question_batch'), false);
});

test('session manager shares one pending orphan cleanup persistence operation', async (t) => {
  const originalWindow = global.window;
  let resolveWrite;
  let writes = 0;
  global.window = { jennyShell: { sessions: {
    setPreferences(sessionId, preferences) {
      writes += 1;
      return new Promise((resolve) => { resolveWrite = () => resolve({ id: sessionId, ...preferences }); });
    },
  } } };
  t.after(() => { global.window = originalWindow; });
  const state = createState();
  state.sessions = [{
    id: 'session-local',
    title: 'Local',
    conversation_mode: 'interactive',
    pending_question_batch: {
      batch_id: 'batch-old',
      round_index: 1,
      questions: [{ id: 'q1', prompt: 'Pick', options: [{ id: 'o1', label: 'One' }] }],
    },
    interactive_sequence_state: 'structured_active',
    interactive_round_count: 1,
  }];
  state.interactiveDraftsBySession.set('session-local', {
    batchId: 'batch-old',
    lastTouchedAtMs: Date.now() - (31 * 60 * 1000),
    createdAtMs: Date.now() - (31 * 60 * 1000),
  });
  const manager = createManager(state);
  const first = manager.clearStalePendingQuestionBatch('session-local');
  const second = manager.clearStalePendingQuestionBatch('session-local');
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(writes, 1);
  resolveWrite();
  assert.equal(await first, true);
});

test('session manager disposal makes a late orphan cleanup result inert', async (t) => {
  const originalWindow = global.window;
  let resolveWrite;
  global.window = { jennyShell: { sessions: {
    setPreferences: () => new Promise((resolve) => { resolveWrite = resolve; }),
  } } };
  t.after(() => { global.window = originalWindow; });
  const state = createState();
  state.sessions = [{
    id: 'session-local',
    pending_question_batch: { batch_id: 'batch-old', round_index: 1, questions: [{ id: 'q1', prompt: 'Pick', options: [{ id: 'o1', label: 'One' }] }] },
    interactive_sequence_state: 'structured_active',
  }];
  state.interactiveDraftsBySession.set('session-local', {
    batchId: 'batch-old', lastTouchedAtMs: Date.now() - (31 * 60 * 1000), createdAtMs: Date.now() - (31 * 60 * 1000),
  });
  const manager = createManager(state);
  const pending = manager.clearStalePendingQuestionBatch('session-local');
  manager.dispose();
  resolveWrite({ id: 'session-local', pending_question_batch: null });
  assert.equal(await pending, false);
  assert.equal(state.sessions[0].pending_question_batch.batch_id, 'batch-old');
});

// Code-review pin (2026-07-10): the delete tombstone is OPT-IN. The bare
// teardown (the shape reconcileSessionCaches uses on a possibly-stale list
// verdict) must NOT tombstone — otherwise a live session a racing list
// momentarily omitted is hidden from every later correct list for the TTL.
// Only the confirmed-delete caller passes { tombstone: true }.
test('removeSessionState tombstones only when the caller confirms a delete', () => {
  const previousController = global.rendererMultiStreamController;
  const state = createState();
  global.rendererMultiStreamController = null;
  try {
    const manager = createManager(state);

    manager.removeSessionState('session-reconciled-away');
    assert.equal(
      state.recentlyDeletedSessionIds instanceof Map
        && state.recentlyDeletedSessionIds.has('session-reconciled-away'),
      false,
      'a bare teardown (cache reconcile) must not tombstone a possibly-live session'
    );

    manager.removeSessionState('session-hard-deleted', { tombstone: true });
    assert.equal(
      state.recentlyDeletedSessionIds.has('session-hard-deleted'),
      true,
      'the confirmed-delete path still writes the A2 tombstone'
    );
  } finally {
    global.rendererMultiStreamController = previousController;
  }
});
