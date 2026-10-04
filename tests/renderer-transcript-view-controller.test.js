'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

delete global.rendererAppLifecyclePreferences;
require('../renderer/app/renderer-app-lifecycle-preferences');

const { createTranscriptViewController } = global.rendererAppLifecyclePreferences;
const STORAGE_KEY = 'jenny.transcriptViewBySession.v1';

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); writes.push(key); },
    read(key) { return values.get(key); },
    writes,
  };
}

// Every side effect lands in one ordered journal so the setView contract order is checkable.
function makeHarness(t, { stored, transcriptViewDefault = 'thinking', reasoning = {}, updateSettings } = {}) {
  const journal = [];
  const storage = makeStorage(stored === undefined ? {} : { [STORAGE_KEY]: stored });
  const originalSetItem = storage.setItem;
  storage.setItem = (key, value) => { journal.push(['storage', key]); originalSetItem(key, value); };
  const state = {
    transcriptViewDefault,
    ui: {
      transcriptViewBySession: new Map(),
      reasoningPhaseExpansionBySession: new Map(Object.entries(reasoning).map(([sessionId, entries]) => [
        sessionId, new Map(Object.entries(entries)),
      ])),
    },
  };
  const reasoningExpansionController = {
    saveReasoningPhaseExpansionPreferences() {
      journal.push(['reasoning-save', [...state.ui.reasoningPhaseExpansionBySession.keys()]]);
    },
  };
  const thinkingController = {
    clearFollowExemptions() { journal.push(['clear-follow-exemptions']); },
    syncReasoningExpansionPause(options) { journal.push(['sync-pause', options]); },
  };
  const previousGlobals = {
    rendererTurnRowToolRenderUtils: global.rendererTurnRowToolRenderUtils,
    rendererTranscriptToolCallUtils: global.rendererTranscriptToolCallUtils,
    jennyShell: global.jennyShell,
  };
  global.rendererTurnRowToolRenderUtils = {
    clearToolRowExpansionOverridesForSession(sessionId) { journal.push(['tool-row-clear', sessionId]); },
  };
  global.rendererTranscriptToolCallUtils = {
    clearToolCallExpansionOverridesForSession(sessionId) { journal.push(['tool-call-clear', sessionId]); },
  };
  const patches = [];
  global.jennyShell = {
    chatUi: {
      async updateSettings(patch) {
        patches.push(patch);
        return updateSettings ? updateSettings(patch) : { zoomPercent: 100, ...patch };
      },
    },
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previousGlobals)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  });
  const controller = createTranscriptViewController({
    state,
    storage,
    thinkingController,
    reasoningExpansionController,
    renderAll: () => journal.push(['render']),
    appendClientLog: (level, event, details) => journal.push(['log', level, event, details]),
  });
  return { controller, state, storage, journal, patches };
}

test('explicit choices round-trip through storage and load on creation', (t) => {
  const first = makeHarness(t);
  first.controller.setView('s1', 'answers');
  first.controller.setView('s2', 'Everything');
  assert.deepEqual(JSON.parse(first.storage.read(STORAGE_KEY)), { s1: 'answers', s2: 'everything' });

  const second = makeHarness(t, { stored: first.storage.read(STORAGE_KEY), transcriptViewDefault: 'answers' });
  assert.deepEqual([...second.state.ui.transcriptViewBySession], [['s1', 'answers'], ['s2', 'everything']]);
  assert.equal(second.controller.getView('s2'), 'everything');
  assert.equal(second.controller.getView('s3'), 'answers', 'sessions without a choice follow the default');
});

test('stored choices drop invalid entries and keep the newest 256 sessions', (t) => {
  const payload = { '': 'answers', bad: 'loud', upper: 'ANSWERS' };
  for (let index = 0; index < 260; index += 1) payload[`s${index}`] = 'everything';
  const { controller, state, storage } = makeHarness(t, { stored: JSON.stringify(payload) });
  const store = state.ui.transcriptViewBySession;
  assert.equal(store.size, 256);
  assert.equal(store.has('bad'), false);
  assert.equal(store.has(''), false);
  assert.equal(store.has('s259'), true);

  controller.setView('fresh', 'answers');
  const saved = JSON.parse(storage.read(STORAGE_KEY));
  assert.equal(Object.keys(saved).length, 256, 'saving stays capped');
  assert.equal(saved.fresh, 'answers', 'the newest choice is kept');
});

