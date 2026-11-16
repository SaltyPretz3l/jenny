const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const view = require('../renderer/shell/model-library/model-library-view.js');

const MODEL_MERGE_PATH = require.resolve('../renderer/shell/model-library/model-library-merge.js');
const MODEL_VIEW_PATH = require.resolve('../renderer/shell/model-library/model-library-view.js');

test.afterEach(() => {
  delete globalThis.jennyI18n;
  delete require.cache[MODEL_MERGE_PATH];
  delete require.cache[MODEL_VIEW_PATH];
});

test('a card whose load failed shows the flag, plain words and the cause-matched actions instead of Use', () => {
  const failure = { cause: 'out_of_memory', message: 'model requires more system memory', context: 40960, at: '2026-10-07T12:00:00.000Z', engine: 'ollama', model: 'acme/model:q6' };
  const row = libRow(card({ loadFailure: failure }), { actions: ['use', 'unload', 'tune', 'menu', 'retry', 'loadSmaller', 'showFits', 'diagnostics', 'copyDetails'], pull: {}, activation: { status: 'idle', key: '', message: '' } });
  const rowEl = row.querySelector('.mrow');
  assert.equal(rowEl.dataset.loadFailed, 'true');
  assert.match(rowEl.querySelector('.mrow-title').textContent, /Didn't load/);
  const note = row.querySelector('.model-card-note--failed');
  assert.equal(note.textContent, 'Not enough memory to load it. A smaller context needs less.');
  assert.equal(note.title, 'model requires more system memory');
  assert.deepEqual(actionNames(row), ['loadSmaller', 'showFits', 'tune', 'menu'], 'the memory fixes replace Use; Tune and the menu stay');
  assert.equal(row.querySelector('[data-model-card-action="loadSmaller"]').textContent.trim(), 'Load at 32K context');
  const unreachable = libRow(card({ loadFailure: { ...failure, cause: 'engine_unreachable' } }), { actions: ['use', 'retry', 'diagnostics', 'copyDetails'], pull: {}, activation: {} });
  assert.deepEqual(actionNames(unreachable), ['diagnostics', 'retry']);
  const plain = libRow(card(), { actions: ['use', 'retry', 'loadSmaller'], pull: {}, activation: {} });
  assert.deepEqual(actionNames(plain), ['use'], 'no failure, no recovery actions');
  assert.equal(plain.querySelector('.mrow').dataset.loadFailed, 'false');
  // The compact card has no recovery row: Use stays its retry and the failure is not announced.
  const compact = fragment(view.buildModelCard(card({ loadFailure: failure }), { actions: ['use', 'retry', 'loadSmaller'], compact: true }));
  assert.deepEqual(actionNames(compact), ['use']);
  assert.equal(compact.querySelector('.model-card-note--failed'), null);
});

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

function fragment(html) {
  return JSDOM.fragment(html);
}

function libRow(model, options = {}) {
  return fragment(view.buildLibraryRow(model, options));
}

function actionNames(root) {
  return Array.from(root.querySelectorAll('[data-model-card-action]'))
    .map((element) => element.dataset.modelCardAction);
}

test('library rows and compact cards enforce the action whitelist and applicability', () => {
  const settings = libRow(card(), {
    actions: ['use', 'tune', 'remove', 'pull', 'cancel', 'unknown'],
  });
  assert.deepEqual(actionNames(settings), ['use', 'tune']);

  const compact = fragment(view.buildModelCard(card(), {
    actions: ['use', 'tune', 'remove'],
    compact: true,
  }));
  assert.deepEqual(actionNames(compact), ['use']);
  assert.equal(compact.querySelector('.model-card-tier'), null);
  assert.ok(compact.querySelector('.model-card'));
  assert.equal(compact.querySelector('.model-row'), null);

  const catalog = fragment(view.buildModelCard(card({ installed: false, source: 'catalog' }), {
    actions: ['use', 'tune', 'remove', 'pull'],
  }));
  assert.deepEqual(actionNames(catalog), ['pull']);
  assert.deepEqual(actionNames(libRow(card({ installed: false, source: 'catalog' }), {
    actions: ['use', 'tune', 'remove', 'pull'],
  })), ['pull']);
});

test('active cards expose data-active and omit inapplicable use/remove actions', () => {
  const root = libRow(card({ active: true }), {
    actions: ['use', 'unload', 'tune', 'remove'],
  });

  assert.equal(root.querySelector('.mrow').dataset.active, 'true');
  assert.deepEqual(actionNames(root), ['unload', 'tune']);
  const compact = fragment(view.buildModelCard(card({ active: true }), { actions: ['use', 'remove'] }));
  assert.equal(compact.querySelector('.model-card').dataset.active, 'true');
  assert.equal(compact.querySelector('.model-card-badges .inv-badge').textContent, 'Active');
  assert.deepEqual(actionNames(compact), []);
});

test('unload appears only on active installed library rows', () => {
  const active = libRow(card({ active: true }), {
    actions: ['unload'],
  });
  assert.deepEqual(actionNames(active), ['unload']);
  assert.equal(active.querySelector('[data-model-card-action="unload"]').textContent, 'Unload');

  const inactive = libRow(card(), { actions: ['unload'] });
  const unavailable = libRow(card({ active: true, engineVisible: false }), {
    actions: ['unload'],
  });
  const compact = fragment(view.buildModelCard(card({ active: true }), {
    actions: ['unload'],
    compact: true,
  }));
  assert.deepEqual(actionNames(inactive), []);
  assert.deepEqual(actionNames(unavailable), []);
  assert.deepEqual(actionNames(compact), []);
});

test('running activation renders a pending row and enforces single-flight actions', () => {
  const activation = { status: 'running', key: 'acme/model:q6', message: '' };
  const pending = libRow(card(), {
    actions: ['use', 'unload', 'tune', 'remove', 'menu'],
    activation,
  });
  const pendingCard = pending.querySelector('.mrow');
  const use = pendingCard.querySelector('[data-model-card-action="use"]');
  assert.equal(pendingCard.dataset.pending, 'true');
  assert.equal(use.textContent, 'Starting…');
  assert.equal(use.disabled, true);
  assert.ok(use.classList.contains('model-card-action--pending'));
  assert.equal(pendingCard.querySelector('[data-model-card-action="tune"]').disabled, true);
  assert.equal(pendingCard.querySelector('[data-model-card-action="remove"]'), null);
  assert.equal(pendingCard.querySelector('[data-model-card-action="menu"]').disabled, true);

  const other = libRow(card({
    key: 'other:1b',
    tag: 'other:1b',
  }), {
    actions: ['use', 'unload', 'tune', 'remove', 'menu'],
    activation,
  });
  assert.equal(other.querySelector('.mrow').dataset.pending, 'false');
  assert.equal(other.querySelector('[data-model-card-action="use"]').disabled, true);
  assert.equal(other.querySelector('[data-model-card-action="tune"]').disabled, false);
  assert.equal(other.querySelector('[data-model-card-action="remove"]'), null);
  assert.equal(other.querySelector('[data-model-card-action="menu"]').disabled, false);

  const activeOther = libRow(card({
    key: 'active:1b',
    tag: 'active:1b',
    active: true,
  }), { actions: ['unload'], activation });
  assert.equal(activeOther.querySelector('[data-model-card-action="unload"]').disabled, true);

  const compact = fragment(view.buildModelCard(card(), { actions: ['use'], activation }));
  assert.equal(compact.querySelector('.model-card').dataset.pending, 'true');
  assert.equal(compact.querySelector('[data-model-card-action="use"]').disabled, true);
});

test('idle activation error is escaped and rendered only on the matching card', () => {
  const attack = '<img src=x onerror="globalThis.pwned=1">';
  const activation = { status: 'idle', key: 'acme/model:q6', message: attack };
  const matchingHtml = view.buildModelCard(card(), { activation });
  const matching = fragment(matchingHtml);
  const other = fragment(view.buildModelCard(card({ key: 'other:1b' }), { activation }));

  assert.equal(matching.querySelector('img'), null);
  assert.equal(matching.querySelector('.model-card-note--error').textContent, attack);
  assert.match(matchingHtml, /&lt;img/);
  assert.equal(other.querySelector('.model-card-note'), null);

  const row = libRow(card(), { activation });
  assert.equal(row.querySelector('img'), null);
  assert.equal(row.querySelector('.model-card-note--error').textContent, attack);
  assert.equal(libRow(card({ key: 'other:1b' }), { activation }).querySelector('.model-card-note'), null);
});

test('fitState exclusively controls the card bar tone', () => {
  const cases = [
    { fitState: 'fits', tone: 'success', budgetMb: 12000, fitLabel: '8 GB of 12 GB VRAM' },
    { fitState: 'cpu', tone: 'warning', budgetMb: 0, fitLabel: 'Runs on CPU' },
    { fitState: 'over', tone: 'danger', budgetMb: 12000, fitLabel: 'Needs 16 GB VRAM' },
  ];

  for (const fitCase of cases) {
    const root = fragment(view.buildModelCard(card(fitCase), {}));
    const bar = root.querySelector('.model-card-fit');
    assert.ok(bar.classList.contains(`model-card-fit--${fitCase.tone}`));
    assert.equal(bar.classList.contains('inv-progress--warning'), false);
    assert.equal(bar.classList.contains('inv-progress--danger'), false);
    if (!fitCase.budgetMb) {
      assert.equal(bar.getAttribute('aria-valuenow'), '0');
      assert.equal(bar.getAttribute('aria-valuemax'), '1');
    }
  }
});

test('localized installed models missing from the catalog keep the localized unknown-fit label', () => {
  const i18n = require('../renderer/shared/i18n-utils').createI18n();
  i18n.load({ tag: 'qps-ploc', strings: {
    'models.library.merge.notInCatalog': '[Nøţ ïñ çåţåļøğ]',
  } });
  globalThis.jennyI18n = i18n;
  delete require.cache[MODEL_MERGE_PATH];
  delete require.cache[MODEL_VIEW_PATH];
  const localizedMerge = require(MODEL_MERGE_PATH);
  const localizedView = require(MODEL_VIEW_PATH);
  const projection = localizedMerge.mergeModelLibrary({
    installed: [{ id: 'private/model:q4', sizeBytes: 4096, engineType: 'ollama' }],
    recommendations: [],
    hardware: { gpu: { type: 'cuda', name: 'Test GPU', vram_mb: 16384 } },
  });

  const root = fragment(localizedView.buildModelCard(projection.cards[0], {}));

  assert.equal(root.querySelector('.model-card-fit .inv-progress-text').textContent, '[Nøţ ïñ çåţåļøğ]');
});

test('estimated fits use compact text and retain full hover and accessible wording', () => {
  const full = '4.1 GB of 15.9 GB VRAM \u00b7 estimated';
  for (const fitState of ['fits', 'unknown']) {
    const model = card({ fitState, fitSource: 'estimated', fitLabel: '4.1 GB of 15.9 GB VRAM' });
    const root = fragment(view.buildModelCard(model, { compact: true }));
    const fit = root.querySelector('.inv-progress-text');
    assert.equal(fit.textContent, '~4.1 GB of 15.9 GB VRAM');
    assert.equal(root.querySelector('.model-card-fit').title, full);
    assert.match(root.querySelector('.model-card-fit').getAttribute('aria-label'),
      /4\.1 GB of 15\.9 GB VRAM \u00b7 estimated/);
  }
});

test('model metadata omits empty and unknown quantization without extra separators', () => {
  for (const quant of ['unknown', 'UnKnOwN', ' UNKNOWN ', '', '   ']) {
    const model = card({ source: 'installed', quant, selectedEngine: 'ollama' });
    const row = libRow(model);
    assert.equal(row.querySelector('.mrow-meta').textContent, 'Ollama \u00b7 12B \u00b7 32K context \u00b7 4 GB on disk');
    const compact = fragment(view.buildModelCard(model, { compact: true }));
    assert.equal(compact.querySelector('.model-card-stats').textContent, '12B \u00b7 32K context \u00b7 4 GB');
  }
  const known = libRow(card({ source: 'installed', quant: 'Q6_K' }));
  assert.match(known.querySelector('.mrow-meta').textContent, /12B \u00b7 Q6_K \u00b7 32K/);
});

test('fitSource observed remains measured while estimated text is compact', () => {
  const bar = (fitSource) => fragment(view.buildModelCard(card({
    fitSource,
    fitLabel: '8 GB of 12 GB VRAM',
  }), { compact: true })).querySelector('.model-card-fit').textContent;
  assert.match(bar('estimated'), /~8 GB of 12 GB VRAM/);
  assert.match(bar('observed'), /8 GB of 12 GB VRAM · measured/);
  assert.doesNotMatch(bar('catalog'), /estimated|measured/);

  const estimatedRow = libRow(card({ fitSource: 'estimated', fitLabel: '8 GB of 12 GB VRAM' }), { budgetMb: 12000 });
  assert.equal(estimatedRow.querySelector('.mrow-fit').title, '8 GB of 12 GB VRAM \u00b7 estimated');
  assert.match(estimatedRow.querySelector('.mrow-fit-num').textContent, /^~/);
});

test('recommended badge is controlled only by card.recommended', () => {
  const absent = fragment(view.buildModelCard(card({
    recommended: false,
    reason: 'Best fit for this machine.',
  }), {}));
  assert.doesNotMatch(absent.textContent, /Best fit for your GPU/);

  const gpuFit = fragment(view.buildModelCard(card({ recommended: true }), {}));
  assert.match(gpuFit.textContent, /Best fit/);

  const cpuFit = fragment(view.buildModelCard(card({
    recommended: true,
    fitState: 'cpu',
  }), {}));
  assert.match(cpuFit.textContent, /Recommended/);
  assert.doesNotMatch(cpuFit.textContent, /Best fit for your GPU/);
});

test('library rows and compact cards show serving and per-model engine pills', () => {
  const row = libRow(card({
    serving: true,
    servingPort: 8033,
    selectedEngine: 'llama-server',
    mtp: { eligible: true, enabled: false, headroomMb: 0 },
    accelerationEligible: true,
  }));
  assert.deepEqual(Array.from(row.querySelectorAll('.mrow-flag')).map((flag) => flag.textContent),
    ['MTP ready', 'Serving on :8033']);
  assert.ok(row.querySelector('.mrow-meta').textContent.startsWith('llama-server \u00b7'));

  const compact = fragment(view.buildModelCard(card({
    recommended: true,
    serving: true,
    servingPort: 8033,
    selectedEngine: 'llama-server',
    mtp: { eligible: true, enabled: false, headroomMb: 0 },
    accelerationEligible: true,
  }), { compact: true }));
  const readyBadges = Array.from(compact.querySelectorAll('.inv-badge')).map((badge) => badge.textContent);
  assert.ok(readyBadges.includes('MTP ready'));
  // Order is part of the contract: recommendation pill, then Serving, then engine.
  const recommendedIndex = readyBadges.findIndex((text) => /^(Best fit|Recommended)/.test(text));
  assert.ok(recommendedIndex >= 0, readyBadges.join(' | '));
  assert.ok(recommendedIndex < readyBadges.indexOf('Serving on :8033'));
  assert.ok(readyBadges.indexOf('Serving on :8033') < readyBadges.indexOf('llama-server'));

  const mtpOn = fragment(view.buildModelCard(card({
    serving: true,
    servingPort: 8033,
    selectedEngine: 'llama-server',
    mtp: { eligible: true, enabled: true, headroomMb: 2048 },
    accelerationEligible: true,
  }), { compact: true }));
  const compactBadges = Array.from(mtpOn.querySelectorAll('.inv-badge'))
    .map((badge) => badge.textContent);
  assert.ok(compactBadges.includes('Serving on :8033'));
  assert.ok(compactBadges.includes('llama-server · MTP'));
  assert.equal(compactBadges.includes('MTP ready'), false);

  const rowMtp = libRow(card({ selectedEngine: 'llama-server', mtp: { enabled: true }, accelerationEligible: true }));
  assert.deepEqual(Array.from(rowMtp.querySelectorAll('.mrow-flag')).map((flag) => flag.textContent), ['MTP']);
});

// Owner gate P2: a card whose llama-server is parked for an image render.
test('a card paused for an image render says so instead of Serving', () => {
  const paused = card({ active: true, servingPaused: true, servingPort: 8033, selectedEngine: 'llama-server' });
  const flags = Array.from(libRow(paused).querySelectorAll('.mrow-flag')).map((flag) => flag.textContent);
  assert.deepEqual(flags, ['Paused for an image render']);

  const badges = Array.from(fragment(view.buildModelCard(paused, { compact: true })).querySelectorAll('.inv-badge')).map((badge) => badge.textContent);
  assert.ok(badges.includes('Paused for an image render'), badges.join(' | '));
  assert.equal(badges.some((text) => /^Serving/.test(text)), false, badges.join(' | '));
  assert.ok(badges.indexOf('Active') < badges.indexOf('Paused for an image render'));
});

test('engine-scoped installed cards cannot emit current-engine actions', () => {
  const ollamaOnly = libRow(card({
    engineVisible: false,
    ollamaOnly: true,
  }), { actions: ['use', 'tune', 'remove', 'menu'] });
  assert.deepEqual(actionNames(ollamaOnly), []);
  assert.deepEqual(actionNames(fragment(view.buildModelCard(card({ engineVisible: false, ollamaOnly: true }), {
    actions: ['use', 'tune', 'remove', 'menu'],
  }))), []);

  const visible = libRow(card({ engineVisible: true }), {
    actions: ['use', 'tune', 'remove', 'menu'],
  });
  assert.deepEqual(actionNames(visible), ['use', 'tune', 'menu']);
});

test('disk labels distinguish installed unknown size from pending download size', () => {
  const installed = fragment(view.buildModelCard(card({ sizeBytes: 0 }), {}));
  assert.match(installed.querySelector('.model-card-stats').textContent, /Size unknown/);
  assert.doesNotMatch(installed.querySelector('.model-card-stats').textContent, /download/);

  const catalog = fragment(view.buildModelCard(card({ installed: false, sizeBytes: 0 }), {}));
  assert.match(catalog.querySelector('.model-card-stats').textContent, /~6\.3 GB download/);
});

test('hosted rows show no fit and only use; local engines and an unreported engine type keep tune and the overflow menu', () => {
  const actions = ['use', 'tune', 'remove', 'menu'];
  const cloud = libRow(card({ engineType: 'plugin_host' }), { actions });
  assert.deepEqual(actionNames(cloud), ['use']);
  assert.equal(cloud.querySelector('.mrow-fit').textContent.trim(), '—');
  assert.match(cloud.querySelector('.mrow-meta').textContent, /Hosted · no download/);

  // normalizeInstalled defaults engine_type to '' for string entries and for any
  // payload missing the field; those stay local, so Tune and the menu (the only
  // Remove path in the row) stay.
  for (const engineType of ['ollama', 'vllm', '']) {
    const root = libRow(card({ engineType }), { actions });
    assert.deepEqual(actionNames(root), ['use', 'tune', 'menu']);
    assert.equal(root.querySelector('[data-model-card-action="remove"]'), null);
    assert.equal(
      root.querySelector('[data-model-card-action="menu"]').getAttribute('aria-label'),
      'More actions for Acme Model'
    );
  }
});

test('running pull renders progress and cancel, while cancel failure is explicit', () => {
  const running = fragment(view.buildModelCard(card({ installed: false }), {
    actions: ['pull', 'cancel'],
    pull: { status: 'running', percent: 37, bytesText: '2.3 GB / 6.4 GB' },
  }));
  assert.equal(running.querySelectorAll('.inv-progress').length, 2);
  assert.equal(running.querySelector('.model-card-pull-progress').getAttribute('aria-valuenow'), '37');
  assert.deepEqual(actionNames(running), ['cancel']);

  const failed = fragment(view.buildModelCard(card({ installed: false }), {
    actions: ['cancel'],
    pull: { cancelFailed: true },
  }));
  const badge = Array.from(failed.querySelectorAll('.inv-badge'))
    .find((element) => element.textContent === 'Cancel failed');
  assert.ok(badge);
  assert.ok(badge.classList.contains('inv-badge--danger'));
});

test('grid resolves card-keyed pull state and renders filter inventory chips with the installed count', () => {
  const model = card({ installed: false });
  const root = fragment(view.buildModelGrid({
    hardware: { detected: true, type: 'cuda', name: 'Test GPU', vramMb: 16384, budgetMb: 16384 },
    cards: [model],
  }, {
    filter: 'all',
    actions: ['pull', 'cancel'],
    pulls: {
      [model.key]: { status: 'running', percent: 50, bytesText: 'Halfway' },
    },
  }));

  assert.equal(root.querySelectorAll('.inv-chip').length, 3);
  assert.equal(root.querySelector('.model-library-filter-chips').getAttribute('role'), 'group');
  assert.equal(root.querySelector('[data-inv-chip="all"]').getAttribute('aria-pressed'), 'true');
  assert.equal(root.querySelector('[data-inv-chip="all"] .inv-chip-count'), null);
  assert.equal(root.querySelector('[data-inv-chip="installed"] .inv-chip-count').textContent, '0');
  assert.equal(root.querySelector('[data-inv-chip="recommended"] .inv-chip-count'), null);
  assert.equal(root.querySelectorAll('.model-card-grid .model-card').length, 1);
  assert.equal(root.querySelector('.model-card-pull-progress').getAttribute('aria-valuenow'), '50');
  assert.match(root.querySelector('.model-library-hardware-summary').textContent, /Test GPU.*16 GB VRAM/);
});

test('filter chips keep partial legacy counts optional', () => {
  const root = fragment(view.buildFilterChips('all', { installed: 2 }));
  assert.equal(root.querySelector('[data-inv-chip="all"] .inv-chip-count'), null);
  assert.equal(root.querySelector('[data-inv-chip="installed"] .inv-chip-count').textContent, '2');
  assert.equal(root.querySelector('[data-inv-chip="recommended"] .inv-chip-count'), null);
});

test('grid lists cards in a flat compact grid and filters them', () => {
  const available = card({ key: 'available', tag: 'available', installed: false });
  const cloud = card({ key: 'cloud', tag: 'cloud', engineType: 'plugin_host' });
  const active = card({ key: 'active', tag: 'active', active: true, recommended: true });
  const merged = { hardware: { detected: false }, cards: [available, cloud, active] };
  const keys = (options) => Array.from(fragment(view.buildModelGrid(merged, options)).querySelectorAll('.model-card'))
    .map((element) => element.dataset.modelKey);

  assert.deepEqual(keys({ filter: 'all' }), ['available', 'cloud', 'active']);
  assert.deepEqual(keys({ filter: 'installed' }), ['cloud', 'active']);
  assert.deepEqual(keys({ filter: 'recommended' }), ['active']);
  const root = fragment(view.buildModelGrid(merged, { filter: 'all' }));
  assert.equal(root.querySelector('.model-row-group, .model-row'), null);
});

test('display names, tags, and hardware names are escaped everywhere', () => {
  const attack = '"><img src=x onerror="globalThis.pwned=1">';
  const html = view.buildModelCard(card({
    key: attack,
    tag: attack,
    displayName: attack,
    reason: attack,
  }), { actions: ['use'] });
  const root = fragment(html);

  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelector('.model-card-name').textContent, attack);
  assert.equal(root.querySelector('.model-card-reason').textContent, attack);
  assert.equal(root.querySelector('[data-model-card-action]').dataset.modelTag, attack);
  assert.match(html, /&lt;img/);

  const rowHtml = view.buildLibraryRow(card({ key: attack, tag: attack, displayName: attack }), { actions: ['use'] });
  const row = fragment(rowHtml);
  assert.equal(row.querySelector('img'), null);
  assert.equal(row.querySelector('.mrow-name').textContent, attack);
  assert.equal(row.querySelector('.mrow').dataset.modelKey, attack);
  assert.match(rowHtml, /&lt;img/);

  const hardware = view.buildHardwareSummaryLine({
    detected: true,
    type: 'cuda',
    name: attack,
    vramMb: 8192,
  });
  assert.equal(fragment(hardware).querySelector('img'), null);
  assert.match(hardware, /&lt;img/);
});

