'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { syncDisabledReason } = require('../renderer/chat/renderer-render-pipeline-chrome');
const visionGateModule = require('../renderer/chat/renderer-composer-vision-gate');

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

function createComposerRenderHarness(t, {
  sendBusy = false,
  ownsActiveStream = false,
  pluginSessionReadOnly = false,
  authenticated = true,
  backendComposerUsable = true,
  reasoningEffortSupported = true,
  busyActivityScopes = [],
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
