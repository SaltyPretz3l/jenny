// Acceleration + per-model engine projection (managed llama-server W4a): split from
// model-library-merge.test.js to keep both files under the 600-line complexity ratchet.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const merge = require('../renderer/shell/model-library/model-library-merge.js');
const { managedModelKey: serviceManagedModelKey } = require('../services/shell-config-engines');

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

test('recommended remains byte-identical with acceleration enabled or disabled', () => {
  const rankedValue = '  sidecar-ranked-v1\u0000verbatim  ';
  const fixture = recommendation(0, { recommended: rankedValue });
  const disabled = mergeLibrary({ recommendations: [fixture] });
  const enabled = mergeLibrary({
    recommendations: [fixture],
    acceleration: { enabled: true, headroomMb: 2048, families: ACCELERATION_FAMILIES },
  });

  assert.equal(disabled.cards[0].recommended, rankedValue);
  assert.equal(enabled.cards[0].recommended, rankedValue);
  assert.equal(JSON.stringify(enabled.cards[0].recommended), JSON.stringify(fixture.recommended));
  assert.equal(JSON.stringify(disabled.cards[0].recommended), JSON.stringify(fixture.recommended));
});

test('marks only verified MTP family prefixes as acceleration eligible', () => {
  const tags = [
    'gemma4-12b-qat',
    'hf.co/unsloth/gemma-4-12B-it-qat-GGUF',
    'ornith15:9b',
    'qwen2.5-coder:1.5b-base',
  ];
  const enabled = mergeLibrary({
    acceleration: { enabled: true, headroomMb: 2048, families: ACCELERATION_FAMILIES },
    recommendations: tags.map((pullTag, index) => recommendation(index, { pullTag })),
  });
  const disabled = mergeLibrary({
    recommendations: tags.map((pullTag, index) => recommendation(index, { pullTag })),
  });

  assert.deepEqual(enabled.cards.map((card) => card.accelerationEligible), [true, true, false, false]);
  assert.deepEqual(disabled.cards.map((card) => card.accelerationEligible), [false, false, false, false]);
});

