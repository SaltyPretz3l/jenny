'use strict';

/* Workspace Chat Dock integration seams (ide_chat_dock):
 *  1. renderLayout drives the host reconcile BEFORE any visibility toggle
 *     (leaving Workspace must restore nodes before #ideView goes offscreen).
 *  2. Dock-scoped approval-steer (plan §17 decision 7 / §11 #9): with a
 *     pending approval the DOCK composer stays live and queue-eligible while
 *     MAIN CHAT keeps the pre-dock hard lock; flag-off is byte-identical.
 *  3. The chat state classes mirror onto #ideChatDockBody. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createChromePipeline } = require('../renderer/chat/renderer-render-pipeline-chrome');
const { createSurfaceStatePipeline } = require('../renderer/chat/renderer-render-pipeline-surface-state');
const surfaceLiveUtils = require('../renderer/chat/renderer-chat-surface-live-utils');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { waitForUiState } = require('./helpers/wait-for-ui-state');

const CONTENTION_WAIT_TIMEOUT_MS = 10_000;

function installSurfaceLiveGlobal(t) {
  const previous = globalThis.rendererChatSurfaceLiveUtils;
  globalThis.rendererChatSurfaceLiveUtils = surfaceLiveUtils;
  t.after(() => {
    if (previous === undefined) {
      delete globalThis.rendererChatSurfaceLiveUtils;
    } else {
      globalThis.rendererChatSurfaceLiveUtils = previous;
    }
  });
}

function makeDom() {
  return new JSDOM(`<!doctype html><body>
    <section id="homeView" class="hidden"></section>
    <section id="chatView" class="hidden"></section>
    <section id="ideView"></section>
    <section id="artifactsView" class="hidden"></section>
    <section id="logsView" class="view-offscreen"></section>
    <section id="settingsView" class="view-offscreen"></section>
    <button id="homeNavButton"></button>
    <textarea id="chatInput"></textarea>
    <div id="composer"></div>
    <div id="composerWrap"></div>
    <button id="sendButton"></button>
    <button id="stopStreamButton" class="hidden"></button>
    <select id="composerModelSelect"></select>
    <select id="composerEffortSelect"></select>
    <button id="composerSettingsButton"></button>
  </body>`);
}

function makeChromeState(overrides = {}) {
  return {
    currentSessionId: 'session-1',
    backend: { phase: 'ready' },
    auth: { authenticated: true },
    attachments: { queued: [] },
    queuedSendBySession: new Map(),
    sessions: [],
    ui: { activeView: 'ide', ideChatDockOpen: true, ...(overrides.ui || {}) },
    features: { featureFlags: { ide_chat_dock: true } },
    ...overrides.rest,
  };
}

function makeChrome(dom, state, extraCallbacks = {}) {
  const doc = dom.window.document;
  const byId = (id) => doc.getElementById(id);
  return createChromePipeline({
    state,
    dom: {
      homeView: byId('homeView'),
      chatView: byId('chatView'),
      ideView: byId('ideView'),
      artifactsView: byId('artifactsView'),
      logsView: byId('logsView'),
      settingsView: byId('settingsView'),
      homeNavButton: byId('homeNavButton'),
      chatInput: byId('chatInput'),
      composer: byId('composer'),
      composerWrap: byId('composerWrap'),
      sendButton: byId('sendButton'),
      stopStreamButton: byId('stopStreamButton'),
      composerModelSelect: byId('composerModelSelect'),
      composerEffortSelect: byId('composerEffortSelect'),
      composerSettingsButton: byId('composerSettingsButton'),
    },
    callbacks: {
      isSessionStreaming: () => true,
      isSendBusy: () => true,
      hasPendingToolApprovalForSession: () => true,
      ...extraCallbacks,
    },
  });
}

async function loadDockedRendererApp(t) {
  const app = await loadRendererApp({
    persistedActiveView: 'ide',
    shell: {
      features: {
        state: { featureFlags: { ide_chat_dock: true } },
      },
      workspaceIde: {
        async getState() {
          return {
            chatDockOpen: true,
            chatDockSide: 'right',
            chatDockWidth: 380,
          };
        },
      },
    },
  });
  t.after(async () => {
    await app.dispose();
  });

  const { window, shell } = app;
  const doc = window.document;
  const state = window.__rendererState;
  const composerWrap = doc.getElementById('composerWrap');
  const dockBody = doc.getElementById('ideChatDockBody');
  await waitForUiState(
    window,
    () => state.ui.activeView === 'ide'
      && state.ui.ideChatDockOpen === true
      && composerWrap.parentElement === dockBody,
    {
      timeoutMs: CONTENTION_WAIT_TIMEOUT_MS,
      message: 'Timed out waiting for the open IDE chat dock to host the composer.',
    }
  );
  return { ...app, doc, state, composerWrap, dockBody };
}

async function startDockedStreamingTurn(fixture, prompt) {
  const { window, shell, state, doc } = fixture;
  const chatInput = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');
  chatInput.value = prompt;
  chatInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUiState(window, () => sendButton.disabled === false, {
    timeoutMs: CONTENTION_WAIT_TIMEOUT_MS,
    message: 'Timed out waiting for the dock send button to become enabled.',
  });
  sendButton.click();
  await waitForUiState(window, () => shell.__state.chatCalls.length === 1, {
    timeoutMs: CONTENTION_WAIT_TIMEOUT_MS,
    message: 'Timed out waiting for the dock composer send to reach chat.startStream.',
  });

  const sessionId = 'session-1';
  const streamId = 'stream-test-1';
  await shell.__emitChat({ type: 'started', sessionId, streamId });
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: 'Streaming characterization chunk.',
    aggregate: 'Streaming characterization chunk.',
  });
  await waitForUiState(
    window,
    () => state.pendingStreams.has(streamId),
    {
      timeoutMs: CONTENTION_WAIT_TIMEOUT_MS,
      message: 'Timed out waiting for the characterization turn to enter streaming state.',
    }
  );
  return { sessionId, streamId };
}

async function settleDockedTurn(fixture, identity, terminalPayload) {
  const { window, shell, state } = fixture;
  await shell.__emitChat({ ...identity, ...terminalPayload });
  await waitForUiState(
    window,
    () => !state.pendingStreams.has(identity.streamId),
    {
      timeoutMs: CONTENTION_WAIT_TIMEOUT_MS,
      message: 'Timed out waiting for the characterization turn registry to settle.',
    }
  );
  // Drain the terminal handler's scheduled chrome pass without interacting
  // with the UI. The post-settle assertions below intentionally do not wait on
  // disabled/inert/aria-hidden themselves: a latched field must fail loudly.
  await waitForUi(window, 300);
}

function assertDockedComposerSelectable(fixture, hypothesis) {
  const { state, doc, composerWrap, dockBody } = fixture;
  const ideView = doc.getElementById('ideView');
  const chatInput = doc.getElementById('chatInput');
  assert.equal(
    state.ui.activeView,
    'ide',
    `${hypothesis}: state.ui.activeView drifted away from ide during terminal settlement`
  );
  assert.equal(
    ideView.inert,
    false,
    `${hypothesis}: ideView.inert latched true after terminal settlement`
  );
  assert.equal(
    ideView.getAttribute('aria-hidden'),
    'false',
    `${hypothesis}: ideView aria-hidden latched to a non-false value after terminal settlement`
  );
  assert.equal(
    chatInput.disabled,
    false,
    `${hypothesis}: chatInput.disabled latched true after terminal settlement`
  );
  assert.equal(
    composerWrap.parentElement,
    dockBody,
    `${hypothesis}: composerWrap.parentElement was not #ideChatDockBody after terminal settlement`
  );
}

test('renderLayout runs the dock reconcile BEFORE the view visibility toggles', (t) => {
  installSurfaceLiveGlobal(t);
  const dom = makeDom();
  const doc = dom.window.document;
  const ideView = doc.getElementById('ideView');
  const chatView = doc.getElementById('chatView');
  const observed = [];
  const state = makeChromeState({ ui: { activeView: 'ide', ideChatDockOpen: true } });
  const chrome = makeChrome(dom, state, {
    reconcileChatDockHost: () => {
      observed.push({
        ideOffscreenAtCall: ideView.classList.contains('view-offscreen'),
        chatHiddenAtCall: chatView.classList.contains('hidden'),
      });
      return true;
    },
  });

  // Leaving Workspace: the reconcile must fire while #ideView is still
  // on-screen and #chatView is still hidden (i.e. before the toggles below).
  state.ui.activeView = 'chat';
  chrome.renderLayout();
  assert.equal(observed.length, 1, 'reconcile called once per renderLayout');
  assert.equal(observed[0].ideOffscreenAtCall, false, 'reconcile ran before #ideView went offscreen');
  assert.equal(observed[0].chatHiddenAtCall, true, 'reconcile ran before #chatView was revealed');
  assert.equal(ideView.classList.contains('view-offscreen'), true, 'toggles still applied after');
  assert.equal(chatView.classList.contains('hidden'), false);
});

test('H1/H2 baseline: docked composer is selectable after send -> streaming -> chat.done', async (t) => {
  const fixture = await loadDockedRendererApp(t);
  const identity = await startDockedStreamingTurn(fixture, 'Characterize chat.done selectability');
  await settleDockedTurn(fixture, identity, {
    type: 'complete',
    content: 'Streaming characterization chunk. Done.',
  });

  assertDockedComposerSelectable(fixture, 'H1/H2 chat.done baseline');
});

test('H1/H2 error terminal: docked composer is selectable after chat.error', async (t) => {
  const fixture = await loadDockedRendererApp(t);
  const identity = await startDockedStreamingTurn(fixture, 'Characterize chat.error selectability');
  await settleDockedTurn(fixture, identity, {
    type: 'error',
    message: 'Characterization error terminal.',
    retryable: true,
    category: 'managed_sidecar',
    status: 'error',
  });

  assertDockedComposerSelectable(fixture, 'H1/H2 chat.error terminal');
});

test('H1/H2 cancelled terminal: docked composer is selectable after cancellation', async (t) => {
  const fixture = await loadDockedRendererApp(t);
  const identity = await startDockedStreamingTurn(fixture, 'Characterize cancelled-turn selectability');
  const stopStreamButton = fixture.doc.getElementById('stopStreamButton');
  assert.equal(
    stopStreamButton.classList.contains('hidden'),
    false,
    'H2 cancelled precondition: stopStreamButton stayed hidden during streaming'
  );
  stopStreamButton.click();
  await waitForUiState(fixture.window, () => fixture.shell.__state.cancelCalls.length === 1, {
    timeoutMs: CONTENTION_WAIT_TIMEOUT_MS,
    message: 'Timed out waiting for the cancelled-turn probe to call chat.cancelStream.',
  });
  await settleDockedTurn(fixture, identity, {
    type: 'error',
    message: 'Stream cancelled.',
    retryable: true,
    category: 'cancelled',
    status: 'cancelled',
    terminal_subcode: 'user_stop',
  });

  assertDockedComposerSelectable(fixture, 'H1/H2 cancelled terminal');
});

test('H1 ordering probe: a chat -> ide chrome flip never leaves an inert composer inside the dock', async (t) => {
  const fixture = await loadDockedRendererApp(t);
  const { window, state, doc, composerWrap, dockBody } = fixture;
  const ideView = doc.getElementById('ideView');
  const chatView = doc.getElementById('chatView');

  doc.getElementById('chatTopRailTab').click();
  await waitForUiState(
    window,
    () => state.ui.activeView === 'chat' && composerWrap.parentElement === chatView,
    {
      timeoutMs: CONTENTION_WAIT_TIMEOUT_MS,
      message: 'Timed out waiting for the H1 ordering probe to render activeView=chat.',
    }
  );
  assert.equal(
    ideView.inert && composerWrap.parentElement === dockBody,
    false,
    'H1 ordering: ideView.inert became true while composerWrap remained inside #ideChatDockBody'
  );

  // Top-rail renders can replace tab nodes, so resolve the IDE tab again.
  doc.getElementById('ideTopRailTab').click();
  await waitForUiState(window, () => state.ui.activeView === 'ide', {
    timeoutMs: CONTENTION_WAIT_TIMEOUT_MS,
    message: 'Timed out waiting for the H1 ordering probe to render activeView=ide again.',
  });
  await waitForUi(window, 100);

  assert.equal(
    ideView.inert,
    false,
    'H1 ordering: ideView.inert latched true after activeView returned to ide'
  );
  assert.equal(
    ideView.getAttribute('aria-hidden'),
    'false',
    'H1 ordering: ideView aria-hidden latched to a non-false value after activeView returned to ide'
  );
  assert.ok(
    composerWrap.parentElement === dockBody || composerWrap.parentElement === chatView,
    'H1 ordering: composerWrap.parentElement ended outside both #ideChatDockBody and #chatView'
  );
  assert.equal(
    ideView.inert && composerWrap.parentElement === dockBody,
    false,
    'H1 ordering: final state left an inert composer inside #ideChatDockBody'
  );
});

test('H2 latch probe: chat.done re-enables the dock input without post-terminal UI interaction', async (t) => {
  const fixture = await loadDockedRendererApp(t);
  const identity = await startDockedStreamingTurn(fixture, 'Probe terminal chrome rerender');
  await settleDockedTurn(fixture, identity, {
    type: 'complete',
    content: 'Streaming characterization chunk. Terminal.',
  });

  assert.equal(
    fixture.doc.getElementById('chatInput').disabled,
    false,
    'H2 latch: chatInput.disabled stayed true because chat.done did not refresh dock chrome'
  );
});

test('approval-steer: dock live keeps the composer enabled + queue-eligible', (t) => {
  installSurfaceLiveGlobal(t);
  const dom = makeDom();
  const doc = dom.window.document;
  const state = makeChromeState({ ui: { activeView: 'ide', ideChatDockOpen: true } });
  const chrome = makeChrome(dom, state);

  chrome.renderComposerState();
  assert.equal(doc.getElementById('chatInput').disabled, false, 'dock composer stays LIVE during an approval gate');
  assert.equal(
    doc.getElementById('sendButton').textContent,
    'Queue — runs in Ask',
    'typed send is queue-eligible one-deep'
  );
});

test('approval-steer stays dock-scoped: main chat keeps the hard lock', (t) => {
  installSurfaceLiveGlobal(t);
  const dom = makeDom();
  const doc = dom.window.document;
  const state = makeChromeState({ ui: { activeView: 'chat', ideChatDockOpen: true } });
  const chrome = makeChrome(dom, state);

  chrome.renderComposerState();
  assert.equal(doc.getElementById('chatInput').disabled, true, 'main chat composer locks during an approval gate (unchanged)');
});

test('approval-steer is flag-gated: ide view with the flag OFF keeps the lock (byte-identical)', (t) => {
  installSurfaceLiveGlobal(t);
  const dom = makeDom();
  const doc = dom.window.document;
  const state = makeChromeState({ ui: { activeView: 'ide', ideChatDockOpen: true } });
  state.features.featureFlags.ide_chat_dock = false;
  const chrome = makeChrome(dom, state);

  chrome.renderComposerState();
  assert.equal(doc.getElementById('chatInput').disabled, true, 'flag-off keeps the pre-dock lock everywhere');
});

test('chat state classes mirror onto #ideChatDockBody', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <section id="chatView" class="chat-empty"></section>
    <div id="composer"></div>
    <div id="composerWrap"></div>
    <div id="ideChatDockBody"></div>
  </body>`);
  const doc = dom.window.document;
  const chatView = doc.getElementById('chatView');
  const dockBody = doc.getElementById('ideChatDockBody');
  const state = { currentSessionId: 'session-1', ui: { chatMode: 'empty' } };
  const pipeline = createSurfaceStatePipeline({
    state,
    dom: {
      chatView,
      composer: doc.getElementById('composer'),
      composerWrap: doc.getElementById('composerWrap'),
    },
    callbacks: {},
  });

  pipeline.applyChatStateClasses(true);
  assert.equal(dockBody.classList.contains('chat-active'), true, 'chat-active mirrored');
  assert.equal(dockBody.classList.contains('chat-empty'), false);

  pipeline.applyChatStateClasses(false);
  assert.equal(dockBody.classList.contains('chat-empty'), true, 'chat-empty mirrored');
  assert.equal(dockBody.classList.contains('chat-active'), false);
  assert.equal(dockBody.classList.contains('thread-transition-ready'), false, 'transition flag cleared with chatView');
});

test('origin chip releases the current session label after the first assistant reply', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="chatOriginChip" class="hidden"></div>
    <span id="chatOriginLabel"></span>
  </body>`);
  const doc = dom.window.document;
  const state = {
    currentSessionId: 'session-origin',
    sessions: [{ id: 'session-origin' }],
    ui: { activeView: 'chat' },
  };
  let messages = [];
  const chrome = createChromePipeline({
    state,
    dom: {
      chatOriginChip: doc.getElementById('chatOriginChip'),
      chatOriginLabel: doc.getElementById('chatOriginLabel'),
    },
    callbacks: { getVisibleSessionMessages: () => messages },
  });

  chrome.setSessionOrigin('session-origin', 'Workspace');
  chrome.renderOriginChip();
  assert.equal(doc.getElementById('chatOriginChip').classList.contains('hidden'), false);

  messages = [{ id: 'assistant-1', role: 'assistant', content: 'Done' }];
  chrome.renderOriginChip();
  assert.equal(doc.getElementById('chatOriginChip').classList.contains('hidden'), true);

  messages = [];
  chrome.renderOriginChip();
  assert.equal(doc.getElementById('chatOriginChip').classList.contains('hidden'), true);
});

test('origin chip releases labels for sessions removed before an assistant reply', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="chatOriginChip" class="hidden"></div>
    <span id="chatOriginLabel"></span>
  </body>`);
  const doc = dom.window.document;
  const state = {
    currentSessionId: 'session-deleted',
    sessions: [{ id: 'session-deleted' }],
    ui: { activeView: 'chat' },
  };
  const chrome = createChromePipeline({
    state,
    dom: {
      chatOriginChip: doc.getElementById('chatOriginChip'),
      chatOriginLabel: doc.getElementById('chatOriginLabel'),
    },
    callbacks: { getVisibleSessionMessages: () => [] },
  });

  chrome.setSessionOrigin('session-deleted', 'Workspace');
  state.sessions = [];
  state.currentSessionId = '';
  chrome.renderOriginChip();

  state.sessions = [{ id: 'session-deleted' }];
  state.currentSessionId = 'session-deleted';
  chrome.renderOriginChip();
  assert.equal(doc.getElementById('chatOriginChip').classList.contains('hidden'), true);
});
