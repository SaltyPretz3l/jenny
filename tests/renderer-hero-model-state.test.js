'use strict';

// Row 38 item 5 (variant A): the words and actions the empty-chat hero shows
// for each model state. The view is given; deriving it is the chrome's job.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { heroCopy, setupFootnote, etaSeconds, etaText } = require('../renderer/chat/renderer-hero-model-state');
const { deriveHeroView, createSessionProjectLookup } = require('../renderer/chat/renderer-hero-model-state');

test('derive prioritizes failure, running pull, missing route, then ready without mutating state', () => {
  const failure = { cause: 'out_of_memory', model: 'large', context: 40960 };
  const pull = { tag: 'small', status: 'running', percent: 20, completedBytes: 20, totalBytes: 100, startedAt: 1000 };
  const state = { backend: { phase: 'model_unavailable', model_lifecycle: { failure } },
    modelPulls: { small: pull }, modelList: { available: true, data: [] }, modelRecommendation: { tag: 'fit', downloadSizeMb: 42 } };
  const before = JSON.stringify(state);
  const deps = { now: () => 5000 };
  assert.equal(deriveHeroView(state, deps).kind, 'failed');
  assert.equal(deriveHeroView(state, deps).model, 'large');
  state.backend = { phase: 'ready' };
  assert.deepEqual(deriveHeroView(state, deps).pull, { tag: 'small', percent: 20, completedBytes: 20, totalBytes: 100, startedAt: 1000 });
  assert.equal(deriveHeroView(state, deps).kind, 'downloading');
  pull.status = 'error';
  assert.equal(deriveHeroView(state, deps).kind, 'noModel');
  assert.deepEqual(deriveHeroView(state, deps).recommended, state.modelRecommendation);
  state.modelList.data = [{ id: 'disabled', available: false }, { id: 'usable' }];
  state.status = { model: 'status', model_loaded: true };
  assert.equal(deriveHeroView(state, deps).kind, 'ready');
  assert.equal(deriveHeroView(state, deps).loaded, true);
  for (const [remove, expected] of [['none', 'status'], ['status', 'active'], ['active', 'preferred'], ['preferred', '']]) {
    state.modelList.active_model = remove === 'active' || remove === 'preferred' ? '' : 'active';
    state.offline = { preferredLocalModel: remove === 'preferred' ? '' : 'preferred' };
    if (remove !== 'none') state.status.model = '';
    assert.equal(deriveHeroView(state, deps).model, expected);
  }
  assert.equal(deriveHeroView(state, deps).now, 5000);
  const frozen = JSON.parse(before);
  deriveHeroView(frozen, deps);
  assert.equal(JSON.stringify(frozen), before);
});

test('derive maps managed acquisition and respects list availability and setup route evidence', () => {
  assert.deepEqual(deriveHeroView({ backend: { phase: 'model_acquiring', model_acquisition: {
    requested_model: 'managed', percent: 25, completed_bytes: 50, total_bytes: 200, started_at: 1000,
  } } }, { now: () => 2000 }).pull, { tag: 'managed', percent: 25, completedBytes: 50, totalBytes: 200, startedAt: 1000 });
  for (const data of [[], [{ available: false }]]) {
    assert.equal(deriveHeroView({ modelList: { data }, setup: { steps: { endpoint: 'done' } } }).kind, 'noModel');
  }
  // An unread, unavailable or shapeless list is unknown, not empty: the hero keeps today's words.
  for (const modelList of [undefined, {}, { available: false, data: [] }, { available: true }]) {
    const state = { modelList, setup: { loaded: true, steps: { localModel: 'skipped', endpoint: 'error' } } };
    assert.equal(deriveHeroView(state).kind, 'ready', `list ${JSON.stringify(modelList)} is not "no model"`);
  }
  assert.equal(deriveHeroView({ modelList: { data: [{ available: true }] } }).kind, 'ready');
  // A model loading now is not "no model", whatever the catalog last said.
  assert.equal(deriveHeroView({ backend: { phase: 'model_loading' }, modelList: { data: [] } }).kind, 'ready');
});

