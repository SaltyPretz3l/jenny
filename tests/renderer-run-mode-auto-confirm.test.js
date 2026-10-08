'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createRunModeHarness, restoreGlobal } = require('./helpers/run-mode-harness');
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
const { settingRow } = require('./helpers/settings-rows');
const {
  createRunModeSwitcherRenderer,
} = require('../renderer/chat/renderer-composer-v2-render');

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
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

test('switching to Auto never asks; the send-time dialog keeps its copy (FG-003)', async (t) => {
  const harness = createRunModeHarness(t, { confirmation: () => Promise.resolve(false) });
  const initialRefreshes = harness.calls.refreshes;

  assert.equal(await harness.control.setRunMode('auto'), true);
  assert.equal(await harness.control.setRunMode('plan'), true);
  assert.equal(await harness.control.setRunMode('auto'), true);
  assert.equal(harness.calls.confirm.length, 0, 'the chip and segments pass through Auto freely');
  assert.equal(harness.prefs.runMode, 'auto');
  assert.equal(initialRefreshes, 1, 'registration refreshes an already-mounted health pill');
  assert.equal(harness.calls.refreshes, initialRefreshes + 3);

  assert.equal(await harness.control.confirmAutoRun(), false);
  assert.equal(harness.calls.confirm.length, 1);
  assert.equal(harness.calls.confirm[0].title, 'Turn on Auto run?');
  assert.equal(harness.calls.confirm[0].confirmLabel, 'Turn on Auto');
  assert.equal(harness.calls.confirm[0].cancelLabel, 'Cancel');
  assert.equal(harness.calls.confirm[0].variant, 'danger');
  assert.equal(harness.prefs.runMode, 'auto', 'a cancelled send leaves the mode alone');
});

test('overlapping Auto sends in one project share one confirmation dialog', async (t) => {
  const gate = deferred();
  const harness = createRunModeHarness(t, { confirmation: () => gate.promise });

  const first = harness.control.confirmAutoRun();
  const second = harness.control.confirmAutoRun();
  assert.equal(harness.calls.confirm.length, 1);
  gate.resolve(true);

  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(harness.calls.persistence.length, 0, 'the acknowledgement never writes the run mode');
});

test('the Auto acknowledgement is per project, shared by its sessions, and persists (FG-003)', async (t) => {
  const saved = new Map([['jenny.auto-run-warning-ack.v1', '1']]);
  const storage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const sessions = [
    { id: 'a1', project_id: 'project_alpha' },
    { id: 'a2', project_id: 'project_alpha' },
    { id: 'b1', project_id: 'project_beta' },
    { id: 'g1' },
  ];
  const harness = createRunModeHarness(t, { storage, sessions, currentSessionId: 'a1' });

  assert.equal(await harness.control.confirmAutoRun('a1'), true, 'the old global v1 key does not count');
  assert.equal(await harness.control.confirmAutoRun('a2'), true);
  assert.equal(await harness.control.confirmAutoRun(), true, 'no id reads the current session');
  assert.equal(harness.calls.confirm.length, 1, 'one prompt for every session of a project');
  assert.equal(await harness.control.confirmAutoRun('b1'), true);
  assert.equal(await harness.control.confirmAutoRun('g1'), true);
  assert.equal(harness.calls.confirm.length, 3, 'each other project (General too) asks once');
  assert.equal(saved.get('jenny.auto-run-warning-ack.v2:project_alpha'), '1');
  assert.equal(saved.get('jenny.auto-run-warning-ack.v2:project_beta'), '1');
  assert.equal(saved.get('jenny.auto-run-warning-ack.v2:project_general'), '1');
  harness.cleanup();

  const restarted = createRunModeHarness(t, { storage, sessions, withDialog: false });
  assert.equal(await restarted.control.confirmAutoRun('a2'), true, 'survives a restart');
  assert.equal(restarted.calls.confirm.length, 0);
});

