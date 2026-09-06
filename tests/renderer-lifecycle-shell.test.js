const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createShellRuntimeController,
} = require('../renderer/shell/renderer-shell-runtime-utils.js');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

function buildSession(sessionId, overrides = {}) {
  return {
    id: sessionId,
    title: `Session ${sessionId}`,
    conversation_mode: 'chat',
    preferred_model: 'gpt-test',
    reasoning_effort: 'default',
    context_preferences: {
      history_scope: 'session',
      include_personality: true,
      include_memory: true,
    },
    interactive_round_count: 0,
    interactive_sequence_state: 'idle',
    pending_question_batch: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

// Six features.onChanged subscriptions are owned by the loaded modules
// (renderer-app-lifecycle-composition, renderer-app-shell-bindings x2,
// renderer-stream-handler-lifecycle, renderer-plugins-settings, the skills
// settings rows) and the skills rows also own the one skills.onChanged.
test('renderer dispose unsubscribes shell listeners and re-init does not duplicate them', async (t) => {
  const app = await loadRendererTestApp(t);
  const { window, shell } = app;
  const doc = window.document;

  assert.deepEqual(shell.__getListenerCounts(), {
    auth: 1,
    backend: 1,
    chat: 1,
    features: 6,
    logs: 1,
    proactive: 0,
    speech: 0,
    skills: 1,
    tips: 1,
    system: 1,
    planUsage: 1,
  });

  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 40);
  doc.querySelector('.settings-nav-item[data-settings-section="offline"]').click();
  await waitForUi(window, 40);
  // Skills rides under Plugins & Extensions. Tips has no Settings section and
  // binds eagerly at startup because contextual guidance is Home-owned.
  doc.querySelector('.settings-nav-item[data-settings-section="plugins"]').click();
  await waitForUi(window, 40);

  assert.deepEqual(shell.__getListenerCounts(), {
    auth: 1,
    backend: 1,
    chat: 1,
    features: 6,
    logs: 1,
    proactive: 0,
    speech: 0,
    skills: 1,
    tips: 1,
    system: 1,
    planUsage: 1,
  });

  await window.__disposeRenderer();

  assert.deepEqual(shell.__getListenerCounts(), {
    auth: 0,
    backend: 0,
    chat: 0,
    features: 0,
    logs: 0,
    proactive: 0,
    speech: 0,
    skills: 0,
    tips: 0,
    system: 0,
    planUsage: 0,
  });

  await app.reloadRendererApp();

  assert.deepEqual(shell.__getListenerCounts(), {
    auth: 1,
    backend: 1,
    chat: 1,
    features: 6,
    logs: 1,
    proactive: 0,
    speech: 0,
    skills: 1,
    tips: 1,
    system: 1,
    planUsage: 1,
  });

  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 40);
  doc.querySelector('.settings-nav-item[data-settings-section="offline"]').click();
  await waitForUi(window, 40);
  // The plugin platform is unavailable in this harness, so the Plugins-hosted
  // Skills subsection stays unbound. Home-owned Tips still binds at startup.
  doc.querySelector('.settings-nav-item[data-settings-section="plugins"]').click();
  await waitForUi(window, 40);

  assert.deepEqual(shell.__getListenerCounts(), {
    auth: 1,
    backend: 1,
    chat: 1,
    features: 6,
    logs: 1,
    proactive: 0,
    speech: 0,
    skills: 1,
    tips: 1,
    system: 1,
    planUsage: 1,
  });
});

