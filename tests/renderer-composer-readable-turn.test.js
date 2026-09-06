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
 * 4. The queue pill surfaces the mode a queued message will run under
 *    ("Queue — runs in Auto", spec §5).
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
} = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="composerWrap"></div>
    <div id="composer"></div>
    <textarea id="chatInput">${draftText}</textarea>
    <button id="sendButton"></button>
    <button id="stopStreamButton"></button>
    <label class="composer-select-shell" for="composerModelSelect"><select id="composerModelSelect"><option value="">Default</option></select></label>
    <label class="composer-select-shell" for="composerEffortSelect"><select id="composerEffortSelect" data-reasoning-supported="true">
      <option value="default">Default</option>
    </select></label>
    <button id="composerSettingsButton"></button>
    <span id="composerModelDisabledReason"></span>
    <span id="composerEffortDisabledReason"></span>
    <span id="composerSettingsDisabledReason"></span>
    <div id="composerModeChips"><div id="composerModeChipsAnnouncer"></div><span id="composerRunModeHint"></span></div>
    <div id="composerRunModeSlot"><button id="composerRunModeChip"></button></div>
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
  const busyScopes = new Set(busyActivityScopes);
  const calls = { popoverClosed: 0, snapshotScopes: [] };
  const state = {
    currentSessionId: 'session-1',
    sessions: [{
      id: 'session-1',
      ...(pluginSessionReadOnly ? { session_type: 'plugin' } : {}),
    }],
    backend: { phase: backendPhase },
    auth: { authenticated },
    attachments: { queued: [] },
    queuedSendBySession: new Map(),
    ui: { activeView: 'chat', composerPopoverOpen, commandPopoverOpen: false, followLatest: true },
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
      composerSettingsButton: byId('composerSettingsButton'),
    },
    callbacks: {
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
    assertUsable(document, 'composerSettingsButton', 'settings gear');
    assert.equal(
      document.getElementById('composerModelDisabledReason').textContent, '',
      'no misleading offline copy while the model prepares'
    );
  });
}

test('drafting stays available while the model prepares; Send stays gated', (t) => {
  const { document, pipeline } = createHarness(t, { backendPhase: 'model_loading' });
  pipeline.renderComposerState();
  assert.equal(document.getElementById('chatInput').disabled, false, 'typing a draft is harmless');
  assert.equal(document.getElementById('sendButton').disabled, true, 'sending still needs a usable backend');
});

for (const phase of ['stopped', 'stopping', 'error', 'no_such_phase']) {
  test(`an OFFLINE backend (${phase}) locks via the inert-readable floor with the offline reason`, (t) => {
    const { document, pipeline } = createHarness(t, { backendPhase: phase });
    pipeline.renderComposerState();
    assertInertLocked(document, 'composerModelSelect', 'model select');
    assertInertLocked(document, 'composerEffortSelect', 'effort select');
    assertInertLocked(document, 'composerSettingsButton', 'settings gear');
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

test('the queue pill surfaces the mode a queued message will run under (spec §5)', (t) => {
  const { document, pipeline } = createHarness(t, {
    sendBusy: true,
    ownsActiveStream: true,
    runMode: 'auto',
  });
  pipeline.renderComposerState();
  const sendButton = document.getElementById('sendButton');
  assert.equal(sendButton.textContent, 'Queue — runs in Auto');
  assert.match(sendButton.getAttribute('aria-label'), /runs in Auto/);
});

test('the queue pill names Plan when a plan-mode turn is streaming', (t) => {
  const { document, pipeline } = createHarness(t, {
    sendBusy: true,
    ownsActiveStream: true,
    runMode: 'plan',
  });
  pipeline.renderComposerState();
  assert.equal(document.getElementById('sendButton').textContent, 'Queue — runs in Plan');
});

for (const [runMode, expectedHint] of [
  ['ask', 'Jenny asks before running tools that change things.'],
  ['auto', 'Tools run without asking. Python, blocked commands, and explicit denies still prompt.'],
  ['plan', 'Read-only: Jenny plans first and presents it before acting.'],
]) {
  test(`syncRunModeChip renders the exact ${runMode} hint copy`, (t) => {
    const { document, pipeline } = createHarness(t, { runMode });
    pipeline.renderComposerState();
    assert.equal(document.getElementById('composerRunModeHint').textContent, expectedHint);
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
