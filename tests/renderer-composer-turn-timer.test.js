'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const chromeModulePath = require.resolve('../renderer/chat/renderer-render-pipeline-chrome');
const {
  createTurnElapsedClock,
  formatElapsedLabel,
} = require('../renderer/chat/renderer-turn-elapsed-clock');

const ELAPSED_SELECTOR = '[data-turn-elapsed][data-elapsed-started-at]';

function createHarness(t, {
  currentSessionId = 'session-a',
  sendBusy = false,
  timerEnabled = true,
  turnClockEntries = [],
} = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="composerWrap">
      <div id="composer" class="composer"></div>
      <div id="composerModeChips">
        <div id="composerModeChipsAnnouncer"></div>
        <span id="composerRunModeHint"></span>
        <span id="composerTurnTimer" data-turn-timer-state="idle"></span>
      </div>
    </div>
    <textarea id="chatInput">Follow up</textarea>
    <button id="sendButton"></button>
    <button id="stopStreamButton"></button>
    <label class="composer-select-shell" for="composerModelSelect"><select id="composerModelSelect"><option value="">Default</option></select></label>
    <label class="composer-select-shell" for="composerEffortSelect"><select id="composerEffortSelect" data-reasoning-supported="true"><option value="default">Default</option></select></label>
    <button id="composerSettingsButton"></button>
    <span id="composerModelDisabledReason"></span>
    <span id="composerEffortDisabledReason"></span>
    <span id="composerSettingsDisabledReason"></span>
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
  const state = {
    currentSessionId,
    sessions: [{ id: 'session-a' }, { id: 'session-b' }],
    backend: { phase: 'ready' },
    auth: { authenticated: true },
    attachments: { queued: [] },
    queuedSendBySession: new Map(),
    turnClockBySession: new Map(turnClockEntries),
    features: { featureFlags: { composer_turn_timer: timerEnabled } },
    ui: { activeView: 'chat', composerPopoverOpen: false, commandPopoverOpen: false, followLatest: true },
    status: {},
    modelList: {},
  };
  const calls = { clockSync: 0 };
  const pipeline = createChromePipeline({
    state,
    constants: { ACTIVITY_SCOPE: {} },
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
      getCurrentRuntimePreferences: () => ({ preferredModel: '', reasoningEffort: 'default', runMode: 'ask' }),
      isSendBusy: () => typeof sendBusy === 'function' ? sendBusy(state.currentSessionId) : sendBusy,
      getActivitySnapshot: () => null,
      isActivityBusy: () => false,
      resolveChatSendLifecycle: () => 'idle',
      syncTurnElapsedClock: () => { calls.clockSync += 1; },
    },
  });

  t.after(() => dom.window.close());
  return { document, pipeline, state, calls };
}

test('busy running entry projects elapsed attributes and an immediate label', (t) => {
  const startedAt = Date.now() - 2_000;
  const { document, pipeline, calls } = createHarness(t, {
    sendBusy: true,
    turnClockEntries: [['session-a', { startedAt, endedAt: null }]],
  });

  pipeline.renderComposerState();

  const timer = document.getElementById('composerTurnTimer');
  assert.equal(timer.getAttribute('data-turn-elapsed'), 'true');
  assert.equal(timer.getAttribute('data-elapsed-started-at'), String(startedAt));
  assert.equal(timer.dataset.turnTimerState, 'running');
  assert.match(timer.textContent, /^\d+:\d{2}$/, 'immediate label is a formatted elapsed value');
  assert.equal(calls.clockSync, 1);
});

test('settled entry freezes its exact formatted total and strips ticker attributes', (t) => {
  const startedAt = 1_000;
  const endedAt = 63_000;
  const { document, pipeline } = createHarness(t, {
    turnClockEntries: [['session-a', { startedAt, endedAt }]],
  });

  pipeline.renderComposerState();

  const timer = document.getElementById('composerTurnTimer');
  assert.equal(timer.hasAttribute('data-turn-elapsed'), false);
  assert.equal(timer.hasAttribute('data-elapsed-started-at'), false);
  assert.equal(timer.dataset.turnTimerState, 'done');
  assert.equal(timer.textContent, formatElapsedLabel(endedAt - startedAt));
});