test('renderer loadSessions prunes stale per-session caches and resets the active session', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const rendererState = window.__rendererState;
  const pretextUtils = window.rendererPretextUtils;
  const evictCalls = [];
  const previousEvictByPrefix = pretextUtils.evictByPrefix;
  rendererState.turnEventsBySession = rendererState.turnEventsBySession || new window.Map();
  pretextUtils.evictByPrefix = (prefix) => {
    evictCalls.push(prefix);
    return previousEvictByPrefix.call(pretextUtils, prefix);
  };
  t.after(() => {
    pretextUtils.evictByPrefix = previousEvictByPrefix;
  });

  shell.__state.sessions = [buildSession('session-keep')];
  rendererState.currentSessionId = 'session-stale';
  rendererState.messagesBySession.set('session-stale', [{ id: 'stale-message', role: 'assistant', content: 'old' }]);
  rendererState.messagesBySession.set('session-keep', [{ id: 'keep-message', role: 'assistant', content: 'keep' }]);
  rendererState.turnEventsBySession.set('session-stale', { turnEventLogVersion: 1, turnEvents: [{ event_id: 'stale-event' }] });
  rendererState.turnEventsBySession.set('session-keep', { turnEventLogVersion: 1, turnEvents: [{ event_id: 'keep-event' }] });
  rendererState.interactiveDraftsBySession.set('session-stale', { batchId: 'batch-stale' });
  rendererState.queuedSendBySession.set('session-stale', { sessionId: 'session-stale', prompt: 'queued', attachments: [] });
  rendererState.pendingStreams.set('stream-stale', 'assistant_stream-stale');
  rendererState.streamThinkingStatusByStream.set('stream-stale', 'Thinking...');
  rendererState.toolCallsByStream.set('stream-stale', [{ callId: 'call-stale' }]);
  rendererState.pendingToolApprovals.set('call-stale', {
    sessionId: 'session-stale',
    streamId: 'stream-stale',
    toolName: 'Read',
    input: {},
  });
  rendererState.activeStreamId = 'stream-stale';

  await shell.__emitBackendStatus({ phase: 'failed', detail: 'sidecar restarted' });
  await shell.__emitBackendStatus({ phase: 'ready', startupStage: 'ready', startupMs: 1 });
  await waitForUi(window, 40);

  assert.equal(rendererState.currentSessionId, 'session-keep');
  assert.equal(rendererState.messagesBySession.has('session-stale'), false);
  assert.equal(rendererState.turnEventsBySession.has('session-stale'), false);
  assert.equal(rendererState.interactiveDraftsBySession.has('session-stale'), false);
  assert.equal(rendererState.queuedSendBySession.has('session-stale'), false);
  assert.equal(rendererState.pendingStreams.size, 0);
  assert.equal(rendererState.streamThinkingStatusByStream.size, 0);
  assert.equal(rendererState.toolCallsByStream.size, 0);
  assert.equal(rendererState.pendingToolApprovals.size, 0);
  assert.equal(rendererState.activeStreamId, '');
  assert.equal(rendererState.messagesBySession.has('session-keep'), true);
  assert.equal(rendererState.turnEventsBySession.has('session-keep'), true);
  assert.deepEqual(evictCalls, ['article:']);
});

test('renderer logout clears multi-stream controller state and legacy busy snapshots', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const rendererState = window.__rendererState;
  const multiStreamController = window.rendererMultiStreamController;
  rendererState.turnEventsBySession = rendererState.turnEventsBySession || new Map();

  multiStreamController.registerStream('session-background', 'stream-background');
  multiStreamController.registerPreflight('session-background', {
    pending: true,
    sessionId: 'session-background',
    streamId: '',
  });
  rendererState.activeStreamId = 'stream-background';
  rendererState.activeStreamSessionId = 'session-background';
  rendererState.sendPreflight = { pending: true, sessionId: 'session-background', streamId: '' };
  rendererState.turnEventsBySession.set('session-background', {
    turnEventLogVersion: 1,
    turnEvents: [{ event_id: 'background-event' }],
  });

  await shell.__emitAuthState({ authenticated: false, user: null });
  await waitForUi(window, 40);

  assert.deepEqual(Array.from(multiStreamController.getStreamingSessionIds()), []);
  assert.deepEqual(Array.from(multiStreamController.getPreflightSessionIds()), []);
  assert.equal(rendererState.activeStreamId, '');
  assert.equal(rendererState.activeStreamSessionId, '');
  assert.equal(rendererState.sendPreflight, null);
  assert.equal(rendererState.turnEventsBySession.size, 0);
});