test('corrupt or non-object storage is treated as empty', (t) => {
  for (const stored of ['{not json', '[1,2]', '"answers"', 'null']) {
    const { controller, state } = makeHarness(t, { stored });
    assert.equal(state.ui.transcriptViewBySession.size, 0, `stored=${stored}`);
    assert.equal(controller.getView('s1'), 'thinking');
  }
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  const state = { ui: {} };
  const controller = createTranscriptViewController({ state, storage: throwing });
  assert.equal(state.ui.transcriptViewBySession.size, 0);
  assert.equal(controller.setView('s1', 'answers'), 'answers', 'a failing storage write does not break the change');
  assert.equal(controller.getView('s1'), 'answers');
});

test('setView resets that session, then syncs, notifies, renders once, and logs, in order', (t) => {
  const { controller, state, journal } = makeHarness(t, {
    reasoning: { s1: { 'm1::p1': true }, s2: { 'm2::p1': true } },
  });

  const result = controller.setView('s1', 'answers', { source: 'shortcut' });

  assert.equal(result, 'answers');
  assert.equal(state.ui.transcriptViewBySession.get('s1'), 'answers');
  assert.equal(state.ui.reasoningPhaseExpansionBySession.has('s1'), false, 'this session reasoning prefs are dropped');
  assert.equal(state.ui.reasoningPhaseExpansionBySession.has('s2'), true, 'other sessions keep theirs');
  assert.deepEqual(journal, [
    ['storage', STORAGE_KEY],
    ['reasoning-save', ['s2']],
    ['tool-row-clear', 's1'],
    ['tool-call-clear', 's1'],
    ['clear-follow-exemptions'],
    ['sync-pause', { userInitiated: true }],
    ['render'],
    ['log', 'INFO', 'chat.transcript_view_changed', { sessionId: 's1', view: 'answers', source: 'shortcut' }],
  ]);
});

test('setView defaults its source to control and is a no-op when the explicit entry is unchanged', (t) => {
  const { controller, journal } = makeHarness(t);
  controller.setView('s1', 'everything');
  assert.deepEqual(journal.find((entry) => entry[0] === 'log')[3], { sessionId: 's1', view: 'everything', source: 'control' });
  journal.length = 0;

  assert.equal(controller.setView('s1', ' EVERYTHING '), 'everything');
  assert.deepEqual(journal, [], 'no storage write, reset, render, or log');
});

// Re-choosing the view a session already shows pins it but changes nothing on
// screen: the open rows (and their overrides) survive and nothing repaints. A
// later default change then leaves the pinned session alone.
test('setView pins the current effective view without resetting overrides or rendering', async (t) => {
  const { controller, state, journal } = makeHarness(t, { reasoning: { s1: { 'm1::p1': true } } });
  assert.equal(controller.setView('s1', 'thinking'), 'thinking');
  assert.equal(state.ui.transcriptViewBySession.get('s1'), 'thinking', 'the choice is pinned');
  assert.equal(state.ui.reasoningPhaseExpansionBySession.has('s1'), true, 'open rows stay open');
  assert.deepEqual(journal.map((entry) => entry[0]), ['storage'], 'persisted, nothing else');

  await controller.setDefault('everything');
  assert.equal(controller.getView('s1'), 'thinking');
  assert.equal(state.ui.reasoningPhaseExpansionBySession.has('s1'), true, 'the pinned session keeps its overrides');
});

test('cycle advances from the resolved view', (t) => {
  const { controller } = makeHarness(t, { transcriptViewDefault: 'everything' });
  assert.equal(controller.cycle('s1'), 'answers', 'follows the default, then wraps');
  assert.equal(controller.cycle('s1', { source: 'shortcut' }), 'thinking');
  assert.equal(controller.cycle('s1'), 'everything');
});

