const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const view = require('../renderer/shell/model-library/model-library-view.js');

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

function actionNames(root) {
  return Array.from(root.querySelectorAll('[data-model-card-action]'))
    .map((element) => element.dataset.modelCardAction);
}

test('settings and compact cards enforce the action whitelist and applicability', () => {
  const settings = fragment(view.buildModelCard(card(), {
    actions: ['use', 'tune', 'remove', 'pull', 'cancel', 'unknown'],
  }));
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
});

test('active cards expose data-active and omit inapplicable use/remove actions', () => {
  const root = fragment(view.buildModelCard(card({ active: true }), {
    actions: ['use', 'unload', 'tune', 'remove'],
  }));

  assert.equal(root.querySelector('.model-row').dataset.active, 'true');
  assert.deepEqual(actionNames(root), ['unload', 'tune']);
  assert.equal(root.querySelector('.model-row-title .inv-badge').textContent, 'Active');
});

test('unload appears only on active installed cards in the full view', () => {
  const active = fragment(view.buildModelCard(card({ active: true }), {
    actions: ['unload'],
  }));
  assert.deepEqual(actionNames(active), ['unload']);
  assert.equal(active.querySelector('[data-model-card-action="unload"]').textContent, 'Unload');

  const inactive = fragment(view.buildModelCard(card(), { actions: ['unload'] }));
  const unavailable = fragment(view.buildModelCard(card({ active: true, engineVisible: false }), {
    actions: ['unload'],
  }));
  const compact = fragment(view.buildModelCard(card({ active: true }), {
    actions: ['unload'],
    compact: true,
  }));
  assert.deepEqual(actionNames(inactive), []);
  assert.deepEqual(actionNames(unavailable), []);
  assert.deepEqual(actionNames(compact), []);
});

test('running activation renders a pending card and enforces single-flight actions', () => {
  const activation = { status: 'running', key: 'acme/model:q6', message: '' };
  const pending = fragment(view.buildModelCard(card(), {
    actions: ['use', 'unload', 'tune', 'remove', 'menu'],
    activation,
  }));
  const pendingCard = pending.querySelector('.model-row');
  const use = pendingCard.querySelector('[data-model-card-action="use"]');
  assert.equal(pendingCard.dataset.pending, 'true');
  assert.equal(use.textContent, 'Starting…');
  assert.equal(use.disabled, true);
  assert.ok(use.classList.contains('model-card-action--pending'));
  assert.equal(pendingCard.querySelector('[data-model-card-action="tune"]').disabled, true);
  assert.equal(pendingCard.querySelector('[data-model-card-action="remove"]'), null);
  assert.equal(pendingCard.querySelector('[data-model-card-action="menu"]').disabled, true);

  const other = fragment(view.buildModelCard(card({
    key: 'other:1b',
    tag: 'other:1b',
  }), {
    actions: ['use', 'unload', 'tune', 'remove', 'menu'],
    activation,
  }));
  assert.equal(other.querySelector('.model-row').dataset.pending, 'false');
  assert.equal(other.querySelector('[data-model-card-action="use"]').disabled, true);
  assert.equal(other.querySelector('[data-model-card-action="tune"]').disabled, false);
  assert.equal(other.querySelector('[data-model-card-action="remove"]'), null);
  assert.equal(other.querySelector('[data-model-card-action="menu"]').disabled, false);

  const activeOther = fragment(view.buildModelCard(card({
    key: 'active:1b',
    tag: 'active:1b',
    active: true,
  }), { actions: ['unload'], activation }));
  assert.equal(activeOther.querySelector('[data-model-card-action="unload"]').disabled, true);
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
});

test('fitState exclusively controls row bar tone and unknown fit omits the bar', () => {
  const cases = [
    { fitState: 'fits', tone: 'success', budgetMb: 12000, fitLabel: '8 GB of 12 GB VRAM' },
    { fitState: 'cpu', tone: 'warning', budgetMb: 0, fitLabel: 'Runs on CPU' },
    { fitState: 'over', tone: 'danger', budgetMb: 12000, fitLabel: 'Needs 16 GB VRAM' },
  ];

  for (const fitCase of cases) {
    const root = fragment(view.buildModelCard(card(fitCase), {}));
    const bar = root.querySelector('.model-row-fit .model-card-fit');
    assert.ok(bar.classList.contains(`model-card-fit--${fitCase.tone}`));
    assert.equal(bar.classList.contains('inv-progress--warning'), false);
    assert.equal(bar.classList.contains('inv-progress--danger'), false);
    if (!fitCase.budgetMb) {
      assert.equal(bar.getAttribute('aria-valuenow'), '0');
      assert.equal(bar.getAttribute('aria-valuemax'), '1');
    }
  }
  const unknown = fragment(view.buildModelCard(card({
    fitState: 'unknown',
    fitLabel: 'Not in catalog',
  }), {}));
  const unknownFit = unknown.querySelector('.model-row-fit');
  assert.equal(unknownFit.querySelector('.inv-progress'), null);
  assert.equal(unknownFit.textContent, 'Not in catalog · fit unknown');
});