test('renderer global error boundary logs all occurrences, dedupes toast noise, and keeps shell interactive', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const rendererState = window.__rendererState;
  const chatInput = window.document.getElementById('chatInput');
  const toastViewport = window.document.getElementById('toastViewport');

  window.dispatchEvent(new window.ErrorEvent('error', {
    message: 'simulated renderer failure',
    filename: 'renderer/app.js',
    lineno: 12,
    colno: 3,
  }));
  window.dispatchEvent(new window.ErrorEvent('error', {
    message: 'simulated renderer failure',
    filename: 'renderer/app.js',
    lineno: 12,
    colno: 3,
  }));
  await waitForUi(window, 40);

  const globalErrorLogs = rendererState.logs.filter((entry) => entry.event === 'renderer.global_error');
  assert.equal(globalErrorLogs.length, 2);
  assert.match(String(toastViewport.textContent || ''), /runtime error occurred/i);
  chatInput.value = 'still interactive';
  assert.equal(chatInput.value, 'still interactive');
});

test('renderer global error boundary suppresses handled Monaco loader events', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const rendererState = window.__rendererState;
  const toastViewport = window.document.getElementById('toastViewport');

  window.dispatchEvent(new window.ErrorEvent('error', {
    message: 'Uncaught [object Event]',
    filename: 'file:///C:/dev/jenny/node_modules/monaco-editor/min/vs/editor/editor.main.js',
    lineno: 7,
    colno: 31474,
  }));
  await waitForUi(window, 40);

  const globalErrorLogs = rendererState.logs.filter((entry) => entry.event === 'renderer.global_error');
  assert.equal(globalErrorLogs.length, 0);
  assert.doesNotMatch(String(toastViewport.textContent || ''), /runtime error occurred/i);
});

test('renderer global error boundary still reports Monaco events when an exception object is attached', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const rendererState = window.__rendererState;
  const toastViewport = window.document.getElementById('toastViewport');
  const event = new window.ErrorEvent('error', {
    message: 'Uncaught [object Event]',
    filename: 'file:///C:/dev/jenny/node_modules/monaco-editor/min/vs/editor/editor.main.js',
    lineno: 7,
    colno: 31474,
  });
  Object.defineProperty(event, 'error', {
    configurable: true,
    value: new Error('Real Monaco failure'),
  });

  window.dispatchEvent(event);
  await waitForUi(window, 40);

  const globalErrorLogs = rendererState.logs.filter((entry) => entry.event === 'renderer.global_error');
  assert.equal(globalErrorLogs.length, 1);
  assert.match(String(globalErrorLogs[0].message || ''), /real monaco failure/i);
  assert.match(String(toastViewport.textContent || ''), /runtime error occurred/i);
});

test('renderer global error boundary suppresses Monaco events when the attached payload is only a generic browser Event', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const rendererState = window.__rendererState;
  const toastViewport = window.document.getElementById('toastViewport');
  const event = new window.ErrorEvent('error', {
    message: 'Uncaught [object Event]',
    filename: 'file:///C:/dev/jenny/node_modules/monaco-editor/min/vs/editor/editor.main.js',
    lineno: 7,
    colno: 31474,
  });
  Object.defineProperty(event, 'error', {
    configurable: true,
    value: new window.Event('error'),
  });

  window.dispatchEvent(event);
  await waitForUi(window, 40);

  const globalErrorLogs = rendererState.logs.filter((entry) => entry.event === 'renderer.global_error');
  assert.equal(globalErrorLogs.length, 0);
  assert.doesNotMatch(String(toastViewport.textContent || ''), /runtime error occurred/i);
});

