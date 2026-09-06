const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSessionLifecycleController } = require('../renderer/shell/renderer-session-lifecycle-utils');
const { createAttachmentQueueController } = require('../renderer/features/renderer-attachment-queue-utils');
const { createSessionManager } = require('../renderer/shell/renderer-session-utils');
const { createComposerSessionState, mergeAttachmentsInto } = require('../renderer/chat/renderer-composer-session-state');
const { createComposerV2FlowController } = require('../renderer/chat/renderer-composer-v2-flow');
const { createControllerHarness } = require('./helpers/send-controller-harness');

// UIUX-006 (release blocker): #chatInput and state.attachments.queued are
// GLOBAL singletons. A session switch must not silently discard the outgoing
// session's typed text/selection, and must not release the outgoing
// session's queued attachment assets out from under it. This suite drives
// the REAL (unmodified except for this slice's fix) session-lifecycle,
// attachment-queue, and session-utils controllers together with the new
// renderer-composer-session-state module wired the way the app composition
// wires it in production: as a globalThis singleton the other controllers
// look up lazily, mirroring the existing globalThis.rendererSessionAutotitleController
// precedent (renderer/shell/renderer-lifecycle-utils.js).

function createChatInput(initial = '') {
  return {
    value: initial,
    selectionStart: initial.length,
    selectionEnd: initial.length,
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  };
}

function buildEnv({ chatInputText = '' } = {}) {
  const state = {
    sessions: [{ id: 'session-a' }, { id: 'session-b' }],
    currentSessionId: 'session-a',
    messagesBySession: new Map(),
    turnEventsBySession: new Map(),
    sessionMessageAccessOrder: new Map(),
    interactiveDraftsBySession: new Map(),
    pendingToolApprovals: new Map(),
    queuedSendBySession: new Map(),
    attachments: { queued: [], dragDepth: 0 },
    ui: {},
  };
  const chatInput = createChatInput(chatInputText);
  const released = [];
  const trayRenders = { count: 0 };
  const composerVisualSyncs = { count: 0 };
  const log = [];

  const composerSessionStateController = createComposerSessionState({
    state,
    getChatInput: () => chatInput,
    log: (level, event, details) => log.push({ level, event, details }),
    releaseAssets: (paths) => { released.push(...paths); },
    renderAttachmentTray: () => { trayRenders.count += 1; },
    syncComposerVisualState: () => { composerVisualSyncs.count += 1; },
  });

  const jennyShell = {
    sessions: { getMessages: async () => ({ data: [] }) },
    attachments: { releaseAssets: async (paths) => { released.push(...paths); } },
  };

  const sessionCacheController = {
    async clearSessionStreamState() {},
    async evictColdSessionCaches() {},
  };

  function resetAttachmentQueue() {
    const queued = Array.isArray(state.attachments.queued) ? state.attachments.queued : [];
    const paths = queued.map((entry) => entry.assetPath).filter(Boolean);
    if (paths.length) released.push(...paths);
    state.attachments.queued = [];
  }

  const sessionLifecycleController = createSessionLifecycleController({
    state,
    sessionCacheController,
    thinkingController: { resumeAutoScroll() {} },
    jennyShell,
    getMultiStreamController: () => null,
    callbacks: {
      resetAttachmentQueue,
      getActiveSession: () => null,
      syncRuntimeDraftFromActiveSession: () => {},
      setSessionMessages: () => {},
      setSessionTurnEventState: () => {},
      clearStalePendingQuestionBatch: async () => {},
      getPendingQuestionBatch: () => null,
      clearInteractiveDraft: () => {},
      clearComposerStatusNotice: () => {},
      setFollowLatest: () => {},
      renderAll: () => {},
      maybeAutoTitleSession: () => {},
      rehydrateLiveTurnState: () => null,
      evictPretextArticlePredictions: () => {},
      appendClientLog: () => {},
    },
  });

  const attachmentQueueController = createAttachmentQueueController({
    state,
    windowRef: { jennyShell, rendererComposerSessionStateController: composerSessionStateController },
    constants: { TOAST_SOURCE: {} },
    callbacks: {
      renderAttachmentTray: () => { trayRenders.count += 1; },
      buildAttachmentToastMessage: () => '',
      showToastMessage: () => {},
      closeComposerPopover: () => {},
      clearAttachmentNotice: () => {},
    },
  });

  const sessionManager = createSessionManager({
    state,
    constants: {},
    callbacks: {
      normalizeChatMessage: (m) => m,
      normalizeChatMessages: (m) => m,
      isInteractiveOtherTrigger: () => false,
      getActiveSession: () => null,
      patchSessionSummary: () => {},
      rekeyDismissedMemorySession: () => {},
      rekeySessionArtifacts: () => {},
      clearProjectionContextCacheForSession: () => {},
      rekeyProjectionContextCache: () => {},
      appendClientLog: () => {},
    },
  });

  return {
    state,
    chatInput,
    released,
    trayRenders,
    composerVisualSyncs,
    log,
    composerSessionStateController,
    sessionLifecycleController,
    attachmentQueueController,
    sessionManager,
  };
}