test('fitSource estimated/observed append a suffix to the row and card fit text', () => {
  const estimatedRow = fragment(view.buildModelRow(card({
    fitSource: 'estimated',
    fitLabel: '8 GB of 12 GB VRAM',
  }), {}));
  assert.match(
    estimatedRow.querySelector('.model-row-fit').textContent,
    /8 GB of 12 GB VRAM · estimated/
  );

  const measuredRow = fragment(view.buildModelRow(card({
    fitSource: 'observed',
    fitLabel: '8 GB of 12 GB VRAM',
  }), {}));
  assert.match(
    measuredRow.querySelector('.model-row-fit').textContent,
    /8 GB of 12 GB VRAM · measured/
  );

  const catalogRow = fragment(view.buildModelRow(card({
    fitSource: 'catalog',
    fitLabel: '8 GB of 12 GB VRAM',
  }), {}));
  assert.doesNotMatch(
    catalogRow.querySelector('.model-row-fit').textContent,
    /estimated|measured/
  );

  const estimatedCard = fragment(view.buildModelCard(card({
    fitSource: 'estimated',
    fitLabel: '8 GB of 12 GB VRAM',
  }), { compact: true }));
  assert.match(
    estimatedCard.querySelector('.model-card-fit').textContent,
    /8 GB of 12 GB VRAM · estimated/
  );

  const unknownEstimated = fragment(view.buildModelRow(card({
    fitState: 'unknown',
    fitLabel: 'Not in catalog',
    fitSource: '',
  }), {}));
  assert.equal(
    unknownEstimated.querySelector('.model-row-fit').textContent,
    'Not in catalog · fit unknown'
  );
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

test('rows and compact cards show serving and per-model engine pills', () => {
  const row = fragment(view.buildModelRow(card({
    recommended: true,
    serving: true,
    servingPort: 8033,
    selectedEngine: 'llama-server',
    mtp: { eligible: true, enabled: false, headroomMb: 0 },
    accelerationEligible: true,
  }), {}));
  const rowBadges = Array.from(row.querySelectorAll('.inv-badge'))
    .map((badge) => badge.textContent);
  assert.ok(rowBadges.includes('Serving on :8033'));
  assert.ok(rowBadges.includes('llama-server'));
  assert.ok(rowBadges.includes('MTP ready'));
  // Order is part of the contract: recommendation pill, then Serving, then engine.
  const recommendedIndex = rowBadges.findIndex((text) => /^(Best fit|Recommended)$/.test(text));
  assert.ok(recommendedIndex >= 0, rowBadges.join(' | '));
  assert.ok(recommendedIndex < rowBadges.indexOf('Serving on :8033'));
  assert.ok(rowBadges.indexOf('Serving on :8033') < rowBadges.indexOf('llama-server'));

  const compact = fragment(view.buildModelCard(card({
    serving: true,
    servingPort: 8033,
    selectedEngine: 'llama-server',
    mtp: { eligible: true, enabled: true, headroomMb: 2048 },
    accelerationEligible: true,
  }), { compact: true }));
  const compactBadges = Array.from(compact.querySelectorAll('.inv-badge'))
    .map((badge) => badge.textContent);
  assert.ok(compactBadges.includes('Serving on :8033'));
  assert.ok(compactBadges.includes('llama-server · MTP'));
  assert.equal(compactBadges.includes('MTP ready'), false);
});

test('the retired global acceleration toggle builder is not exported', () => {
  assert.equal(view.buildAccelerationToggle, undefined);
});

test('engine-scoped installed cards cannot emit current-engine actions', () => {
  const ollamaOnly = fragment(view.buildModelCard(card({
    engineVisible: false,
    ollamaOnly: true,
  }), { actions: ['use', 'tune', 'remove', 'menu'] }));
  assert.deepEqual(actionNames(ollamaOnly), []);

  const visible = fragment(view.buildModelCard(card({ engineVisible: true }), {
    actions: ['use', 'tune', 'remove', 'menu'],
  }));
  assert.deepEqual(actionNames(visible), ['use', 'tune', 'menu']);
});

test('disk labels distinguish installed unknown size from pending download size', () => {
  const installed = fragment(view.buildModelCard(card({ sizeBytes: 0 }), {}));
  assert.match(installed.querySelector('.model-row-meta').textContent, /Size unknown/);
  assert.doesNotMatch(installed.querySelector('.model-row-meta').textContent, /download/);

  const catalog = fragment(view.buildModelCard(card({ installed: false, sizeBytes: 0 }), {}));
  assert.match(catalog.querySelector('.model-row-meta').textContent, /~6\.3 GB download/);
});

test('rows distinguish raw installed tags from catalog display names', () => {
  const installed = fragment(view.buildModelRow(card({
    source: 'installed',
    displayName: 'Ignored display name',
  }), {}));
  const rawName = installed.querySelector('code.model-row-name--tag');
  assert.equal(rawName.textContent, 'acme/model:q6');
  assert.equal(rawName.title, 'acme/model:q6');

  const catalog = fragment(view.buildModelRow(card(), {}));
  const displayName = catalog.querySelector('span.model-row-name');
  assert.equal(displayName.textContent, 'Acme Model');
  assert.equal(displayName.title, 'acme/model:q6');
  assert.ok(catalog.querySelector('.model-row-meta').textContent.startsWith('acme/model:q6 ·'));
});

test('cloud rows show hosted metadata, no fit bar, and only use', () => {
  const root = fragment(view.buildModelRow(card({
    engineType: 'plugin_host',
  }), { actions: ['use', 'tune', 'remove', 'menu'] }));

  assert.match(root.querySelector('.model-row-meta').textContent, /Hosted · no download/);
  assert.equal(root.querySelector('.model-row-fit').textContent, '—');
  assert.equal(root.querySelector('.model-row-fit .inv-progress'), null);
  assert.deepEqual(actionNames(root), ['use']);
});

test('local ollama and vllm rows expose tune and menu without inline remove', () => {
  for (const engineType of ['ollama', 'vllm']) {
    const root = fragment(view.buildModelRow(card({ engineType }), {
      actions: ['use', 'tune', 'remove', 'menu'],
    }));
    assert.deepEqual(actionNames(root), ['use', 'tune', 'menu']);
    assert.equal(root.querySelector('[data-model-card-action="remove"]'), null);
    assert.equal(
      root.querySelector('[data-model-card-action="menu"]').getAttribute('aria-label'),
      'More actions for Acme Model'
    );
  }
});

test('an installed row whose engine type is unreported keeps tune and the overflow menu', () => {
  // normalizeInstalled defaults engine_type to '' for string entries and for
  // any payload missing the field. groupModelCards files those under
  // "Installed", so the row must keep Tune and the menu - the menu is the only
  // Remove path in the row view.
  const root = fragment(view.buildModelRow(card({ engineType: '' }), {
    actions: ['use', 'tune', 'remove', 'menu'],
  }));
  assert.deepEqual(actionNames(root), ['use', 'tune', 'menu']);

  const cloud = fragment(view.buildModelRow(card({ engineType: 'plugin_host' }), {
    actions: ['use', 'tune', 'remove', 'menu'],
  }));
  assert.deepEqual(actionNames(cloud), ['use']);
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

test('grid resolves card-keyed pull state and renders filter inventory chips', () => {
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
  assert.equal(root.querySelector('[data-inv-chip="all"] .inv-chip-count').textContent, '1');
  assert.equal(root.querySelector('[data-inv-chip="installed"] .inv-chip-count').textContent, '0');
  assert.equal(root.querySelector('[data-inv-chip="recommended"] .inv-chip-count').textContent, '0');
  assert.equal(root.querySelector('.model-card-pull-progress').getAttribute('aria-valuenow'), '50');
  assert.match(root.querySelector('.model-library-hardware-summary').textContent, /Test GPU.*16 GB VRAM/);
});

test('filter chips keep partial legacy counts optional', () => {
  const root = fragment(view.buildFilterChips('all', { installed: 2 }));
  assert.equal(root.querySelector('[data-inv-chip="all"] .inv-chip-count'), null);
  assert.equal(root.querySelector('[data-inv-chip="installed"] .inv-chip-count').textContent, '2');
  assert.equal(root.querySelector('[data-inv-chip="recommended"] .inv-chip-count'), null);
});

test('grid renders groups in canonical order and omits empty groups', () => {
  const available = card({ key: 'available', tag: 'available', installed: false });
  const cloud = card({
    key: 'cloud',
    tag: 'cloud',
    engineType: 'plugin_host',
  });
  const active = card({ key: 'active', tag: 'active', active: true });
  const root = fragment(view.buildModelGrid({
    hardware: { detected: false },
    cards: [available, cloud, active],
  }, { filter: 'all' }));

  assert.deepEqual(
    Array.from(root.querySelectorAll('.model-row-group')).map((element) => element.dataset.modelGroup),
    ['in-use', 'cloud', 'available']
  );
  assert.deepEqual(
    Array.from(root.querySelectorAll('.model-row')).map((element) => element.dataset.modelKey),
    ['active', 'cloud', 'available']
  );
  assert.equal(root.querySelector('[data-model-group="installed"]'), null);
  assert.equal(view.buildModelGroups([
    { id: 'installed', label: 'Installed', cards: [] },
  ]), '');
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
  assert.equal(root.querySelector('.model-row-name').textContent, attack);
  assert.equal(root.querySelector('.model-card-reason'), null);
  assert.equal(root.querySelector('[data-model-card-action]').dataset.modelTag, attack);
  assert.match(html, /&lt;img/);

  const hardware = view.buildHardwareSummaryLine({
    detected: true,
    type: 'cuda',
    name: attack,
    vramMb: 8192,
  });
  assert.equal(fragment(hardware).querySelector('img'), null);
  assert.match(hardware, /&lt;img/);
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
