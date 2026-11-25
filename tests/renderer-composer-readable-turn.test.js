'use strict';

/* S3 (COMPOSER_RUN_MODE_SPEC §6): readable composer during active turns.
 *
 * Contract pinned here, driven through the real renderComposerState():
 * 1. Model/effort/settings are next-send preferences saved over local IPC —
 *    a backend that is PREPARING (sidecar_spawned / model_acquiring /
 *    model_loading / starting / retrying) must not lock them. Only a
 *    genuinely offline backend (stopped / stopping / error / unknown),
 *    auth loss, plugin-readonly, or an in-flight save may lock them.
 * 2. Anything that must lock uses the inert-readable floor: aria-disabled
 *    + .composer-control-inert + tabindex=-1, native disabled stays false
 *    so the value stays legible; syncDisabledReason pairs the reason.
 * 3. The settings popover is never force-closed by a transient disable —
 *    only a plugin-readonly surface or auth loss closes it.
 * 4. The queue button names the mode a queued message will run under
 *    ("Queue follow-up prompt — runs in Auto", spec §5); row 192 keeps it
 *    Send's size with an icon and adds the status line under the box.
 * 5. The composer.modelRuntimeMirror activity scope is vestigial (never
 *    begun anywhere) and its reads are gone.
 * 6. chatInput may draft while the model prepares; Send stays gated until
 *    the backend can actually take the message.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const chromeModulePath = require.resolve('../renderer/chat/renderer-render-pipeline-chrome');

function createHarness(t, {
  backendPhase = 'ready',
  sendBusy = false,
  ownsActiveStream = false,
  pluginSessionReadOnly = false,
  authenticated = true,
  runMode = 'ask',
  composerPopoverOpen = false,
  busyActivityScopes = [],
  draftText = 'Follow up',
  currentSessionId = 'session-1',
  approvalPending = false,
  timelineHtml = '',
} = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="composerWrap"></div>
    <div id="composer"></div>
    <textarea id="chatInput">${draftText}</textarea>
    <button id="sendButton" class="composer-send"></button>
    <button id="stopStreamButton"></button>
    <label class="composer-select-shell" for="composerModelSelect"><select id="composerModelSelect"><option value="">Default</option></select></label>
    <label class="composer-select-shell" for="composerEffortSelect"><select id="composerEffortSelect" data-reasoning-supported="true">
      <option value="default">Default</option>
    </select></label>
    <span id="composerModelDisabledReason"></span>
    <span id="composerEffortDisabledReason"></span>
    <div id="composerModeChips"><div id="composerModeChipsAnnouncer"></div><span id="composerTurnTimer"></span></div>
    <div id="composerRunModeSlot"><button id="composerRunModeChip"></button></div>
    <div id="chatTimeline">${timelineHtml}</div>
  </body>`);
  const previousWindow = global.window;
  const cachedChromeModule = require.cache[chromeModulePath];
  global.window = dom.window;
  delete require.cache[chromeModulePath];
  let createChromePipeline;
  try {
    ({ createChromePipeline } = require(chromeModulePath));
  } finally {
    if (cachedChromeModule) require.cache[chromeModulePath] = cachedChromeModule;
    else delete require.cache[chromeModulePath];
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }

  const document = dom.window.document;
  const byId = (id) => document.getElementById(id);
  const activityScopes = {
    composerPreferredModel: 'composerPreferredModel',
    composerReasoningEffort: 'composerReasoningEffort',
    composerRunMode: 'composerRunMode',
    composerModelRuntimeMirror: 'composerModelRuntimeMirror',
  };
  // Split view W3-1: a model/effort save is keyed by the session it saves
  // (activity-utils sessionScope); the harness saves on session-1.
  const SESSION_KEYED_SCOPES = new Set(['composerPreferredModel', 'composerReasoningEffort']);
  const busyScopes = new Set(busyActivityScopes.map((scope) => (SESSION_KEYED_SCOPES.has(scope) ? `${scope}:session-1` : scope)));
  const calls = { popoverClosed: 0, snapshotScopes: [] };
  const state = {
    currentSessionId,
    sessions: [{
      id: 'session-1',
      ...(pluginSessionReadOnly ? { session_type: 'plugin' } : {}),
    }],
    backend: { phase: backendPhase },
    auth: { authenticated },
    attachments: { queued: [] },
    queuedSendBySession: new Map(),
    ui: { activeView: 'chat', composerPopoverOpen, followLatest: true },
    status: {},
    modelList: {},
  };
  const pipeline = createChromePipeline({
    state,
    constants: { ACTIVITY_SCOPE: activityScopes },
    dom: {
      composerWrap: byId('composerWrap'),
      chatInput: byId('chatInput'),
      composer: byId('composer'),
      sendButton: byId('sendButton'),
      stopStreamButton: byId('stopStreamButton'),
      composerModelSelect: byId('composerModelSelect'),
      composerEffortSelect: byId('composerEffortSelect'),
      chatTimeline: byId('chatTimeline'),
    },
    callbacks: {
      hasPendingToolApprovalForSession: () => approvalPending,
      getCurrentRuntimePreferences: () => ({
        preferredModel: '',
        reasoningEffort: 'default',
        runMode,
        planMode: runMode === 'plan',
      }),
      isSendBusy: () => sendBusy,
      isSessionStreaming: () => ownsActiveStream,
      getActivitySnapshot: (scope) => {
        calls.snapshotScopes.push(scope);
        return { busy: busyScopes.has(scope) };
      },
      isActivityBusy: (activity) => activity?.busy === true,
      closeComposerPopover: () => {
        calls.popoverClosed += 1;
        state.ui.composerPopoverOpen = false;
      },
      resolveChatSendLifecycle: () => {
        if (ownsActiveStream) return 'streaming';
        return sendBusy ? 'preflight' : 'idle';
      },
    },
  });

  t.after(() => dom.window.close());
  return { document, pipeline, state, calls };
}

function assertUsable(document, id, label) {
  const control = document.getElementById(id);
  assert.equal(control.disabled, false, `${label}: not natively disabled`);
  assert.notEqual(control.getAttribute('aria-disabled'), 'true', `${label}: not aria-disabled`);
  assert.equal(control.classList.contains('composer-control-inert'), false, `${label}: not inert`);
  const shell = control.closest('.composer-select-shell');
  if (shell) {
    assert.equal(shell.classList.contains('composer-control-inert'), false, `${label}: shell label not inert`);
  }
}

function assertInertLocked(document, id, label) {
  const control = document.getElementById(id);
  assert.equal(control.disabled, false, `${label}: readable floor keeps native disabled off`);
  assert.equal(control.getAttribute('aria-disabled'), 'true', `${label}: aria-disabled`);
  assert.ok(control.classList.contains('composer-control-inert'), `${label}: inert class`);
  assert.equal(control.getAttribute('tabindex'), '-1', `${label}: out of the tab order`);
  // A wrapping <label> forwards clicks to the control even through the
  // control's own pointer-events: none — the shell must go inert with it.
  const shell = control.closest('.composer-select-shell');
  if (shell) {
    assert.ok(shell.classList.contains('composer-control-inert'), `${label}: shell label inert too`);
  }
}

for (const phase of ['sidecar_spawned', 'model_acquiring', 'model_loading', 'starting', 'retrying']) {
  test(`a PREPARING backend (${phase}) leaves model/effort/settings usable`, (t) => {
    const { document, pipeline } = createHarness(t, { backendPhase: phase });
    pipeline.renderComposerState();
    assertUsable(document, 'composerModelSelect', 'model select');
    assertUsable(document, 'composerEffortSelect', 'effort select');
    assert.equal(
      document.getElementById('composerModelDisabledReason').textContent, '',
      'no misleading offline copy while the model prepares'
    );
  });
}

test('while the model prepares, drafting stays available and Send queues into the open chat (row 62)', (t) => {
  const { document, pipeline } = createHarness(t, { backendPhase: 'model_loading' });
  pipeline.renderComposerState();
  assert.equal(document.getElementById('chatInput').disabled, false, 'typing a draft is harmless');
  assert.equal(document.getElementById('sendButton').disabled, false, 'Send queues until the engine is ready');
});

test('while the model prepares with no open chat, Send stays gated', (t) => {
  const { document, pipeline } = createHarness(t, { backendPhase: 'model_loading', currentSessionId: '' });
  pipeline.renderComposerState();
  assert.equal(document.getElementById('chatInput').disabled, false, 'typing a draft is harmless');
  assert.equal(document.getElementById('sendButton').disabled, true, 'a queued send needs a chat to land in');
});

for (const phase of ['stopped', 'stopping', 'error', 'no_such_phase']) {
  test(`an OFFLINE backend (${phase}) locks via the inert-readable floor with the offline reason`, (t) => {
    const { document, pipeline } = createHarness(t, { backendPhase: phase });
    pipeline.renderComposerState();
    assertInertLocked(document, 'composerModelSelect', 'model select');
    assertInertLocked(document, 'composerEffortSelect', 'effort select');
    assert.match(
      document.getElementById('composerModelDisabledReason').textContent,
      /backend is offline/, 'offline reason paired'
    );
    assert.equal(
      document.getElementById('composerModelSelect').getAttribute('aria-describedby'),
      'composerModelDisabledReason', 'aria-disabled controls still reference their reason'
    );
    assert.equal(document.getElementById('chatInput').disabled, true, 'input locks when genuinely offline');
  });
}

test('an in-flight preference save locks its own select via the inert floor', (t) => {
  const { document, pipeline } = createHarness(t, { busyActivityScopes: ['composerPreferredModel'] });
  pipeline.renderComposerState();
  assertInertLocked(document, 'composerModelSelect', 'model select');
  assertUsable(document, 'composerEffortSelect', 'effort select');
  assert.match(
    document.getElementById('composerModelDisabledReason').textContent,
    /being saved/, 'save-in-flight reason paired'
  );
});

test('a transient disable no longer force-closes an open settings popover', (t) => {
  const { pipeline, calls, state } = createHarness(t, {
    backendPhase: 'model_loading',
    composerPopoverOpen: true,
  });
  pipeline.renderComposerState();
  assert.equal(calls.popoverClosed, 0, 'phase flap must not snap the popover shut');
  assert.equal(state.ui.composerPopoverOpen, true);
});

test('a plugin-readonly surface still closes an open settings popover', (t) => {
  const { pipeline, calls } = createHarness(t, {
    pluginSessionReadOnly: true,
    composerPopoverOpen: true,
  });
  pipeline.renderComposerState();
  assert.equal(calls.popoverClosed, 1, 'hard surface change keeps the close');
});

test('auth loss still closes an open settings popover', (t) => {
  const { pipeline, calls } = createHarness(t, {
    authenticated: false,
    composerPopoverOpen: true,
  });
  pipeline.renderComposerState();
  assert.equal(calls.popoverClosed, 1);
});

// Row 192 C11: Queue keeps Send's round shape and size and shows an icon; the mode is in its name and tooltip.
test('the queue button names the mode a queued message will run under (spec §5)', (t) => {
  const { document, pipeline } = createHarness(t, {
    sendBusy: true,
    ownsActiveStream: true,
    runMode: 'auto',
  });
  pipeline.renderComposerState();
  const sendButton = document.getElementById('sendButton');
  assert.deepEqual([...sendButton.classList], ['composer-send', 'composer-send-queue', 'composer-send-queue--icon'], 'Send\'s own size class stays');
  assert.equal(sendButton.textContent, '', 'no words on the button: its width never changes');
  assert.ok(sendButton.querySelector(':scope > svg[aria-hidden="true"]'), 'the queue icon');
  assert.equal(sendButton.getAttribute('aria-label'), 'Queue follow-up prompt — runs in Auto');
  assert.equal(sendButton.getAttribute('title'), 'Queue this message. It runs in Auto when this turn ends.');
});

test('the queue button names Plan when a plan-mode turn is streaming', (t) => {
  const { document, pipeline } = createHarness(t, {
    sendBusy: true,
    ownsActiveStream: true,
    runMode: 'plan',
  });
  pipeline.renderComposerState();
  assert.equal(document.getElementById('sendButton').getAttribute('aria-label'), 'Queue follow-up prompt — runs in Plan');
});

const statusLine = (document) => document.querySelector('#composerModeChips > .composer-status-line');
const LIVE_TURN = (status) => '<div class="turn-row-list" data-turn-row-list data-turn-live="true">'
  + ['completed', status].map((rowStatus, index) => `<div class="chat-row" data-row-kind="tool_call"><div class="tool-call-row tool-call-row--minimal" data-tool-status="${rowStatus}">`
    + `<div class="tool-call-row-header"><div class="tool-call-row-toggle"><span class="tool-call-main"><span class="tool-call-name">${index ? 'Run command' : 'Read'}</span>`
    + `<span class="tool-call-summary tool-call-row-summary">${index ? 'npm test' : 'notes.md'}</span></span></div></div></div></div>`).join('')
  + '</div>';

test('while a reply runs with a draft, the status line says Jenny is working and that Enter queues', (t) => {
  const { document, pipeline } = createHarness(t, { sendBusy: true, ownsActiveStream: true, runMode: 'auto' });
  pipeline.renderComposerState();
  const line = statusLine(document);
  assert.ok(line, 'one status line under the box');
  assert.equal(line.nextElementSibling, document.getElementById('composerTurnTimer'), 'before the turn timer');
  assert.equal(line.getAttribute('role'), 'status');
  assert.ok(line.classList.contains('composer-loading-line'));
  assert.ok(line.querySelector('.status-dot.status-dot--active'));
  assert.equal(line.textContent, 'Jenny is working · Enter queues your message (runs in Auto)');
  pipeline.renderComposerState();
  assert.equal(document.querySelectorAll('.composer-status-line').length, 1, 'a render updates the line in place');
});

test('with an empty draft and a queued follow-up, Queue reads queued and the line drops the Enter hint', (t) => {
  const { document, pipeline, state } = createHarness(t, { sendBusy: true, ownsActiveStream: true, draftText: '' });
  state.queuedSendBySession.set('session-1', { text: 'Next' });
  pipeline.renderComposerState();
  const sendButton = document.getElementById('sendButton');
  assert.equal(sendButton.getAttribute('aria-label'), 'Queued follow-up — runs in Ask');
  assert.ok(sendButton.classList.contains('composer-send-queue--icon'));
  assert.equal(statusLine(document).textContent, 'Jenny is working');
});

test('the running step is named on the status line, and a step update is not announced', (t) => {
  const { document, pipeline } = createHarness(t, { sendBusy: true, ownsActiveStream: true, timelineHtml: LIVE_TURN('running') });
  pipeline.renderComposerState();
  const line = statusLine(document);
  assert.equal(line.textContent, 'Step 2 · Run command npm test · Enter queues your message (runs in Ask)');
  assert.equal(line.querySelector('.composer-status-line-text').getAttribute('aria-live'), 'off', 'steps change silently');
  const headed = createHarness(t, { sendBusy: true, ownsActiveStream: true,
    timelineHtml: LIVE_TURN('running').replace('data-turn-live="true">', 'data-turn-live="true"><div class="chat-row" data-row-kind="work_ledger" data-ledger-step="7"></div>') });
  headed.pipeline.renderComposerState();
  assert.match(statusLine(headed.document).textContent, /^Step 7 · /, 'the line takes the steps heading\'s own number');
});

test('an approval waiting turns the line into a polite question and keeps Send the arrow', (t) => {
  const { document, pipeline } = createHarness(t, { sendBusy: true, ownsActiveStream: true, approvalPending: true, timelineHtml: LIVE_TURN('running') });
  pipeline.renderComposerState();
  const line = statusLine(document);
  assert.equal(line.textContent, 'Waiting for your answer above.');
  assert.ok(line.querySelector('.status-dot.status-dot--pending'));
  assert.equal(line.querySelector('.composer-status-line-text').hasAttribute('aria-live'), false, 'announced once, politely');
  assert.equal(document.getElementById('sendButton').textContent, '↑');
});

test('a pending question card keeps Send the arrow (a typed send answers it)', (t) => {
  globalThis.rendererSendFlowHelpers = { findPendingUserQuestionRef: () => ({ id: 'q1' }), syncQuestionReplyPlaceholder: () => {} };
  t.after(() => { delete globalThis.rendererSendFlowHelpers; });
  const { document, pipeline } = createHarness(t, { sendBusy: true, ownsActiveStream: true });
  pipeline.renderComposerState();
  const sendButton = document.getElementById('sendButton');
  assert.equal(sendButton.textContent, '↑');
  assert.equal(sendButton.classList.contains('composer-send-queue'), false);
  assert.equal(statusLine(document).textContent, 'Waiting for your answer above.');
});

test('no status line when no reply runs, and the model-loading line keeps priority', (t) => {
  const idle = createHarness(t, {});
  idle.pipeline.renderComposerState();
  assert.equal(statusLine(idle.document), null);
  globalThis.rendererComposerV2Render = require('../renderer/chat/renderer-composer-v2-render');
  t.after(() => { delete globalThis.rendererComposerV2Render; });
  const loading = createHarness(t, { backendPhase: 'model_loading', sendBusy: true, ownsActiveStream: true });
  loading.state.backend.model_lifecycle = { requested_model: 'qwen3:8b' };
  loading.pipeline.renderComposerState();
  assert.ok(loading.document.getElementById('composerLoadingLine'), 'precondition: the loading line shows');
  assert.equal(statusLine(loading.document), null);
});

for (const [runMode, expectedHint] of [
  ['ask', 'Jenny asks before running tools that change things.'],
  ['auto', 'Tools and project Python run without asking. Blocked commands and denies prompt.'],
  ['plan', 'Read-only: Jenny plans first and presents it before acting.'],
]) {
  test(`syncRunModeChip puts the exact ${runMode} hint copy in the chip title`, (t) => {
    const { document, pipeline } = createHarness(t, { runMode });
    pipeline.renderComposerState();
    assert.equal(document.getElementById('composerRunModeChip').getAttribute('title').endsWith(` · ${expectedHint}`), true);
  });
}

test('the vestigial composer.modelRuntimeMirror activity scope is no longer read', (t) => {
  const { pipeline, calls } = createHarness(t, {});
  pipeline.renderComposerState();
  assert.equal(
    calls.snapshotScopes.includes('composerModelRuntimeMirror'), false,
    'the mirror activity was never begun anywhere; its reads are retired'
  );
});
