const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const merge = require('../renderer/shell/model-library/model-library-merge.js');

const catalog = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'config', 'model-recommendation-catalog.json'),
  'utf8'
));

function recommendation(index, overrides = {}) {
  return {
    ...catalog.models[index],
    fits: true,
    fitsInVram: true,
    fitsInAccelerator: false,
    fitsOnCpu: true,
    recommended: false,
    reason: 'Fits this machine.',
    ...overrides,
  };
}

function mergeLibrary(overrides = {}) {
  return merge.mergeModelLibrary({
    installed: [],
    ollamaTags: [],
    recommendations: [],
    hardware: { gpu: { type: 'cuda', name: 'Test GPU', vram_mb: 16384 } },
    memory: { totalMb: 32768, availableMb: 24576 },
    catalogMeta: { catalogVersion: catalog.catalogVersion },
    activeModel: '',
    preferredLocalModel: '',
    ...overrides,
  });
}

const ACCELERATION_FAMILIES = [
  { matchPrefixes: ['gemma4', 'gemma-4'], mtp: 'yes' },
  { matchPrefixes: ['ornith15'], mtp: 'unverified' },
];

test('no managed input preserves the projection with neutral engine and acceleration fields', () => {
  const result = merge.mergeModelLibrary({
    installed: [{ id: 'baseline:latest', sizeBytes: 4096, engineType: 'OLLAMA', loaded: true }],
    ollamaTags: [],
    recommendations: [{
      pullTag: 'baseline:latest',
      displayName: 'Baseline Model',
      tier: 'small',
      params: '1B',
      quant: 'Q4',
      contextLength: 8192,
      downloadSizeMb: 1024,
      vramRequiredMb: 4096,
      ramRequiredMb: 6144,
      fits: true,
      fitsInVram: true,
      fitsInAccelerator: false,
      fitsOnCpu: true,
      recommended: 'sidecar-value',
      reason: 'Sidecar reason.',
    }],
    hardware: { gpu: { type: 'cuda', name: 'Test GPU', vram_mb: 16384 } },
    memory: { totalMb: 32768, availableMb: 24576 },
    catalogMeta: { catalogVersion: 7 },
    activeModel: 'baseline',
    preferredLocalModel: 'BASELINE:latest',
  });

  assert.deepEqual(result, {
    hardware: {
      detected: true,
      type: 'cuda',
      name: 'Test GPU',
      vramMb: 16384,
      memoryArchitecture: '',
      unifiedMemoryMb: 0,
      ramTotalMb: 32768,
      ramAvailableMb: 24576,
      budgetMb: 16384,
      accelerationHeadroomMb: 0,
    },
    catalogMeta: { catalogVersion: 7 },
    cards: [{
      key: 'baseline:latest',
      tag: 'baseline:latest',
      displayName: 'Baseline Model',
      tier: 'small',
      params: '1B',
      quant: 'Q4',
      contextLength: 8192,
      sizeBytes: 4096,
      downloadSizeMb: 1024,
      vramRequiredMb: 4096,
      ramRequiredMb: 6144,
      installed: true,
      engineVisible: true,
      ollamaOnly: false,
      engineType: 'ollama',
      available: true,
      active: true,
      preferredLocal: true,
      recommended: 'sidecar-value',
      reason: 'Sidecar reason.',
      fitState: 'fits',
      fitRatio: 0.25,
      fitLabel: '4 GB of 16 GB VRAM',
      fitSource: 'catalog',
      fitConfidence: 'high',
      accelerationEligible: false,
      accelerationHeadroomMb: 0,
      managedKey: 'baseline-latest',
      engines: {
        ollama: { available: true },
        llamaServer: { available: false, modelPath: '', drafter: false },
      },
      selectedEngine: 'ollama',
      mtp: { eligible: false, enabled: false, headroomMb: 0 },
      serving: false,
      servingPort: 0,
      source: 'both',
    }],
  });
});