function withGlobalController(controller, fn) {
  return async (t) => {
    global.rendererComposerSessionStateController = controller;
    t.after(() => { delete global.rendererComposerSessionStateController; });
    await fn();
  };
}

// --- case (a): text + selection ownership across a session switch ---------

test('switching sessions preserves the outgoing session draft and clears the incoming composer', async (t) => {
  const env = buildEnv({ chatInputText: 'draft for A' });
  env.chatInput.setSelectionRange(3, 7);
  await withGlobalController(env.composerSessionStateController, async () => {
    await env.sessionLifecycleController.openSession('session-b', { silent: true });
    assert.equal(env.chatInput.value, '', 'B must open with an empty composer, not A\'s leaked text');

    await env.sessionLifecycleController.openSession('session-a', { silent: true });
    assert.equal(env.chatInput.value, 'draft for A', 'A\'s exact text must be restored');
    assert.equal(env.chatInput.selectionStart, 3, 'A\'s selection start must be restored');
    assert.equal(env.chatInput.selectionEnd, 7, 'A\'s selection end must be restored');
    assert.equal(env.composerVisualSyncs.count, 2, 'each restored composer must recompute its active holo state');
  })(t);
});

test('opening the already-current session restores its persisted draft when no composer record exists', async (t) => {
  const env = buildEnv();
  env.state.sessions[0].composer_draft = 'Persisted task brief';
  await withGlobalController(env.composerSessionStateController, async () => {
    assert.equal(env.composerSessionStateController.has('session-a'), false);
    await env.sessionLifecycleController.openSession('session-a', { silent: true });
    assert.equal(env.chatInput.value, 'Persisted task brief');
    assert.equal(env.composerSessionStateController.has('session-a'), true);
  })(t);
});

test('task-session create restores its persisted draft without sending or touching the outbox', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body><textarea></textarea></body></html>');
  const previous = { window: global.window, document: global.document,
    composer: global.rendererComposerSessionState, lifecycle: global.rendererSessionLifecycleUtils,
    requestAnimationFrame: global.requestAnimationFrame };
  global.window = dom.window;
  global.document = dom.window.document;
  global.requestAnimationFrame = (callback) => callback();
  global.rendererComposerSessionState = require('../renderer/chat/renderer-composer-session-state');
  global.rendererSessionLifecycleUtils = require('../renderer/shell/renderer-session-lifecycle-utils');
  const brief = 'Ship WO-10c\n\nKeep the brief unsent.';
  const summary = { id: 'session-task', title: 'Ship WO-10c', session_type: 'chat',
    composer_draft: brief, context_preferences: {} };
  const creates = [], lists = [];
  dom.window.jennyShell = { sessions: {
    create: async (payload) => { creates.push(payload); return { data: summary }; },
    list: async () => { lists.push(true); return { data: [summary] }; },
    getMessages: async () => ({ data: [], turn_events: [] }),
  }, chat: { startStream: async () => { throw new Error('draft must not send'); } } };
  const state = { ui: { activeView: 'home' }, backend: { phase: 'starting' }, auth: { authenticated: true }, logs: [], sessions: [],
    messagesBySession: new Map(), turnEventsBySession: new Map(), sessionMessageAccessOrder: new Map(),
    interactiveDraftsBySession: new Map(), queuedSendBySession: new Map(), pendingStreams: new Map(),
    streamThinkingStatusByStream: new Map(), toolCallsByStream: new Map(), pendingToolApprovals: new Map(), attachments: { queued: [] },
    runtimeDraft: {}, features: { featureFlags: {} } };
  delete require.cache[require.resolve('../renderer/shell/renderer-lifecycle-utils')];
  const { createLifecycleController } = require('../renderer/shell/renderer-lifecycle-utils');
  const controller = createLifecycleController({ state, constants: { INTERACTIVE_SEQUENCE_IDLE: 'idle', TOAST_SOURCE: {} },
    dom: { chatInput: dom.window.document.querySelector('textarea') }, callbacks: {
      normalizeReasoningEffort: (value) => value, renderAll() {},
    }, controllers: { thinkingController: { resumeAutoScroll() {} } } });
  t.after(() => { controller.disposeLifecycleController(); global.window = previous.window;
    global.document = previous.document; global.rendererComposerSessionState = previous.composer;
    global.rendererSessionLifecycleUtils = previous.lifecycle;
    global.requestAnimationFrame = previous.requestAnimationFrame; dom.window.close(); });

  await dom.window.rendererTaskSessionActions.start({ title: 'Ship WO-10c', initialPrompt: brief });
  assert.equal(creates[0].initialPrompt, brief);
  assert.equal(lists.length, 1);
  assert.deepEqual(state.sessions, [summary]);
  assert.equal(dom.window.document.querySelector('textarea').value, brief);
  assert.equal(state.ui.activeView, 'chat');
  assert.equal(state.queuedSendBySession.size, 0);
  const successorActions = { start() {} };
  dom.window.rendererTaskSessionActions = successorActions;
  controller.disposeLifecycleController();
  assert.equal(dom.window.rendererTaskSessionActions, successorActions);
});

