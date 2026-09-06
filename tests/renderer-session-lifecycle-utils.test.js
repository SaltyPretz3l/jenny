const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionLifecycleController } = require('../renderer/shell/renderer-session-lifecycle-utils');

test('opening a different session clears one-send active-file consent', async () => {
  const state = {
    currentSessionId: 'session-old',
    sessionMessageAccessOrder: new Map(),
    pendingToolApprovals: new Map(),
    messagesBySession: new Map(),
  };
  let clears = 0;
  const controller = createSessionLifecycleController({
    state,
    sessionCacheController: { async evictColdSessionCaches() {} },
    thinkingController: { resumeAutoScroll() {} },
    jennyShell: {
      sessions: { async getMessages() { return { data: [], turn_events: [] }; } },
      chat: { async getActiveTurnState() { return null; } },
    },
    callbacks: {
      clearActiveFileContext() { clears += 1; },
    },
  });

  await controller.openSession('session-new', { silent: true });

  assert.equal(state.currentSessionId, 'session-new');
  assert.equal(clears, 1);
});

test('active-turn transport failure preserves an existing approval and emits a bounded diagnostic', async () => {
  const approval = { approvalId: 'approval-1', callId: 'call-1', sessionId: 'session-new',
    streamId: 'stream-1', toolName: 'write_file', input: { path: 'notes.md' } };
  const logs = [];
  const state = {
    currentSessionId: 'session-old',
    sessionMessageAccessOrder: new Map(),
    pendingToolApprovals: new Map([['approval-1', approval]]),
    messagesBySession: new Map(),
  };
  const controller = createSessionLifecycleController({
    state,
    sessionCacheController: { async evictColdSessionCaches() {} },
    thinkingController: { resumeAutoScroll() {} },
    jennyShell: {
      sessions: { async getMessages() { return { data: [], turn_events: [] }; } },
      chat: { async getActiveTurnState() {
        throw new Error('IPC failed at C:\\Users\\alice\\private\\state.json');
      } },
    },
    callbacks: { appendClientLog: (...entry) => logs.push(entry) },
  });

  await controller.openSession('session-new', { silent: true });

  assert.equal(state.pendingToolApprovals.get('approval-1'), approval);
  assert.deepEqual(logs, [['WARN', 'chat.active_turn_rehydrate_failed', {
    sessionId: 'session-new', reason: 'transport_failed',
  }]]);
  assert.doesNotMatch(JSON.stringify(logs), /Users\\alice|state\.json|IPC failed/);
});

test('openSession honors an explicit outgoing session after workspace state publishes', async (t) => {
  const previousController = globalThis.rendererComposerSessionStateController;
  const composerCalls = { capture: [], restore: [] };
  globalThis.rendererComposerSessionStateController = {
    captureActive(sessionId, reason) {
      composerCalls.capture.push({ sessionId, reason });
    },
    restoreForSession(sessionId) {
      composerCalls.restore.push(sessionId);
    },
  };
  t.after(() => {
    globalThis.rendererComposerSessionStateController = previousController;
  });
  const state = {
    currentSessionId: 'session-new',
    sessionMessageAccessOrder: new Map(),
    pendingToolApprovals: new Map(),
    messagesBySession: new Map(),
  };
  const controller = createSessionLifecycleController({
    state,
    sessionCacheController: { async evictColdSessionCaches() {} },
    thinkingController: { resumeAutoScroll() {} },
    jennyShell: {
      sessions: { async getMessages() { return { data: [], turn_events: [] }; } },
      chat: { async getActiveTurnState() { return null; } },
    },
  });

  await controller.openSession('session-new', {
    silent: true,
    outgoingSessionId: 'session-old',
  });

  assert.deepEqual(composerCalls.capture, [{ sessionId: 'session-old', reason: 'session_switch' }]);
  assert.deepEqual(composerCalls.restore, ['session-new']);
});

test('openSession prepares the outgoing chat anchor before publishing the incoming session', async () => {
  const state = {
    currentSessionId: 'session-new',
    sessionMessageAccessOrder: new Map(),
    pendingToolApprovals: new Map(),
    messagesBySession: new Map(),
  };
  const observations = [];
  const controller = createSessionLifecycleController({
    state,
    sessionCacheController: { async evictColdSessionCaches() {} },
    thinkingController: { resumeAutoScroll() {} },
    jennyShell: {
      sessions: { async getMessages() { return { data: [], turn_events: [] }; } },
      chat: { async getActiveTurnState() { return null; } },
    },
    callbacks: {
      prepareChatDockSessionTransition(outgoingSessionId, incomingSessionId) {
        observations.push({ outgoingSessionId, incomingSessionId, currentSessionId: state.currentSessionId });
      },
    },
  });

  await controller.openSession('session-next', {
    silent: true,
    outgoingSessionId: 'session-old',
  });

  assert.deepEqual(observations, [{
    outgoingSessionId: 'session-old',
    incomingSessionId: 'session-next',
    currentSessionId: 'session-new',
  }]);
});

