'use strict';

// Row 38 item 5 (variant A): the words and actions the empty-chat hero shows
// for each model state. The view is given; deriving it is the chrome's job.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { heroCopy, setupFootnote, etaSeconds, etaText } = require('../renderer/chat/renderer-hero-model-state');
const { deriveHeroView } = require('../renderer/chat/renderer-hero-model-state');

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
  assert.equal(copy.hint, 'Or sign in with ChatGPT in Settings › Cloud models.');
  assert.equal(copy.composerLine, 'Send turns on once a model is ready.');
  const bare = heroCopy({ kind: 'noModel', recommended: null });
  assert.equal(bare.subtitle, 'Jenny needs a model before she can reply.');
  assert.deepEqual(actions(bare.actionsHtml), [['browse', '', 'Browse models', true]], 'Browse is primary when nothing is recommended');
});

test('downloading: progress with an ETA once a rate exists, Cancel, and the composer line names the pull', () => {
  const pull = { tag: 'qwen3:4b', percent: 61, completedBytes: 1.6 * 1024 ** 3, totalBytes: 2.6 * 1024 ** 3, startedAt: 1000 };
  const copy = heroCopy({ kind: 'downloading', pull, now: 1000 + 100000 });
  assert.equal(copy.title, 'Getting qwen3:4b ready');
  assert.equal(copy.subtitle, "1.6 GB of 2.6 GB · about 1 minute left. You can write your first message now; Jenny replies once it's in.");
  assert.deepEqual(actions(copy.actionsHtml), [['cancel-download', 'qwen3:4b', 'Cancel download', false]]);
  assert.equal(copy.composerLine, 'Jenny is downloading qwen3:4b. Send turns on when it is ready.');
  const early = heroCopy({ kind: 'downloading', pull: { ...pull, completedBytes: 0, percent: 0 } });
  assert.equal(early.subtitle, "You can write your first message now; Jenny replies once it's in.", 'no bytes yet: the wait alone');
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

test('ready: today\'s hero, naming the model that loads on first message only while none is loaded', () => {
  const lazy = heroCopy({ kind: 'ready', model: 'qwen3:4b', loaded: false });
  assert.equal(lazy.title, 'New session');
  assert.equal(lazy.subtitle, 'Ask Jenny anything to begin');
  assert.equal(lazy.hint, 'qwen3:4b loads with your first message');
  assert.equal(lazy.actionsHtml, '');
  assert.equal(lazy.composerLine, '');
  assert.equal(heroCopy({ kind: 'ready', model: 'qwen3:4b', loaded: true }).hint, '');
  assert.equal(heroCopy({ kind: 'ready', model: '', loaded: false }).hint, '', 'no model to name, no hint');
  assert.equal(heroCopy(null).title, 'New session', 'an unknown view reads as ready');
});

test('the setup footnote appears only when a reply can happen, and names the model', () => {
  assert.equal(setupFootnote({ kind: 'ready', model: 'qwen3:4b' }), 'qwen3:4b is ready, so you can start chatting now.');
  assert.equal(setupFootnote({ kind: 'noModel' }), '');
  assert.equal(setupFootnote({ kind: 'downloading', model: 'qwen3:4b' }), '');
  assert.equal(setupFootnote({ kind: 'failed', model: 'qwen3:8b' }), '');
  assert.equal(setupFootnote({ kind: 'ready', model: '' }), '');
});
