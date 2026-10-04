'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createActivityPrefsController } = require('../renderer/shell/renderer-activity-prefs-utils.js');

const ACTIVITY_SCOPE = {
  composerPlanMode: 'composer.planMode',
  composerRunMode: 'composer.runMode',
  composerPreferredModel: 'composer.preferredModel',
  composerReasoningEffort: 'composer.reasoningEffort',
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

// Split view W2-2a: a pane's rail writes ITS session's preferences. The
// `sessionId` option binds the receipt, the optimistic patch, the persist call
// and the previous-value snapshot to that session's own record; omitted, the
// active session is the target exactly as before.
function twoSessionController(overrides = {}) {
  const sessionB = {
    id: 'sess-2',
    preferred_model: 'model-b',
    reasoning_effort: 'low',
    run_mode: 'auto',
    plan_mode: false,
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: false },
  };
  const state = { ui: { activeView: 'chat' }, runtimeDraft: {}, sessions: [{ id: 'sess-1' }, sessionB] };
  const fromSession = (session) => ({
    preferredModel: session.preferred_model,
    reasoningEffort: session.reasoning_effort,
    runMode: session.run_mode,
    planMode: session.plan_mode === true,
    contextPreferences: {
      historyScope: session.context_preferences.history_scope,
      includePersonality: session.context_preferences.include_personality,
      includeMemory: session.context_preferences.include_memory,
    },
  });
  const built = makeController({ getRuntimePreferencesFromSession: fromSession, ...overrides }, { state });
  return { ...built, state, sessionB };
}

test('a sessionId option binds the receipt, the persist and the previous snapshot to that session', async () => {
  const { controller, calls } = twoSessionController();

  const snapshot = controller.getRuntimePreferenceSnapshot('sess-2');
  assert.deepEqual(snapshot, {
    preferredModel: 'model-b',
    reasoningEffort: 'low',
    runMode: 'auto',
    planMode: false,
    contextPreferences: { historyScope: 'session', includePersonality: true, includeMemory: false },
  }, 'the snapshot is sess-2\'s record, not the active session\'s');

  await controller.runRuntimePreferenceActivity({
    patch: { preferredModel: 'model-z' },
    scopes: ['composer.preferredModel'],
    previousValue: snapshot,
    failureMessage: 'failed',
    successMessage: '',
    sessionId: 'sess-2',
  });

  assert.equal(calls.setSessionPreferences.length, 1);
  assert.equal(calls.setSessionPreferences[0][0], 'sess-2', 'the write goes to sess-2');
  assert.equal(calls.setSessionPreferences[0][1].preferred_model, 'model-z');
  assert.equal(calls.setSessionPreferences[0][1].reasoning_effort, 'low', 'unpatched fields come from sess-2, not the active session');
  assert.equal(calls.setSessionPreferences[0][1].run_mode, 'auto');
  assert.deepEqual(calls.patchSessionSummary.map(([id]) => id), ['sess-2', 'sess-2'], 'optimistic and persisted patches both land on sess-2');
});

test('a failed write with a sessionId rolls back THAT session to its previous snapshot', async () => {
  const { controller, calls } = twoSessionController({ setSessionPreferences: async () => { throw new Error('nope'); } });
  const previousValue = controller.getRuntimePreferenceSnapshot('sess-2');

  await assert.rejects(() => controller.runRuntimePreferenceActivity({
    patch: { reasoningEffort: 'high' },
    scopes: ['composer.reasoningEffort'],
    previousValue,
    failureMessage: 'failed',
    successMessage: '',
    sessionId: 'sess-2',
  }));

  const restore = calls.patchSessionSummary.at(-1);
  assert.equal(restore[0], 'sess-2');
  assert.equal(restore[1].reasoning_effort, 'low', 'the rollback restores sess-2\'s own effort');
});

test('without a sessionId the active session stays the target (today\'s path)', async () => {
  const { controller, calls } = twoSessionController();

  assert.equal(controller.getRuntimePreferenceSnapshot().preferredModel, 'model-a', 'the snapshot reads the current preferences');
  await controller.runRuntimePreferenceActivity({
    patch: { reasoningEffort: 'low' }, scopes: ['composer.reasoningEffort'], previousValue: basePreferences(), failureMessage: 'failed', successMessage: '',
  });

  assert.equal(calls.setSessionPreferences[0][0], 'sess-1');
  assert.equal(calls.setSessionPreferences[0][1].preferred_model, 'model-a');
});

test('an unknown sessionId falls back to the active session rather than a blank record', async () => {
  const { controller, calls } = twoSessionController();

  await controller.persistRuntimePreferences({ reasoningEffort: 'low' });
  await controller.runRuntimePreferenceActivity({
    patch: { reasoningEffort: 'medium' }, scopes: [], previousValue: basePreferences(), failureMessage: 'failed', successMessage: '', sessionId: 'sess-missing',
  });

  assert.deepEqual(calls.setSessionPreferences.map(([id]) => id), ['sess-1', 'sess-1']);
});