test('openSession fails closed when the outgoing plugin workspace cannot settle', async (t) => {
  const previousPluginSessions = globalThis.rendererPluginSessions;
  t.after(() => {
    if (previousPluginSessions === undefined) delete globalThis.rendererPluginSessions;
    else globalThis.rendererPluginSessions = previousPluginSessions;
  });
  const state = {
    currentSessionId: 'session-old',
    sessions: [{ id: 'session-old', session_type: 'plugin' },
      { id: 'session-new', session_type: 'plugin' }],
    sessionMessageAccessOrder: new Map(),
    pendingToolApprovals: new Map(),
    messagesBySession: new Map(),
  };
  let openCalls = 0;
  globalThis.rendererPluginSessions = {
    instance: {
      guardLeaveSession: async () => false,
      openSessionView: async () => { openCalls += 1; return { ok: true }; },
    },
  };
  const controller = createSessionLifecycleController({
    state,
    sessionCacheController: { async evictColdSessionCaches() {} },
    thinkingController: { resumeAutoScroll() {} },
    jennyShell: {
      sessions: { async getMessages() { return { data: [], turn_events: [] }; } },
      chat: { async getActiveTurnState() { return null; } },
    },
    callbacks: {
      getActiveSession: () => state.sessions.find((session) => session.id === state.currentSessionId),
    },
  });

  assert.equal(await controller.openSession('session-new', { outgoingSessionId: 'session-old' }), false);
  assert.equal(openCalls, 0, 'the incoming workspace is not opened after refusal');
  assert.equal(state.currentSessionId, 'session-old');

  globalThis.rendererPluginSessions.instance.guardLeaveSession = async () => true;
  assert.equal(await controller.openSession('session-new', { outgoingSessionId: 'session-old' }), true);
  assert.equal(openCalls, 1);
  assert.equal(state.currentSessionId, 'session-new');
});

test('reconcileSessionCaches routes stale sessions through canonical removeSessionState cleanup', async () => {
  const state = {
    sessions: [{ id: 'session-keep', title: 'Keep' }],
    currentSessionId: 'session-stale',
    messagesBySession: new Map([['session-stale', []], ['session-keep', []]]),
    turnEventsBySession: new Map([['session-stale', { turnEvents: [] }]]),
    interactiveDraftsBySession: new Map([['session-stale', { batchId: 'batch-stale' }]]),
    sessionMessageAccessOrder: new Map([['session-stale', 1]]),
    pendingToolApprovals: new Map(),
  };
  const calls = {
    clearStream: [],
    removed: [],
    evicted: 0,
    pruned: [],
  };
  const controller = createSessionLifecycleController({
    state,
    sessionCacheController: {
      async clearSessionStreamState(sessionId) {
        calls.clearStream.push(sessionId);
      },
      async evictColdSessionCaches() {},
    },
    jennyShell: {},
    callbacks: {
      removeSessionState(sessionId) {
        calls.removed.push(sessionId);
        state.messagesBySession.delete(sessionId);
        state.turnEventsBySession.delete(sessionId);
        state.interactiveDraftsBySession.delete(sessionId);
        state.sessionMessageAccessOrder.delete(sessionId);
      },
      clearDismissedMemorySession() {},
      pruneSessionArtifacts(validSessionIds) {
        calls.pruned.push([...validSessionIds]);
      },
      evictPretextArticlePredictions() {
        calls.evicted += 1;
      },
    },
  });

  await controller.reconcileSessionCaches();

  assert.deepEqual(calls.clearStream, ['session-stale']);
  assert.deepEqual(calls.removed, ['session-stale']);
  assert.equal(calls.evicted, 1);
  assert.deepEqual(calls.pruned, [['session-keep']]);
  assert.equal(state.messagesBySession.has('session-stale'), false);
  assert.equal(state.turnEventsBySession.has('session-stale'), false);
  assert.equal(state.interactiveDraftsBySession.has('session-stale'), false);
  assert.equal(state.sessionMessageAccessOrder.has('session-stale'), false);
  assert.equal(state.currentSessionId, 'session-keep');
});

test('reconcileSessionCaches treats stale Composer V2 session maps as cleanup roots', async () => {
  const state = {
    sessions: [{ id: 'session-keep', title: 'Keep' }],
    currentSessionId: 'session-keep',
    messagesBySession: new Map([['session-keep', []]]),
    turnEventsBySession: new Map(),
    interactiveDraftsBySession: new Map(),
    sessionMessageAccessOrder: new Map(),
    pendingToolApprovals: new Map(),
    ui: {
      composerV2: {
        draftsBySession: new Map([['session-stale', { prompt: 'draft' }]]),
        lifecycleBySession: new Map([['session-stale', 'drafting']]),
        modeListeners: new Map([['session-stale', new Set([() => {}])]]),
      },
    },
  };
  const calls = {
    clearStream: [],
    removed: [],
  };
  const controller = createSessionLifecycleController({
    state,
    sessionCacheController: {
      async clearSessionStreamState(sessionId) {
        calls.clearStream.push(sessionId);
      },
      async evictColdSessionCaches() {},
    },
    jennyShell: {},
    callbacks: {
      removeSessionState(sessionId) {
        calls.removed.push(sessionId);
        state.ui.composerV2.draftsBySession.delete(sessionId);
        state.ui.composerV2.lifecycleBySession.delete(sessionId);
        state.ui.composerV2.modeListeners.delete(sessionId);
      },
      clearDismissedMemorySession() {},
      pruneSessionArtifacts() {},
    },
  });

  await controller.reconcileSessionCaches();

  assert.deepEqual(calls.clearStream, ['session-stale']);
  assert.deepEqual(calls.removed, ['session-stale']);
  assert.equal(state.ui.composerV2.draftsBySession.has('session-stale'), false);
  assert.equal(state.ui.composerV2.lifecycleBySession.has('session-stale'), false);
  assert.equal(state.ui.composerV2.modeListeners.has('session-stale'), false);
});