test('per-card headroom penalizes only eligible families and honors family overrides', () => {
  const result = mergeLibrary({
    acceleration: {
      enabled: true,
      headroomMb: 2048,
      families: [
        { matchPrefixes: ['gemma4', 'gemma-4'], mtp: 'yes', vramHeadroomMb: 512 },
        { matchPrefixes: ['bigdraft'], mtp: 'yes' },
        { matchPrefixes: ['ornith15'], mtp: 'unverified' },
      ],
    },
    managed: {
      enabled: true,
      perModel: {
        'gemma4-12b-qat': { engine: 'llama-server', mtp: { mode: 'mtp' } },
        'bigdraft-latest': { engine: 'llama-server', mtp: { mode: 'mtp' } },
      },
    },
    recommendations: [
      recommendation(0, { pullTag: 'gemma4-12b-qat', vramRequiredMb: 15872 }),
      recommendation(1, { pullTag: 'bigdraft:latest', vramRequiredMb: 15000 }),
      recommendation(2, { pullTag: 'ornith15:9b', vramRequiredMb: 15000 }),
    ],
  });
  const byTag = new Map(result.cards.map((card) => [card.tag, card]));

  assert.equal(result.hardware.budgetMb, 16384);
  assert.equal(result.hardware.accelerationHeadroomMb, 2048);

  // Family override (512 MB drafter) beats the 2 GB catalog default.
  const gemma = byTag.get('gemma4-12b-qat');
  assert.equal(gemma.accelerationHeadroomMb, 512);
  assert.equal(gemma.fitState, 'fits');
  assert.equal(gemma.fitRatio, 15872 / 15872);

  // Eligible family without an override pays the catalog default.
  const bigdraft = byTag.get('bigdraft:latest');
  assert.equal(bigdraft.accelerationHeadroomMb, 2048);
  assert.equal(bigdraft.fitState, 'over');
  assert.equal(bigdraft.fitRatio, 15000 / 14336);

  // A family that will not accelerate keeps its full budget.
  const ornith = byTag.get('ornith15:9b');
  assert.equal(ornith.accelerationHeadroomMb, 0);
  assert.equal(ornith.fitState, 'fits');
  assert.equal(ornith.fitRatio, 15000 / 16384);
});

test('global acceleration mode never charges headroom without per-model MTP', () => {
  const result = mergeLibrary({
    acceleration: {
      enabled: true,
      mode: 'ngram',
      headroomMb: 0,
      families: [{ matchPrefixes: ['gemma4', 'gemma-4'], mtp: 'yes', vramHeadroomMb: 512 }],
    },
    recommendations: [recommendation(0, { pullTag: 'gemma4-12b-qat', vramRequiredMb: 16000 })],
  });
  const card = result.cards[0];

  assert.equal(card.accelerationHeadroomMb, 0);
  assert.equal(card.fitState, 'fits');
  assert.equal(card.fitRatio, 16000 / 16384);
});

test('headroom exhausting the budget only degrades fits — over stays over', () => {
  const result = mergeLibrary({
    hardware: { gpu: { type: 'cuda', name: 'Tiny GPU', vram_mb: 512 } },
    acceleration: { enabled: true, headroomMb: 512, families: ACCELERATION_FAMILIES },
    managed: {
      enabled: true,
      perModel: {
        'gemma4-12b-qat': { engine: 'llama-server', mtp: { mode: 'mtp' } },
      },
    },
    recommendations: [
      recommendation(0, { pullTag: 'gemma4-12b-qat', vramRequiredMb: 256 }),
      recommendation(1, {
        pullTag: 'gemma4-27b',
        vramRequiredMb: 20000,
        fits: false,
        fitsInVram: false,
        fitsInAccelerator: false,
        fitsOnCpu: false,
      }),
    ],
  });
  const byTag = new Map(result.cards.map((card) => [card.tag, card]));

  assert.equal(byTag.get('gemma4-12b-qat').fitState, 'unknown');
  assert.equal(byTag.get('gemma4-27b').fitState, 'over');
  assert.equal(byTag.get('gemma4-27b').fitLabel, 'Needs 19.5 GB VRAM');
});

