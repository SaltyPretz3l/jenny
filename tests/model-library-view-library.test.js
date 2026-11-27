// new-test-file: tests/model-library-view.test.js sits at the 600-line cap, and these cases are the Settings Library surface (libraryRowsModel, buildLibraryRow, buildLibraryList), a different builder family from the old row and card builders.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const view = require('../renderer/shell/model-library/model-library-view.js');

function fragment(html) {
  return JSDOM.fragment(html);
}

function card(overrides = {}) {
  return {
    key: 'acme/model:q6',
    tag: 'acme/model:q6',
    displayName: 'Acme Model',
    tier: 'daily',
    params: '12B',
    quant: 'Q6_K',
    contextLength: 32768,
    sizeBytes: 4_294_967_296,
    downloadSizeMb: 6400,
    vramRequiredMb: 8000,
    ramRequiredMb: 12000,
    budgetMb: 12000,
    installed: true,
    engineType: 'ollama',
    engineVisible: true,
    ollamaOnly: false,
    active: false,
    preferredLocal: false,
    recommended: false,
    reason: 'A good local fit.',
    fitState: 'fits',
    fitRatio: 2 / 3,
    fitLabel: 'Fits accelerator memory',
    source: 'both',
    ...overrides,
  };
}

// --- Settings > Models > Library: one search, scope chips, sort, keyed rows ---

function libraryMerged() {
  return {
    hardware: { detected: true, vramMb: 12288, budgetMb: 12000, name: 'Test GPU' },
    cards: [
      card({ key: 'alpha:1b', tag: 'alpha:1b', displayName: 'Alpha', selectedEngine: 'ollama', quant: 'Q4_K_M', vramRequiredMb: 6000, fitSource: 'observed' }),
      card({ key: 'bravo:2b', tag: 'bravo:2b', displayName: 'Bravo', selectedEngine: 'llama-server', quant: 'Q8_0', vramRequiredMb: 0, fitState: 'unknown', fitSource: '' }),
      card({ key: 'run:5b', tag: 'run:5b', displayName: 'Running', selectedEngine: 'ollama', active: true }),
      card({ key: 'zulu:9b', tag: 'zulu:9b', displayName: 'Zulu', selectedEngine: 'ollama', installed: false, engineVisible: false, source: 'catalog', recommended: true, fitState: 'fits', vramRequiredMb: 9000, fitSource: 'catalog' }),
      card({ key: 'echo:3b', tag: 'echo:3b', displayName: 'Echo', selectedEngine: 'ollama', installed: false, engineVisible: false, source: 'catalog', recommended: false, fitState: 'over', vramRequiredMb: 20000, fitSource: 'catalog' }),
    ],
  };
}

function libraryKeys(models) {
  return { mine: models.mine.map((c) => c.key), catalog: models.catalog.map((c) => c.key) };
}

test('libraryRowsModel filters by name, tag, quant and engine, case-insensitively, and counts follow the query', () => {
  const base = { scope: 'all', sort: 'name' };
  const all = view.libraryRowsModel(libraryMerged(), { ...base, query: '' });
  assert.deepEqual(libraryKeys(all), { mine: ['alpha:1b', 'bravo:2b'], catalog: ['zulu:9b', 'echo:3b'] });
  assert.deepEqual(all.counts, { all: 4, mine: 2, get: 2 });
  assert.deepEqual(libraryKeys(view.libraryRowsModel(libraryMerged(), { ...base, query: 'BRAVO' })).mine, ['bravo:2b'], 'name');
  assert.deepEqual(libraryKeys(view.libraryRowsModel(libraryMerged(), { ...base, query: 'alpha:1' })).mine, ['alpha:1b'], 'tag');
  assert.deepEqual(libraryKeys(view.libraryRowsModel(libraryMerged(), { ...base, query: 'q8_0' })).mine, ['bravo:2b'], 'quant');
  const engine = view.libraryRowsModel(libraryMerged(), { ...base, query: 'Llama-Server' });
  assert.deepEqual(libraryKeys(engine).mine, ['bravo:2b'], 'engine');
  assert.deepEqual(engine.counts, { all: 1, mine: 1, get: 0 });
  assert.deepEqual(view.libraryRowsModel(libraryMerged(), { ...base, query: 'nothing here' }).counts, { all: 0, mine: 0, get: 0 });
});

