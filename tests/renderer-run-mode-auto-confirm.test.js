'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createSettingsEventBindings,
} = require('../renderer/chat/renderer-chat-event-settings-bindings');
const {
  createComposerV2FlowController,
} = require('../renderer/chat/renderer-composer-v2-flow');
const {
  createHealthPillController,
} = require('../renderer/shell/renderer-health-pill-utils');
const {
  buildPillMarkup,
  buildPopoverMarkup,
} = require('../renderer/shell/renderer-health-pill-markup-utils');
const {
  buildDefaultRunModeFieldMarkup,
} = require('../renderer/shell/renderer-settings-support');

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function restoreGlobal(key, previous) {
  if (previous === undefined) {
    delete globalThis[key];
  } else {
    globalThis[key] = previous;
  }
}

function createRunModeHarness(t, options = {}) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  function appendElement(tagName, id, parent = doc.body) {
    const element = doc.createElement(tagName);
    element.id = id;
    parent.appendChild(element);
    return element;
  }
  appendElement('div', 'toastViewport');
  appendElement('select', 'composerModelSelect');
  appendElement('select', 'composerEffortSelect');
  appendElement('button', 'composerSettingsButton');
  appendElement('button', 'openComposerSettingsViewButton');
  const runModeSlot = appendElement('div', 'composerRunModeSlot');
  appendElement('button', 'composerRunModeChip', runModeSlot);
  appendElement('div', 'composerModeChipsAnnouncer');
  const previous = {
    document: globalThis.document,
    rendererIdeConfirmDialog: globalThis.rendererIdeConfirmDialog,
    inventoryActionButton: globalThis.inventoryActionButton,
    inventoryHelpOverlay: globalThis.inventoryHelpOverlay,
    rendererHealthPillController: globalThis.rendererHealthPillController,
    rendererRunModeControl: globalThis.rendererRunModeControl,
  };
  globalThis.document = dom.window.document;
  globalThis.inventoryActionButton = function actionButton() { return ''; };
  globalThis.inventoryHelpOverlay = { createHelpOverlay() {} };

  const calls = { confirm: [], logs: [], persistence: [], toasts: [], refreshes: 0 };
  const prefs = { runMode: options.runMode || 'ask' };
  const confirmation = options.confirmation || (() => Promise.resolve(true));
  if (options.withDialog !== false) {
    globalThis.rendererIdeConfirmDialog = {
      createIdeConfirmDialog(config) {
        calls.dialogConfig = config;
        return {
          confirm(configure) {
            calls.confirm.push(configure);
            return confirmation();
          },
        };
      },
    };
  } else {
    delete globalThis.rendererIdeConfirmDialog;
  }
  globalThis.rendererHealthPillController = {
    refreshRunModeFacet() { calls.refreshes += 1; },
  };

  const bindings = createSettingsEventBindings({
    getAutoRunWarningStorage: () => options.storage,
    toastViewport: doc.getElementById('toastViewport'),
    composerModelSelect: doc.getElementById('composerModelSelect'),
    composerEffortSelect: doc.getElementById('composerEffortSelect'),
    composerSettingsButton: doc.getElementById('composerSettingsButton'),
    openComposerSettingsViewButton: doc.getElementById('openComposerSettingsViewButton'),
    state: { ui: {}, models: {}, modelList: {}, unattendedGuardMinutes: options.unattendedGuardMinutes ?? 0 },
    TOAST_SOURCE: { memory: 'memory', composerAction: 'composer' },
    ACTIVITY_SCOPE: {
      composerPreferredModel: 'model',
      composerReasoningEffort: 'effort',
      composerRunMode: 'run-mode',
    },
    dismissToast() {},
    appendClientLog(level, event, details) { calls.logs.push({ level, event, details }); },
    showShellErrorToast() {},
    showToastMessage(message) { calls.toasts.push(message); },
    toErrorMessage(error) { return String(error); },
    getRuntimePreferenceSnapshot() { return { ...prefs }; },
    runRuntimePreferenceActivity(activity) {
      calls.persistence.push(activity);
      Object.assign(prefs, activity.patch);
      return Promise.resolve({});
    },
    getCurrentRuntimePreferences() { return prefs; },
    showComposerActionError() {},
    closeComposerPopover() {},
    openComposerPopover() {},
    setActiveView() {},
    setComposerStatusNotice() {},
    clearComposerStatusNotice() {},
    toastActionHandlers: new Map(),
  });
  bindings.bindSettingsEvents((element, type, handler) => {
    element?.addEventListener?.(type, handler);
  }, {});

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    bindings.dispose();
    restoreGlobal('document', previous.document);
    restoreGlobal('rendererIdeConfirmDialog', previous.rendererIdeConfirmDialog);
    restoreGlobal('inventoryActionButton', previous.inventoryActionButton);
    restoreGlobal('inventoryHelpOverlay', previous.inventoryHelpOverlay);
    restoreGlobal('rendererHealthPillController', previous.rendererHealthPillController);
    restoreGlobal('rendererRunModeControl', previous.rendererRunModeControl);
    dom.window.close();
  }
  t.after(cleanup);
  return { bindings, calls, cleanup, prefs, control: globalThis.rendererRunModeControl };
}