test('renderer deleting the active session clears stream state and approvals before reload', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-delete-active';
          state.sessions = [buildSession(sessionId, {
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
          })];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-delete-active' };
        },
      },
    },
  });
  const rendererState = window.__rendererState;
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Delete this active session';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 30);

  await shell.__emitChat({
    type: 'tool_use',
    sessionId: 'session-delete-active',
    streamId: 'stream-delete-active',
    callId: 'call-delete-active',
    toolName: 'Read',
    summary: 'Read src/app.js',
    input: { file_path: 'src/app.js' },
    status: 'pending_approval',
  });
  await shell.__emitChat({
    type: 'tool_approval_needed',
    sessionId: 'session-delete-active',
    streamId: 'stream-delete-active',
    callId: 'call-delete-active',
    toolName: 'Read',
    input: { file_path: 'src/app.js' },
  });
  await waitForUi(window, 30);

  assert.equal(
    rendererState.pendingStreams.size,
    0,
    'stream state should stay placeholder-free until assistant content actually arrives'
  );
  assert.equal(rendererState.streamThinkingStatusByStream.size, 0);
  assert.equal(rendererState.toolCallsByStream.size, 1);
  assert.equal(rendererState.pendingToolApprovals.size, 1);
  assert.equal(rendererState.activeStreamId, 'stream-delete-active');
  rendererState.queuedSendBySession.set('session-delete-active', {
    sessionId: 'session-delete-active',
    prompt: 'queued while deleting',
    attachments: [],
  });

  const menuButton = window.document.querySelector(
    '[data-session-action="menu"][data-session-id="session-delete-active"]'
  );
  assert.ok(menuButton, 'expected the actions menu for the active session');
  menuButton.click();
  await waitForUi(window, 10);
  const deleteItem = [...window.document.querySelectorAll('.inv-context-menu-item')]
    .find((button) => button.textContent.trim() === 'Delete');
  assert.ok(deleteItem, 'expected the Delete menu item');
  deleteItem.click();
  await waitForUi(window, 20);
  window.document.querySelector('[data-toast-action-id="session-delete-now"]').click();
  await waitForUi(window, 60);

  assert.deepEqual(shell.__state.cancelCalls, ['stream-delete-active']);
  assert.equal(rendererState.pendingStreams.size, 0);
  assert.equal(rendererState.streamThinkingStatusByStream.size, 0);
  assert.equal(rendererState.toolCallsByStream.size, 0);
  assert.equal(rendererState.pendingToolApprovals.size, 0);
  assert.equal(rendererState.activeStreamId, '');
  assert.equal(rendererState.messagesBySession.has('session-delete-active'), false);
  assert.equal(rendererState.queuedSendBySession.has('session-delete-active'), false);
});

test('renderer restores hidden reasoning stream when returning to chat before completion', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-hidden-reasoning-nav';
          state.sessions = [buildSession(sessionId, {
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
          })];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-hidden-reasoning-nav' };
        },
      },
    },
  });
  const rendererState = window.__rendererState;
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const logsTab = window.document.getElementById('logsTopRailTab');

  input.value = 'Navigate while reasoning';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 40);

  logsTab.click();
  await waitForUi(window, 30);
  assert.equal(rendererState.ui.activeView, 'logs');

  await shell.__emitChat({
    type: 'phase_started',
    sessionId: 'session-hidden-reasoning-nav',
    streamId: 'stream-hidden-reasoning-nav',
    phaseKind: 'reasoning',
    phaseId: 'phase-hidden-reasoning-nav',
    thinkingId: 'thinking-hidden-reasoning-nav',
    summary: 'Reading context',
  });
  await waitForUi(window, 30);

  window.document.getElementById('chatTopRailTab').click();
  await waitForUi(window, 60);

  const sessionMessages = rendererState.messagesBySession.get('session-hidden-reasoning-nav') || [];
  const assistantShell = sessionMessages.find((message) => message.id === 'assistant_stream-hidden-reasoning-nav');
  assert.ok(assistantShell, 'expected the in-flight reasoning shell to survive returning to chat');
  assert.equal(assistantShell.status, 'streaming');
  assert.equal(rendererState.pendingStreams.get('stream-hidden-reasoning-nav'), 'assistant_stream-hidden-reasoning-nav');
  assert.match(
    String(window.document.getElementById('chatTimeline')?.textContent || ''),
    /Reading context/
  );
});