test('the active card is never listed and sort size orders by VRAM with unknown last', () => {
  const models = view.libraryRowsModel(libraryMerged(), { scope: 'all', sort: 'name', query: 'run' });
  assert.deepEqual(libraryKeys(models), { mine: [], catalog: [] }, 'the running model belongs to Running now');
  const bySize = view.libraryRowsModel(libraryMerged(), { scope: 'all', sort: 'size', query: '' });
  assert.deepEqual(libraryKeys(bySize), { mine: ['alpha:1b', 'bravo:2b'], catalog: ['zulu:9b', 'echo:3b'] });
  const cards = libraryMerged().cards.map((c) => (c.key === 'alpha:1b' ? { ...c, vramRequiredMb: 0 } : c.key === 'bravo:2b' ? { ...c, vramRequiredMb: 3000, fitState: 'fits' } : c));
  assert.deepEqual(view.libraryRowsModel({ ...libraryMerged(), cards }, { scope: 'mine', sort: 'size', query: '' }).mine.map((c) => c.key), ['bravo:2b', 'alpha:1b']);
});

test('scope chips: mine lists installed only, get lists catalog only, all collapses the catalog until searched', () => {
  const list = (opts) => fragment(`<div>${view.buildLibraryList(libraryMerged(), { actions: ['use', 'tune', 'pull', 'menu'], sort: 'name', ...opts })}</div>`);
  const keys = (root) => [...root.querySelectorAll('.mrow[data-model-key]')].map((el) => el.dataset.modelKey);
  const mine = list({ scope: 'mine', query: '' });
  assert.deepEqual(keys(mine), ['alpha:1b', 'bravo:2b']);
  assert.equal(mine.querySelector('.mrow-sep'), null);
  const get = list({ scope: 'get', query: '' });
  assert.deepEqual(keys(get), ['zulu:9b', 'echo:3b']);
  assert.equal(get.querySelector('.mrow-sep'), null);
  const collapsed = list({ scope: 'all', query: '' });
  assert.deepEqual(keys(collapsed), ['alpha:1b', 'bravo:2b']);
  const more = collapsed.querySelector('.mp-more--inlist');
  assert.match(more.textContent, /^1 more models fit this PC/);
  assert.ok(more.querySelector('[data-model-library-section-action="show-catalog"]'));
  const expanded = list({ scope: 'all', query: '', showAllCatalog: true });
  assert.deepEqual(keys(expanded), ['alpha:1b', 'bravo:2b', 'zulu:9b', 'echo:3b']);
  assert.match(expanded.querySelector('.mrow-sep').textContent, /Not on this PC yet/);
  assert.ok(expanded.querySelector('[data-model-library-section-action="hide-catalog"]'));
  const searched = list({ scope: 'all', query: 'b' });
  assert.ok(searched.querySelector('.mrow-sep'), 'a query shows the catalog matches under the separator');
  assert.equal(searched.querySelector('[data-model-library-section-action="hide-catalog"]'), null, 'no Hide while searching');
  const noFit = view.buildLibraryList({ ...libraryMerged(), cards: libraryMerged().cards.filter((c) => c.key !== 'zulu:9b') }, { scope: 'all', query: '', sort: 'name', actions: [] });
  assert.match(noFit, /1 models you can download/);
  const empty = fragment(`<div>${view.buildLibraryList(libraryMerged(), { scope: 'all', query: 'zzz', sort: 'name', actions: [] })}</div>`);
  assert.match(empty.querySelector('.mp-empty').textContent, /Nothing matches “zzz”\. To pull a model Jenny does not list, paste its full tag, such as qwen3:8b\./);
  assert.ok(empty.querySelector('[data-model-library-section-action="clear-search"]'));
});