test('setDefault persists through chatUi and resets only sessions that follow the default', async (t) => {
  const { controller, state, journal, patches } = makeHarness(t, {
    reasoning: { pinned: { 'm1::p1': true }, follower: { 'm2::p1': false }, other: { 'm3::p1': true } },
  });
  controller.setView('pinned', 'answers');
  // A row the user opens after pinning the view is a fresh override the default change must keep.
  state.ui.reasoningPhaseExpansionBySession.set('pinned', new Map([['m1::p2', true]]));
  // A loaded session with tool overrides but no saved reasoning prefs follows the default too.
  state.sessions = [{ id: 'pinned' }, { id: 'loaded' }, { id: '' }, null];
  journal.length = 0;

  const result = await controller.setDefault('Everything');

  assert.equal(result, 'everything');
  assert.deepEqual(patches, [{ transcriptViewDefault: 'everything' }]);
  assert.equal(state.transcriptViewDefault, 'everything');
  assert.deepEqual([...state.ui.reasoningPhaseExpansionBySession.keys()], ['pinned'], 'explicit sessions keep their prefs');
  assert.deepEqual(journal.filter((entry) => entry[0] === 'tool-row-clear').map((entry) => entry[1]), ['follower', 'other', 'loaded']);
  assert.deepEqual(journal.filter((entry) => entry[0] === 'tool-call-clear').map((entry) => entry[1]), ['follower', 'other', 'loaded']);
  assert.deepEqual(journal.slice(-4), [
    ['clear-follow-exemptions'],
    ['sync-pause', { userInitiated: true }],
    ['render'],
    ['log', 'INFO', 'chat.transcript_view_default_changed', { view: 'everything', source: 'settings' }],
  ]);
  assert.equal(controller.getView('pinned'), 'answers');
  assert.equal(controller.getView('follower'), 'everything');

  journal.length = 0;
  assert.equal(await controller.setDefault('everything'), 'everything');
  assert.deepEqual(patches.length, 1, 'unchanged default does not persist');
  assert.deepEqual(journal, [], 'unchanged default does not reset, notify, or render');
});

test('setDefault keeps the renderer default until the save is confirmed and rejects when it is not', async (t) => {
  const { controller, state, journal } = makeHarness(t, {
    reasoning: { follower: { 'm1::p1': true } },
    updateSettings: () => ({ transcriptViewDefault: 'thinking' }),
  });

  await assert.rejects(controller.setDefault('answers'));

  assert.equal(state.transcriptViewDefault, 'thinking');
  assert.equal(state.ui.reasoningPhaseExpansionBySession.has('follower'), true, 'nothing is reset on failure');
  assert.equal(journal.some((entry) => entry[0] === 'event' || entry[0] === 'render'), false);
  assert.equal(journal.some((entry) => entry[0] === 'log' && entry[1] === 'WARN'), true);
});

