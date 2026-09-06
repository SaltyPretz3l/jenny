'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createActivityPrefsController } = require('../renderer/shell/renderer-activity-prefs-utils.js');

const ACTIVITY_SCOPE = {
  composerPlanMode: 'composer.planMode',
  composerRunMode: 'composer.runMode',
};

function basePreferences() {
  return {
    preferredModel: 'model-a',
    reasoningEffort: 'high',
    planMode: false,
    contextPreferences: {
      historyScope: 'recent',
      includePersonality: true,
      includeMemory: true,
    },
  };
}

function makeController(overrides = {}, controllerOptions = {}) {
  const calls = { setSessionPreferences: [], patchSessionSummary: [], beginActivity: [], resolveActivity: [], failActivity: [] };
  let currentPreferences = basePreferences();
  const callbacks = {
    getCurrentRuntimePreferences: () => currentPreferences,
    getActiveSession: () => ({ id: 'sess-1' }),
    patchSessionSummary: (id, summary) => {
      calls.patchSessionSummary.push([id, summary]);
      if (Object.prototype.hasOwnProperty.call(summary, 'preferred_model')) {
        currentPreferences = {
          preferredModel: summary.preferred_model,
          reasoningEffort: summary.reasoning_effort,
          planMode: summary.plan_mode,
          contextPreferences: {
            historyScope: summary.context_preferences.history_scope,
            includePersonality: summary.context_preferences.include_personality,
            includeMemory: summary.context_preferences.include_memory,
          },
        };
      }
    },
    syncRuntimeDraftFromActiveSession: () => {},
    beginActivity: (...args) => { calls.beginActivity.push(args); },
    resolveActivity: (...args) => { calls.resolveActivity.push(args); },
    failActivity: (...args) => { calls.failActivity.push(args); },
    getActivitySnapshot: () => null,
    getMostRecentActivity: () => null,
    applyActivityAttributes: () => {},
    setComposerStatusNotice: () => {},
    clearComposerStatusNotice: () => {},
    renderComposerState: () => {},
    renderSettings: () => {},
    renderPersonalityEditor: () => {},
    renderBackendBanner: () => {},
    renderSessions: () => {},
    setSessionPreferences: (id, prefs) => {
      calls.setSessionPreferences.push([id, prefs]);
      return { persisted: true };
    },
    ...overrides,
  };
  const controller = createActivityPrefsController({
    state: controllerOptions.state || { ui: { activeView: 'chat' }, runtimeDraft: {} },
    constants: { ACTIVITY_SCOPE },
    dom: { composerStatusNotice: controllerOptions.composerStatusNotice || null },
    callbacks,
  });
  return { controller, calls, getCurrentPreferences: () => currentPreferences };
}

test('persistRuntimePreferences routes through the injected setSessionPreferences boundary', async () => {
  // Node has no global `window`; the previous window.jennyShell.sessions.setPreferences
  // call would throw ReferenceError here. Reaching the spy proves the boundary is used.
  const { controller, calls } = makeController();

  await controller.persistRuntimePreferences({});

  assert.equal(calls.setSessionPreferences.length, 1, 'boundary called exactly once');
  const [sessionId, mappedPrefs] = calls.setSessionPreferences[0];
  assert.equal(sessionId, 'sess-1');
  assert.deepEqual(mappedPrefs, {
    preferred_model: 'model-a',
    reasoning_effort: 'high',
    plan_mode: false,
    context_preferences: {
      history_scope: 'recent',
      include_personality: true,
      include_memory: true,
    },
  }, 'preferences are mapped to the snake_case persistence contract');
});

test('composer compaction activity follows the active session and uses the existing polite status host', () => {
  const previousCoordinator = global.rendererCompactionCoordinator;
  global.rendererCompactionCoordinator = require('../renderer/shell/renderer-settings-compaction-section.js');
  const classes = new Set(['hidden']);
  const host = {
    innerHTML: '',
    classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name); } },
    querySelector() { return null; },
    dataset: {},
    setAttribute() {},
    removeAttribute() {},
  };
  const state = {
    currentSessionId: 's1', runtimeDraft: {},
    ui: { activeView: 'chat', composerStatusNotice: '', composerStatusNoticeOwner: '' },
    compactionActivities: new Map([['s1', {
      sessionId: 's1', state: 'pending', pending: true, message: 'Compacting context…', tone: 'pending',
    }]]),
  };
  try {
    const { controller } = makeController({}, { state, composerStatusNotice: host });
    controller.renderComposerStatusNotice();
    assert.equal(classes.has('hidden'), false);
    assert.match(host.innerHTML, /Compacting context/);

    state.currentSessionId = 's2';
    controller.renderComposerStatusNotice();
    assert.equal(classes.has('hidden'), true);

    state.currentSessionId = 's1';
    controller.renderComposerStatusNotice();
    assert.equal(classes.has('hidden'), false);
  } finally {
    global.rendererCompactionCoordinator = previousCoordinator;
  }
});