test('a pasted tag adds the Pull row first, only for tag-shaped text and never under On this PC', () => {
  const row = (query, scope = 'all') => fragment(`<div>${view.buildLibraryList(libraryMerged(), { scope, query, sort: 'name', actions: ['use'] })}</div>`).querySelector('.mrow--pull');
  const first = fragment(`<div>${view.buildLibraryList(libraryMerged(), { scope: 'all', query: 'qwen3:8b', sort: 'name', actions: [] })}</div>`);
  assert.ok(first.firstElementChild.firstElementChild.classList.contains('mrow--pull'), 'the Pull row leads');
  const pull = row('qwen3:8b');
  assert.match(pull.querySelector('.mrow-name').textContent, /Pull “qwen3:8b”/);
  assert.equal(pull.querySelector('.mrow-meta').textContent, 'An Ollama tag from ollama.com. Jenny shows the size before anything downloads.');
  assert.match(pull.querySelector('.mrow-fit').textContent, /Size checked first/);
  assert.equal(pull.querySelector('[data-model-library-section-action="pull-tag"]').textContent.trim(), 'Pull');
  assert.match(row('hf.co/a/b:Q4').querySelector('.mrow-meta').textContent, /^A Hugging Face GGUF address, pulled through Ollama\./);
  assert.ok(row('ab/cd'), 'a slash is enough');
  assert.equal(row('qwen 3'), null, 'whitespace is not a tag');
  assert.equal(row('ab:'), null, 'three characters or fewer are not a tag');
  assert.equal(row('qwen3'), null, 'no : or /');
  assert.equal(row('qwen3:8b', 'mine'), null, 'hidden under On this PC');
  assert.equal(row('alpha:1b'), null, 'an installed tag has its own row');
  assert.equal(view.libraryRowsModel(libraryMerged(), { scope: 'all', query: ' qwen3:8b ', sort: 'name' }).pullRow, 'qwen3:8b');
  assert.equal(view.libraryRowsModel(libraryMerged(), { scope: 'all', query: 'ab:', sort: 'name' }).pullRow, '');
});

test('the library has one primary button only while the Pull row shows; Use stays secondary', () => {
  const html = (query) => view.buildLibraryList(libraryMerged(), { scope: 'all', query, sort: 'name', showAllCatalog: true, actions: ['use', 'tune', 'pull', 'menu', 'retry'] });
  assert.equal(fragment(html('')).querySelectorAll('.btn--primary').length, 0);
  assert.equal(fragment(html('qwen3:8b')).querySelectorAll('.btn--primary').length, 1);
  const use = fragment(html('')).querySelector('[data-model-key="alpha:1b"] [data-model-card-action="use"]');
  assert.ok(use.classList.contains('mrow-use'));
  assert.equal(use.classList.contains('btn--primary'), false);
  assert.ok(fragment(html('')).querySelector('[data-model-key="alpha:1b"] [data-model-card-action="tune"]').classList.contains('btn--ghost'));
  const pullButton = fragment(html('')).querySelector('[data-model-key="zulu:9b"] [data-model-card-action="pull"]');
  assert.equal(pullButton.textContent.trim(), 'Download');
  assert.equal(pullButton.classList.contains('btn--primary'), false);
});

test('a Library row button says Load, with the model in its label, and keeps the use action id', () => {
  const row = fragment(view.buildLibraryRow(card({ key: 'alpha:1b', tag: 'alpha:1b', displayName: 'Alpha' }), { actions: ['use'] }));
  const load = row.querySelector('[data-model-card-action="use"]');
  assert.equal(load.textContent.trim(), 'Load');
  assert.equal(load.getAttribute('aria-label'), 'Load Alpha');
  const pending = fragment(view.buildLibraryRow(card({ key: 'alpha:1b', displayName: 'Alpha' }), { actions: ['use'], activation: { status: 'running', key: 'alpha:1b' } }));
  assert.equal(pending.querySelector('[data-model-card-action="use"]').textContent.trim(), 'Starting…');
});

test('cloud models leave the Library rows and chip counts, and one line says where they went', () => {
  const merged = libraryMerged();
  merged.cards.push(card({ key: 'cloud:gpt', tag: 'cloud:gpt', displayName: 'Cloud GPT', engineType: 'openai', selectedEngine: '' }));
  const withCloud = view.libraryRowsModel(merged, { scope: 'all', sort: 'name', showAllCatalog: true });
  assert.deepEqual(libraryKeys(withCloud), libraryKeys(view.libraryRowsModel(libraryMerged(), { scope: 'all', sort: 'name', showAllCatalog: true })));
  assert.deepEqual(withCloud.counts, view.libraryRowsModel(libraryMerged(), { scope: 'all', sort: 'name', showAllCatalog: true }).counts);
  assert.equal(view.libraryRowsModel(merged, { scope: 'all', query: 'openai' }).counts.all, 0, 'the engine name does not find a cloud row');
  const items = view.buildLibraryItems(merged, { scope: 'mine', sort: 'name', actions: ['use'] }).items;
  assert.equal(items.some((item) => item.key === 'cloud:gpt'), false);
  const note = fragment(items[items.length - 1].html).querySelector('.mlib-cloud-note');
  assert.equal(items[items.length - 1].key, ':cloud', 'the line comes last, under the list');
  assert.equal(note.textContent.replace(/\s+/g, ' ').trim(), "Cloud models are not listed here. You pick one in a chat's model button; their providers are under Cloud providers.");
  assert.equal(note.querySelector('[data-model-library-section-action="cloud-providers"]').textContent, 'Cloud providers');
  const empty = view.buildLibraryItems({ cards: [card({ engineType: 'openai' })] }, { scope: 'all' }).items;
  assert.deepEqual(empty.map((item) => item.key), [':empty', ':cloud'], 'the line stays under an empty list');
});

