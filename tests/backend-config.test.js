const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  LLAMA_SERVER_PROFILE_MANAGED_ARGS,
  LLAMA_SERVER_PROFILE_SCHEMA_VERSION,
  LLAMA_SERVER_PROFILE_SCHEMA_VERSIONS,
  loadLlamaServerProfile,
  resolveLlamaServerSettings,
  validateExtraArgs,
} = require('../services/backend/backend-config');

const REPO_ROOT = path.resolve(__dirname, '..');

test('llama-server profile schema exports preserve v1 and accept v2', () => {
  assert.equal(LLAMA_SERVER_PROFILE_SCHEMA_VERSION, 1);
  assert.deepEqual(LLAMA_SERVER_PROFILE_SCHEMA_VERSIONS, new Set([1, 2]));
});

test('llama-server autostart is opt-in by default', () => {
  const settings = resolveLlamaServerSettings({ env: {} });

  assert.equal(settings.autostart, false);
});

test('llama-server autostart honors explicit true and false environment settings', () => {
  assert.equal(
    resolveLlamaServerSettings({
      env: { JENNY_LLAMA_SERVER_AUTOSTART: 'true' },
    }).autostart,
    true
  );
  assert.equal(
    resolveLlamaServerSettings({
      env: { JENNY_LLAMA_SERVER_AUTOSTART: 'off' },
    }).autostart,
    false
  );
});

test('llama-server environment settings win over managed config', () => {
  const settings = resolveLlamaServerSettings({
    env: {
      JENNY_LLAMA_SERVER_AUTOSTART: 'off',
      JENNY_LLAMA_SERVER_PROFILE: 'env-profile',
      JENNY_LLAMA_SERVER_MODEL_PATH: 'C:\\models\\env.gguf',
    },
    managed: {
      enabled: true,
      profileId: 'config-profile',
      lastUsedTag: 'config-model',
      perModel: { 'config-model': { modelPath: 'C:\\models\\config.gguf' } },
    },
  });

  assert.equal(settings.autostart, false);
  assert.equal(settings.profileId, 'env-profile');
  assert.equal(settings.modelPathOverride, 'C:\\models\\env.gguf');
  assert.equal(settings.modelTagOverride, '');
  assert.equal(settings.source, 'env');
});

test('llama-server managed config supplies config-only launch settings', () => {
  const settings = resolveLlamaServerSettings({
    env: {},
    managed: {
      enabled: true,
      profileId: '',
      lastUsedTag: 'gemma4-12b',
      perModel: { 'gemma4-12b': { modelPath: 'C:\\models\\gemma4.gguf' } },
    },
  });

  assert.equal(settings.autostart, true);
  assert.equal(settings.modelPathOverride, 'C:\\models\\gemma4.gguf');
  assert.equal(settings.modelTagOverride, 'gemma4-12b');
  assert.equal(settings.source, 'config');

  const withTag = resolveLlamaServerSettings({
    env: {},
    managed: {
      enabled: true,
      profileId: '',
      lastUsedTag: 'gemma4-12b',
      perModel: { 'gemma4-12b': { modelPath: 'C:\\models\\gemma4.gguf', tag: 'gemma4:12b' } },
    },
  });
  assert.equal(withTag.modelTagOverride, 'gemma4:12b', 'the display tag aliases the boot launch');
});

test('llama-server env profile never inherits the persisted model path of another model', () => {
  const settings = resolveLlamaServerSettings({
    env: { JENNY_LLAMA_SERVER_PROFILE: 'qwen-profile' },
    managed: {
      enabled: true,
      profileId: '',
      lastUsedTag: 'ornith-9b',
      perModel: { 'ornith-9b': { modelPath: 'C:\\models\\ornith.gguf', tag: 'ornith:9b' } },
    },
  });
  assert.equal(settings.profileId, 'qwen-profile');
  assert.equal(settings.modelPathOverride, '', 'the profile resolves its own weights');
  assert.equal(settings.modelTagOverride, '');
});

test('llama-server managed config does not autostart without a last-used tag', () => {
  const settings = resolveLlamaServerSettings({
    env: {},
    managed: { enabled: true, profileId: '', lastUsedTag: '', perModel: {} },
  });

  assert.equal(settings.autostart, false);
  assert.equal(settings.source, 'config');
});

test('llama-server null managed settings match omitted managed settings', () => {
  const omitted = resolveLlamaServerSettings({ env: {} });
  assert.deepEqual(resolveLlamaServerSettings({ env: {}, managed: null }), omitted);
  assert.equal(omitted.modelTagOverride, '');
  assert.equal(omitted.source, 'none');
});