// Split view W3-1: a model/effort save shimmers only the pane showing the saved
// session, so its activity is keyed `scope:sessionId`; other scopes stay bare.
test('a preference save begins and resolves the session-keyed scope; run mode stays bare', async () => {
  const { controller, calls } = twoSessionController();
  await controller.runRuntimePreferenceActivity({
    patch: { preferredModel: 'model-z', reasoningEffort: 'high' },
    scopes: ['composer.preferredModel', 'composer.reasoningEffort'],
    previousValue: controller.getRuntimePreferenceSnapshot('sess-2'),
    failureMessage: 'failed',
    successMessage: '',
    sessionId: 'sess-2',
  });
  assert.deepEqual(calls.beginActivity.map(([scope]) => scope), ['composer.preferredModel:sess-2', 'composer.reasoningEffort:sess-2']);
  assert.deepEqual(calls.resolveActivity.map(([scope]) => scope), ['composer.preferredModel:sess-2', 'composer.reasoningEffort:sess-2']);

  await controller.runRuntimePreferenceActivity({
    patch: { runMode: 'plan' }, scopes: ['composer.runMode'], previousValue: {}, failureMessage: 'failed', successMessage: '', sessionId: 'sess-2',
  });
  assert.equal(calls.beginActivity.at(-1)[0], 'composer.runMode', 'the run-mode notice scope is not session-keyed');
});

test('overlapping saves on two sessions each settle their own keyed scope', async () => {
  const pending = [];
  const { controller, calls } = twoSessionController({
    setSessionPreferences: (id, prefs) => new Promise((resolve) => pending.push({ id, prefs, resolve })),
  });
  const onActive = controller.runRuntimePreferenceActivity({
    patch: { preferredModel: 'model-c' }, scopes: ['composer.preferredModel'], previousValue: {}, failureMessage: 'failed', successMessage: '',
  });
  const onPaneOne = controller.runRuntimePreferenceActivity({
    patch: { preferredModel: 'model-d' }, scopes: ['composer.preferredModel'], previousValue: {}, failureMessage: 'failed', successMessage: '', sessionId: 'sess-2',
  });
  assert.deepEqual(pending.map((entry) => entry.id), ['sess-1', 'sess-2']);
  pending[1].resolve(pending[1].prefs);
  pending[0].resolve(pending[0].prefs);
  await Promise.all([onActive, onPaneOne]);
  assert.deepEqual(calls.resolveActivity.map(([scope]) => scope).sort(), ['composer.preferredModel:sess-1', 'composer.preferredModel:sess-2'],
    'neither save strands the other session\'s shimmer');
});

test('a keyed activity change re-syncs the composer of the pane showing that session', () => {
  const synced = [];
  let settingsRenders = 0;
  const { controller } = makeController({
    renderSessionComposer: (sessionId) => synced.push(sessionId),
    renderSettings: () => { settingsRenders += 1; },
  });
  controller.handleActivityChange('composer.preferredModel:sess-2');
  assert.deepEqual(synced, ['sess-2']);
  assert.equal(settingsRenders, 1, 'the settings surface still refreshes');
  controller.handleActivityChange('composer.reasoningEffort');
  assert.deepEqual(synced, ['sess-2'], 'a bare (draft) scope has no pane to route to');
  assert.equal(settingsRenders, 2);
});

function fakeNoticeHost() {
  const classes = new Set(['hidden']);
  return {
    innerHTML: '',
    textContent: '',
    dataset: {},
    classes,
    classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name); } },
    querySelector() { return null; },
    setAttribute() {},
    removeAttribute() {},
  };
}

function withPaneVisibility(t) {
  const previous = global.rendererPaneVisibilityUtils;
  global.rendererPaneVisibilityUtils = require('../renderer/chat/renderer-pane-visibility-utils.js');
  t.after(() => { global.rendererPaneVisibilityUtils = previous; });
}

test('a notice keyed to pane 1\'s session renders under pane 1 only; unkeyed notices stay pane 0\'s', (t) => {
  withPaneVisibility(t);
  const paneZeroHost = fakeNoticeHost();
  const paneOneHost = fakeNoticeHost();
  const state = {
    currentSessionId: 'sess-1', runtimeDraft: {},
    panes: { panes: [{ paneId: 0, sessionId: 'sess-1' }, { paneId: 1, sessionId: 'sess-2' }], focusedPaneId: 0 },
    ui: { activeView: 'chat', composerStatusNotice: 'Large paste added.', composerStatusNoticeOwner: 'composer:paste-size',
      composerStatusNoticeTone: 'warning', composerStatusNoticeSessionId: 'sess-2' },
  };
  const { controller } = makeController({}, { state, composerStatusNotice: paneZeroHost });
  controller.renderComposerStatusNotice();
  controller.renderComposerStatusNotice({ node: paneOneHost, sessionId: 'sess-2' });
  assert.equal(paneZeroHost.classes.has('hidden'), true, 'pane 0 never shows pane 1\'s paste notice');
  assert.equal(paneZeroHost.innerHTML, '');
  assert.equal(paneOneHost.classes.has('hidden'), false);
  assert.match(paneOneHost.innerHTML || paneOneHost.textContent, /Large paste added\./);

  state.ui.composerStatusNoticeSessionId = '';
  controller.renderComposerStatusNotice();
  controller.renderComposerStatusNotice({ node: paneOneHost, sessionId: 'sess-2' });
  assert.equal(paneZeroHost.classes.has('hidden'), false, 'an unkeyed notice is pane 0\'s');
  assert.equal(paneOneHost.classes.has('hidden'), true);

  state.ui.composerStatusNoticeSessionId = 'sess-1';
  controller.renderComposerStatusNotice({ node: paneOneHost, sessionId: 'sess-2' });
  controller.renderComposerStatusNotice();
  assert.equal(paneZeroHost.classes.has('hidden'), false, 'a notice keyed to pane 0\'s session is pane 0\'s');
  assert.equal(paneOneHost.classes.has('hidden'), true);
});