test('session switches re-derive timer state without cross-session bleed', (t) => {
  const startedAt = Date.now() - 3_000;
  const { document, pipeline, state } = createHarness(t, {
    sendBusy: (sessionId) => sessionId === 'session-a',
    turnClockEntries: [['session-a', { startedAt, endedAt: null }]],
  });

  pipeline.renderComposerState();
  const timer = document.getElementById('composerTurnTimer');
  assert.equal(timer.dataset.turnTimerState, 'running');
  assert.notEqual(timer.textContent, '');

  state.currentSessionId = 'session-b';
  pipeline.renderComposerState();
  assert.equal(timer.dataset.turnTimerState, 'idle');
  assert.equal(timer.textContent, '');
  assert.equal(timer.hasAttribute('data-turn-elapsed'), false);
  assert.equal(timer.hasAttribute('data-elapsed-started-at'), false);
});

test('a running entry derives its terminal stamp when send-busy is already false', (t) => {
  const entry = { startedAt: Date.now() - 1_000, endedAt: null };
  const { document, pipeline, state } = createHarness(t, {
    sendBusy: false,
    turnClockEntries: [['session-a', entry]],
  });

  pipeline.renderComposerState();

  assert.equal(Number.isFinite(entry.endedAt), true);
  assert.equal(state.turnClockBySession.get('session-a'), entry);
  const timer = document.getElementById('composerTurnTimer');
  assert.equal(timer.dataset.turnTimerState, 'done');
  assert.equal(timer.textContent, formatElapsedLabel(entry.endedAt - entry.startedAt));
});

test('flag-off projection stays empty even when the current entry is running', (t) => {
  const { document, pipeline } = createHarness(t, {
    sendBusy: true,
    timerEnabled: false,
    turnClockEntries: [['session-a', { startedAt: Date.now() - 5_000, endedAt: null }]],
  });

  pipeline.renderComposerState();

  const timer = document.getElementById('composerTurnTimer');
  assert.equal(timer.hasAttribute('data-turn-elapsed'), false);
  assert.equal(timer.hasAttribute('data-elapsed-started-at'), false);
  assert.equal(timer.dataset.turnTimerState, 'idle');
  assert.equal(timer.textContent, '');
});

function createFakeTimerNode(startedAt) {
  const attrs = new Map([
    ['data-turn-elapsed', 'true'],
    ['data-elapsed-started-at', String(startedAt)],
  ]);
  let text = '';
  return {
    get textContent() { return text; },
    set textContent(value) { text = String(value); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    removeAttribute(name) { attrs.delete(name); },
    hasAttribute(name) { return attrs.has(name); },
  };
}

function createFakeMetaRow(nodes) {
  return {
    querySelectorAll(selector) {
      if (selector !== ELAPSED_SELECTOR) return [];
      return nodes.filter((node) => node.hasAttribute('data-turn-elapsed')
        && node.hasAttribute('data-elapsed-started-at'));
    },
  };
}

function createFakeTimers() {
  let nextId = 1;
  const intervals = new Map();
  return {
    setInterval(callback) {
      const id = nextId;
      nextId += 1;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    advance() {
      for (const callback of Array.from(intervals.values())) callback();
    },
  };
}

test('the real elapsed clock advances inside the meta row and self-stops after settle stripping', () => {
  const timer = createFakeTimerNode(1_000);
  const metaRow = createFakeMetaRow([timer]);
  const timers = createFakeTimers();
  let now = 5_000;
  const clock = createTurnElapsedClock({
    getRoot: () => metaRow,
    getNow: () => now,
    timers,
  });

  clock.sync();
  assert.equal(timer.textContent, '0:04');
  now = 6_000;
  timers.advance();
  assert.equal(timer.textContent, '0:05');

  timer.removeAttribute('data-turn-elapsed');
  timer.removeAttribute('data-elapsed-started-at');
  timers.advance();
  assert.equal(clock.isRunning(), false);
});
