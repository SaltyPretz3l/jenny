'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  canonicalizeModelToken,
  loadAccelerationCatalog,
  findDrafterFile,
  resolveAccelerationArgs,
} = require('../services/backend/llama-server-acceleration');

const REPO_ROOT = path.resolve(__dirname, '..');
const MODEL_DIR = path.join(REPO_ROOT, 'models');
const MATCHING_DRAFTER_FS = {
  readdirSync: () => ['MTP-gemma-4-12B-it.gguf', 'other.gguf'],
};
const NO_DRAFTER_FS = {
  readdirSync: () => ['other.gguf'],
};
const CAPABILITIES = {
  ok: true,
  supportsMtp: true,
  specTypes: ['draft-mtp', 'ngram-cache'],
};

const loadedCatalog = loadAccelerationCatalog({ repoRoot: REPO_ROOT });
assert.equal(loadedCatalog.error, '');
const CATALOG = loadedCatalog.catalog;

function resolve(overrides = {}) {
  return resolveAccelerationArgs({
    modelTag: 'qwen3.8:27b-ud-iq3-s',
    mode: 'mtp',
    draftNMax: 4,
    allowUnverified: true,
    catalog: CATALOG,
    capabilities: CAPABILITIES,
    profileExtraArgs: [],
    modelDir: MODEL_DIR,
    fsImpl: MATCHING_DRAFTER_FS,
    ...overrides,
  });
}

test('canonicalizeModelToken exactly matches the sidecar token form', () => {
  const cases = [
    ['hf.co/unsloth/gemma-4-12B-it-qat-GGUF', 'gemma-4-12b-it-qat-gguf'],
    ['gemma4-12b-qat', 'gemma4-12b-qat'],
    ['qwen3.8:27b-ud-iq3-s', 'qwen3-8'],
    ['Ornith15:9b', 'ornith15'],
    ['  ', ''],
  ];
  for (const [input, expected] of cases) {
    assert.equal(canonicalizeModelToken(input), expected, input);
  }
});

test('loadAccelerationCatalog loads the shipped catalog and sanitizes numeric defaults', () => {
  assert.equal(loadedCatalog.error, '');
  assert.equal(
    loadedCatalog.catalog.families.find((entry) => entry.family === 'gemma4').mtp,
    'yes'
  );

  const sanitized = loadAccelerationCatalog({
    repoRoot: REPO_ROOT,
    fsImpl: {
      readFileSync: () => JSON.stringify({
        schema_version: 1,
        defaults: {
          draftNMax: '4',
          draftNMaxMin: NaN,
          draftNMaxMax: 2.5,
          vramHeadroomMb: -1,
        },
        families: [{
          family: 'example',
          matchPrefixes: ['example'],
          mtp: 'yes',
          mtpShape: 'native',
        }],
      }),
    },
  });
  assert.equal(sanitized.error, '');
  assert.deepEqual(sanitized.catalog.defaults, {
    draftNMax: 4,
    draftNMaxMin: 1,
    draftNMaxMax: 6,
    vramHeadroomMb: 2048,
  });
});

test('loadAccelerationCatalog returns stable errors and never throws', () => {
  const cases = [
    {
      name: 'not found',
      input: { fsImpl: { readFileSync: () => { throw new Error('missing'); } } },
      error: 'catalog_not_found',
    },
    {
      name: 'malformed JSON',
      input: { fsImpl: { readFileSync: () => '{' } },
      error: 'catalog_json_invalid',
    },
    {
      name: 'unsupported schema',
      input: { fsImpl: { readFileSync: () => JSON.stringify({ schema_version: 2 }) } },
      error: 'catalog_schema_unsupported',
    },
    {
      name: 'families is not an array',
      input: {
        fsImpl: {
          readFileSync: () => JSON.stringify({ schema_version: 1, defaults: {}, families: {} }),
        },
      },
      error: 'catalog_invalid',
    },
    {
      name: 'defaults is missing',
      input: {
        fsImpl: { readFileSync: () => JSON.stringify({ schema_version: 1, families: [] }) },
      },
      error: 'catalog_invalid',
    },
    {
      name: 'family shape is invalid',
      input: {
        fsImpl: {
          readFileSync: () => JSON.stringify({
            schema_version: 1,
            defaults: {},
            families: [{ family: 'bad', matchPrefixes: [], mtp: 'maybe', mtpShape: 'other' }],
          }),
        },
      },
      error: 'catalog_invalid',
    },
  ];

  for (const entry of cases) {
    assert.doesNotThrow(() => {
      const result = loadAccelerationCatalog({ repoRoot: REPO_ROOT, ...entry.input });
      assert.equal(result.error, entry.error, entry.name);
      assert.equal(result.catalog, null, entry.name);
    }, entry.name);
  }
  assert.doesNotThrow(() => loadAccelerationCatalog());
  assert.equal(loadAccelerationCatalog().error, 'catalog_not_found');
});