test('one pane: a notice keyed to another session still renders in pane 0 (today\'s path)', (t) => {
  withPaneVisibility(t);
  const host = fakeNoticeHost();
  const state = {
    currentSessionId: 'sess-1', runtimeDraft: {},
    ui: { activeView: 'chat', composerStatusNotice: 'Large paste added.', composerStatusNoticeOwner: 'composer:paste-size',
      composerStatusNoticeTone: 'warning', composerStatusNoticeSessionId: 'sess-9' },
  };
  const { controller } = makeController({}, { state, composerStatusNotice: host });
  controller.renderComposerStatusNotice();
  assert.equal(host.classes.has('hidden'), false);
});

// Gate §D follow-ups (2026-09-26).
test('two panes: a notice keyed to a session neither pane shows renders nowhere', (t) => {
  withPaneVisibility(t);
  const paneZeroHost = fakeNoticeHost();
  const paneOneHost = fakeNoticeHost();
  const state = {
    currentSessionId: 'sess-1', runtimeDraft: {},
    // Pane 1 moved from sess-2 to sess-3 while sess-2's paste notice was up.
    panes: { panes: [{ paneId: 0, sessionId: 'sess-1' }, { paneId: 1, sessionId: 'sess-3' }], focusedPaneId: 0 },
    ui: { activeView: 'chat', composerStatusNotice: 'Paste is too large.', composerStatusNoticeOwner: 'composer:paste-size',
      composerStatusNoticeTone: 'warning', composerStatusNoticeSessionId: 'sess-2' },
  };
  const { controller } = makeController({}, { state, composerStatusNotice: paneZeroHost });
  controller.renderComposerStatusNotice();
  controller.renderComposerStatusNotice({ node: paneOneHost, sessionId: 'sess-3' });
  assert.equal(paneZeroHost.classes.has('hidden'), true, 'pane 0 does not inherit sess-2\'s notice');
  assert.equal(paneZeroHost.innerHTML, '');
  assert.equal(paneOneHost.classes.has('hidden'), true);
});

test('pane 1\'s host renders its own session\'s compaction progress; pane 0 keeps its own', (t) => {
  withPaneVisibility(t);
  const previousCoordinator = global.rendererCompactionCoordinator;
  global.rendererCompactionCoordinator = require('../renderer/shell/renderer-settings-compaction-section.js');
  t.after(() => { global.rendererCompactionCoordinator = previousCoordinator; });
  const paneZeroHost = fakeNoticeHost();
  const paneOneHost = fakeNoticeHost();
  const applied = [];
  const state = {
    currentSessionId: 'sess-1', runtimeDraft: {},
    panes: { panes: [{ paneId: 0, sessionId: 'sess-1' }, { paneId: 1, sessionId: 'sess-2' }], focusedPaneId: 0 },
    ui: { activeView: 'chat', composerStatusNotice: '', composerStatusNoticeOwner: '' },
    compactionActivities: new Map([['sess-2', {
      sessionId: 'sess-2', state: 'pending', pending: true, message: 'Compacting context…', tone: 'pending',
    }]]),
  };
  const { controller } = makeController({
    applyActivityAttributes: (node, snapshot) => applied.push([node, snapshot ? snapshot.state : null]),
  }, { state, composerStatusNotice: paneZeroHost });
  controller.renderComposerStatusNotice();
  controller.renderComposerStatusNotice({ node: paneOneHost, sessionId: 'sess-2' });
  assert.equal(paneZeroHost.classes.has('hidden'), true, 'pane 0 (sess-1) is not compacting');
  assert.equal(paneOneHost.classes.has('hidden'), false);
  assert.match(paneOneHost.innerHTML || paneOneHost.textContent, /Compacting context/);
  assert.deepEqual(applied.filter(([node]) => node === paneOneHost).map(([, value]) => value), ['pending'], 'pane 1\'s host is marked busy');

  state.compactionActivities.set('sess-2', { sessionId: 'sess-2', state: 'success', pending: false, message: 'Compacted.', tone: 'success' });
  controller.renderComposerStatusNotice({ node: paneOneHost, sessionId: 'sess-2' });
  assert.match(paneOneHost.innerHTML || paneOneHost.textContent, /Compacted\./, 'the settled result replaces the progress');
});