test('renderer keeps live stream text visible when returning to chat before completion', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-hidden-text-nav';
          state.sessions = [buildSession(sessionId, {
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
          })];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-hidden-text-nav' };
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const logsTab = window.document.getElementById('logsTopRailTab');
  const timeline = window.document.getElementById('chatTimeline');

  input.value = 'Navigate while text streams';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 40);

  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-hidden-text-nav',
    streamId: 'stream-hidden-text-nav',
    content: 'Visible before nav.',
  });
  await waitForUi(window, 60);
  assert.match(String(timeline.textContent || ''), /Visible before nav\./);

  logsTab.click();
  await waitForUi(window, 30);

  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-hidden-text-nav',
    streamId: 'stream-hidden-text-nav',
    content: ' Hidden after nav.',
  });
  await waitForUi(window, 60);
  assert.match(
    String(
      window.__rendererState.messagesBySession
        .get('session-hidden-text-nav')
        ?.find((message) => message.streamId === 'stream-hidden-text-nav')
        ?.content || ''
    ),
    /Hidden after nav\./
  );

  window.document.getElementById('chatTopRailTab').click();
  await waitForUi(window, 80);

  const restoredTimeline = window.document.getElementById('chatTimeline');
  const text = String(restoredTimeline?.textContent || '');
  assert.equal(window.__rendererState.ui.activeView, 'chat');
  assert.match(text, /Visible before nav\./);
  assert.match(text, /Hidden after nav\./);
});

test('bootstrap restores the persisted last-active view across launches', async (t) => {
  const app = await loadRendererTestApp(t, { persistedActiveView: 'home' });
  const { window } = app;
  await waitForUi(window, 40);

  assert.equal(window.__rendererState.ui.activeView, 'home');
  assert.equal(window.document.documentElement.dataset.activeView, 'home');
});

test('bootstrap hydrates the Home companion panel when Home is the restored boot view', async (t) => {
  const app = await loadRendererTestApp(t, { persistedActiveView: 'home' });
  const { window } = app;
  await waitForUi(window, 60);

  assert.equal(window.__rendererState.ui.activeView, 'home');
  // Regression guard: restoring Home used to set state.ui.activeView directly
  // and skip its activation hydration, so refreshCompanionState() never ran and
  // Home stayed stuck on its loading skeleton forever. bootstrap() must now run
  // the Home hydration once backend status is settled.
  assert.equal(
    window.__rendererState.companion.loaded,
    true,
    'restored Home boot must run refreshCompanionState() so the loading skeleton clears'
  );
  const status = window.document.getElementById('homeOpenLoopStatus');
  assert.notEqual(
    String(status?.textContent || '').trim(),
    'Loading open loops...',
    'Home open-loops status must leave the loading state after hydration'
  );
});

test('bootstrap re-opens the persisted Workspace (IDE) files when IDE is the restored boot view', async (t) => {
  const app = await loadRendererTestApp(t, {
    persistedActiveView: 'ide',
    // A prior session left one file open. Re-opening persisted tabs happens only
    // via activateIde() -> hydratePersistedState() -> applyPersistedState(), which
    // is the exact path the boot back-fill must trigger. (Editor *settings* like
    // fontSize are separately re-applied by the Settings "Editor" section, so open
    // tabs — not settings — are the signal that isolates the boot-activation fix.)
    shell: {
      workspaceIde: {
        getState: () => ({ openTabs: [{ path: 'src/foo.js' }], activeTabPath: 'src/foo.js' }),
      },
    },
  });
  const { window } = app;
  await waitForUi(window, 60);

  assert.equal(window.__rendererState.ui.activeView, 'ide');
  // Regression guard: restoring the IDE view used to set state.ui.activeView
  // directly and skip its one-time activation hydration, so previously-open files
  // stayed missing until the user navigated away and back. bootstrap() must now
  // run the IDE activation hydration once backend status is settled.
  // Assert scalars, not the array itself: openTabs is a JSDOM-realm array, so a
  // deepEqual against a node-realm array trips the cross-realm prototype check.
  const openTabs = window.__rendererState.ui.ide.openTabs || [];
  assert.equal(
    openTabs.length,
    1,
    'restored IDE boot must re-open the persisted files via activateIde() hydration'
  );
  assert.equal(openTabs[0] && openTabs[0].path, 'src/foo.js');
  assert.equal(window.__rendererState.ui.ide.activeTabPath, 'src/foo.js');
});