test('headroom at or above budget produces unknown fit with zero non-negative ratio', () => {
  for (const headroomMb of [1024, 2048]) {
    const result = mergeLibrary({
      hardware: { gpu: { type: 'cuda', name: 'Small GPU', vram_mb: 1024 } },
      acceleration: { enabled: true, headroomMb, families: ACCELERATION_FAMILIES },
      managed: {
        enabled: true,
        perModel: {
          'gemma4-12b-qat': { engine: 'llama-server', mtp: { mode: 'mtp' } },
        },
      },
      recommendations: [recommendation(0, { pullTag: 'gemma4-12b-qat', vramRequiredMb: 512 })],
    });
    const card = result.cards[0];

    assert.equal(card.accelerationHeadroomMb, headroomMb);

    assert.equal(card.fitState, 'unknown');
    assert.equal(card.fitRatio, 0);
    assert.ok(card.fitRatio >= 0);
    assert.ok(result.hardware.budgetMb >= 0);
    assert.ok(result.hardware.accelerationHeadroomMb >= 0);
  }
});

test('joins tag spelling aliases with canonicalOllamaTag and keeps installed bytes', () => {
  const result = mergeLibrary({
    installed: [{ id: 'EXAMPLE', size: 4_294_967_296, loaded: true }],
    ollamaTags: ['example:latest'],
    recommendations: [recommendation(0, {
      modelId: 'example:latest',
      pullTag: 'example:latest',
      displayName: 'Example Model',
    })],
    activeModel: 'example',
    preferredLocalModel: 'EXAMPLE:latest',
  });

  assert.equal(result.cards.length, 1);
  assert.deepEqual(result.catalogMeta, { catalogVersion: catalog.catalogVersion });
  assert.equal(result.cards[0].key, 'example:latest');
  assert.equal(result.cards[0].source, 'both');
  assert.equal(result.cards[0].sizeBytes, 4_294_967_296);
  assert.equal(result.cards[0].engineVisible, true);
  assert.equal(result.cards[0].ollamaOnly, false);
  assert.equal(result.cards[0].active, true);
  assert.equal(result.cards[0].preferredLocal, true);
});

test('projects installed-only, catalog-only, both, and Ollama-only cards', () => {
  const both = recommendation(0);
  const catalogOnly = recommendation(1);
  const result = mergeLibrary({
    installed: [
      { id: both.pullTag, size: 2048 },
      { id: 'private/installed-only:q4', size: 0 },
    ],
    ollamaTags: [both.pullTag, 'private/ollama-only:q8'],
    recommendations: [both, catalogOnly],
  });
  const byTag = new Map(result.cards.map((card) => [card.tag, card]));

  assert.equal(byTag.get(both.pullTag).source, 'both');
  assert.equal(byTag.get(both.pullTag).installed, true);
  assert.equal(byTag.get(catalogOnly.pullTag).source, 'catalog');
  assert.equal(byTag.get(catalogOnly.pullTag).installed, false);
  assert.equal(byTag.get('private/installed-only:q4').source, 'installed');
  assert.equal(byTag.get('private/installed-only:q4').fitState, 'unknown');
  assert.equal(byTag.get('private/installed-only:q4').fitLabel, 'Not in catalog');
  assert.equal(byTag.get('private/ollama-only:q8').installed, true);
  assert.equal(byTag.get('private/ollama-only:q8').engineVisible, false);
  assert.equal(byTag.get('private/ollama-only:q8').ollamaOnly, true);
});