function createSendHarness(prompt = 'hello') {
  const calls = [];
  const chatInput = { value: prompt };
  const controller = createComposerV2FlowController({
    chatInput,
    startPromptSend: async (...args) => { calls.push(args); },
    state: { currentSessionId: 'session-1', sessions: [{ id: 'session-1' }] },
  });
  return { calls, chatInput, controller };
}

function createInteractiveSendHarness() {
  const batch = {
    batch_id: 'batch-1',
    round_index: 1,
    questions: [{ id: 'question-1' }],
  };
  const draft = {
    batchId: batch.batch_id,
    selections: {},
    customModeByQuestionId: {},
    customTextByQuestionId: {},
    skippedByQuestionId: {},
  };
  const calls = [];
  const state = {
    currentSessionId: 'session-1',
    sessions: [{ id: 'session-1', pending_question_batch: batch }],
  };
  const controller = createComposerV2FlowController({
    INTERACTIVE_GUARDRAIL_PROMPT: 'Use the best available answer.',
    INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback_requested',
    buildInteractiveAnswerPrompt: () => 'Selected answer.',
    buildInteractiveSelectedAnswers: () => [],
    chatInput: { value: '' },
    ensureInteractiveDraft: () => draft,
    getInteractiveDraft: () => draft,
    getPendingQuestionBatch: () => batch,
    isInteractiveQuestionAnswered: () => true,
    normalizePendingQuestionBatch: (value) => value,
    patchSessionSummary() {},
    startPromptSend: async (...args) => { calls.push(args); },
    state,
    windowRef: { jennyShell: { sessions: { setPreferences: async () => ({}) } } },
  });
  return { batch, calls, controller };
}

async function runInteractiveSendPaths(harness) {
  await harness.controller.handleInteractiveSubmit(harness.batch.batch_id);
  await harness.controller.handleInteractiveSkip(harness.batch.batch_id);
  await harness.controller.requestInteractiveGuardrailAnswer('session-1', harness.batch);
}

function readySnapshot() {
  return {
    runtime: {
      engine: 'ollama',
      model: 'ornith:9b',
      model_loaded: true,
      lifecycle: { available: true, state: 'ready', phase: 'ready' },
      provider_capability_profiles: [],
      recent_tool_observations: [],
    },
  };
}

test('Auto mode cancellation leaves the current mode and toast state unchanged', async (t) => {
  const harness = createRunModeHarness(t, { confirmation: () => Promise.resolve(false) });

  assert.equal(await harness.control.setRunMode('auto'), false);
  assert.equal(harness.prefs.runMode, 'ask');
  assert.equal(harness.calls.persistence.length, 0);
  assert.equal(harness.calls.toasts.length, 0);
  assert.equal(harness.calls.confirm.length, 1);
  assert.equal(harness.calls.confirm[0].title, 'Turn on Auto run?');
  assert.equal(harness.calls.confirm[0].confirmLabel, 'Turn on Auto');
  assert.equal(harness.calls.confirm[0].cancelLabel, 'Cancel');
  assert.equal(harness.calls.confirm[0].variant, 'danger');
});

