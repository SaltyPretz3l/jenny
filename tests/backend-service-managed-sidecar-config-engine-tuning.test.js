const os = require('os');
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildManagedSidecarConfig } = require('../services/backend/managed-sidecar-config');
const { normalizeState, serializeState } = require('../services/shell-config-state');
const { engineTuningMethods } = require('../services/shell-config-engine-tuning');
const { ENGINE_TUNING_FIELDS } = require('../renderer/shared/engine-tuning-schema');

/* Fields that buildManagedSidecarConfig already emits into raw_config. Tier A
 * is the set whose readers existed all along but whose values never survived
 * persistence; Tier C (maxBudgetUsd) persisted fine and only lacked UI. */
const EMITTED_FIELDS = ENGINE_TUNING_FIELDS.filter(
  (field) => field.tier === 'A' || field.tier === 'C'
);

/* Tier B keys the sidecar has always parsed but Electron never sent a user value
 * for. They emit null when unset rather than a default, which is what keeps them
 * inert: raw_config.get(k) returning None makes the sidecar apply its own
 * default, byte-identically to the key being absent. */
const TIER_B_FIELDS = ENGINE_TUNING_FIELDS.filter((field) => field.tier === 'B');

/* Every field the builder emits, whatever its unset contract. */
const ALL_EMITTED_FIELDS = [...EMITTED_FIELDS, ...TIER_B_FIELDS];

/* Persist through the REAL normalize -> serialize -> normalize path rather than
 * hand-building a state object. That round-trip IS the boundary that was broken:
 * normalizeState's allowlist silently dropped every one of these keys, so a
 * hand-built fixture would pass while production still lost the value. */
function persistThroughRoundTrip(seed) {
  const first = normalizeState(seed);
  const onDisk = JSON.parse(JSON.stringify(serializeState(first)));
  return normalizeState(onDisk);
}

function buildRawConfigFor(seed) {
  const state = persistThroughRoundTrip(seed);
  const configService = {
    state,
    getState: () => state,
    getEngineTuning: engineTuningMethods.getEngineTuning,
    resolveEngineTuningValue: engineTuningMethods.resolveEngineTuningValue,
  };
  const service = {
    configService,
    options: { userDataPath: os.tmpdir() },
    currentEngineType: 'ollama',
    currentModel: 'test-model',
    defaultModel: 'test-model',
  };
  return { rawConfig: buildManagedSidecarConfig(service), state };
}

/* Every field persists in the one owned block. */
function seedFor(field, value) {
  return { engineTuning: { [field.key]: value } };
}

function getFieldByKey(key) {
  const field = ENGINE_TUNING_FIELDS.find((candidate) => candidate.key === key);
  assert.ok(field, `unknown schema field ${key}`);
  return field;
}

/* A value inside bounds that is NOT the default, so a pass cannot be explained
 * by the reader silently falling back. */
function midOverrideFor(field) {
  const candidates = field.type === 'integer'
    ? [Math.floor((field.min + field.max) / 2), field.min, field.max]
    : [(field.min + field.max) / 2, field.min, field.max];
  const picked = candidates.find((candidate) => candidate !== field.default);
  return field.type === 'integer' ? Math.trunc(picked) : picked;
}

test('a persisted engine-tuning override survives the round-trip and reaches raw_config', () => {
  // THE regression test. Against the pre-CONFIG_VERSION-48 code every one of
  // these assertions fails with the hardcoded default, because normalizeState
  // discarded the key before managed-sidecar-config ever read it.
  for (const field of EMITTED_FIELDS) {
    const override = midOverrideFor(field);
    const { rawConfig, state } = buildRawConfigFor(seedFor(field, override));

    assert.equal(
      state.engineTuning[field.key],
      override,
      `${field.key}: value did not survive normalizeState -> serializeState -> normalizeState`
    );
    assert.equal(
      rawConfig[field.rawKey],
      override,
      `${field.key}: persisted ${override} but raw_config.${field.rawKey} was ${rawConfig[field.rawKey]}`
    );
    if (field.default != null) {
      assert.notEqual(
        rawConfig[field.rawKey],
        field.default,
        `${field.key}: raw_config still shows the default - the override was ignored`
      );
    }
  }
});