test('Ollama-only entries retain their on-disk size', () => {
  const result = mergeLibrary({
    ollamaTags: [{ id: 'private/ollama-sized:q8', sizeBytes: 987654321 }],
  });

  assert.equal(result.cards[0].tag, 'private/ollama-sized:q8');
  assert.equal(result.cards[0].sizeBytes, 987654321);
  assert.equal(result.cards[0].engineType, '');
  assert.equal(result.cards[0].available, true);
});

test('derives all fit states from the sidecar fit fields', () => {
  const result = mergeLibrary({
    recommendations: [
      recommendation(0, { fitsInVram: true, fitsInAccelerator: false, fitsOnCpu: true }),
      recommendation(1, { fitsInVram: false, fitsInAccelerator: true, fitsOnCpu: true }),
      recommendation(2, { fitsInVram: false, fitsInAccelerator: false, fitsOnCpu: true, fits: true }),
      recommendation(3, { fitsInVram: false, fitsInAccelerator: false, fitsOnCpu: false, fits: false }),
      recommendation(4, {
        fitsInVram: undefined,
        fitsInAccelerator: undefined,
        fitsOnCpu: undefined,
        fits: undefined,
      }),
    ],
  });

  assert.deepEqual(result.cards.map((card) => card.fitState), [
    'fits',
    'fits',
    'cpu',
    'over',
    'unknown',
  ]);
  assert.deepEqual(result.cards.map(merge.fitTone), [
    'success',
    'success',
    'warning',
    'danger',
    'muted',
  ]);
});

test('a missing hardware profile forces unknown fit without recomputing sidecar flags', () => {
  const result = mergeLibrary({
    hardware: null,
    recommendations: [recommendation(0, { fitsInVram: true, recommended: true })],
  });

  assert.equal(result.hardware.detected, false);
  assert.equal(result.cards[0].fitState, 'unknown');
  assert.equal(result.cards[0].fitRatio, 0);
  assert.equal(result.cards[0].recommended, true);
});

test('normalizes hardware and clamps fit ratios to 1.5', () => {
  const result = mergeLibrary({
    hardware: {
      gpu: {
        type: 'metal',
        name: 'Apple Silicon GPU',
        memory_architecture: 'unified',
        unified_memory_mb: 20000,
      },
    },
    recommendations: [
      recommendation(0, { vramRequiredMb: 5000 }),
      recommendation(1, { vramRequiredMb: 30000, fitsInVram: false, fits: false, fitsOnCpu: false }),
    ],
  });

  assert.equal(result.hardware.budgetMb, 10000);
  assert.equal(result.hardware.ramAvailableMb, 24576);
  assert.equal(result.cards[0].fitRatio, 0.5);
  assert.equal(result.cards[1].fitRatio, 1.5);
});

test('ordering is stable across installed, recommended, and remaining catalog groups', () => {
  const cards = [
    { key: 'catalog-a', installed: false, recommended: false },
    { key: 'installed-a', installed: true, recommended: false },
    { key: 'recommended-a', installed: false, recommended: true },
    { key: 'catalog-b', installed: false, recommended: false },
    { key: 'installed-b', installed: true, recommended: true },
    { key: 'recommended-b', installed: false, recommended: true },
  ];

  assert.deepEqual(merge.orderModelCards(cards).map((card) => card.key), [
    'installed-a',
    'installed-b',
    'recommended-a',
    'recommended-b',
    'catalog-a',
    'catalog-b',
  ]);
  assert.deepEqual(merge.filterModelCards(cards, 'installed').map((card) => card.key), [
    'installed-a',
    'installed-b',
  ]);
  assert.deepEqual(merge.filterModelCards(cards, 'recommended').map((card) => card.key), [
    'recommended-a',
    'installed-b',
    'recommended-b',
  ]);
  assert.deepEqual(merge.filterModelCards(cards, 'garbage'), cards);
});