test('bootstrap defaults to chat when no view has been persisted', async (t) => {
  const app = await loadRendererTestApp(t);
  const { window } = app;
  await waitForUi(window, 40);

  assert.equal(window.__rendererState.ui.activeView, 'chat');
});

test('bootstrap ignores an unknown persisted view and falls back to chat', async (t) => {
  const app = await loadRendererTestApp(t, { persistedActiveView: 'not-a-real-view' });
  const { window } = app;
  await waitForUi(window, 40);

  assert.equal(window.__rendererState.ui.activeView, 'chat');
});

test('runtime delete wrapper syncs workspace state even when deletion fails', async () => {
  const calls = [];
  const logs = [];
  const controller = createShellRuntimeController({
    state: { sessions: [] },
    callbacks: {
      appendClientLog(level, eventName, details) {
        logs.push({ level, eventName, details });
      },
      async handleDeleteSession() {
        calls.push('delete');
        throw new Error('delete failed');
      },
      async syncWorkspaceFromStore() {
        calls.push('sync');
      },
    },
  });

  await assert.rejects(
    () => controller.handleDeleteSessionWithWorkspace('session-failed-delete'),
    /delete failed/
  );
  assert.deepEqual(calls, ['delete', 'sync']);

  const maskingCalls = [];
  const maskingController = createShellRuntimeController({
    state: { sessions: [] },
    callbacks: {
      appendClientLog(level, eventName, details) {
        logs.push({ level, eventName, details });
      },
      async handleDeleteSession() {
        maskingCalls.push('delete');
        throw new Error('delete failed');
      },
      async syncWorkspaceFromStore() {
        maskingCalls.push('sync');
        throw new Error('sync failed');
      },
    },
  });

  await assert.rejects(
    () => maskingController.handleDeleteSessionWithWorkspace('session-failed-delete'),
    /delete failed/
  );
  assert.deepEqual(maskingCalls, ['delete', 'sync']);
  assert.equal(logs.at(-1).level, 'WARN');
  assert.equal(logs.at(-1).eventName, 'workspace.sync_after_delete_failed');
  assert.deepEqual(logs.at(-1).details, { message: 'sync failed' });
});

test('renderer keeps a session visible when backend delete reports deleted false', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const rendererState = window.__rendererState;
  const sessionId = 'session-delete-false';
  shell.__state.sessions = [buildSession(sessionId, { title: 'Delete False' })];
  rendererState.sessions = shell.__state.sessions.slice();
  rendererState.messagesBySession.set(sessionId, [{
    id: 'message-delete-false',
    role: 'assistant',
    content: 'Still here',
  }]);
  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 40);

  const originalDelete = window.jennyShell.sessions.delete;
  window.jennyShell.sessions.delete = async () => ({
    object: 'session',
    id: sessionId,
    deleted: false,
  });
  t.after(() => {
    window.jennyShell.sessions.delete = originalDelete;
  });

  const menuButton = window.document.querySelector(
    `[data-session-action="menu"][data-session-id="${sessionId}"]`
  );
  assert.ok(menuButton, 'expected the actions menu for the test session');
  menuButton.click();
  await waitForUi(window, 10);
  const deleteItem = [...window.document.querySelectorAll('.inv-context-menu-item')]
    .find((button) => button.textContent.trim() === 'Delete');
  assert.ok(deleteItem, 'expected the Delete menu item');
  deleteItem.click();
  await waitForUi(window, 20);
  window.document.querySelector('[data-toast-action-id="session-delete-now"]').click();
  await waitForUi(window, 80);

  assert.equal(
    rendererState.sessions.some((session) => session.id === sessionId),
    true,
    'session summary should remain visible when backend refuses deletion'
  );
  assert.equal(
    rendererState.messagesBySession.has(sessionId),
    true,
    'cached messages should remain when backend refuses deletion'
  );
  assert.ok(window.document.querySelector(`[data-session-id="${sessionId}"]`));
});