test('llama-server Qwen3.8 profile fixes 128K context and the GPU launch contract', () => {
  const settings = resolveLlamaServerSettings({
    env: { JENNY_LLAMA_SERVER_PROFILE: 'qwen3.8-27b-ud-iq3-s-128k' },
    repoRoot: REPO_ROOT,
  });

  assert.equal(settings.profileError, '');
  assert.equal(settings.profile.id, 'qwen3.8-27b-ud-iq3-s-128k');
  assert.equal(settings.profile.modelTag, 'qwen3.8:27b-ud-iq3-s');
  assert.equal(settings.profile.contextSize, 131072);
  assert.equal(settings.profile.acceleration, null);
  assert.deepEqual(settings.profile.extraArgs, [
    '--parallel', '1',
    '--no-mmproj',
    '--gpu-layers', 'all',
    '--split-mode', 'none',
    '--flash-attn', 'on',
    '--cache-type-k', 'q8_0',
    '--cache-type-v', 'q8_0',
    '--kv-unified',
    '--batch-size', '512',
    '--ubatch-size', '128',
    '--fit', 'off',
  ]);
});

test('llama-server profile loader rejects unsafe ids and managed-argument overrides', () => {
  assert.equal(
    loadLlamaServerProfile({ profileId: '../outside', repoRoot: REPO_ROOT }).error,
    'invalid_profile_id'
  );

  const result = loadLlamaServerProfile({
    profileId: 'unsafe',
    repoRoot: REPO_ROOT,
    fsImpl: {
      readFileSync: () => JSON.stringify({
        schema_version: 1,
        profile_id: 'unsafe',
        model_tag: 'unsafe:model',
        context_size: 131072,
        extra_args: ['--host=0.0.0.0'],
      }),
    },
  });
  assert.equal(result.error, 'profile_extra_args_invalid');
});

test('llama-server shipped schema-v2 profiles load frozen acceleration settings', () => {
  const gemmaResult = loadLlamaServerProfile({
    profileId: 'gemma4-12b-qat-accel',
    repoRoot: REPO_ROOT,
  });
  assert.equal(gemmaResult.error, '');
  assert.equal(gemmaResult.profile.modelTag, 'gemma4-12b-qat');
  assert.equal(gemmaResult.profile.contextSize, 32768);
  assert.deepEqual(gemmaResult.profile.extraArgs, [
    '--parallel', '1',
    '--no-mmproj',
    '--gpu-layers', 'all',
    '--split-mode', 'none',
    '--flash-attn', 'on',
  ]);
  assert.deepEqual(gemmaResult.profile.acceleration, {
    mode: 'mtp',
    draftNMax: 4,
    allowUnverified: false,
  });
  assert.equal(Object.isFrozen(gemmaResult.profile.acceleration), true);

  const ornithResult = loadLlamaServerProfile({
    profileId: 'ornith15-9b-accel',
    repoRoot: REPO_ROOT,
  });
  assert.equal(ornithResult.error, '');
  assert.equal(ornithResult.profile.modelTag, 'ornith15:9b');
  assert.equal(ornithResult.profile.contextSize, 32768);
  assert.deepEqual(ornithResult.profile.extraArgs, gemmaResult.profile.extraArgs);
  assert.deepEqual(ornithResult.profile.acceleration, {
    mode: 'mtp',
    draftNMax: 3,
    allowUnverified: true,
  });
  assert.equal(Object.isFrozen(ornithResult.profile.acceleration), true);
});