test('findDrafterFile matches case-insensitively, sorts, and rejects unsafe patterns', () => {
  const sortedFs = {
    readdirSync: () => ['mtp-z.gguf', 'MTP-a.gguf', 'other.gguf'],
  };
  const cases = [
    {
      name: 'matching file',
      args: { modelDir: MODEL_DIR, drafterPattern: 'mtp-*.gguf', fsImpl: sortedFs },
      expected: path.join(MODEL_DIR, 'MTP-a.gguf'),
    },
    {
      name: 'no matching file',
      args: { modelDir: MODEL_DIR, drafterPattern: 'mtp-*.gguf', fsImpl: NO_DRAFTER_FS },
      expected: '',
    },
    {
      name: 'parent traversal pattern',
      args: { modelDir: MODEL_DIR, drafterPattern: '../mtp-*.gguf', fsImpl: sortedFs },
      expected: '',
    },
    {
      name: 'separator pattern',
      args: { modelDir: MODEL_DIR, drafterPattern: 'nested/mtp-*.gguf', fsImpl: sortedFs },
      expected: '',
    },
    {
      name: 'filesystem error',
      args: {
        modelDir: MODEL_DIR,
        drafterPattern: 'mtp-*.gguf',
        fsImpl: { readdirSync: () => { throw new Error('unreadable'); } },
      },
      expected: '',
    },
  ];
  for (const entry of cases) {
    assert.equal(findDrafterFile(entry.args), entry.expected, entry.name);
  }
});

test('resolver applies precedence rules before mode eligibility', () => {
  const realQwenProfile = JSON.parse(fs.readFileSync(path.join(
    REPO_ROOT,
    'config',
    'llama-server-profiles',
    'qwen3.8-27b-ud-iq3-s-128k.json'
  ), 'utf8'));
  const cases = [
    { name: 'falsy mode', overrides: { mode: '' }, reason: 'disabled' },
    { name: 'off mode', overrides: { mode: 'off' }, reason: 'disabled' },
    {
      name: 'unknown capabilities',
      overrides: { capabilities: { ok: false } },
      reason: 'capabilities_unknown',
    },
    {
      name: 'spec type equals form',
      overrides: { profileExtraArgs: ['--spec-type=draft-mtp'] },
      reason: 'profile_owns_spec_type',
    },
    {
      name: 'bare model draft',
      overrides: { profileExtraArgs: ['--model-draft', 'draft.gguf'] },
      reason: 'profile_owns_spec_type',
    },
    {
      name: 'real Qwen profile fit off',
      overrides: { profileExtraArgs: realQwenProfile.extra_args },
      reason: 'profile_fit_off',
    },
    {
      name: 'fit equals off',
      overrides: { profileExtraArgs: ['--fit=off'] },
      reason: 'profile_fit_off',
    },
  ];

  for (const entry of cases) {
    assert.deepEqual(resolve(entry.overrides), {
      mode: 'off',
      extraArgs: [],
      vramHeadroomMb: 0,
      reason: entry.reason,
      drafter: '',
    }, entry.name);
  }
});

test('resolver covers MTP ineligibility and ngram fallback branches', () => {
  const noNgramCatalog = {
    defaults: CATALOG.defaults,
    families: [{
      family: 'qwen38',
      matchPrefixes: ['qwen3-8'],
      mtp: 'yes',
      mtpShape: 'native',
      ngram: false,
    }],
  };
  const cases = [
    {
      name: 'binary lacks MTP',
      overrides: { capabilities: { ...CAPABILITIES, supportsMtp: false } },
      mode: 'ngram',
      reason: 'mtp_ineligible:binary',
    },
    {
      name: 'unknown family',
      overrides: { modelTag: 'unknown:7b' },
      mode: 'ngram',
      reason: 'mtp_ineligible:unknown_family',
    },
    {
      name: 'family says no',
      overrides: { modelTag: 'qwen3.6:35b-a3b' },
      mode: 'ngram',
      reason: 'mtp_ineligible:family',
    },
    {
      name: 'unverified family is not allowed',
      overrides: { allowUnverified: false },
      mode: 'ngram',
      reason: 'mtp_ineligible:family',
    },
    {
      name: 'binary fallback unsupported and family disallows ngram',
      overrides: {
        catalog: noNgramCatalog,
        capabilities: { ...CAPABILITIES, supportsMtp: false },
      },
      mode: 'off',
      reason: 'mtp_ineligible:binary',
    },
    {
      name: 'specific fallback reason survives missing ngram capability',
      overrides: {
        capabilities: { ok: true, supportsMtp: false, specTypes: [] },
      },
      mode: 'off',
      reason: 'mtp_ineligible:binary',
    },
  ];

  for (const entry of cases) {
    const result = resolve(entry.overrides);
    assert.equal(result.mode, entry.mode, entry.name);
    assert.equal(result.reason, entry.reason, entry.name);
    assert.equal(result.vramHeadroomMb, 0, entry.name);
    assert.equal(result.drafter, '', entry.name);
    assert.deepEqual(
      result.extraArgs,
      entry.mode === 'ngram' ? ['--spec-type', 'ngram-cache'] : [],
      entry.name
    );
  }
});