// A render between the request and the confirmation (a streaming delta) must
// still see the old default: otherwise it commits the new view with the old
// overrides and the final render, seeing no view change, never resets them.
test('setDefault publishes the new default only after the save is confirmed', async (t) => {
  let resolveSave = null;
  const { controller, state, journal } = makeHarness(t, {
    reasoning: { follower: { 'm1::p1': false } },
    updateSettings: (patch) => new Promise((resolve) => { resolveSave = () => resolve({ ...patch }); }),
  });
  journal.length = 0;

  const pending = controller.setDefault('everything');
  await Promise.resolve();
  assert.equal(state.transcriptViewDefault, 'thinking', 'a render before the confirmation keeps the old default');
  assert.equal(state.ui.reasoningPhaseExpansionBySession.has('follower'), true, 'overrides are untouched until then');
  assert.deepEqual(journal, [], 'no reset, notice or render before the confirmation');

  resolveSave();
  assert.equal(await pending, 'everything');
  assert.equal(state.transcriptViewDefault, 'everything');
  assert.equal(state.ui.reasoningPhaseExpansionBySession.has('follower'), false, 'the inherited session resets with the view change');
  assert.deepEqual(journal.filter((entry) => entry[0] === 'render').length, 1);
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

// Overlapping default writes run one after another: each request evaluates
// against the default the previous one confirmed and publishes only its own
// confirmed snapshot, so the user's last choice wins and disk never splits from
// the renderer.
test('overlapping saves that both fail leave the renderer on the persisted default', async (t) => {
  const settlers = [];
  const { controller, state, patches } = makeHarness(t, {
    updateSettings: () => new Promise((_resolve, reject) => { settlers.push(reject); }),
  });

  const first = controller.setDefault('answers');
  const second = controller.setDefault('everything');
  await settle();
  assert.equal(settlers.length, 1, 'the second write waits for the first');
  settlers[0](new Error('first save failed'));
  await assert.rejects(first, /first save failed/);
  await settle();
  assert.equal(settlers.length, 2, 'the second write starts once the first settles');
  settlers[1](new Error('second save failed'));
  await assert.rejects(second, /second save failed/);

  assert.equal(state.transcriptViewDefault, 'thinking', 'nothing unpersisted is restored');
  assert.equal(patches.length, 2);
  // The renderer default still matches the persisted one, so choosing Answers again saves.
  global.jennyShell.chatUi.updateSettings = async (patch) => { patches.push(patch); return { ...patch }; };
  assert.equal(await controller.setDefault('answers'), 'answers');
  assert.equal(patches.length, 3, 'the retry persists instead of short-circuiting');
});

test('A -> B -> A: the last choice is written and wins', async (t) => {
  const resolvers = [];
  const { controller, state, patches, journal } = makeHarness(t, {
    updateSettings: (patch) => new Promise((resolve) => { resolvers.push(() => resolve({ ...patch })); }),
  });
  const calls = [controller.setDefault('answers'), controller.setDefault('everything'), controller.setDefault('answers')];
  for (let index = 0; index < 3; index += 1) {
    await settle();
    assert.equal(resolvers.length, index + 1, `write ${index + 1} starts after the previous confirmed`);
    resolvers[index]();
  }
  assert.deepEqual(await Promise.all(calls), ['answers', 'everything', 'answers']);
  assert.deepEqual(patches.map((patch) => patch.transcriptViewDefault), ['answers', 'everything', 'answers'], 'every request writes');
  assert.equal(state.transcriptViewDefault, 'answers', 'the user\'s last choice is the default');
  assert.equal(journal.filter((entry) => entry[0] === 'render').length, 3, 'each confirmed write publishes once');
});

test('a confirmed write followed by a failed one leaves the confirmed value on disk and screen', async (t) => {
  let failEverything = true;
  const { controller, state, patches } = makeHarness(t, {
    updateSettings: (patch) => (failEverything && patch.transcriptViewDefault === 'everything'
      ? Promise.reject(new Error('disk full'))
      : { ...patch }),
  });
  const first = controller.setDefault('answers');
  const second = controller.setDefault('everything');
  assert.equal(await first, 'answers');
  await assert.rejects(second, /disk full/);
  assert.equal(state.transcriptViewDefault, 'answers', 'the last confirmed persisted value stays published');
  assert.deepEqual(patches.map((patch) => patch.transcriptViewDefault), ['answers', 'everything']);
  failEverything = false;
  assert.equal(await controller.setDefault('everything'), 'everything', 'a retry writes again');
});

test('forgetSession and rekeySession move explicit choices and persist', (t) => {
  const { controller, state, storage } = makeHarness(t);
  controller.setView('draft', 'answers');
  controller.setView('gone', 'everything');

  assert.equal(controller.rekeySession('draft', 'real'), true);
  assert.equal(state.ui.transcriptViewBySession.has('draft'), false);
  assert.equal(controller.getView('real'), 'answers');
  assert.equal(controller.forgetSession('gone'), true);
  assert.deepEqual(JSON.parse(storage.read(STORAGE_KEY)), { real: 'answers' });

  assert.equal(controller.forgetSession('never'), false);
  assert.equal(controller.rekeySession('never', 'other'), false);
  assert.equal(controller.rekeySession('real', 'real'), false);
});

test('a view change reaches every pane reasoning controller, not only the app-level one (split view)', (t) => {
  const calls = [];
  const makeController = (name) => ({
    clearFollowExemptions: () => calls.push([name, 'clear']),
    syncReasoningExpansionPause: (options) => calls.push([name, 'sync', options]),
  });
  const state = { ui: {}, sessions: [], transcriptViewDefault: 'thinking' };
  const storage = { getItem: () => '{}', setItem() {} };
  let paneController = makeController('pane-1');
  const controller = createTranscriptViewController({
    state,
    storage,
    thinkingController: makeController('app'),
    getPaneThinkingControllers: () => [paneController],
    renderAll: () => calls.push(['render']),
  });

  controller.setView('s1', 'answers');
  assert.deepEqual(calls, [
    ['app', 'clear'], ['app', 'sync', { userInitiated: true }],
    ['pane-1', 'clear'], ['pane-1', 'sync', { userInitiated: true }],
    ['render'],
  ]);

  calls.length = 0;
  paneController = undefined; // one pane: no second controller
  controller.setView('s1', 'everything');
  assert.deepEqual(calls.map((call) => call[0]), ['app', 'app', 'render']);
});