test('model_unavailable is never "ready": a known model failed to load, and with none known the hero asks for one', () => {
  // Unread model list and no classified cause: the degraded returning boot.
  const view = deriveHeroView({ backend: { phase: 'model_unavailable', model_lifecycle: { engine: 'ollama' } },
    offline: { preferredLocalModel: 'qwen3:8b' } });
  assert.equal(view.kind, 'failed');
  assert.equal(view.model, 'qwen3:8b');
  const copy = heroCopy(view);
  assert.equal(copy.title, "qwen3:8b didn't load");
  assert.equal(copy.subtitle, 'Ollama could not load it.');
  assert.deepEqual(actions(copy.actionsHtml).map(([action]) => action), ['retry', 'copyDetails']);
  assert.equal(copy.composerLine, 'Sending retries the load.');
  assert.equal(deriveHeroView({ backend: { phase: 'model_unavailable' } }).kind, 'noModel');
  // Every other phase keeps an unread list unknown.
  for (const phase of ['ready', 'starting', 'failed']) assert.equal(deriveHeroView({ backend: { phase } }).kind, 'ready', phase);
});

function actions(html) {
  const dom = new JSDOM(html);
  return [...dom.window.document.querySelectorAll('button[data-hero-action]')]
    .map((button) => [button.dataset.heroAction, button.dataset.heroModel, button.textContent.trim(), /primary/.test(button.className)]);
}

test('no model: pick a model, the recommended fit first, Browse beside it, the cloud route as a hint', () => {
  const copy = heroCopy({ kind: 'noModel', recommended: { tag: 'qwen3:4b', downloadSizeMb: 2600 } });
  assert.equal(copy.title, 'Pick a model to start');
  assert.equal(copy.subtitle, 'Jenny needs a model before she can reply. qwen3:4b fits this computer (2.5 GB download).');
  assert.deepEqual(actions(copy.actionsHtml), [
    ['download', 'qwen3:4b', 'Download qwen3:4b', true],
    ['browse', '', 'Browse models', false],
  ]);
  // Your own API key comes first, so ChatGPT does not read as Jenny's default provider.
  assert.equal(copy.hint, 'Or add an API key or sign in with ChatGPT.');
  // heroCopy stays pure: the links are data, and renderHero builds the buttons.
  assert.deepEqual(copy.hintAction, {
    parts: [
      'Or ',
      { action: 'api-key', label: 'add an API key',
        html: '<button type="button" class="hero-hint-link" data-hero-action="api-key">add an API key</button>' },
      ' or ',
      { action: 'cloud', label: 'sign in with ChatGPT',
        html: '<button type="button" class="hero-hint-link" data-hero-action="cloud">sign in with ChatGPT</button>' },
      '.',
    ],
  });
  assert.equal(copy.composerLine, 'Send turns on once a model is ready.');
  const bare = heroCopy({ kind: 'noModel', recommended: null });
  assert.equal(bare.subtitle, 'Jenny needs a model before she can reply.');
  assert.deepEqual(actions(bare.actionsHtml), [['browse', '', 'Browse models', true]], 'Browse is primary when nothing is recommended');
});

test('no model: a translation may reorder the hint links; a missing one falls back to plain text', (t) => {
  const saved = globalThis.jennyI18nFallback;
  t.after(() => { globalThis.jennyI18nFallback = saved; delete require.cache[require.resolve('../renderer/chat/renderer-hero-model-state')]; });
  const strings = { 'hero.noModel.cloudOptions': '{chatgpt}, oder {apiKey}.' };
  globalThis.jennyI18nFallback = (key, fallback) => strings[key] ?? fallback;
  delete require.cache[require.resolve('../renderer/chat/renderer-hero-model-state')];
  const translated = require('../renderer/chat/renderer-hero-model-state');
  const reordered = translated.heroCopy({ kind: 'noModel' });
  assert.equal(reordered.hint, 'sign in with ChatGPT, oder add an API key.');
  assert.deepEqual(reordered.hintAction.parts.map((part) => (typeof part === 'string' ? part : part.action)), ['', 'cloud', ', oder ', 'api-key', '.']);
  strings['hero.noModel.cloudOptions'] = 'Oder {chatgpt}.';
  const partial = translated.heroCopy({ kind: 'noModel' });
  assert.equal(partial.hint, 'Oder {chatgpt}.', 'a sentence missing a link shows as written');
  assert.equal(partial.hintAction, null);
});