test('overrides reach raw_config at both ends of their bounds', () => {
  for (const field of EMITTED_FIELDS) {
    for (const edge of [field.min, field.max]) {
      if (edge === field.default) continue;
      const { rawConfig } = buildRawConfigFor(seedFor(field, edge));
      assert.equal(
        rawConfig[field.rawKey],
        edge,
        `${field.key}: boundary value ${edge} did not reach raw_config`
      );
    }
  }
});

test('an out-of-bounds override never reaches raw_config', () => {
  // Drop-not-clamp: the sidecar would fall back to its default for an
  // out-of-range value, so Electron must not send a clamped one either.
  for (const field of EMITTED_FIELDS) {
    const { rawConfig } = buildRawConfigFor(seedFor(field, field.max + 1000));
    if (field.default != null) {
      assert.equal(
        rawConfig[field.rawKey],
        field.default,
        `${field.key}: out-of-bounds value leaked into raw_config`
      );
    } else {
      assert.equal(rawConfig[field.rawKey], null, `${field.key}: expected unset`);
    }
  }
});

test('with no overrides every emitted key still equals its documented default', () => {
  // The inverse-inertness half: adding persistence must not have changed what a
  // user who never opens the Advanced section receives.
  const { rawConfig, state } = buildRawConfigFor({});
  assert.deepEqual(state.engineTuning, {}, 'a clean config carries no overrides');
  for (const field of EMITTED_FIELDS) {
    if (field.default == null) {
      assert.equal(
        rawConfig[field.rawKey],
        null,
        `${field.rawKey}: an unset optional key must be null, not a fabricated value`
      );
      continue;
    }
    assert.equal(
      rawConfig[field.rawKey],
      field.default,
      `${field.rawKey}: default drifted`
    );
  }
});

test('the legacy flat key spelling is harvested rather than lost', () => {
  // Somebody who hand-edited shell-config.json has these as flat top-level keys.
  // The v48 migration is their only chance to be rescued into the owned block.
  const { rawConfig, state } = buildRawConfigFor({
    version: 47,
    maxToolsPerTurn: 7,
    max_sub_agent_concurrency: 4,
  });
  assert.equal(state.engineTuning.maxToolsPerTurn, 7);
  assert.equal(state.engineTuning.maxSubAgentConcurrency, 4);
  assert.equal(rawConfig.max_tools_per_turn, 7);
  assert.equal(rawConfig.max_sub_agent_concurrency, 4);
  // ...and the flat spellings must not linger where they could shadow a later edit.
  assert.equal(state.maxToolsPerTurn, undefined);
  assert.equal(state.max_sub_agent_concurrency, undefined);
});

test('the retired serializeState passthroughs stay gone', () => {
  // maxToolsPerTurn / diagnosticsLogLevel / diagnosticsCaptureMode were emitted
  // by serializeState but never populated by normalizeState, so they were always
  // undefined. Re-adding one would resurrect the same silent-drop confusion.
  const serialized = serializeState(normalizeState({ engineTuning: { maxToolsPerTurn: 7 } }));
  assert.ok(!('maxToolsPerTurn' in serialized), 'flat maxToolsPerTurn must not be serialized');
  assert.equal(serialized.engineTuning.maxToolsPerTurn, 7, 'it lives in the owned block now');
});

test('resolveEngineTuningValue reports unset rather than a default', () => {
  // managed-sidecar-config relies on null meaning "user has no opinion" so it
  // can hand the sidecar an absent key instead of a fabricated value.
  const state = persistThroughRoundTrip({ engineTuning: { maxToolsPerTurn: 7 } });
  const host = { state, ...engineTuningMethods };
  const resolve = (key) => host.resolveEngineTuningValue(key);
  assert.equal(resolve('maxToolsPerTurn'), 7);
  assert.equal(resolve('maxLoopIterations'), null);
  assert.equal(resolve('notAField'), null);
});