test('the hardware line reads neutral while the probe is pending, never a bare negative', () => {
  const pending = fragment(view.buildHardwareSummaryLine(null, { pending: true }));
  assert.equal(pending.textContent, 'Checking hardware…');
  assert.doesNotMatch(pending.textContent, /not detected/i);

  // A finished probe that found nothing still says so.
  assert.equal(fragment(view.buildHardwareSummaryLine({ detected: false })).textContent, 'Hardware not detected');
  // A detected profile wins over a stale pending hint.
  assert.match(fragment(view.buildHardwareSummaryLine({
    detected: true, type: 'cuda', name: 'Test GPU', vramMb: 12288,
  }, { pending: true })).textContent, /Test GPU · 12 GB VRAM/);
});

test('all interactive markup is emitted by inventory primitives', () => {
  const root = fragment(view.buildModelGrid({
    hardware: { detected: false },
    cards: [card()],
  }, {
    actions: ['use', 'tune', 'remove'],
    filter: 'installed',
  }));
  const controls = root.querySelectorAll('button, input, select');

  assert.ok(controls.length > 0);
  for (const control of controls) {
    if (control.hasAttribute('data-model-card-action')) {
      assert.ok(control.classList.contains('btn'), control.outerHTML);
    } else {
      assert.ok(
        Array.from(control.classList).some((name) => name.startsWith('inv-')),
        control.outerHTML
      );
    }
  }
  assert.equal(root.querySelectorAll('input, select').length, 0);
});

test('view builders tolerate absent data and invalid filters', () => {
  assert.doesNotThrow(() => view.buildModelCard(null, null));
  const grid = fragment(view.buildModelGrid(null, { filter: 'bad' }));
  assert.match(grid.textContent, /Hardware not detected/);
  assert.match(grid.textContent, /No models match this filter/);
  assert.equal(grid.querySelector('[data-inv-chip="all"]').getAttribute('aria-pressed'), 'true');
});