// --- case (b): attachment ownership across a session switch ---------------

test('switching sessions preserves queued attachments without releasing the outgoing session\'s assets', async (t) => {
  const env = buildEnv();
  env.state.attachments.queued = [{ id: 'att-1', assetPath: '/tmp/att-1', path: '/tmp/att-1' }];
  await withGlobalController(env.composerSessionStateController, async () => {
    await env.sessionLifecycleController.openSession('session-b', { silent: true });
    assert.deepEqual(env.state.attachments.queued, [], 'B\'s tray must start empty');
    assert.deepEqual(env.released, [], 'A\'s attachment assets must NOT be released on a mere session switch');

    await env.sessionLifecycleController.openSession('session-a', { silent: true });
    assert.deepEqual(
      env.state.attachments.queued.map((e) => e.id),
      ['att-1'],
      'A\'s queued attachment must be restored'
    );
  })(t);
});

// --- case (c): a slow attachment op started in A resolves after switching to B ---

test('an attachment op started in A that resolves after switching to B lands in A\'s record, not B\'s live queue', async (t) => {
  const env = buildEnv();
  let resolvePick;
  env.attachmentQueueController.__pick = () => new Promise((resolve) => { resolvePick = resolve; });
  const jennyShellWithSlowPicker = {
    attachments: {
      pick: () => new Promise((resolve) => { resolvePick = resolve; }),
    },
  };
  const attachmentQueueController = createAttachmentQueueController({
    state: env.state,
    windowRef: {
      jennyShell: jennyShellWithSlowPicker,
      rendererComposerSessionStateController: env.composerSessionStateController,
    },
    constants: { TOAST_SOURCE: {} },
    callbacks: {
      renderAttachmentTray: () => { env.trayRenders.count += 1; },
      buildAttachmentToastMessage: () => '',
      showToastMessage: () => {},
      closeComposerPopover: () => {},
      clearAttachmentNotice: () => {},
    },
  });

  await withGlobalController(env.composerSessionStateController, async () => {
    const pickPromise = attachmentQueueController.handleAttachmentPicker();
    await env.sessionLifecycleController.openSession('session-b', { silent: true });

    resolvePick({ accepted: [{ id: 'slow-att', assetPath: '/tmp/slow-att', path: '/tmp/slow-att' }], rejected: [] });
    await pickPromise;

    assert.deepEqual(env.state.attachments.queued, [], 'B\'s live queue must not receive A\'s slow picker result');

    await env.sessionLifecycleController.openSession('session-a', { silent: true });
    assert.deepEqual(
      env.state.attachments.queued.map((e) => e.id),
      ['slow-att'],
      'A\'s record must have absorbed the deferred picker result'
    );
  })(t);
});

// --- case (d): a slow op resolves after the origin session was closed/GC'd ---