test('downloading: progress with an ETA once a rate exists, Cancel, and the composer line names the pull', () => {
  const pull = { tag: 'qwen3:4b', percent: 61, completedBytes: 1.6 * 1024 ** 3, totalBytes: 2.6 * 1024 ** 3, startedAt: 1000 };
  const copy = heroCopy({ kind: 'downloading', pull, now: 1000 + 100000 });
  assert.equal(copy.title, 'Getting qwen3:4b ready');
  // Send is off during a download, so the hero says so in the composer's terms.
  assert.equal(copy.subtitle, '1.6 GB of 2.6 GB · about 1 minute left. Write your first message now; you can send it when the download finishes.');
  assert.equal(copy.hintAction, null);
  assert.deepEqual(actions(copy.actionsHtml), [['cancel-download', 'qwen3:4b', 'Cancel download', false]]);
  assert.equal(copy.composerLine, 'Jenny is downloading qwen3:4b. Send turns on when it is ready.');
  const early = heroCopy({ kind: 'downloading', pull: { ...pull, completedBytes: 0, percent: 0 } });
  assert.equal(early.subtitle, 'Write your first message now; you can send it when the download finishes.', 'no bytes yet: the wait alone');
  const noTotal = heroCopy({ kind: 'downloading', pull: { tag: 'x', percent: 40 } });
  assert.match(noTotal.subtitle, /^40% so far\. /);
});

test('eta: null until there is a rate or a total, under a minute, then rounded minutes', () => {
  assert.equal(etaSeconds({ completedBytes: 0, totalBytes: 10, startedAt: 1 }, 100), null);
  assert.equal(etaSeconds({ completedBytes: 5, totalBytes: 0, startedAt: 1 }, 100), null);
  assert.equal(etaSeconds({ completedBytes: 5, totalBytes: 10, startedAt: 1000 }, 1000), null, 'no elapsed time, no rate');
  assert.equal(etaSeconds({ completedBytes: 500, totalBytes: 1000, startedAt: 1000 }, 11000), 10);
  assert.equal(etaText(null), '');
  assert.equal(etaText(30), 'under a minute');
  assert.equal(etaText(60), 'about 1 minute');
  assert.equal(etaText(150), 'about 3 minutes');
});

test("failed: the model that didn't load, the cause in plain words, item 1's two matching fixes", () => {
  const failure = { cause: 'out_of_memory', message: 'needs 7.2 GiB', context: 40960, at: '2026-10-07T12:00:00Z', engine: 'ollama', model: 'qwen3:8b' };
  const copy = heroCopy({ kind: 'failed', failure });
  assert.equal(copy.title, "qwen3:8b didn't load");
  assert.equal(copy.subtitle, 'Not enough memory to load it. A smaller context needs less.');
  assert.deepEqual(actions(copy.actionsHtml), [
    ['loadSmaller', 'qwen3:8b', 'Load at 32K context', true],
    ['showFits', 'qwen3:8b', 'Show models that fit', false],
  ]);
  assert.equal(copy.composerLine, 'Sending retries the load.');
  const unreachable = heroCopy({ kind: 'failed', failure: { ...failure, cause: 'engine_unreachable' } });
  assert.deepEqual(actions(unreachable.actionsHtml).map((row) => row[0]), ['diagnostics', 'retry']);
  assert.equal(unreachable.subtitle, "Ollama isn't responding.");
});

test('failed by a Live tab program: the hero names it and offers to stop it, then Retry (row 197)', () => {
  const failure = { cause: 'out_of_memory', message: 'x', engine: 'openai-compatible', model: 'qwen3:8b', liveRun: { projectId: 'p1', program: 'game.exe' } };
  const copy = heroCopy({ kind: 'failed', failure });
  assert.equal(copy.subtitle, 'game.exe, started from the Live tab, is using the GPU memory this model needs.');
  assert.deepEqual(actions(copy.actionsHtml), [
    ['stopLiveRun', 'qwen3:8b', 'Stop game.exe', true],
    ['retry', 'qwen3:8b', 'Retry', false],
  ]);
});

test('ready: "New chat", no subtitle, and the model note only while none is loaded', () => {
  const lazy = heroCopy({ kind: 'ready', model: 'qwen3:4b', loaded: false });
  assert.equal(lazy.title, 'New chat');
  assert.equal(lazy.subtitle, '', 'the placeholder already says what to do');
  assert.equal(lazy.hint, 'qwen3:4b loads with your first message');
  assert.equal(lazy.hintAction, null);
  assert.equal(lazy.actionsHtml, '');
  assert.equal(lazy.composerLine, '');
  assert.equal(heroCopy({ kind: 'ready', model: 'qwen3:4b', loaded: true }).hint, '');
  assert.equal(heroCopy({ kind: 'ready', model: '', loaded: false }).hint, '', 'no model to name, no hint');
  assert.equal(heroCopy(null).title, 'New chat', 'an unknown view reads as ready');
});