test('confirmed Auto mode does not prompt again in the same renderer instance', async (t) => {
  const harness = createRunModeHarness(t);
  const initialRefreshes = harness.calls.refreshes;

  assert.equal(await harness.control.setRunMode('auto'), true);
  assert.equal(await harness.control.setRunMode('ask'), true);
  assert.equal(await harness.control.setRunMode('auto'), true);
  assert.equal(harness.calls.confirm.length, 1);
  assert.equal(initialRefreshes, 1, 'registration refreshes an already-mounted health pill');
  assert.equal(harness.calls.refreshes, initialRefreshes + 3);
});

test('overlapping Auto mode requests share one confirmation dialog', async (t) => {
  const gate = deferred();
  const harness = createRunModeHarness(t, { confirmation: () => gate.promise });

  const first = harness.control.setRunMode('auto');
  const second = harness.control.setRunMode('auto');
  assert.equal(harness.calls.confirm.length, 1);
  gate.resolve(true);

  assert.deepEqual(await Promise.all([first, second]), [false, true]);
  assert.equal(harness.calls.persistence.length, 1);
});

test('acknowledged Auto warning survives renderer restart and resumed conversation sends', async (t) => {
  const saved = new Map();
  const storage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const first = createRunModeHarness(t, { storage, runMode: 'auto' });
  assert.equal(await first.control.confirmAutoRun(), true);
  assert.equal(first.calls.confirm.length, 1);
  first.cleanup();

  const resumed = createRunModeHarness(t, { storage, runMode: 'auto', withDialog: false });
  const send = createSendHarness();
  await send.controller.handleSend();
  assert.equal(send.calls.length, 1);
  assert.equal(resumed.calls.confirm.length, 0);
  assert.equal(resumed.calls.persistence.length, 0, 'warning acknowledgement does not change run mode');
});

test('cancelled or stale warning acknowledgement is not persisted', async (t) => {
  const saved = new Map();
  const storage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const cancelled = createRunModeHarness(t, { storage, confirmation: async () => false });
  assert.equal(await cancelled.control.confirmAutoRun(), false);
  cancelled.cleanup();
  assert.equal(saved.size, 0);

  const gate = deferred();
  const stale = createRunModeHarness(t, { storage, confirmation: () => gate.promise });
  const pending = stale.control.confirmAutoRun();
  stale.cleanup();
  gate.resolve(true);
  assert.equal(await pending, false);
  assert.equal(saved.size, 0);
});

test('unavailable acknowledgement storage still asks and accepts an explicit confirmation', async (t) => {
  const storage = {
    getItem() { throw new Error('storage blocked'); },
    setItem() { throw new Error('storage blocked'); },
  };
  const harness = createRunModeHarness(t, { storage });
  assert.equal(await harness.control.confirmAutoRun(), true);
  assert.equal(await harness.control.confirmAutoRun(), true);
  assert.equal(harness.calls.confirm.length, 1);
});

test('disposing an open Auto gate rejects it and a fresh instance prompts again', async (t) => {
  const gate = deferred();
  const firstHarness = createRunModeHarness(t, { confirmation: () => gate.promise });
  const pending = firstHarness.control.confirmAutoRun();
  firstHarness.cleanup();
  gate.resolve(true);
  assert.equal(await pending, false);

  const secondHarness = createRunModeHarness(t);
  assert.equal(await secondHarness.control.confirmAutoRun(), true);
  assert.equal(secondHarness.calls.confirm.length, 1);
});