test('an attachment op that resolves after its origin session was dropped releases the assets and lands nowhere', async (t) => {
  const env = buildEnv();
  let resolvePick;
  const jennyShellWithSlowPicker = {
    attachments: { pick: () => new Promise((resolve) => { resolvePick = resolve; }) },
  };
  const attachmentQueueController = createAttachmentQueueController({
    state: env.state,
    windowRef: {
      jennyShell: jennyShellWithSlowPicker,
      rendererComposerSessionStateController: env.composerSessionStateController,
    },
    constants: { TOAST_SOURCE: {} },
    callbacks: {
      renderAttachmentTray: () => { env.trayRenders.count += 1; },
      buildAttachmentToastMessage: () => '',
      showToastMessage: () => {},
      closeComposerPopover: () => {},
      clearAttachmentNotice: () => {},
    },
  });

  await withGlobalController(env.composerSessionStateController, async () => {
    const pickPromise = attachmentQueueController.handleAttachmentPicker();
    // A gets backgrounded (creates its record) then torn down entirely
    // (delete/GC) before the picker settles.
    await env.sessionLifecycleController.openSession('session-b', { silent: true });
    env.sessionManager.removeSessionState('session-a');

    resolvePick({ accepted: [{ id: 'orphan-att', assetPath: '/tmp/orphan-att', path: '/tmp/orphan-att' }], rejected: [] });
    await pickPromise;

    assert.deepEqual(env.state.attachments.queued, [], 'B\'s live queue must not receive the orphaned result');
    assert.deepEqual(env.released, ['/tmp/orphan-att'], 'the orphaned attachment asset must be released, not silently kept');
  })(t);
});

// --- case (e): rekey (new-contract) — optimistic -> server session id ------

test('rekeySessionState migrates the composer record from an optimistic id to its server id', async (t) => {
  const env = buildEnv();
  await withGlobalController(env.composerSessionStateController, async () => {
    env.state.currentSessionId = 'session-local-1';
    env.composerSessionStateController.captureActive('session-local-1', 'test_seed');
    env.chatInput.value = 'typed before the server session existed';
    env.composerSessionStateController.captureActive('session-local-1', 'test_seed_2');

    env.sessionManager.rekeySessionState('session-local-1', 'session-server-1');

    assert.equal(env.state.composerSessionState.has('session-local-1'), false, 'the optimistic id record must be gone');
    const migrated = env.state.composerSessionState.get('session-server-1');
    assert.ok(migrated, 'the record must have migrated to the server session id');
    assert.equal(migrated.text, 'typed before the server session existed');
  })(t);
});

// --- case (f): a completed send consumes the sending session's record -----

test('a completed send consumes the sending session\'s record without touching another session\'s record', async (t) => {
  const env = buildEnv();
  // Simulate: B has a live in-progress draft (its own record from an earlier
  // switch), A just finished sending (composer + attachments already
  // cleared by the send flow) and captures that cleared state into its own
  // record, mirroring the capture hook this slice adds after a send commits.
  env.state.currentSessionId = 'session-b';
  env.composerSessionStateController.captureActive('session-b', 'seed_b');
  env.chatInput.value = 'still drafting in B';
  env.composerSessionStateController.captureActive('session-b', 'seed_b_2');

  env.state.currentSessionId = 'session-a';
  env.chatInput.value = '';
  env.state.attachments.queued = [];
  env.composerSessionStateController.captureActive('session-a', 'send_consumed');

  const recordA = env.state.composerSessionState.get('session-a');
  const recordB = env.state.composerSessionState.get('session-b');
  assert.equal(recordA.text, '', 'A\'s record must be cleared after its send is consumed');
  assert.deepEqual(recordA.attachments, [], 'A\'s attachments must be cleared after its send is consumed');
  assert.equal(recordB.text, 'still drafting in B', 'B\'s record must be untouched by A\'s send');
});

// --- case (g): rapid A -> B -> A with an in-flight generation bump --------
//
// The token IS generation-stale (session-a's record was rebuilt by the
// return trip through restoreForSession), so isTokenActive() correctly
// routes this through the 'origin' path rather than the live mergeActive
// path. But session-a is ALSO the CURRENT session by the time the IPC
// resolves (the user went A -> B -> A, not A -> B and stayed), so the
// result must become visible immediately -- not sit invisible in the record
// until the next switch away and back (that was the bug: this case used to
// assert the queue stayed empty here).