test('library rows show flags, meta, the fit bar with its number, and an honest dash when unmeasured', () => {
  const doc = (c, o) => fragment(view.buildLibraryRow(c, { actions: ['use', 'tune', 'menu', 'pull'], budgetMb: 12000, ...o }));
  const alpha = doc(card({ key: 'alpha:1b', tag: 'alpha:1b', displayName: 'Alpha', selectedEngine: 'ollama', params: '12B', quant: 'Q4_K_M', vramRequiredMb: 6000, fitSource: 'estimated', mtp: { enabled: true }, preferredLocal: true, accelerationEligible: true }));
  const rowEl = alpha.querySelector('.mrow');
  assert.equal(rowEl.dataset.modelKey, 'alpha:1b');
  assert.equal(rowEl.querySelector('.mrow-name').title, 'alpha:1b');
  assert.deepEqual([...rowEl.querySelectorAll('.mrow-flag')].map((f) => f.textContent), ['MTP', 'Default']);
  assert.equal([...rowEl.querySelectorAll('.mrow-flag')].find((f) => f.textContent === 'Default').title, 'New chats set to Default use this model');
  assert.equal(rowEl.querySelector('.mrow-meta').textContent, 'Ollama · 12B · Q4_K_M · 32K context · 4 GB on disk');
  assert.equal(rowEl.querySelector('.mrow-fit-bar i').style.width, '50%');
  assert.equal(rowEl.querySelector('.mrow-fit-num').textContent, '~5.9 GB');
  assert.equal(rowEl.querySelector('.mrow-fit-bar--over'), null);
  const ready = doc(card({ accelerationEligible: true, mtp: { enabled: false } }));
  assert.deepEqual([...ready.querySelectorAll('.mrow-flag')].map((f) => f.textContent), ['MTP ready']);
  const over = doc(card({ fitState: 'over', vramRequiredMb: 20000 }));
  assert.ok(over.querySelector('.mrow-fit-bar--over'));
  assert.equal(over.querySelector('.mrow-fit-bar i').style.width, '100%', 'clamped');
  const cpu = doc(card({ fitState: 'cpu' }));
  assert.equal(cpu.querySelector('.mrow-fit').textContent, 'Runs on CPU');
  const unknown = doc(card({ fitState: 'unknown', fitSource: '', vramRequiredMb: 0 }));
  assert.equal(unknown.querySelector('.mrow-fit').textContent.trim(), '—');
  assert.match(unknown.querySelector('.mrow-fit [title]').title, /has not measured this file yet/);
  assert.ok(unknown.querySelector('.mrow-fit-num--none'), 'the dash sits where the numbers do');
  assert.equal(cpu.querySelector('.mrow-fit-num--none'), null);
  // The bar is a share of the whole card (vramMb), the scale Running now and its preview use.
  const listed = fragment(view.buildLibraryList(libraryMerged(), { actions: ['use'] }));
  assert.equal(listed.querySelector('[data-model-key="alpha:1b"] .mrow-fit-bar i').style.width, '48.8%');
  const hosted = doc(card({ engineType: 'openai', engineVisible: true }));
  assert.match(hosted.querySelector('.mrow-meta').textContent, /Hosted · no download$/);
  assert.equal(hosted.querySelector('.mrow-fit').textContent.trim(), '—');
  const best = doc(card({ installed: false, source: 'catalog', recommended: true, fitState: 'fits', downloadSizeMb: 6400 }));
  assert.deepEqual([...best.querySelectorAll('.mrow-flag')].map((f) => f.textContent), ['Best fit']);
  assert.match(best.querySelector('.mrow-meta').textContent, /~6\.3 GB download$/);
  const failed = doc(card({ loadFailure: { cause: 'out_of_memory', message: 'x', context: 40960, at: '2026-10-07T12:00:00.000Z', engine: 'ollama', model: 'acme/model:q6' } }), { actions: ['use', 'tune', 'menu', 'retry', 'loadSmaller', 'showFits'] });
  assert.equal(failed.querySelector('.mrow').dataset.loadFailed, 'true');
  assert.match(failed.querySelector('.mrow-flag--danger').textContent, /Didn't load/);
  assert.equal(failed.querySelectorAll('.btn--primary').length, 0, 'recovery buttons are not primary at rest');
});

test('libraryEngineName and isHostedCard name the engine and tell a hosted card from a local one', () => {
  assert.equal(view.libraryEngineName(card({ selectedEngine: 'ollama' })), 'Ollama');
  assert.equal(view.libraryEngineName(card({ selectedEngine: 'ninfer' })), 'NInfer');
  assert.equal(view.libraryEngineName(card({ selectedEngine: 'llama-server', customBuild: 10683 })), 'llama-server \u00b7 build 10683');
  assert.equal(view.libraryEngineName(card({ selectedEngine: 'llama-server', customBuild: 0 })), 'llama-server');
  assert.equal(view.libraryEngineName(card({ selectedEngine: undefined })), 'Ollama', 'an unnamed engine reads as Ollama');
  assert.equal(view.isHostedCard(card({ engineType: 'openai' })), true);
  assert.equal(view.libraryEngineName(card({ engineType: 'openai' })), 'openai');
  assert.equal(view.isHostedCard(card({ engineType: 'openai', installed: false })), false, 'a catalog card is not hosted');
  for (const engineType of ['ollama', 'vllm', 'openai-compatible', '']) {
    assert.equal(view.isHostedCard(card({ engineType })), false, engineType);
  }
});

// Row 201 C1 / OD-1: team models sit in their own read-only "From your teams" group.
function teamMerged(extra = {}) {
  return {
    ...libraryMerged(),
    teamModels: [
      { id: 'team/team_alpha1/qwen3:70b', modelId: 'qwen3:70b', teamId: 'team_alpha1', teamName: 'Alpha crew', contextLength: 32768 },
      { id: 'team/team_bravo2/gemma3:27b', modelId: 'gemma3:27b', teamId: 'team_bravo2', teamName: '', contextLength: 0 },
    ],
    ...extra,
  };
}

test('team models list under "From your teams" with the team in the name, read-only, never in On this PC', () => {
  const options = { scope: 'all', query: '', sort: 'name', actions: ['use', 'tune', 'pull', 'menu', 'unload'] };
  const root = fragment(`<div>${view.buildLibraryList(teamMerged(), options)}</div>`);
  const sep = [...root.querySelectorAll('.mrow-sep')].find((el) => /From your teams/.test(el.textContent));
  assert.ok(sep, 'the group has its title');
  const rows = [...root.querySelectorAll('.mrow[data-team-model]')];
  assert.deepEqual(rows.map((row) => row.querySelector('.mrow-name').textContent), ['qwen3:70b \u00b7 Alpha crew', 'gemma3:27b \u00b7 Unnamed team']);
  for (const row of rows) {
    assert.equal(row.querySelector('button'), null, 'no Load, Tune, Set as default or menu');
    assert.doesNotMatch(row.textContent, /Ollama|team\/team_/);
    assert.doesNotMatch(row.textContent, /can read your prompts/, "the notice is the group's, not the row's");
  }
  assert.equal(root.querySelector('[data-model-key^="team/"]'), null, 'no On this PC row');
  assert.deepEqual(view.libraryRowsModel(teamMerged(), options).counts, { all: 4, mine: 2, get: 2 }, 'On this PC counts exclude team models');
  for (const scope of ['mine', 'get']) {
    const other = fragment(`<div>${view.buildLibraryList(teamMerged(), { ...options, scope })}</div>`);
    assert.equal(other.querySelector('[data-team-model]'), null, scope);
  }
  const searched = fragment(`<div>${view.buildLibraryList(teamMerged(), { ...options, query: 'alpha' })}</div>`);
  assert.deepEqual([...searched.querySelectorAll('[data-team-model]')].map((row) => row.dataset.teamModel), ['team/team_alpha1/qwen3:70b']);
  const none = fragment(`<div>${view.buildLibraryList(teamMerged({ teamModels: [] }), options)}</div>`);
  assert.equal(none.querySelector('[data-team-model]'), null);
  assert.equal([...none.querySelectorAll('.mrow-sep')].some((el) => /From your teams/.test(el.textContent)), false, 'no group without a team model');
});

// Layout D4 A: the team model privacy notice is drawn once under the group heading, not under every row.
test('the team model notice is drawn once, directly under "From your teams", and every team row points at it', () => {
  const notice = 'The team’s host and the person whose hardware responds can read your prompts and replies.';
  const three = teamMerged({ teamModels: ['a', 'b', 'c'].map((n) => ({ id: `team/team_alpha1/m-${n}`, modelId: `m-${n}`, teamId: 'team_alpha1', teamName: 'Studio', contextLength: 8192 })) });
  const options = { scope: 'all', query: '', sort: 'name', actions: ['use', 'tune', 'pull', 'menu', 'unload'] };
  const count = (html) => html.split(notice).length - 1;
  const html = view.buildLibraryList(three, options);
  assert.equal(count(html), 1, 'once for three team rows');
  const root = fragment(`<div>${html}</div>`);
  const sep = root.querySelector('[data-item="sep-team"]');
  const note = root.querySelector('.mlib-team-note');
  assert.equal(note.textContent, notice);
  assert.equal(sep.nextElementSibling, note, 'directly under the heading, above the first row');
  assert.equal(note.nextElementSibling.dataset.teamModel, 'team/team_alpha1/m-a');
  assert.ok(note.id);
  for (const row of root.querySelectorAll('[data-team-model]')) assert.equal(row.getAttribute('aria-describedby'), note.id);
  const one = view.buildLibraryList(three, { ...options, query: 'm-b' });
  assert.equal(count(one), 1, 'a search that leaves one team row still shows the notice');
  assert.equal(fragment(`<div>${one}</div>`).querySelectorAll('[data-team-model]').length, 1);
  assert.equal(count(view.buildLibraryList(teamMerged({ teamModels: [] }), options)), 0, 'no team model, no notice');
  assert.equal(count(view.buildLibraryList(three, { ...options, scope: 'mine' })), 0, 'no group outside All, no notice');
});

// --- row 200: the Strata row ---

test('a Strata row names the engine in its meta, wears the Strata badge and shows Serving while it serves', () => {
  const strata = card({
    key: 'inkling-2-mini-sq-20:latest', tag: 'inkling-2-mini-sq-20', displayName: 'Inkling 2 Mini', selectedEngine: 'strata', engineType: 'openai-compatible',
    params: '26.4B', quant: 'SQ-20', contextLength: 114432, sizeBytes: 19983212544, vramRequiredMb: 0, fitState: 'unknown',
  });
  assert.equal(view.libraryEngineName(strata), 'Strata');
  const row = fragment(view.buildLibraryRow(strata, { actions: ['use', 'tune', 'menu'] }));
  assert.match(row.querySelector('.mrow-meta').textContent, /^Strata · 26\.4B · SQ-20 · 111\.8K context · 18\.6 GB on disk$/);
  assert.deepEqual([...row.querySelectorAll('.mrow-flag')].map((f) => f.textContent), []);
  assert.equal(row.querySelector('.mrow-fit-num--none').textContent, '—', 'no VRAM figure');
  const compact = fragment(view.buildModelCard(strata, { compact: true, actions: ['use'], pull: {}, activation: {} }));
  assert.ok([...compact.querySelectorAll('.inv-badge')].some((badge) => badge.textContent === 'Strata'));
  const serving = fragment(view.buildLibraryRow({ ...strata, active: true, serving: true, servingPort: 8035 }, { actions: ['use', 'unload', 'tune', 'menu'] }));
  assert.deepEqual([...serving.querySelectorAll('.mrow-flag')].map((f) => f.textContent), ['Serving on :8035']);
});

test('a locked Strata row says why in the existing failed-row note and keeps its Tune button', () => {
  const locked = card({
    key: 'inkling-2-mini-sq-20:latest', tag: 'inkling-2-mini-sq-20', displayName: 'Inkling 2 Mini', selectedEngine: 'strata', engineType: 'openai-compatible',
    loadFailure: { cause: 'other', message: 'the SQ-20 pack failed its check. See Engines and providers.', context: null, at: '', engine: 'openai-compatible', model: 'inkling-2-mini-sq-20', managed: 'strata' },
  });
  const row = fragment(view.buildLibraryRow(locked, { actions: ['use', 'tune', 'menu'] }));
  assert.equal(row.querySelector('.mrow').dataset.loadFailed, 'true');
  assert.equal(row.querySelector('.model-card-note--failed').textContent, 'Strata: the SQ-20 pack failed its check. See Engines and providers.');
  assert.ok(row.querySelector('[data-model-card-action="tune"]'));
});
