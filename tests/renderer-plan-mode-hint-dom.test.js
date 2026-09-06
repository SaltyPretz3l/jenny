/* DOM tests for the small-model plan-mode hint: toggling the plan chip on
 * with a small/unknown local model surfaces a one-time composer status
 * notice (owner "plan-mode-hint"); toggling off clears it. The binding under
 * test is the #composerRunModeSlot delegate and run-mode control in
 * renderer-chat-event-settings-bindings.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createSettingsEventBindings,
} = require('../renderer/chat/renderer-chat-event-settings-bindings');

function buildHarness(t, { preferredModel, initialPlanMode = false, runActivity = null, mountChip = true, prePlanRunMode }) {
  const dom = new JSDOM(
    '<!doctype html><body><div id="composerModeChips">'
      + '<div id="composerModeChipsAnnouncer"></div></div>'
      + '<div id="composerRunModeSlot">'
      + (mountChip ? '<button type="button" id="composerRunModeChip">Ask</button>' : '')
      + '</div></body>'
  );
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => {
    globalThis.document = previousDocument;
  });

  const prefs = { runMode: initialPlanMode ? 'plan' : 'ask', planMode: initialPlanMode, preferredModel };
  if (prePlanRunMode !== undefined) prefs.prePlanRunMode = prePlanRunMode;
  const state = { ui: {}, models: { status: { currentModel: '' } }, modelList: {} };
  const calls = { notices: [], clears: [], activities: [], errors: [] };
  const bindings = createSettingsEventBindings({
    state,
    TOAST_SOURCE: {},
    ACTIVITY_SCOPE: { composerRunMode: 'composer.run_mode' },
    getCurrentRuntimePreferences: () => ({ ...prefs }),
    getRuntimePreferenceSnapshot: () => ({ ...prefs }),
    runRuntimePreferenceActivity: (payload) => {
      calls.activities.push(payload);
      if (runActivity) {
        return runActivity(payload, prefs, calls);
      }
      if (payload && payload.patch && 'runMode' in payload.patch) {
        prefs.runMode = payload.patch.runMode;
      }
      return Promise.resolve();
    },
    showComposerActionError: (error) => { calls.errors.push(error.message); },
    setComposerStatusNotice: (message, options) => {
      calls.notices.push({ message, options });
    },
    clearComposerStatusNotice: (options) => {
      calls.clears.push(options);
    },
    toastActionHandlers: new Map(),
  });
  bindings.bindSettingsEvents((element, eventName, handler, options) => {
    if (element && typeof element.addEventListener === 'function') {
      element.addEventListener(eventName, handler, options);
    }
  }, undefined);
  t.after(() => bindings.dispose());

  return { dom, state, prefs, calls, control: globalThis.rendererRunModeControl };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('plan toggle ON with a small model shows the hint once', async (t) => {
  const h = buildHarness(t, { preferredModel: 'gemma4-e4b-it-q6_k:latest' });

  h.control.togglePlanMode();
  await flush();

  assert.equal(h.calls.notices.length, 1, 'one notice on first toggle-on');
  const notice = h.calls.notices[0];
  assert.match(notice.message, /may not follow a multi-step plan reliably/);
  assert.equal(notice.options.owner, 'plan-mode-hint');
  assert.equal(notice.options.tone, 'warning');
  assert.equal(h.calls.activities.length, 1, 'plan-mode preference still saved');
  assert.equal(h.calls.activities[0].patch.runMode, 'plan');
});

test('plan toggle ON with a large model shows no hint', async (t) => {
  const h = buildHarness(t, { preferredModel: 'some-70b-instruct' });

  h.control.togglePlanMode();
  await flush();

  assert.equal(h.calls.notices.length, 0, 'no hint for a capable model');
  assert.equal(h.calls.activities.length, 1, 'preference save unaffected');
});

test('hint is deduped per model within the session', async (t) => {
  const h = buildHarness(t, { preferredModel: 'gemma4-e4b-it-q6_k:latest' });

  h.control.togglePlanMode(); // on  -> notice
  await flush();
  h.control.togglePlanMode(); // off -> clear
  await flush();
  h.control.togglePlanMode(); // on  -> deduped
  await flush();

  assert.equal(h.calls.notices.length, 1, 'second toggle-on is deduped');
});

test('plan toggle OFF clears the hint notice', async (t) => {
  const h = buildHarness(t, { preferredModel: 'gemma4-e4b-it-q6_k:latest' });

  h.control.togglePlanMode(); // on
  await flush();
  h.control.togglePlanMode(); // off
  await flush();

  assert.equal(h.calls.clears.length, 1, 'toggle-off clears the notice');
  assert.equal(h.calls.clears[0].owner, 'plan-mode-hint');
});

test('empty/unknown model errs toward showing the hint', async (t) => {
  const h = buildHarness(t, { preferredModel: '' });

  h.control.togglePlanMode();
  await flush();

  assert.equal(h.calls.notices.length, 1, 'unknown model gets the hint');
  assert.match(h.calls.notices[0].message, /the current model/);
});

test('a failed plan-mode enable does not show or dedupe the hint before a successful retry', async (t) => {
  let attempt = 0;
  const h = buildHarness(t, {
    preferredModel: 'gemma4-e4b-it-q6_k:latest',
    runActivity(payload, prefs) {
      attempt += 1;
      prefs.runMode = payload.patch.runMode;
      if (attempt === 1) {
        prefs.runMode = 'ask';
        return Promise.reject(new Error('save failed'));
      }
      return Promise.resolve();
    },
  });

  h.control.togglePlanMode();
  await flush();
  assert.equal(h.calls.notices.length, 0);
  assert.deepEqual(h.calls.errors, ['save failed']);

  h.control.togglePlanMode();
  await flush();
  assert.equal(h.calls.notices.length, 1, 'the successful retry owns the first hint');
});

test('the run-mode control registers even when the chip is not yet mounted', (t) => {
  // Binding order must not matter: settings-bindings can bind before the
  // composer renderer mounts #composerRunModeChip. The control registers
  // unconditionally; per-call availability is guarded inside each method.
  const h = buildHarness(t, { preferredModel: 'some-70b-instruct', mountChip: false });

  assert.ok(h.control, 'rendererRunModeControl registered without the chip in the DOM');
  assert.equal(typeof h.control.cycleRunMode, 'function');
  assert.equal(h.control.cycleRunMode(), false, 'calls stand down while the chip is unmounted');
  assert.equal(h.calls.activities.length, 0);
});

test('plan toggle OFF restores the session pre-plan mode, not a module-local default', async (t) => {
  // Simulates a reload mid-plan: this bindings instance never saw the plan
  // entry, so the restore target must come from the session preferences
  // (store-owned pre_plan_run_mode), never a shadow variable.
  const h = buildHarness(t, {
    preferredModel: 'some-70b-instruct',
    initialPlanMode: true,
    prePlanRunMode: 'auto',
  });

  h.control.togglePlanMode();
  await flush();

  assert.equal(h.calls.activities.length, 1);
  assert.equal(h.calls.activities[0].patch.runMode, 'auto',
    'plan exit restores the persisted pre-plan mode (auto), not the ask fallback');
});

test('plan toggle OFF falls back to Ask when the store summary echo is missing', async (t) => {
  // The store owns the restore target. If its summary echo is unavailable,
  // the renderer must choose the safe direction instead of inferring Auto.
  const h = buildHarness(t, { preferredModel: 'some-70b-instruct' });
  h.prefs.runMode = 'auto';

  h.control.togglePlanMode(); // enter plan from Auto
  await flush();
  h.control.togglePlanMode(); // exit before pre_plan_run_mode is visible
  await flush();

  assert.equal(h.calls.activities.length, 2);
  assert.equal(h.calls.activities[1].patch.runMode, 'ask');
});

test('a missing summary echo cannot leak a prior session mode into another session', async (t) => {
  const h = buildHarness(t, { preferredModel: 'some-70b-instruct' });
  h.prefs.runMode = 'auto';

  h.control.togglePlanMode();
  await flush();

  // Retarget the app-global binding to another session already in Plan whose
  // store summary has no pre-plan echo.
  h.prefs.runMode = 'plan';
  h.prefs.planMode = true;
  delete h.prefs.prePlanRunMode;
  h.control.togglePlanMode();
  await flush();

  assert.equal(h.calls.activities[1].patch.runMode, 'ask');
});

test('a failed plan-mode disable does not clear the still-active hint', async (t) => {
  let attempt = 0;
  const h = buildHarness(t, {
    preferredModel: 'gemma4-e4b-it-q6_k:latest',
    runActivity(payload, prefs) {
      attempt += 1;
      prefs.runMode = payload.patch.runMode;
      if (attempt === 2) {
        prefs.runMode = 'plan';
        return Promise.reject(new Error('save failed'));
      }
      return Promise.resolve();
    },
  });

  h.control.togglePlanMode();
  await flush();
  assert.equal(h.calls.notices.length, 1);

  h.control.togglePlanMode();
  await flush();
  assert.equal(h.calls.clears.length, 0);
  assert.deepEqual(h.calls.errors, ['save failed']);
});