test('tier B keys stay inert until the user sets one', () => {
  // Newly emitting a key the sidecar previously defaulted is the main risk of
  // this change; null-when-unset is what reduces it to zero.
  const { rawConfig } = buildRawConfigFor({});
  for (const field of TIER_B_FIELDS) {
    assert.equal(
      rawConfig[field.rawKey],
      null,
      `${field.rawKey}: must be null when unset so the sidecar default wins`
    );
  }
});

test('a tier B override reaches raw_config', () => {
  for (const field of TIER_B_FIELDS) {
    const override = midOverrideFor(field);
    const { rawConfig } = buildRawConfigFor(seedFor(field, override));
    assert.equal(
      rawConfig[field.rawKey],
      override,
      `${field.key}: persisted ${override} but raw_config.${field.rawKey} was ${rawConfig[field.rawKey]}`
    );
  }
});

test('cloud twins are never emitted with narrower bounds than their local twin', () => {
  // config.py explicitly forbids narrowing the cloud profile to match local.
  const pairs = [
    ['cloudMaxToolsPerTurn', 500],
    ['cloudMaxChatLoopIterations', 1000],
    ['cloudMaxTaskLoopIterations', 1000],
  ];
  for (const [key, atLeast] of pairs) {
    const { rawConfig } = buildRawConfigFor(seedFor(getFieldByKey(key), atLeast));
    const field = getFieldByKey(key);
    assert.equal(
      rawConfig[field.rawKey],
      atLeast,
      `${key}: the widened cloud ceiling was rejected somewhere in the chain`
    );
  }
});

test('the owned block is authoritative: unset keys do not fall through to a full getState() clone', () => {
  // Regression: every unset key (the default state) used to fall back to
  // configService.getState() - a deep clone of the whole shell config - so one
  // buildManagedSidecarConfig performed ~28 deep clones to answer ~28 lookups.
  const {
    resolveEngineTuningOverride,
  } = require('../services/backend/managed-sidecar-engine-tuning');
  let getStateCalls = 0;
  const configService = {
    resolveEngineTuningValue: () => null,
    getState: () => { getStateCalls += 1; return { maxToolsPerTurn: 99 }; },
  };
  assert.equal(resolveEngineTuningOverride({ configService }, ['maxToolsPerTurn', 'max_tools_per_turn']), null);
  assert.equal(getStateCalls, 0);
  // A config service that predates the owned block still gets the flat-key walk.
  const legacy = { getState: () => ({ max_tools_per_turn: 12 }) };
  assert.equal(resolveEngineTuningOverride({ configService: legacy }, ['maxToolsPerTurn', 'max_tools_per_turn']), 12);
});

test('managed-sidecar readers take their bounds and defaults from the schema, not literals', () => {
  // Drift guard for the second bounds table the review found: an unset field
  // must emit the SCHEMA default (tier A/C) or null (tier B stays inert) for every
  // field, without this file knowing the numbers - and the reader module must not
  // restate them. A just-out-of-range value must do the same, never clamp.
  for (const field of ALL_EMITTED_FIELDS) {
    const expected = field.tier === 'B' ? null : field.default;
    assert.equal(buildRawConfigFor({ engineTuning: {} }).rawConfig[field.rawKey], expected,
      field.key + ': unset must emit ' + expected);
    const { rawConfig } = buildRawConfigFor(seedFor(field, field.max + 1));
    assert.equal(
      rawConfig[field.rawKey],
      expected,
      field.key + ': unset must emit the schema default (' + field.default + ')'
    );
  }
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'services', 'backend', 'managed-sidecar-engine-tuning.js'),
    'utf8'
  );
  assert.ok(
    !/getConfiguredOptionalBounded\(\s*service,\s*\[[^\]]+\],\s*\d/.test(source),
    'managed-sidecar-engine-tuning.js must not restate numeric bounds'
  );
});