test('canonicalFamilyToken matches shared acceleration fixtures', () => {
  const cases = [
    ['hf.co/unsloth/gemma-4-12B-it-qat-GGUF', 'gemma-4-12b-it-qat-gguf'],
    ['qwen3.8:27b', 'qwen3-8'],
    ['Ornith15:9b', 'ornith15'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(merge.canonicalFamilyToken(input), expected, input);
  }
});

test('managedModelKey agrees with the shell-config owner while preserving size tags', () => {
  const tags = [
    'gemma4:12b',
    'Ornith:9B',
    'qwen3-coder:30b',
    'library/ns/model:tag',
    'gemma4',
  ];

  for (const tag of tags) {
    assert.equal(merge.managedModelKey(tag), serviceManagedModelKey(tag), tag);
  }
  const family = merge.matchAccelerationFamily('gemma4:12b', {
    enabled: true,
    families: ACCELERATION_FAMILIES,
  });
  assert.equal(merge.isEligibleFamily(family), true);
});

test('projects Ollama and local GGUF availability with Ollama selected by default', () => {
  const result = mergeLibrary({
    installed: [
      { id: 'gemma4:12b', engineType: 'ollama' },
      { id: 'remote:7b', engineType: 'plugin_host' },
      { id: 'legacy:3b' },
      { id: 'vllm-only:7b', engineType: 'vllm' },
    ],
    ollamaTags: ['remote:7b', 'legacy:3b'],
    acceleration: { enabled: true, headroomMb: 2048, families: ACCELERATION_FAMILIES },
    localGgufs: [
      {
        tag: 'gemma4:12b',
        source: 'library',
        dir: 'C:\\models',
        mainGguf: 'gemma.gguf',
        drafterGguf: 'draft.gguf',
      },
      { tag: 'gemma4:12b', dir: 'D:\\ignored', mainGguf: 'ignored.gguf' },
    ],
  });
  const byTag = new Map(result.cards.map((card) => [card.tag, card]));
  const gemma = byTag.get('gemma4:12b');

  assert.deepEqual(gemma.engines, {
    ollama: { available: true },
    llamaServer: {
      available: true,
      modelPath: 'C:\\models\\gemma.gguf',
      drafter: true,
    },
  });
  assert.equal(gemma.managedKey, 'gemma4-12b');
  assert.equal(gemma.selectedEngine, 'ollama');
  assert.deepEqual(gemma.mtp, { eligible: true, enabled: false, headroomMb: 0 });
  assert.equal(gemma.serving, false);
  assert.equal(gemma.servingPort, 0);
  // Ollama lists remote:7b itself, so it stays Ollama-runnable even though the
  // installed entry names another engine; a non-Ollama install with no tag is not.
  assert.equal(byTag.get('remote:7b').engines.ollama.available, true);
  assert.equal(byTag.get('legacy:3b').engines.ollama.available, true);
  assert.equal(byTag.get('vllm-only:7b').engines.ollama.available, false);
});

test('per-model llama-server MTP selection uses persisted path and charges family headroom', () => {
  const result = mergeLibrary({
    recommendations: [recommendation(0, { pullTag: 'gemma4:12b' })],
    acceleration: {
      enabled: true,
      headroomMb: 2048,
      families: [{ matchPrefixes: ['gemma4'], mtp: 'yes', vramHeadroomMb: 512 }],
    },
    managed: {
      enabled: true,
      perModel: {
        'gemma4-12b': {
          engine: 'llama-server',
          modelPath: 'D:/persisted/gemma.gguf',
          mtp: { mode: 'mtp' },
        },
      },
    },
    localGgufs: [{
      tag: 'gemma4:12b',
      source: 'library',
      dir: 'C:\\models',
      mainGguf: 'local.gguf',
      drafterGguf: 'draft.gguf',
    }],
  });
  const card = result.cards[0];

  assert.equal(card.selectedEngine, 'llama-server');
  assert.deepEqual(card.engines.llamaServer, {
    available: true,
    modelPath: 'D:/persisted/gemma.gguf',
    drafter: true,
  });
  assert.deepEqual(card.mtp, { eligible: true, enabled: true, headroomMb: 512 });
  assert.equal(card.accelerationHeadroomMb, 512);
});

test('projects an Ollama blob copy as runnable llama-server source', () => {
  const result = mergeLibrary({
    recommendations: [recommendation(0, { pullTag: 'gemma4:12b' })],
    localGgufs: [{
      tag: 'gemma4:12b',
      source: 'ollama',
      dir: 'C:\\ollama\\blobs',
      mainGguf: 'sha256-abc',
      drafterGguf: '',
    }],
  });

  assert.deepEqual(result.cards[0].engines.llamaServer, {
    available: true,
    modelPath: 'C:\\ollama\\blobs\\sha256-abc',
    drafter: false,
  });
});

test('unverified families cannot enable per-model MTP or consume headroom', () => {
  const result = mergeLibrary({
    recommendations: [recommendation(0, { pullTag: 'Ornith:9B' })],
    acceleration: { enabled: true, headroomMb: 2048, families: ACCELERATION_FAMILIES },
    managed: {
      enabled: true,
      perModel: {
        'ornith-9b': {
          engine: 'llama-server',
          modelPath: 'C:/models/ornith.gguf',
          mtp: { mode: 'mtp' },
        },
      },
    },
  });
  const card = result.cards[0];

  assert.equal(card.selectedEngine, 'llama-server');
  assert.deepEqual(card.mtp, { eligible: false, enabled: false, headroomMb: 0 });
  assert.equal(card.accelerationHeadroomMb, 0);
});

test('serving status matches the managed key including the model size tag', () => {
  const result = mergeLibrary({
    recommendations: [
      recommendation(0, { pullTag: 'gemma4:12b' }),
      recommendation(1, { pullTag: 'gemma4:27b' }),
    ],
    llamaServer: { state: 'ready', alias: 'gemma4:12b', port: 8033 },
  });
  const byTag = new Map(result.cards.map((card) => [card.tag, card]));

  assert.equal(byTag.get('gemma4:12b').serving, true);
  assert.equal(byTag.get('gemma4:12b').servingPort, 8033);
  assert.equal(byTag.get('gemma4:27b').serving, false);
  assert.equal(byTag.get('gemma4:27b').servingPort, 0);
});
