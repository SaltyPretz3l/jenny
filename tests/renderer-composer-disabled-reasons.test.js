'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { syncDisabledReason } = require('../renderer/chat/renderer-render-pipeline-chrome');
const visionGateModule = require('../renderer/chat/renderer-composer-vision-gate');
const { mountTurnPauseButton } = require('../renderer/chat/renderer-turn-pause-interaction');
const inventoryActionButton = require('../renderer/inventory/action-button');

test('natively disabled and aria-disabled composer controls expose and clear programmatic reason text', () => {
  const dom = new JSDOM('<button id="control"></button><span id="reason"></span>');
  const control = dom.window.document.getElementById('control');
  const reason = dom.window.document.getElementById('reason');
  control.disabled = true;
  syncDisabledReason(control, reason, 'Wait for the current response to finish.');
  assert.equal(control.getAttribute('aria-describedby'), 'reason');
  assert.equal(reason.textContent, 'Wait for the current response to finish.');
  control.disabled = false;
  control.setAttribute('aria-disabled', 'true');
  syncDisabledReason(control, reason, 'This value is read-only.');
  assert.equal(control.getAttribute('aria-describedby'), 'reason');
  assert.equal(reason.textContent, 'This value is read-only.');
  control.removeAttribute('aria-disabled');
  syncDisabledReason(control, reason, 'stale reason');
  assert.equal(control.hasAttribute('aria-describedby'), false);
  assert.equal(reason.textContent, '');
});

const chromeModulePath = require.resolve('../renderer/chat/renderer-render-pipeline-chrome');
const harnessExtras = new WeakMap();