test('renderer evicts the least-recent inactive cached sessions after opening more than six sessions', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const rendererState = window.__rendererState;

  shell.__state.sessions = Array.from({ length: 8 }, (_, index) =>
    buildSession(`session-${index + 1}`)
  );
  rendererState.currentSessionId = 'session-8';
  rendererState.sessionMessageAccessOrder = new Map();
  for (let index = 0; index < 8; index += 1) {
    const sessionId = `session-${index + 1}`;
    rendererState.messagesBySession.set(sessionId, [{
      id: `message-${sessionId}`,
      role: 'assistant',
      content: `cached ${sessionId}`,
    }]);
    rendererState.sessionMessageAccessOrder.set(sessionId, index + 1);
  }

  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 40);

  assert.equal(rendererState.messagesBySession.size, 6);
  assert.equal(rendererState.messagesBySession.has('session-1'), false);
  assert.equal(rendererState.messagesBySession.has('session-2'), false);
  assert.equal(rendererState.messagesBySession.has('session-8'), true);
  assert.equal(rendererState.currentSessionId, 'session-8');
});

test('renderer keeps sessions with pending approval state cached even when they are oldest', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const rendererState = window.__rendererState;

  shell.__state.sessions = Array.from({ length: 7 }, (_, index) =>
    buildSession(`session-${index + 1}`)
  );
  rendererState.currentSessionId = 'session-7';
  rendererState.sessionMessageAccessOrder = new Map();
  for (let index = 0; index < 7; index += 1) {
    const sessionId = `session-${index + 1}`;
    rendererState.messagesBySession.set(sessionId, [{
      id: `message-${sessionId}`,
      role: 'assistant',
      content: `cached ${sessionId}`,
    }]);
    rendererState.sessionMessageAccessOrder.set(sessionId, index + 1);
  }
  rendererState.pendingToolApprovals.set('call-pinned', {
    sessionId: 'session-1',
    streamId: 'stream-pinned',
    toolName: 'Read',
    input: {},
  });

  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 40);

  assert.equal(rendererState.messagesBySession.size, 6);
  assert.equal(rendererState.messagesBySession.has('session-1'), true);
  assert.equal(rendererState.messagesBySession.has('session-2'), false);
  assert.equal(rendererState.pendingToolApprovals.has('call-pinned'), true);
});

test('renderer rehydrates pending approval state from the live active-turn snapshot on session load', async (t) => {
  const app = await loadRendererTestApp(t, {
    shell: {
      chat: {
        async getActiveTurnState(sessionId) {
          assert.equal(sessionId, 'session-live');
          return {
            request_id: 'stream-live',
            trace_id: 'trace-live',
            session_id: 'session-live',
            state: 'pending_approval',
            phase: 'approval_wait',
            terminal_reason: null,
            terminal_subcode: null,
            created_at_monotonic: 1,
            updated_at_monotonic: 2,
            pending_approval: {
              call_id: 'call-live',
              tool_name: 'write_file',
              summary: 'write_file notes.md',
            },
          };
        },
      },
    },
  });
  const { window, shell } = app;

  shell.__state.sessions = [buildSession('session-live')];
  shell.__state.messagesBySession.set('session-live', [{
    id: 'tool_use_call-live',
    role: 'assistant',
    kind: 'tool_use',
    content: 'write_file notes.md',
    timestamp: new Date().toISOString(),
    finalizedAt: new Date().toISOString(),
    tool_call: {
      call_id: 'call-live',
      tool_name: 'write_file',
      input_json: JSON.stringify({ path: 'notes.md' }),
      input: { path: 'notes.md' },
      summary: 'write_file notes.md',
      status: 'pending_approval',
      approval_state: 'pending',
      duration_ms: 0,
      parent_stream_id: 'stream-live',
    },
  }]);

  await app.reloadRendererApp();
  await waitForUi(window, 40);

  const rendererState = window.__rendererState;
  const multiStreamController = window.rendererMultiStreamController;
  const approval = rendererState.pendingToolApprovals.get('call-live');
  assert.ok(approval);
  assert.equal(approval.sessionId, 'session-live');
  assert.equal(approval.streamId, 'stream-live');
  assert.equal(approval.toolName, 'write_file');
  assert.deepEqual({ ...approval.input }, { path: 'notes.md' });
  assert.equal(multiStreamController.getStreamIdForSession('session-live'), 'stream-live');
});