test('persistRuntimePreferences applies the boundary result to the session summary', async () => {
  const { controller, calls } = makeController();

  await controller.persistRuntimePreferences({ reasoningEffort: 'low' });

  assert.equal(calls.setSessionPreferences[0][1].reasoning_effort, 'low', 'patch is merged before persist');
  assert.deepEqual(calls.patchSessionSummary.at(-1), ['sess-1', { persisted: true }],
    'the value returned by the boundary is applied to the session summary');
});

test('persistRuntimePreferences fails closed when no setSessionPreferences callback is wired', async () => {
  // Omitting the boundary must reject (not silently drop the write) so the caller
  // can roll back the optimistic UI.
  const { controller } = makeController({ setSessionPreferences: undefined });

  await assert.rejects(
    () => controller.persistRuntimePreferences({}),
    /setSessionPreferences callback not wired/,
  );
});

test('last-write receipt ignores an older preference result that resolves last', async () => {
  const pending = [];
  const { controller, calls, getCurrentPreferences } = makeController({
    setSessionPreferences: (id, prefs) => new Promise((resolve) => pending.push({ id, prefs, resolve })),
  });
  const scopes = ['composer.preferredModel'];
  const first = controller.runRuntimePreferenceActivity({
    patch: { preferredModel: 'model-b' }, scopes, previousValue: basePreferences(), failureMessage: 'failed', successMessage: 'saved',
  });
  const secondPrevious = controller.getRuntimePreferenceSnapshot();
  const second = controller.runRuntimePreferenceActivity({
    patch: { preferredModel: 'model-c' }, scopes, previousValue: secondPrevious, failureMessage: 'failed', successMessage: 'saved',
  });

  assert.equal(pending.length, 2);
  assert.equal(pending[1].prefs.preferred_model, 'model-c');
  pending[1].resolve(pending[1].prefs);
  await second;
  pending[0].resolve(pending[0].prefs);
  await first;

  assert.equal(getCurrentPreferences().preferredModel, 'model-c');
  assert.notEqual(calls.patchSessionSummary.at(-1)[1].preferred_model, 'model-b');
  assert.equal(calls.beginActivity.length, 2, 'both writes expose Saving state');
  assert.equal(calls.resolveActivity.length, 1, 'only the newest overlapping receipt exposes Saved state');
  assert.equal(calls.failActivity.length, 0);
});

test('latest preference failure restores its origin snapshot and exposes failed state', async () => {
  const failure = new Error('backend detail must not enter activity copy');
  const { controller, calls, getCurrentPreferences } = makeController({
    setSessionPreferences: async () => { throw failure; },
  });

  await assert.rejects(() => controller.runRuntimePreferenceActivity({
    patch: { reasoningEffort: 'low' },
    scopes: ['composer.reasoningEffort'],
    previousValue: basePreferences(),
    failureMessage: () => 'Could not save reasoning effort.',
    successMessage: 'Saved.',
  }), failure);

  assert.equal(getCurrentPreferences().reasoningEffort, 'high');
  assert.equal(calls.failActivity.length, 1);
  assert.equal(calls.failActivity[0][1].message, 'Could not save reasoning effort.');
});

test('a failed run-mode save surfaces the composer activity notice (composer.runMode is watched)', () => {
  // The plan chip's composer.planMode activity scope has no producers left;
  // the live scope the switcher writes is composer.runMode. The notice sync
  // must watch it or failActivity messages never render inline.
  const notices = [];
  const { controller } = makeController({
    setComposerStatusNotice: (message, options) => notices.push({ message, options }),
    getMostRecentActivity: (scopes) => (Array.isArray(scopes) && scopes.includes('composer.runMode')
      ? { scope: 'composer.runMode', message: 'Could not save run mode.', startedAt: 7 }
      : null),
  });

  controller.syncComposerActivityNotice();

  assert.equal(notices.length, 1, 'run-mode activity drives the composer notice');
  assert.equal(notices[0].message, 'Could not save run mode.');
});

test('preference persistence never touches the retired sticky plan-mode key', async (t) => {
  // The Wave-G 'jenny.composer.planMode' sticky boot default is retired:
  // S4's config defaultRunMode owns new-chat defaults, and a stale sticky key
  // would silently override the chip (a user who left Plan via the switcher
  // would still boot every new chat in Plan forever).
  const previousLocalStorage = global.localStorage;
  const writes = [];
  global.localStorage = {
    getItem: () => null,
    setItem: (...args) => writes.push(args),
  };
  t.after(() => { global.localStorage = previousLocalStorage; });
  const { controller } = makeController({});

  await controller.persistRuntimePreferences({ planMode: true });
  await controller.persistRuntimePreferences({ runMode: 'auto' });

  assert.deepEqual(writes, [], 'no browser-storage writes from preference persistence');
});