test('ready in a project: the title names it from one string, and the facts line leads with its folder', () => {
  const project = { name: 'jenny', path: 'D:\\Work\\jenny' };
  const lazy = heroCopy({ kind: 'ready', model: 'fit:3b', loaded: false, project });
  assert.equal(lazy.title, 'New chat in jenny');
  assert.equal(lazy.hint, 'D:\\Work\\jenny · fit:3b loads with your first message');
  assert.equal(heroCopy({ kind: 'ready', model: 'fit:3b', loaded: true, project }).hint, 'D:\\Work\\jenny');
  const folderless = heroCopy({ kind: 'ready', model: 'fit:3b', loaded: true, project: { name: 'Notes', path: '' } });
  assert.equal(folderless.title, 'New chat in Notes');
  assert.equal(folderless.hint, '', 'a folderless project with a loaded model has nothing to say');
  assert.equal(heroCopy({ kind: 'ready', project: { name: '', path: 'C:\\x' } }).title, 'New chat', 'no name, no project title');
  assert.equal(heroCopy({ kind: 'noModel', project }).title, 'Pick a model to start', 'only the ready state names the project');
});

test('the session project lookup loads the switcher once, waits for it, and stops listening on dispose', async () => {
  const projects = [{ id: 'p1', name: 'jenny', rootPath: 'D:\\Work\\jenny' }, { id: 'p2', name: 'Notes', rootPath: '' }];
  const switcherListeners = new Set();
  let loads = 0;
  let refreshes = 0;
  const switcher = {
    projectById: (id) => projects.find((project) => project.id === id) || null,
    onProjectsChanged: (listener) => { switcherListeners.add(listener); return () => switcherListeners.delete(listener); },
    refreshProjects: () => { refreshes += 1; return Promise.resolve(projects); },
  };
  let cleanup = null;
  const lookup = createSessionProjectLookup({
    getProjectSwitcher: () => { loads += 1; return Promise.resolve(switcher); },
    isPrimarySession: (session) => session.id === 'primary',
    registerCleanup: (fn) => { cleanup = fn; },
  });
  let notified = 0;
  const unsubscribe = lookup.onProjectsChanged(() => { notified += 1; });
  for (const session of [null, { id: 'g' }, { id: 'g', project_id: 'project_general' }, { id: 'primary', project_id: 'p1' },
    { id: 'plugin', project_id: 'p1', session_type: 'plugin' }]) {
    assert.equal(lookup.getSessionProject(session), null);
  }
  assert.equal(loads, 0, 'General, primary and plugin chats never load the switcher');
  assert.equal(lookup.getSessionProject({ id: 'a', project_id: 'p1' }), null, 'unknown until the switcher answers');
  assert.equal(lookup.getSessionProject({ id: 'b', project_id: 'p1' }), null);
  assert.equal(loads, 1, 'one load however many renders ask');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1);
  assert.ok(notified >= 1, 'the hero hears when the switcher arrives');
  assert.deepEqual(lookup.getSessionProject({ id: 'a', project_id: 'p1' }), { name: 'jenny', path: 'D:\\Work\\jenny' });
  assert.deepEqual(lookup.getSessionProject({ id: 'a', project_id: 'p2' }), { name: 'Notes', path: '' });
  assert.equal(lookup.getSessionProject({ id: 'a', project_id: 'gone' }), null);
  const before = notified;
  switcherListeners.forEach((listener) => listener([]));
  assert.equal(notified, before + 1, 'a list change reaches the hero');
  unsubscribe();
  switcherListeners.forEach((listener) => listener([]));
  assert.equal(notified, before + 1);
  lookup.onProjectsChanged(() => { notified += 1; });
  assert.equal(typeof cleanup, 'function', 'the lookup registers its teardown');
  cleanup();
  assert.equal(switcherListeners.size, 0, 'dispose leaves the switcher');
  assert.equal(lookup.getSessionProject({ id: 'a', project_id: 'p1' }), null);
});

test('the setup footnote appears only when a reply can happen, and names the model', () => {
  assert.equal(setupFootnote({ kind: 'ready', model: 'qwen3:4b' }), 'qwen3:4b is ready, so you can start chatting now.');
  assert.equal(setupFootnote({ kind: 'noModel' }), '');
  assert.equal(setupFootnote({ kind: 'downloading', model: 'qwen3:4b' }), '');
  assert.equal(setupFootnote({ kind: 'failed', model: 'qwen3:8b' }), '');
  assert.equal(setupFootnote({ kind: 'ready', model: '' }), '');
});