test('first send in inherited Auto mode confirms once while Ask sends never confirm', async (t) => {
  const previous = globalThis.rendererRunModeControl;
  let confirms = 0;
  let confirmed = false;
  globalThis.rendererRunModeControl = {
    currentRunMode: () => 'auto',
    confirmAutoRun: async () => {
      if (!confirmed) confirms += 1;
      confirmed = true;
      return true;
    },
  };
  t.after(() => restoreGlobal('rendererRunModeControl', previous));
  const auto = createSendHarness();
  await auto.controller.handleSend();
  await auto.controller.handleSend();
  assert.equal(confirms, 1);
  assert.equal(auto.calls.length, 2);

  globalThis.rendererRunModeControl = {
    currentRunMode: () => 'ask',
    confirmAutoRun: async () => { confirms += 1; return true; },
  };
  const ask = createSendHarness();
  await ask.controller.handleSend();
  assert.equal(confirms, 1);
  assert.equal(ask.calls.length, 1);
});

test('cancelled first Auto send keeps the composer input and skips sending', async (t) => {
  const previous = globalThis.rendererRunModeControl;
  globalThis.rendererRunModeControl = {
    currentRunMode: () => 'auto',
    confirmAutoRun: async () => false,
  };
  t.after(() => restoreGlobal('rendererRunModeControl', previous));
  const harness = createSendHarness('keep me');

  await harness.controller.handleSend();
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.chatInput.value, 'keep me');
});

test('cancelled Auto confirmation blocks every interactive continuation send path', async (t) => {
  const previous = globalThis.rendererRunModeControl;
  let confirms = 0;
  globalThis.rendererRunModeControl = {
    currentRunMode: () => 'auto',
    confirmAutoRun: async () => { confirms += 1; return false; },
  };
  t.after(() => restoreGlobal('rendererRunModeControl', previous));
  const harness = createInteractiveSendHarness();

  await harness.controller.handleInteractiveSubmit(harness.batch.batch_id);
  assert.equal(confirms, 1);
  assert.equal(harness.calls.length, 0);
  await harness.controller.handleInteractiveSkip(harness.batch.batch_id);
  assert.equal(confirms, 2);
  assert.equal(harness.calls.length, 0);
  await harness.controller.requestInteractiveGuardrailAnswer('session-1', harness.batch);
  assert.equal(confirms, 3);
  assert.equal(harness.calls.length, 0);
});

test('confirmed Auto continuation paths prompt only once per renderer lifetime', async (t) => {
  const confirmation = createRunModeHarness(t, { runMode: 'auto' });
  const harness = createInteractiveSendHarness();

  await harness.controller.handleInteractiveSubmit(harness.batch.batch_id);
  assert.equal(confirmation.calls.confirm.length, 1);
  assert.equal(harness.calls.length, 1);
  await harness.controller.handleInteractiveSkip(harness.batch.batch_id);
  await harness.controller.requestInteractiveGuardrailAnswer('session-1', harness.batch);
  assert.equal(confirmation.calls.confirm.length, 1);
  assert.equal(harness.calls.length, 3);
});

test('Ask mode interactive continuation paths never prompt', async (t) => {
  const previous = globalThis.rendererRunModeControl;
  let confirms = 0;
  globalThis.rendererRunModeControl = {
    currentRunMode: () => 'ask',
    confirmAutoRun: async () => { confirms += 1; return true; },
  };
  t.after(() => restoreGlobal('rendererRunModeControl', previous));
  const harness = createInteractiveSendHarness();

  await runInteractiveSendPaths(harness);

  assert.equal(confirms, 0);
  assert.equal(harness.calls.length, 3);
});

test('missing confirm dependency fails closed without locking out a later prompt', async (t) => {
  const harness = createRunModeHarness(t, { runMode: 'auto', withDialog: false });
  const send = createSendHarness();

  assert.equal(await harness.control.confirmAutoRun(), false);
  await send.controller.handleSend();
  assert.equal(send.calls.length, 0);
  assert.deepEqual(harness.calls.logs, [{
    level: 'WARN',
    event: 'run_mode.auto_confirm_unavailable',
    details: { confirmDialogAvailable: false, helpOverlayAvailable: true },
  }]);

  globalThis.rendererIdeConfirmDialog = {
    createIdeConfirmDialog() {
      return {
        confirm(configure) {
          harness.calls.confirm.push(configure);
          return Promise.resolve(true);
        },
      };
    },
  };
  await send.controller.handleSend();
  assert.equal(harness.calls.confirm.length, 1);
  assert.equal(send.calls.length, 1);
});