test('a stale attachment token whose origin is the CURRENT session becomes visible on resolve, not just on the next switch', async (t) => {
  const env = buildEnv();
  await withGlobalController(env.composerSessionStateController, async () => {
    const staleToken = env.composerSessionStateController.beginAttachmentOp();

    await env.sessionLifecycleController.openSession('session-b', { silent: true });
    await env.sessionLifecycleController.openSession('session-a', { silent: true });

    env.trayRenders.count = 0; // isolate the render triggered by the resolve itself

    const result = env.composerSessionStateController.commitAttachmentResult(
      staleToken,
      { accepted: [{ id: 'late-att', assetPath: '/tmp/late-att', path: '/tmp/late-att' }], rejected: [] },
      { mergeActive: () => { throw new Error('must not take the active merge path for a stale token'); } }
    );

    assert.equal(result.target, 'origin', 'a generation-stale token for the now-current session must not be treated as active');
    assert.deepEqual(
      env.state.attachments.queued.map((e) => e.id),
      ['late-att'],
      'session A is CURRENT, so the live queue must receive the attachment immediately, not just on the next switch'
    );
    assert.equal(
      env.trayRenders.count,
      1,
      'the tray must re-render so the attachment becomes visible without another switch'
    );
    const record = env.state.composerSessionState.get('session-a');
    assert.deepEqual(record.attachments.map((e) => e.id), ['late-att'], 'the record still absorbs the result');
  })(t);
});

test('a background origin releases managed assets rejected by its queue capacity', async (t) => {
  const env = buildEnv();
  env.state.attachments.queued = Array.from({ length: 8 }, (_, index) => ({
    id: `full-${index}`, assetPath: `/tmp/full-${index}`,
  }));
  await withGlobalController(env.composerSessionStateController, async () => {
    env.composerSessionStateController.captureActive('session-a', 'seed_full');
    const token = env.composerSessionStateController.beginAttachmentOp();
    await env.sessionLifecycleController.openSession('session-b', { silent: true });

    const result = env.composerSessionStateController.commitAttachmentResult(token, {
      accepted: [{ id: 'overflow', assetPath: '/tmp/overflow' }], rejected: [],
    });

    assert.equal(result.target, 'origin');
    assert.deepEqual(env.released, ['/tmp/overflow']);
  })(t);
});

test('plugin sessions leave their prompt draft for the provider view', async () => {
  const env = buildEnv({ chatInputText: 'paint a lighthouse' });
  env.state.sessions = [{ id: 'session-a', session_type: 'plugin' }];
  let chatSendCalls = 0;

  const flow = createComposerV2FlowController({
    chatInput: env.chatInput,
    state: env.state,
    windowRef: { rendererComposerSessionStateController: env.composerSessionStateController },
    startPromptSend: async () => { chatSendCalls += 1; },
  });
  await flow.handleSend();

  assert.equal(chatSendCalls, 0);
  assert.equal(env.chatInput.value, 'paint a lighthouse');
});

test('an accepted image start preserves newer edits made after its receipt', () => {
  const env = buildEnv({ chatInputText: 'original prompt' });
  const receipt = env.composerSessionStateController.beginDraftOp('session-a');
  env.chatInput.value = 'newer prompt';
  env.composerSessionStateController.captureActive('session-a', 'test_edit');

  assert.deepEqual(
    env.composerSessionStateController.consumeDraftOp(receipt),
    { consumed: false, live: false },
  );
  assert.equal(env.chatInput.value, 'newer prompt');
});

// --- case (h): a cache-miss reopen of the ALREADY-current session must not
// clobber the live composer or bump the record generation -----------------

test('reopening the CURRENT session (cache-miss refresh, not a real switch) does not clobber the live composer or bump the record generation', async (t) => {
  const env = buildEnv({ chatInputText: 'live typing, not yet captured' });
  env.chatInput.setSelectionRange(5, 5);
  await withGlobalController(env.composerSessionStateController, async () => {
    const generationBefore = env.composerSessionStateController.beginAttachmentOp().generation;

    // Mirrors loadSessions()'s cache-miss reopen call site:
    // `openSession(state.currentSessionId, { silent: true })` -- the sessionId
    // passed in already equals state.currentSessionId, i.e. the user never
    // actually left this session.
    assert.equal(env.state.currentSessionId, 'session-a', 'precondition: session-a is already current');
    await env.sessionLifecycleController.openSession('session-a', { silent: true });

    assert.equal(
      env.chatInput.value,
      'live typing, not yet captured',
      'a same-session reopen must not stomp the live composer text with a stale/empty record'
    );
    assert.equal(env.chatInput.selectionStart, 5, 'the live caret start must not move');
    assert.equal(env.chatInput.selectionEnd, 5, 'the live caret end must not move');

    const recordAfter = env.state.composerSessionState.get('session-a');
    assert.equal(
      recordAfter.generation,
      generationBefore,
      'a same-session reopen must not bump the composer record generation'
    );
  })(t);
});