test('an Auto send in another project waits for the open prompt, then asks for its own', async (t) => {
  const gate = deferred();
  const answers = [() => gate.promise, () => Promise.resolve(true)];
  const sessions = [{ id: 'a1', project_id: 'project_alpha' }, { id: 'b1', project_id: 'project_beta' }];
  const harness = createRunModeHarness(t, { sessions, confirmation: () => answers.shift()() });

  const alpha = harness.control.confirmAutoRun('a1');
  const beta = harness.control.confirmAutoRun('b1');
  assert.equal(harness.calls.confirm.length, 1, 'one dialog at a time');
  gate.resolve(false);
  assert.deepEqual(await Promise.all([alpha, beta]), [false, true]);
  assert.equal(harness.calls.confirm.length, 2);
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

test('confirmAutoSend asks only for an Auto session, once per project (send boundary, FG-003)', async (t) => {
  const harness = createRunModeHarness(t, { runMode: 'ask' });
  assert.equal(await harness.control.confirmAutoSend(), true);
  assert.equal(harness.calls.confirm.length, 0);
  harness.prefs.runMode = 'auto';
  assert.equal(await harness.control.confirmAutoSend(), true);
  assert.equal(await harness.control.confirmAutoSend(), true);
  assert.equal(harness.calls.confirm.length, 1);
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
  assert.match(autoPill, /data-run-mode="auto" data-pause-state="none" data-health-pill-action="open-run-mode">Auto<\/button>/);
  assert.match(autoPill, /aria-label="Run mode: Auto"/);
  assert.match(autoPill, /title="Run mode: Auto"/);
  assert.doesNotMatch(buildPillMarkup(
    { tone: 'success', label: 'Ready' },
    { runMode: 'ask' }
  ), /workbench-health-pill-mode/);
  assert.match(buildPillMarkup(
    { tone: 'success', label: 'Ready' },
    { runMode: 'auto', pauseState: 'paused' }
  ), />Auto · Paused<\/button>/);

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
  // The sentence rides on the settings-field row (shared binding), behind the row's "?" detail.
  const markup = settingRow('defaultRunModeSelect', undefined, {
    selectField() { return '<select></select>'; },
    settingsField(options) { return options.detail; },
  });
  assert.match(markup, /blocked commands are refused\./);
  assert.doesNotMatch(markup, /blocked commands[^.]*prompt/i);
});


for (const minutes of [0, 45]) {
  test(`Auto confirmation describes configured inactivity behavior (${minutes})`, async (t) => {
    const harness = createRunModeHarness(t, { unattendedGuardMinutes: minutes });
    assert.equal(await harness.control.confirmAutoRun(), true);
    const text = harness.calls.confirm[0].message;
    assert.match(text, minutes === 0 ? /Inactivity pause is off/ : /after 45 minutes/);
    assert.match(text, /Settings > Tools/);
  });
}

/* Collapsed settings popover (spec 2026-09-26 §4 step 4): a segment click in
 * the run-mode slot sets that exact mode through setRunMode (an unchanged mode
 * is a no-op; Auto asks at send time, not here); the chip click still cycles. */
const segment = (harness, mode) => harness.runModeSlot.querySelector(`[data-run-mode-option="${mode}"]`);
const settleRunMode = () => new Promise((resolve) => setImmediate(resolve));
const clickInside = (harness, node) => node.dispatchEvent(new harness.doc.defaultView.MouseEvent('click', { bubbles: true }));

test('a segment click (on its icon too) sets that exact mode, and the chip click still cycles', async (t) => {
  const harness = createRunModeHarness(t, { switcher: true });
  clickInside(harness, segment(harness, 'plan').querySelector('.composer-run-mode-segment-icon svg'));
  await settleRunMode();
  assert.equal(harness.prefs.runMode, 'plan', 'Plan from Ask, not the cycle step (Auto)');
  assert.equal(harness.calls.confirm.length, 0);
  assert.deepEqual(harness.calls.persistence.map((entry) => [entry.patch, entry.sessionId]), [[{ runMode: 'plan' }, undefined]]);
  harness.switcher.sync();
  assert.equal(segment(harness, 'plan').getAttribute('aria-pressed'), 'true');
  assert.equal(segment(harness, 'ask').getAttribute('aria-pressed'), 'false');
  harness.doc.getElementById('composerRunModeChip').click();
  await settleRunMode();
  assert.equal(harness.prefs.runMode, 'propose', 'Plan cycles to Propose');
});

test('an Auto segment click sets Auto without the confirmation dialog (FG-003)', async (t) => {
  const harness = createRunModeHarness(t, { switcher: true, confirmation: () => Promise.resolve(false) });
  segment(harness, 'auto').click();
  await settleRunMode();
  assert.equal(harness.calls.confirm.length, 0, 'switching never asks');
  assert.equal(harness.prefs.runMode, 'auto');
  assert.deepEqual(harness.calls.persistence.map((entry) => entry.patch), [{ runMode: 'auto' }]);
});

test('the pressed segment is a no-op and a disabled chip or segment ignores the click', async (t) => {
  const harness = createRunModeHarness(t, { switcher: true, runMode: 'plan' });
  segment(harness, 'plan').click();
  await settleRunMode();
  assert.equal(harness.calls.persistence.length, 0, 'unchanged mode writes nothing');
  const chip = harness.doc.getElementById('composerRunModeChip');
  chip.disabled = true; // plugin read-only session
  segment(harness, 'ask').click();
  await settleRunMode();
  assert.equal(harness.calls.persistence.length, 0, 'a disabled chip blocks the segments');
  chip.disabled = false;
  segment(harness, 'ask').disabled = true;
  clickInside(harness, segment(harness, 'ask'));
  clickInside(harness, segment(harness, 'ask').querySelector('.composer-run-mode-segment-label'));
  await settleRunMode();
  assert.equal(harness.calls.persistence.length, 0, 'a disabled segment does nothing');
  assert.equal(harness.prefs.runMode, 'plan');
});

test('a pane rail segment click targets that pane session with its own chip', async (t) => {
  const harness = createRunModeHarness(t);
  const paneSlot = harness.doc.body.appendChild(harness.doc.createElement('div'));
  const paneSwitcher = createRunModeSwitcherRenderer({ slot: paneSlot, domId: '', getRunMode: () => 'ask' });
  t.after(() => paneSwitcher.destroy());
  harness.bindings.bindComposerRailEvents({
    registerListener: (element, type, handler) => element?.addEventListener?.(type, handler),
    listenerOptions: {},
    dom: { composerRunModeSlot: paneSlot },
    getSessionId: () => 'session-b',
  });
  paneSlot.querySelector('[data-run-mode-option="auto"]').click();
  await settleRunMode();
  assert.equal(harness.calls.confirm.length, 0, 'a pane rail switches to Auto without asking');
  assert.deepEqual(harness.calls.persistence.map((entry) => [entry.patch, entry.sessionId]), [[{ runMode: 'auto' }, 'session-b']]);
  paneSlot.querySelector('[data-inv-chip="composer-run-mode"]').disabled = true;
  paneSlot.querySelector('[data-run-mode-option="plan"]').click();
  await settleRunMode();
  assert.equal(harness.calls.persistence.length, 1, 'the pane chip disabled state gates its segments');
});