test('merge preserves catalog order within card groups', () => {
  const result = mergeLibrary({
    recommendations: [recommendation(3), recommendation(1), recommendation(2)],
  });
  assert.deepEqual(result.cards.map((card) => card.tag), [
    catalog.models[3].pullTag,
    catalog.models[1].pullTag,
    catalog.models[2].pullTag,
  ]);
});

test('duplicate recommendation keys preserve the sidecar-selected twin', () => {
  const laterRecommended = mergeLibrary({
    recommendations: [
      recommendation(0, {
        pullTag: 'twin-model',
        displayName: 'First twin',
        recommended: false,
      }),
      recommendation(1, {
        pullTag: 'TWIN-MODEL:latest',
        displayName: 'Later recommended twin',
        recommended: true,
      }),
    ],
  });
  assert.equal(laterRecommended.cards.length, 1);
  assert.equal(laterRecommended.cards[0].recommended, true);
  assert.equal(laterRecommended.cards[0].displayName, 'Later recommended twin');

  const firstRecommended = mergeLibrary({
    recommendations: [
      recommendation(0, {
        pullTag: 'other-twin',
        displayName: 'First recommended twin',
        recommended: true,
      }),
      recommendation(1, {
        pullTag: 'OTHER-TWIN:latest',
        displayName: 'Later unselected twin',
        recommended: false,
      }),
    ],
  });
  assert.equal(firstRecommended.cards.length, 1);
  assert.equal(firstRecommended.cards[0].recommended, true);
  assert.equal(firstRecommended.cards[0].displayName, 'First recommended twin');
});

test('installed controller entries carry engine metadata and strings keep safe defaults', () => {
  const result = mergeLibrary({
    installed: [
      {
        id: 'controller-shape:q6',
        sizeBytes: 123456,
        engineType: 'OLLAMA',
        available: false,
        reason: 'x',
      },
      'bare-string:tag',
    ],
  });
  const byTag = new Map(result.cards.map((model) => [model.tag, model]));
  const controller = byTag.get('controller-shape:q6');
  const bare = byTag.get('bare-string:tag');

  assert.equal(controller.sizeBytes, 123456);
  assert.equal(controller.engineType, 'ollama');
  assert.equal(controller.available, false);
  assert.equal(bare.engineType, '');
  assert.equal(bare.available, true);
  assert.equal(bare.engineVisible, true);
});

test('recommended passes through verbatim and is never inferred', () => {
  const result = mergeLibrary({
    installed: [{ id: 'installed:no-catalog' }],
    recommendations: [
      recommendation(0, { recommended: 'ranked-upstream' }),
      recommendation(1, { recommended: false }),
      recommendation(2, { recommended: undefined }),
    ],
  });
  const catalogCards = result.cards.filter((card) => card.source === 'catalog');
  const installedCard = result.cards.find((card) => card.source === 'installed');

  assert.equal(catalogCards[0].recommended, 'ranked-upstream');
  assert.equal(catalogCards[1].recommended, false);
  assert.equal(catalogCards[2].recommended, undefined);
  assert.equal(installedCard.recommended, undefined);
});

test('null and garbage inputs degrade to an empty projection without throwing', () => {
  for (const input of [null, undefined, 'bad', 42, [], { installed: {}, recommendations: 'bad' }]) {
    assert.doesNotThrow(() => merge.mergeModelLibrary(input));
    assert.deepEqual(merge.mergeModelLibrary(input).cards, []);
  }
  assert.deepEqual(merge.orderModelCards(null), []);
  assert.deepEqual(merge.filterModelCards('bad', 'all'), []);
  assert.equal(merge.fitTone(null), 'muted');
  assert.deepEqual(merge.mergeModelLibrary({ catalogMeta: {} }).catalogMeta, {});
});