// Audit finding A2: a sessions.list() snapshot awaited BEFORE a delete must
// not resurrect the deleted session when it resolves AFTER the teardown.
// removeSessionState tombstones deleted ids (state.recentlyDeletedSessionIds);
// refreshSessionSummaries filters stale snapshots against the tombstones.
test('a stale sessions.list snapshot cannot resurrect a tombstoned (deleted) session', async () => {
  let resolveList;
  const state = {
    auth: { authenticated: true },
    sessions: [
      { id: 'session-keep', title: 'Keep' },
      { id: 'session-doomed', title: 'Doomed' },
    ],
    currentSessionId: 'session-keep',
    messagesBySession: new Map([['session-keep', []]]),
    turnEventsBySession: new Map(),
    interactiveDraftsBySession: new Map(),
    sessionMessageAccessOrder: new Map(),
    pendingToolApprovals: new Map(),
    ui: {},
  };
  const controller = createSessionLifecycleController({
    state,
    sessionCacheController: {
      async clearSessionStreamState() {},
      async evictColdSessionCaches() {},
    },
    jennyShell: {
      sessions: {
        list: () => new Promise((resolve) => { resolveList = resolve; }),
      },
    },
    callbacks: {
      removeSessionState() {},
      clearDismissedMemorySession() {},
      pruneSessionArtifacts() {},
      evictPretextArticlePredictions() {},
      syncRuntimeDraftFromActiveSession() {},
    },
  });

  // The refresh's list() call goes out while session-doomed still exists...
  const refreshPromise = controller.refreshSessionSummaries('', { preserveCurrentSession: true });
  assert.equal(typeof resolveList, 'function', 'precondition: the list snapshot is in flight');

  // ...then the user deletes it: teardown removes it from state and
  // tombstones the id (mirroring removeSessionState in renderer-session-utils).
  state.sessions = state.sessions.filter((session) => session.id !== 'session-doomed');
  state.messagesBySession.delete('session-doomed');
  state.recentlyDeletedSessionIds = new Map([['session-doomed', Date.now()]]);

  // The STALE snapshot (taken pre-delete) finally resolves, still listing it.
  resolveList({
    data: [
      { id: 'session-keep', title: 'Keep' },
      { id: 'session-doomed', title: 'Doomed' },
    ],
  });
  const result = await refreshPromise;

  assert.equal(
    state.sessions.some((session) => session.id === 'session-doomed'),
    false,
    'the tombstoned session must not be resurrected into state.sessions'
  );
  assert.equal(result.validSessionIds.has('session-doomed'), false);
  assert.equal(result.validSessionIds.has('session-keep'), true);
});

// Green pin: expired tombstones stop filtering (self-healing TTL), so a
// legitimately re-listed id is not suppressed forever.
test('an EXPIRED tombstone no longer filters the listed session', async () => {
  const state = {
    auth: { authenticated: true },
    sessions: [{ id: 'session-keep', title: 'Keep' }],
    currentSessionId: 'session-keep',
    messagesBySession: new Map([['session-keep', []]]),
    turnEventsBySession: new Map(),
    interactiveDraftsBySession: new Map(),
    sessionMessageAccessOrder: new Map(),
    pendingToolApprovals: new Map(),
    ui: {},
    recentlyDeletedSessionIds: new Map([['session-old-delete', Date.now() - (6 * 60 * 1000)]]),
  };
  const controller = createSessionLifecycleController({
    state,
    sessionCacheController: {
      async clearSessionStreamState() {},
      async evictColdSessionCaches() {},
    },
    jennyShell: {
      sessions: {
        list: async () => ({
          data: [
            { id: 'session-keep', title: 'Keep' },
            { id: 'session-old-delete', title: 'Back Again' },
          ],
        }),
      },
    },
    callbacks: {
      removeSessionState() {},
      clearDismissedMemorySession() {},
      pruneSessionArtifacts() {},
      evictPretextArticlePredictions() {},
      syncRuntimeDraftFromActiveSession() {},
    },
  });

  const result = await controller.refreshSessionSummaries('', { preserveCurrentSession: true });

  assert.equal(result.validSessionIds.has('session-old-delete'), true, 'expired tombstones self-heal');
  assert.equal(state.recentlyDeletedSessionIds.has('session-old-delete'), false, 'the expired entry is pruned');
});