function createComposerRenderHarness(t, {
  sendBusy = false,
  ownsActiveStream = false,
  pluginSessionReadOnly = false,
  authenticated = true,
  backendComposerUsable = true,
  reasoningEffortSupported = true,
  busyActivityScopes = [],
  sessionRuntime = false,
  runtimeSendController = null,
  mountPause = true,
  activeStreamId = 'stream-1',
} = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="composerWrap"></div>
    <div id="composer"></div>
    <textarea id="chatInput">Follow up</textarea>
    <button id="sendButton"></button>
    <span id="composerSendDisabledReason"></span>
    <div id="composerStatusNotice"></div>
    <button id="stopStreamButton"></button>
    <select id="composerModelSelect"><option value="">Default</option></select>
    <select id="composerEffortSelect" data-reasoning-supported="${reasoningEffortSupported}">
      <option value="default">Default</option>
    </select>
    <button id="composerSettingsButton"></button>
    <span id="composerModelDisabledReason"></span>
    <span id="composerEffortDisabledReason"></span>
    <span id="composerSettingsDisabledReason"></span>
  </body>`);
  const previousWindow = global.window;
  const previousVisionGate = global.rendererComposerVisionGate;
  const cachedChromeModule = require.cache[chromeModulePath];
  global.window = dom.window;
  global.rendererComposerVisionGate = visionGateModule;
  dom.window.rendererComposerVisionGate = visionGateModule;
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
  // Pause is not in the markup: the shell builds it beside Stop through the
  // inventory primitive at boot, so the harness does the same.
  const mountPauseButton = () => mountTurnPauseButton({ anchor: byId('stopStreamButton'), actionButton: inventoryActionButton });
  if (mountPause) mountPauseButton();
  const activityScopes = {
    composerPreferredModel: 'composerPreferredModel',
    composerReasoningEffort: 'composerReasoningEffort',
    composerRunMode: 'composerRunMode',
  };
  const busyScopes = new Set(busyActivityScopes);
  const state = {
    currentSessionId: 'session-1',
    sessions: [{
      id: 'session-1',
      ...(pluginSessionReadOnly ? { session_type: 'plugin' } : {}),
    }],
    backend: { phase: backendComposerUsable ? 'ready' : 'offline' },
    features: { featureFlags: { session_runtime: sessionRuntime === true } },
    runtimeSendController,
    activeStreamId: ownsActiveStream ? activeStreamId : '',
    auth: { authenticated },
    attachments: { queued: [] },
    queuedSendBySession: new Map(),
    ui: { activeView: 'chat', composerPopoverOpen: false, followLatest: true },
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
        planMode: false,
      }),
      isSendBusy: () => sendBusy,
      isSessionStreaming: () => ownsActiveStream,
      getActivitySnapshot: (scope) => ({ busy: busyScopes.has(scope) }),
      isActivityBusy: (activity) => activity?.busy === true,
      resolveChatSendLifecycle: () => {
        if (ownsActiveStream) return 'streaming';
        return sendBusy ? 'preflight' : 'idle';
      },
    },
  });
  harnessExtras.set(pipeline, { mountPauseButton });

  t.after(() => {
    dom.window.close();
    if (previousVisionGate === undefined) delete global.rendererComposerVisionGate;
    else global.rendererComposerVisionGate = previousVisionGate;
  });
  return { document, pipeline, state };
}

test('mid-turn render keeps the model and effort selectors usable', (t) => {
  const { document, pipeline } = createComposerRenderHarness(t, { sendBusy: true });

  pipeline.renderComposerState();

  assert.equal(document.getElementById('composerModelSelect').disabled, false);
  assert.equal(document.getElementById('composerEffortSelect').disabled, false);
  assert.equal(document.getElementById('composerSettingsButton').disabled, false);
});

test('preflight keeps the send control and the input locked', (t) => {
  const { document, pipeline } = createComposerRenderHarness(t, { sendBusy: true });

  pipeline.renderComposerState();

  // Both of these read `sendBusy && !queueEligible`, so they hold only while that
  // term survives: this is the guard that stops the fix from becoming "delete
  // every sendBusy gate". stopStreamButton is deliberately NOT asserted here —
  // its disabled state is `!ownsActiveStream || isSendPreflightPending()`, which
  // carries no sendBusy term and would stay true no matter what was removed.
  assert.equal(document.getElementById('sendButton').disabled, true);
  assert.equal(document.getElementById('chatInput').disabled, true);
});

test('while the turn is actually streaming, both selectors stay usable', (t) => {
  const { document, pipeline } = createComposerRenderHarness(t, {
    sendBusy: true,
    ownsActiveStream: true,
  });

  pipeline.renderComposerState();

  // isSendBusy() alone is only the preflight sliver; this is the state the owner
  // reported, and queueEligible flips with it.
  assert.equal(document.getElementById('composerModelSelect').disabled, false);
  assert.equal(document.getElementById('composerEffortSelect').disabled, false);
  // Send/stop keep their real streaming behaviour: the send control becomes the
  // one-deep queue affordance and stop is live.
  assert.equal(document.getElementById('sendButton').textContent, 'Queue — runs in Ask');
  assert.equal(document.getElementById('stopStreamButton').disabled, false);
});

test('surviving shared reasons still disable both selectors', (t) => {
  const cases = [
    ['plugin session', { pluginSessionReadOnly: true }],
    ['unauthenticated session', { authenticated: false }],
    ['unusable backend', { backendComposerUsable: false }],
  ];

  for (const [label, options] of cases) {
    const { document, pipeline } = createComposerRenderHarness(t, options);
    pipeline.renderComposerState();
    for (const id of ['composerModelSelect', 'composerEffortSelect']) {
      const control = document.getElementById(id);
      assert.equal(control.disabled, false, `${label}: native disabled stays off`);
      assert.equal(control.getAttribute('aria-disabled'), 'true', `${label}: aria-disabled`);
      assert.ok(control.classList.contains('composer-control-inert'), `${label}: inert class`);
      assert.equal(control.getAttribute('tabindex'), '-1', `${label}: removed from tab order`);
    }
  }
});

test('per-select activity and support reasons remain enforced', (t) => {
  const modelActivityHarness = createComposerRenderHarness(t, {
    busyActivityScopes: ['composerPreferredModel'],
  });
  modelActivityHarness.pipeline.renderComposerState();
  assert.equal(
    modelActivityHarness.document.getElementById('composerModelSelect').getAttribute('aria-disabled'),
    'true'
  );

  const effortActivityHarness = createComposerRenderHarness(t, {
    busyActivityScopes: ['composerReasoningEffort'],
  });
  effortActivityHarness.pipeline.renderComposerState();
  assert.equal(
    effortActivityHarness.document.getElementById('composerEffortSelect').getAttribute('aria-disabled'),
    'true'
  );

  const unsupportedHarness = createComposerRenderHarness(t, { reasoningEffortSupported: false });
  unsupportedHarness.pipeline.renderComposerState();
  assert.equal(
    unsupportedHarness.document.getElementById('composerEffortSelect').getAttribute('aria-disabled'),
    'true'
  );
});

test('mid-turn render leaves no disabled reason or ARIA reference on either selector', (t) => {
  const { document, pipeline } = createComposerRenderHarness(t, { sendBusy: true });

  pipeline.renderComposerState();

  for (const [controlId, reasonId] of [
    ['composerModelSelect', 'composerModelDisabledReason'],
    ['composerEffortSelect', 'composerEffortDisabledReason'],
  ]) {
    assert.equal(document.getElementById(reasonId).textContent, '');
    assert.equal(document.getElementById(controlId).hasAttribute('aria-describedby'), false);
  }
});

test('composer vision gate disables and clears Send as model capability and image count change', (t) => {
  const { document, pipeline, state } = createComposerRenderHarness(t);
  state.attachments.queued = [{ kind: 'image' }];
  state.status = {
    model: 'text-only',
    local_runtime: { capabilities: { vision: { available: false, source: 'unsupported' } } },
  };

  pipeline.renderComposerState();
  assert.equal(document.getElementById('sendButton').disabled, true);
  assert.equal(
    document.getElementById('composerSendDisabledReason').textContent,
    'Remove the image or choose a vision model to send.'
  );

  state.status.local_runtime.capabilities.vision.available = true;
  pipeline.renderComposerState();
  assert.equal(document.getElementById('sendButton').disabled, false);
  assert.equal(document.getElementById('composerSendDisabledReason').textContent, '');

  state.attachments.queued = Array.from({ length: 5 }, () => ({ kind: 'image' }));
  pipeline.renderComposerState();
  assert.equal(document.getElementById('sendButton').disabled, true);
  assert.equal(document.getElementById('composerSendDisabledReason').textContent, 'Remove 1 image to send.');
});

/* ── Runtime UX A2 (JEN-044): the composer Pause control ── */

function pauseController({ pause = null, closing = false, reads = [], owned = ['stream-1'] } = {}) {
  return {
    pauseSession() {},
    ownsStream: (streamId) => owned.includes(streamId),
    listPending: () => [],
    getSessionRuntimeState: () => ({ closing, pause }),
    refreshSessionRows: (sessionId) => { reads.push(sessionId); return Promise.resolve(true); },
  };
}

const streaming = { sendBusy: true, ownsActiveStream: true };

test('Pause appears beside Stop only while the runtime owns a reply in progress', (t) => {
  const idle = createComposerRenderHarness(t, { sessionRuntime: true, runtimeSendController: pauseController() });
  idle.pipeline.renderComposerState();
  assert.equal(idle.document.getElementById('pauseTurnButton').classList.contains('hidden'), true);
  assert.equal(idle.document.getElementById('stopStreamButton').classList.contains('hidden'), true);

  const live = createComposerRenderHarness(t, { ...streaming, sessionRuntime: true, runtimeSendController: pauseController() });
  live.pipeline.renderComposerState();
  const button = live.document.getElementById('pauseTurnButton');
  assert.equal(button.classList.contains('hidden'), false);
  assert.equal(button.disabled, false);
  assert.equal(button.title, 'Pause at the next approval');
  assert.equal(button.getAttribute('aria-label'), 'Pause this reply');
  assert.equal(Object.hasOwn(button.dataset, 'pauseState'), false);
});

test('the chrome finds a Pause control mounted after its first render, beside Stop, with no markup of its own', (t) => {
  const { document, pipeline } = createComposerRenderHarness(t, { ...streaming, sessionRuntime: true,
    runtimeSendController: pauseController(), mountPause: false });
  pipeline.renderComposerState();
  assert.equal(document.getElementById('pauseTurnButton'), null, 'nothing is invented before the shell mounts it');
  const button = harnessExtras.get(pipeline).mountPauseButton();
  assert.equal(button.nextElementSibling, document.getElementById('stopStreamButton'), 'Pause sits directly before Stop');
  assert.equal(button.classList.contains('hidden'), true, 'mounted hidden until the chrome shows it');
  pipeline.renderComposerState();
  assert.equal(button.classList.contains('hidden'), false);
  assert.equal(button.getAttribute('aria-label'), 'Pause this reply');
  assert.ok(button.querySelector('svg'), 'the glyph rides in through the primitive');
});

test('Pause stays hidden without the session runtime flag, without a controller, and in a plugin transcript', (t) => {
  const off = createComposerRenderHarness(t, { ...streaming, runtimeSendController: pauseController() });
  off.pipeline.renderComposerState();
  assert.equal(off.document.getElementById('pauseTurnButton').classList.contains('hidden'), true);

  const noController = createComposerRenderHarness(t, { ...streaming, sessionRuntime: true });
  noController.pipeline.renderComposerState();
  assert.equal(noController.document.getElementById('pauseTurnButton').classList.contains('hidden'), true);

  const plugin = createComposerRenderHarness(t, { ...streaming, sessionRuntime: true,
    pluginSessionReadOnly: true, runtimeSendController: pauseController() });
  plugin.pipeline.renderComposerState();
  assert.equal(plugin.document.getElementById('pauseTurnButton').classList.contains('hidden'), true);
});

test('Pause stays hidden for a reply the runtime did not admit, even while Stop shows', (t) => {
  const legacy = createComposerRenderHarness(t, { ...streaming, sessionRuntime: true,
    activeStreamId: 'stream-legacy', runtimeSendController: pauseController() });
  legacy.pipeline.renderComposerState();
  assert.equal(legacy.document.getElementById('stopStreamButton').classList.contains('hidden'), false);
  assert.equal(legacy.document.getElementById('pauseTurnButton').classList.contains('hidden'), true,
    'an edit, a retry or a legacy stream has no running work to pause');

  const owned = createComposerRenderHarness(t, { ...streaming, sessionRuntime: true,
    activeStreamId: 'stream-legacy', runtimeSendController: pauseController({ owned: ['stream-legacy'] }) });
  owned.pipeline.renderComposerState();
  assert.equal(owned.document.getElementById('pauseTurnButton').classList.contains('hidden'), false);
});

test('a requested pause disables the control and claims only that it was requested', (t) => {
  const { document, pipeline } = createComposerRenderHarness(t, { ...streaming, sessionRuntime: true,
    runtimeSendController: pauseController({ pause: { workId: 'work_1', status: 'requested' } }) });
  pipeline.renderComposerState();
  const button = document.getElementById('pauseTurnButton');
  assert.equal(button.classList.contains('hidden'), false);
  assert.equal(button.disabled, true);
  assert.equal(button.dataset.pauseState, 'requested');
  assert.equal(button.title, 'Pause requested…');
  assert.equal(button.getAttribute('aria-label'), 'Pause requested…');
  assert.equal(/\bpaused\b/i.test(button.title), false, 'a request never reads as a pause');
});

test('the composer reads session work rows once per conversation activation, never per render', (t) => {
  const reads = [];
  const { pipeline, state } = createComposerRenderHarness(t, { sessionRuntime: true,
    runtimeSendController: pauseController({ reads }) });
  for (let i = 0; i < 12; i += 1) pipeline.renderComposerState();
  assert.deepEqual(reads, ['session-1'], 'an idle conversation with no runtime work is read once, not on every keystroke');
  state.currentSessionId = 'session-2';
  state.sessions.push({ id: 'session-2' });
  pipeline.renderComposerState();
  pipeline.renderComposerState();
  assert.deepEqual(reads, ['session-1', 'session-2']);
  state.currentSessionId = 'session-1';
  pipeline.renderComposerState();
  assert.deepEqual(reads, ['session-1', 'session-2', 'session-1'], 'coming back re-reads, so a reply paused meanwhile shows');
});

/* ── Runtime queue strip: only rows that wait behind other work reach it ── */

test('the runtime queue strip receives queued and recovery rows only; a direct Send stays out', (t) => {
  const rows = [
    { key: 'direct', workId: '', turnId: '', prompt: 'direct', position: null, status: 'pending', admitted: false, queued: false },
    { key: 'waiting', workId: 'work_2', turnId: '', prompt: 'waiting', position: 2, status: 'pending', admitted: false, queued: true },
    // An older producer without the field is still shown; only an explicit false is filtered.
    { key: 'paused', workId: 'work_3', turnId: '', prompt: 'paused', position: null, status: 'paused', admitted: true },
  ];
  const captured = [];
  const previous = global.rendererRuntimeQueueView;
  global.rendererRuntimeQueueView = { renderRuntimeQueue: (options) => { captured.push(options.rows); return options.rows.length; } };
  t.after(() => { if (previous === undefined) delete global.rendererRuntimeQueueView; else global.rendererRuntimeQueueView = previous; });
  const h = createComposerRenderHarness(t, { sessionRuntime: true,
    runtimeSendController: { ...pauseController(), listPending: () => rows } });
  h.pipeline.renderComposerState();
  assert.deepEqual(captured.at(-1).map((row) => row.key), ['waiting', 'paused']);
});