// --- send-flow interplay: restoreQueuedSendDraft / send-consume -----------

test('restoreQueuedSendDraft syncs the composer-session record so a later switch captures the restored draft', async (t) => {
  const harness = createControllerHarness([]);
  harness.multiStreamController.registerStream('session-1', 'stream-active');
  harness.state.queuedSendBySession.set('session-1', {
    sessionId: 'session-1',
    prompt: 'queued while busy',
    attachments: [],
    runtimePreferences: null,
    createdAt: Date.now(),
  });
  t.after(() => harness.restore());

  const composerSessionStateController = createComposerSessionState({
    state: harness.state,
    getChatInput: () => harness.chatInput,
    releaseAssets: () => {},
  });
  global.rendererComposerSessionStateController = composerSessionStateController;
  t.after(() => { delete global.rendererComposerSessionStateController; });

  await harness.controller.handleStopActiveStream();

  assert.equal(harness.chatInput.value, 'queued while busy');
  const record = harness.state.composerSessionState?.get('session-1');
  assert.ok(record, 'restoreQueuedSendDraft must sync the new composer-session record, not just chatInput');
  assert.equal(record.text, 'queued while busy');
});

test('a successful send clears the composer-session record for the sending session', async (t) => {
  const harness = createControllerHarness([], { chatInputValue: 'send me' });
  t.after(() => harness.restore());

  const composerSessionStateController = createComposerSessionState({
    state: harness.state,
    getChatInput: () => harness.chatInput,
    releaseAssets: () => {},
  });
  global.rendererComposerSessionStateController = composerSessionStateController;
  t.after(() => { delete global.rendererComposerSessionStateController; });
  composerSessionStateController.captureActive('session-1', 'seed');

  const result = await harness.controller.startPromptSend('send me');

  assert.ok(result, 'precondition: the send must succeed');
  const record = harness.state.composerSessionState.get(result.sessionId);
  assert.ok(record, 'the sending session must end up with a composer-session record');
  assert.equal(record.text, '', 'the record must be cleared, not left holding the pre-send draft');
});

test('clearAll removes every session draft and releases each managed asset once', () => {
  const env = buildEnv({ chatInputText: 'draft A' });
  env.state.attachments.queued = [{ id: 'asset-a', assetPath: '/tmp/asset-a' }];
  env.composerSessionStateController.captureActive('session-a', 'seed-a');
  env.state.composerSessionState.set('session-b', {
    sessionId: 'session-b', text: 'draft B', attachments: [
      { id: 'asset-a-copy', assetPath: '/tmp/asset-a' },
      { id: 'asset-b', assetPath: '/tmp/asset-b' },
    ], generation: 1, draftRevision: 1, sendReceiptId: '', touchedAtMs: 0,
  });

  assert.equal(env.composerSessionStateController.clearAll(), 2);
  assert.equal(env.state.composerSessionState.size, 0);
  assert.deepEqual(env.state.attachments.queued, []);
  assert.deepEqual(env.released.sort(), ['/tmp/asset-a', '/tmp/asset-b']);
});

test('dropping the active session clears its live attachment queue', () => {
  const env = buildEnv();
  env.state.attachments.queued = [{ id: 'asset-a', assetPath: '/tmp/asset-a' }];
  env.composerSessionStateController.captureActive('session-a', 'seed-a');

  assert.equal(env.composerSessionStateController.dropSession('session-a'), true);
  assert.deepEqual(env.state.attachments.queued, []);
  assert.equal(env.state.composerSessionState.has('session-a'), false);
  assert.deepEqual(env.released, ['/tmp/asset-a']);
});

// --- module-level: pure merge helper --------------------------------------

test('mergeAttachmentsInto dedupes by identity and caps at 8', () => {
  const existing = Array.from({ length: 7 }, (_, i) => ({ id: `existing-${i}`, path: `/p/${i}` }));
  const { next, droppedForCapacity, addedCount } = mergeAttachmentsInto(existing, [
    { id: 'existing-0', path: '/p/0' }, // duplicate, ignored
    { id: 'new-1', path: '/p/new1' },
    { id: 'new-2', path: '/p/new2' }, // exceeds cap of 8
  ]);
  assert.equal(next.length, 8);
  assert.equal(addedCount, 1);
  assert.equal(droppedForCapacity, 1);
});