test('llama-server profile acceleration is optional only for schema v2', () => {
  const omittedResult = loadLlamaServerProfile({
    profileId: 'v2-omitted',
    fsImpl: {
      readFileSync: () => JSON.stringify({
        schema_version: 2,
        profile_id: 'v2-omitted',
        model_tag: 'example:model',
        context_size: 32768,
        extra_args: [],
      }),
    },
  });
  assert.equal(omittedResult.error, '');
  assert.equal(omittedResult.profile.acceleration, null);

  const nullResult = loadLlamaServerProfile({
    profileId: 'v2-null',
    fsImpl: {
      readFileSync: () => JSON.stringify({
        schema_version: 2,
        profile_id: 'v2-null',
        model_tag: 'example:model',
        context_size: 32768,
        extra_args: [],
        acceleration: null,
      }),
    },
  });
  assert.equal(nullResult.error, '');
  assert.equal(nullResult.profile.acceleration, null);

  const defaultsResult = loadLlamaServerProfile({
    profileId: 'v2-defaults',
    fsImpl: {
      readFileSync: () => JSON.stringify({
        schema_version: 2,
        profile_id: 'v2-defaults',
        model_tag: 'example:model',
        context_size: 32768,
        extra_args: [],
        acceleration: { mode: 'ngram', ignored_key: 'ignored' },
      }),
    },
  });
  assert.equal(defaultsResult.error, '');
  assert.deepEqual(defaultsResult.profile.acceleration, {
    mode: 'ngram',
    draftNMax: 0,
    allowUnverified: false,
  });
  assert.equal(Object.isFrozen(defaultsResult.profile.acceleration), true);

  const v1Result = loadLlamaServerProfile({
    profileId: 'v1-acceleration',
    fsImpl: {
      readFileSync: () => JSON.stringify({
        schema_version: 1,
        profile_id: 'v1-acceleration',
        model_tag: 'example:model',
        context_size: 32768,
        extra_args: [],
        acceleration: { mode: 'off' },
      }),
    },
  });
  assert.equal(v1Result.error, 'profile_acceleration_invalid');
  assert.equal(v1Result.profile, null);
});

test('llama-server profile loader rejects malformed acceleration settings', () => {
  const invalidAccelerations = [
    [],
    { mode: 'MTP' },
    { mode: 'bogus' },
    { mode: 'mtp', draft_n_max: '3' },
    { draft_n_max: 3 },
    { mode: 'mtp', draft_n_max: 0 },
    { mode: 'mtp', draft_n_max: 7 },
    { mode: 'mtp', draft_n_max: 2.5 },
    { mode: 'mtp', allow_unverified: 'yes' },
  ];

  for (const [index, acceleration] of invalidAccelerations.entries()) {
    const result = loadLlamaServerProfile({
      profileId: `invalid-acceleration-${index}`,
      fsImpl: {
        readFileSync: () => JSON.stringify({
          schema_version: 2,
          profile_id: `invalid-acceleration-${index}`,
          model_tag: 'example:model',
          context_size: 32768,
          extra_args: [],
          acceleration,
        }),
      },
    });
    assert.equal(result.error, 'profile_acceleration_invalid');
    assert.equal(result.profile, null);
  }
});

test('validateExtraArgs accepts the shipped Qwen args and trims returned values', () => {
  const qwenProfile = JSON.parse(fs.readFileSync(
    path.join(
      REPO_ROOT,
      'config',
      'llama-server-profiles',
      'qwen3.8-27b-ud-iq3-s-128k.json'
    ),
    'utf8'
  ));
  assert.deepEqual(validateExtraArgs(qwenProfile.extra_args), {
    args: qwenProfile.extra_args,
    error: '',
  });
  assert.deepEqual(validateExtraArgs(['  --parallel  ', '  1  ']), {
    args: ['--parallel', '1'],
    error: '',
  });
});

test('validateExtraArgs rejects managed flags and malformed entries', () => {
  for (const managedArg of LLAMA_SERVER_PROFILE_MANAGED_ARGS) {
    assert.equal(validateExtraArgs([managedArg]).error, 'profile_extra_args_invalid');
    assert.equal(validateExtraArgs([`${managedArg}=x`]).error, 'profile_extra_args_invalid');
  }

  for (const invalidArgs of [
    null,
    Array(65).fill('--safe'),
    ['--safe', 3],
    [''],
    ['--safe\rvalue'],
    ['--safe\nvalue'],
    ['--safe\0value'],
  ]) {
    assert.deepEqual(validateExtraArgs(invalidArgs), {
      args: [],
      error: 'profile_extra_args_invalid',
    });
  }
});

test('validateExtraArgs rejects llama-server authentication and slots overrides', () => {
  for (const extraArgs of [
    ['--api-key', 'x'],
    ['--api-key-file', 'x'],
    ['--no-slots'],
    ['--slots'],
  ]) {
    assert.equal(validateExtraArgs(extraArgs).error, 'profile_extra_args_invalid');
  }
});

test('llama-server profile loader rejects unsupported schema versions', () => {
  const result = loadLlamaServerProfile({
    profileId: 'future-profile',
    fsImpl: {
      readFileSync: () => JSON.stringify({
        schema_version: 3,
        profile_id: 'future-profile',
        model_tag: 'example:model',
        context_size: 32768,
        extra_args: [],
      }),
    },
  });
  assert.equal(result.error, 'profile_schema_unsupported');
  assert.equal(result.profile, null);
});