test('health-pill markup and controller project Auto and pause state', (t) => {
  const autoPill = buildPillMarkup(
    { tone: 'success', label: 'Ready' },
    { runMode: 'auto', pauseState: 'none' }
  );
  assert.match(autoPill, /class="workbench-health-pill-mode"/);
  assert.match(autoPill, /data-run-mode="auto" data-pause-state="none">Auto<\/span>/);
  assert.match(autoPill, /aria-label="[^"]*, Auto run on"/);
  assert.match(autoPill, /title="[^"]*, Auto run on"/);
  assert.doesNotMatch(buildPillMarkup(
    { tone: 'success', label: 'Ready' },
    { runMode: 'ask' }
  ), /workbench-health-pill-mode/);
  assert.match(buildPillMarkup(
    { tone: 'success', label: 'Ready' },
    { runMode: 'auto', pauseState: 'paused' }
  ), />Auto · Paused<\/span>/);

  const state = { error: '', toneLabel: { tone: 'success', label: 'Ready', summary: '' } };
  assert.match(buildPopoverMarkup(state, readySnapshot(), { runMode: 'auto' }), /Run mode/);
  assert.match(
    buildPopoverMarkup(state, readySnapshot(), { runMode: 'auto', pauseState: 'paused' }),
    /Auto — tools run without asking.*Auto · Paused/
  );
  assert.doesNotMatch(buildPopoverMarkup(state, readySnapshot(), { runMode: 'ask' }), /Run mode/);

  const previousRunMode = globalThis.rendererRunModeControl;
  const previousHealthPill = globalThis.rendererHealthPillController;
  let runMode = 'ask';
  globalThis.rendererRunModeControl = { currentRunMode: () => runMode };
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>');
  const slot = dom.window.document.getElementById('slot');
  const controller = createHealthPillController({
    window: dom.window,
    document: dom.window.document,
    slot,
  });
  t.after(() => {
    controller.dispose();
    restoreGlobal('rendererRunModeControl', previousRunMode);
    restoreGlobal('rendererHealthPillController', previousHealthPill);
    dom.window.close();
  });
  assert.equal(globalThis.rendererHealthPillController, controller);
  const askButton = slot.firstElementChild;
  runMode = 'auto';
  controller.refreshRunModeFacet();
  assert.notEqual(slot.firstElementChild, askButton, 'mode changes repaint the pill');
  assert.equal(slot.querySelector('.workbench-health-pill-mode').textContent, 'Auto');
  controller.setRunModePauseState('paused');
  assert.equal(slot.querySelector('.workbench-health-pill-mode').dataset.pauseState, 'paused');
  controller.setRunModePauseState('bogus');
  assert.equal(slot.querySelector('.workbench-health-pill-mode').dataset.pauseState, 'none');
  controller.dispose();
  assert.notEqual(globalThis.rendererHealthPillController, controller);
});

test('Auto settings help says blocked commands are refused', () => {
  const markup = buildDefaultRunModeFieldMarkup({
    selectField(options) { return options.hint; },
  });
  assert.match(markup, /blocked commands are refused\./);
  assert.doesNotMatch(markup, /blocked commands[^.]*prompt/i);
});


for (const minutes of [0, 45]) {
  test(`Auto confirmation describes configured inactivity behavior (${minutes})`, async (t) => {
    const harness = createRunModeHarness(t, { unattendedGuardMinutes: minutes });
    assert.equal(await harness.control.setRunMode('auto'), true);
    const text = harness.calls.confirm[0].message;
    assert.match(text, minutes === 0 ? /Inactivity pause is off/ : /after 45 minutes/);
    assert.match(text, /Settings > Tools/);
  });
}