test('resolver finds a separate drafter for both Gemma 4 prefix forms', () => {
  for (const modelTag of [
    'gemma4-12b-qat',
    'hf.co/unsloth/gemma-4-12B-it-qat-GGUF',
  ]) {
    const result = resolve({ modelTag });
    const expectedPath = path.join(MODEL_DIR, 'MTP-gemma-4-12B-it.gguf');
    assert.equal(result.mode, 'mtp', modelTag);
    assert.equal(result.reason, 'mtp', modelTag);
    assert.equal(result.vramHeadroomMb, 512, modelTag);
    assert.equal(result.drafter, 'MTP-gemma-4-12B-it.gguf', modelTag);
    assert.deepEqual(result.extraArgs, [
      '--spec-type', 'draft-mtp',
      '--spec-draft-n-max', '4',
      '--model-draft', expectedPath,
    ], modelTag);
  }
});

test('resolver falls back when a separate drafter is missing or its pattern is unsafe', () => {
  const unsafeCatalog = structuredClone(CATALOG);
  unsafeCatalog.families.find((entry) => entry.family === 'gemma4').drafterPattern = '../mtp-*.gguf';
  const cases = [
    {
      name: 'no matching file',
      overrides: { modelTag: 'gemma4-12b-qat', fsImpl: NO_DRAFTER_FS },
    },
    {
      name: 'unsafe catalog pattern',
      overrides: { modelTag: 'gemma4-12b-qat', catalog: unsafeCatalog },
    },
  ];
  for (const entry of cases) {
    assert.deepEqual(resolve(entry.overrides), {
      mode: 'ngram',
      extraArgs: ['--spec-type', 'ngram-cache'],
      vramHeadroomMb: 0,
      reason: 'drafter_missing',
      drafter: '',
    }, entry.name);
  }
});

test('resolver uses only an in-range integer draftNMax', () => {
  const cases = [
    [0, '4'],
    [7, '4'],
    [2.5, '4'],
    ['4', '4'],
    [NaN, '4'],
    [3, '3'],
  ];
  for (const [draftNMax, expected] of cases) {
    const result = resolve({ draftNMax });
    const index = result.extraArgs.indexOf('--spec-draft-n-max');
    assert.equal(result.extraArgs[index + 1], expected, String(draftNMax));
  }
});

test('resolver handles direct ngram, unsupported modes, and final argument rejection', () => {
  const cases = [
    {
      name: 'direct ngram',
      overrides: { mode: 'ngram' },
      mode: 'ngram',
      reason: 'ngram',
      extraArgs: ['--spec-type', 'ngram-cache'],
    },
    {
      name: 'direct ngram unsupported',
      overrides: { mode: 'ngram', capabilities: { ok: true, specTypes: [] } },
      mode: 'off',
      reason: 'no_supported_mode',
      extraArgs: [],
    },
    {
      name: 'unknown requested mode',
      overrides: { mode: 'future' },
      mode: 'off',
      reason: 'no_supported_mode',
      extraArgs: [],
    },
    {
      name: 'generated path rejected by shared validator',
      overrides: {
        modelTag: 'gemma4-12b-qat',
        modelDir: `${MODEL_DIR}\nunsafe`,
      },
      mode: 'off',
      reason: 'args_rejected',
      extraArgs: [],
    },
  ];
  for (const entry of cases) {
    const result = resolve(entry.overrides);
    assert.equal(result.mode, entry.mode, entry.name);
    assert.equal(result.reason, entry.reason, entry.name);
    assert.deepEqual(result.extraArgs, entry.extraArgs, entry.name);
    assert.equal(result.vramHeadroomMb, 0, entry.name);
    assert.equal(result.drafter, '', entry.name);
  }
});