test('identifies the frozen set of local engine types', () => {
  assert.deepEqual(merge.LOCAL_ENGINE_TYPES, ['ollama', 'vllm', 'openai-compatible']);
  assert.equal(Object.isFrozen(merge.LOCAL_ENGINE_TYPES), true);
  assert.equal(merge.isLocalEngine({ engineType: 'OLLAMA' }), true);
  assert.equal(merge.isLocalEngine({ engineType: 'vllm' }), true);
  assert.equal(merge.isLocalEngine({ engineType: 'openai-compatible' }), true);
  assert.equal(merge.isLocalEngine({ engineType: 'plugin_host' }), false);
  assert.equal(merge.isLocalEngine(null), false);
  assert.equal(merge.isLocalEngine('ollama'), false);
  // The row renderer's tune/menu gates share the second predicate with
  // groupModelCards; drift strands an installed card with engine_type '' in
  // "Installed" with no Tune and no overflow menu (its only Remove path).
  for (const [entry, local] of [[{ installed: true, engineType: '' }, true],
    [{ installed: true }, true], [{ engineType: 'ollama' }, true],
    [{ engineType: 'plugin_host' }, false], [null, false], ['ollama', false]]) {
    assert.equal(merge.isLocalOrUnknownEngine(entry), local);
  }
  const grouped = merge.groupModelCards([{ key: 'no-engine', installed: true, engineType: '' }]);
  assert.deepEqual(grouped[1].cards.map((card) => card.key), ['no-engine']);
});

test('groups model cards by use, local install, cloud, and availability', () => {
  const cards = [
    { key: 'cloud-active', active: true, installed: false, engineType: 'plugin_host' },
    { key: 'ollama-a', installed: true, engineType: 'ollama' },
    { key: 'plugin-a', installed: true, engineType: 'plugin_host' },
    { key: 'vllm-a', installed: true, engineType: 'vllm' },
    { key: 'catalog-only', installed: false, engineType: '' },
    { key: 'compatible-a', installed: true, engineType: 'openai-compatible' },
    { key: 'ollama-only', installed: true, engineType: '', ollamaOnly: true },
    { key: 'unknown-engine', installed: true, engineType: '', ollamaOnly: false },
  ];
  const groups = merge.groupModelCards(cards);

  assert.deepEqual(groups.map(({ id, label }) => ({ id, label })), [
    { id: 'in-use', label: 'In use' },
    { id: 'installed', label: 'Installed' },
    { id: 'cloud', label: 'Cloud' },
    { id: 'available', label: 'Available to download' },
  ]);
  assert.deepEqual(groups.map((group) => group.cards.map((card) => card.key)), [
    ['cloud-active'],
    ['ollama-a', 'vllm-a', 'compatible-a', 'ollama-only', 'unknown-engine'],
    ['plugin-a'],
    ['catalog-only'],
  ]);
});

test('grouping returns four empty groups for empty or non-array input and skips invalid entries', () => {
  for (const input of [null, undefined, 'bad', 42, {}]) {
    const groups = merge.groupModelCards(input);
    assert.equal(groups.length, 4);
    assert.deepEqual(groups.map((group) => group.cards), [[], [], [], []]);
  }

  const groups = merge.groupModelCards([null, 'bad', 42, [], { key: 'valid' }]);
  assert.deepEqual(groups.map((group) => group.cards.map((card) => card.key)), [
    [],
    [],
    [],
    ['valid'],
  ]);
});

test('filter counts use strict card flags over the unfiltered list', () => {
  const cards = [
    { key: 'both', installed: true, recommended: true },
    { key: 'installed', installed: true, recommended: false },
    { key: 'recommended', installed: false, recommended: true },
    { key: 'neither', installed: false, recommended: 'ranked' },
    null,
    'bad',
    [],
  ];

  assert.deepEqual(merge.filterCounts(cards), { all: 4, installed: 2, recommended: 2 });
  assert.deepEqual(merge.filterCounts(null), { all: 0, installed: 0, recommended: 0 });
  assert.deepEqual(merge.filterCounts('bad'), { all: 0, installed: 0, recommended: 0 });
});
