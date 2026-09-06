const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ENGINE_TUNING_FIELDS,
  ENGINE_TUNING_GROUPS,
  SCOPE_CLOUD,
  SCOPE_LOCAL,
  getFieldDefinition,
  isEngineTuningValueInRange,
  normalizeEngineTuningValue,
} = require('../renderer/shared/engine-tuning-schema');

const ENGINE_TUNING_KEYS = ENGINE_TUNING_FIELDS.map((field) => field.key);

const CONFIG_PY_PATH = path.join(__dirname, '..', 'sidecar', 'ai', 'config.py');
const CONFIG_PY_SOURCE = fs.readFileSync(CONFIG_PY_PATH, 'utf8');

/* Identifiers the sidecar uses as a `default=` instead of a numeric literal.
 * `max_chat_loop_iterations` defaults to whatever `max_loop_iterations` parsed
 * to, which is itself 8 - so the effective default the UI must show is 8. */
const SYMBOLIC_DEFAULTS = Object.freeze({ max_loop_iterations: 8 });

/* Bounds the schema INTENTIONALLY narrows relative to config.py. Each entry needs
 * a reason: the guard's whole value is that an unexplained divergence fails. */
const INTENTIONAL_BOUND_OVERRIDES = Object.freeze({
  token_budget_tool_overhead: Object.freeze({
    min: 1,
    reason: 'config.py parses min_value=0 but then applies `... or None`, so a stored '
      + '0 is indistinguishable from unset. Offering 0 in the UI would be a control '
      + 'whose value silently means "no override".',
  }),
});

/* Pull the bounds the sidecar actually parses for one raw_config key. Returns
 * null for keys parsed by a helper that carries no default (the optional
 * ratio/budget fields), which the caller asserts about separately. */
function parseSidecarBounds(rawKey) {
  const callRe = new RegExp(
    `_as_(?:optional_)?bounded_(?:int|float)\\(\\s*raw_config\\.get\\(\\s*"${rawKey}"\\s*\\)\\s*,([^)]*)\\)`,
    'm'
  );
  const match = CONFIG_PY_SOURCE.match(callRe);
  if (!match) return null;
  const body = match[1];
  const read = (name) => {
    const found = body.match(new RegExp(`${name}\\s*=\\s*([A-Za-z0-9_.]+)`));
    if (!found) return undefined;
    const token = found[1];
    if (Object.prototype.hasOwnProperty.call(SYMBOLIC_DEFAULTS, token)) {
      return SYMBOLIC_DEFAULTS[token];
    }
    const numeric = Number(token.replace(/_/g, ''));
    return Number.isFinite(numeric) ? numeric : undefined;
  };
  return { default: read('default'), min: read('min_value'), max: read('max_value') };
}

test('every schema field names a raw_config key the sidecar actually parses', () => {
  for (const field of ENGINE_TUNING_FIELDS) {
    assert.ok(field.rawKey, `${field.key} must declare a rawKey`);
    assert.ok(
      CONFIG_PY_SOURCE.includes(`raw_config.get("${field.rawKey}")`),
      `${field.key}: sidecar/ai/config.py never reads raw_config["${field.rawKey}"]`
    );
  }
});

/* THE drift guard. The schema is hand-written but its numbers are not opinions -
 * they mirror sidecar/ai/config.py. An exploration pass already got
 * tools_python_runtime_max_memory_mb wrong (claimed 1-8192, actually 64-4096),
 * which is exactly the failure this test exists to catch. */
test('schema bounds and defaults mirror sidecar/ai/config.py exactly', () => {
  const checked = [];
  for (const field of ENGINE_TUNING_FIELDS) {
    const sidecar = parseSidecarBounds(field.rawKey);
    if (!sidecar) continue;
    checked.push(field.key);
    const intentional = INTENTIONAL_BOUND_OVERRIDES[field.rawKey] || {};
    if (sidecar.min !== undefined) {
      const expectedMin = intentional.min !== undefined ? intentional.min : sidecar.min;
      assert.equal(field.min, expectedMin, `${field.key}: min drifted from config.py`);
    }
    if (sidecar.max !== undefined) {
      const expectedMax = intentional.max !== undefined ? intentional.max : sidecar.max;
      assert.equal(field.max, expectedMax, `${field.key}: max drifted from config.py`);
    }
    // The optional-ratio helpers carry no default, and the two `... or None`
    // int fields declare default=0 purely to mean "unset" - the schema models
    // both as `default: null`, so only compare where a real default exists.
    if (sidecar.default !== undefined && field.default !== null && sidecar.default !== 0) {
      assert.equal(
        field.default,
        sidecar.default,
        `${field.key}: default drifted from config.py`
      );
    }
  }
  // Guard the guard: if the regex stops matching, this test would silently
  // check nothing at all.
  assert.ok(
    checked.length >= 24,
    `expected to verify most fields against config.py, only matched ${checked.length}: ${checked.join(', ')}`
  );
});

test('every intentional bound override still diverges and still explains itself', () => {
  // Without this, an allowlist entry outlives the divergence it excused and
  // silently stops guarding the field it names.
  for (const [rawKey, override] of Object.entries(INTENTIONAL_BOUND_OVERRIDES)) {
    assert.ok(override.reason, `${rawKey}: an intentional override must state why`);
    const field = ENGINE_TUNING_FIELDS.find((candidate) => candidate.rawKey === rawKey);
    assert.ok(field, `${rawKey}: allowlisted but no schema field uses it`);
    const sidecar = parseSidecarBounds(rawKey);
    assert.ok(sidecar, `${rawKey}: allowlisted but config.py no longer parses it`);
    for (const bound of ['min', 'max']) {
      if (override[bound] === undefined) continue;
      assert.notEqual(
        override[bound],
        sidecar[bound],
        `${rawKey}: ${bound} override now matches config.py - delete the allowlist entry`
      );
    }
  }
});

test('cloud bounds are never narrower than their local twin', () => {
  const pairs = [
    ['maxChatLoopIterations', 'cloudMaxChatLoopIterations'],
    ['maxTaskLoopIterations', 'cloudMaxTaskLoopIterations'],
    ['maxToolsPerTurn', 'cloudMaxToolsPerTurn'],
    ['maxToolCallsPerSession', 'cloudMaxToolCallsPerSession'],
    ['maxWebToolCallsPerTurn', 'cloudMaxWebToolCallsPerTurn'],
    ['toolsExecutionTimeoutSeconds', 'cloudToolsExecutionTimeoutSeconds'],
  ];
  for (const [localKey, cloudKey] of pairs) {
    const local = getFieldDefinition(localKey);
    const cloud = getFieldDefinition(cloudKey);
    assert.ok(local && cloud, `${localKey}/${cloudKey} must both exist`);
    assert.equal(local.scope, SCOPE_LOCAL, `${localKey} belongs on the local pane`);
    assert.equal(cloud.scope, SCOPE_CLOUD, `${cloudKey} belongs on the cloud pane`);
    assert.ok(
      cloud.max >= local.max,
      `${cloudKey} max (${cloud.max}) must not be narrower than ${localKey} (${local.max})`
    );
  }
});

test('field keys are unique and every field carries renderable metadata', () => {
  assert.equal(new Set(ENGINE_TUNING_KEYS).size, ENGINE_TUNING_KEYS.length);
  const groupIds = new Set(ENGINE_TUNING_GROUPS.map((group) => group.id));
  for (const field of ENGINE_TUNING_FIELDS) {
    assert.ok(field.label, `${field.key} needs a label`);
    assert.ok(groupIds.has(field.group), `${field.key} references unknown group ${field.group}`);
    assert.ok(['local', 'cloud', 'shared'].includes(field.scope), `${field.key} scope`);
    assert.ok(['A', 'B', 'C'].includes(field.tier), `${field.key} tier`);
    assert.ok(Number.isFinite(field.min) && Number.isFinite(field.max), `${field.key} bounds`);
    assert.ok(field.min < field.max, `${field.key}: min must be below max`);
    if (field.default !== null) {
      assert.ok(
        field.default >= field.min && field.default <= field.max,
        `${field.key}: default ${field.default} sits outside its own bounds`
      );
    }
  }
});

test('normalizeEngineTuningValue drops rather than clamps, matching the sidecar', () => {
  // Out of range must NOT clamp to the bound: config.py's _as_bounded_int
  // returns `default` for an out-of-range value, so clamping here would make
  // the UI show a value the engine never received.
  assert.equal(normalizeEngineTuningValue('maxToolsPerTurn', 999), null);
  assert.equal(normalizeEngineTuningValue('maxToolsPerTurn', 0), null);
  assert.equal(normalizeEngineTuningValue('maxToolsPerTurn', 100), 100);
  assert.equal(normalizeEngineTuningValue('maxToolsPerTurn', 1), 1);
});

test('normalizeEngineTuningValue drops values equal to the default', () => {
  // The "Modified" badge and reset-enablement are defined as
  // hasOwnProperty(values, key), which only holds if defaults never persist.
  for (const field of ENGINE_TUNING_FIELDS) {
    if (field.default === null) continue;
    assert.equal(
      normalizeEngineTuningValue(field.key, field.default),
      null,
      `${field.key}: default value must never persist as an override`
    );
  }
});

test('normalizeEngineTuningValue rejects malformed and unknown input', () => {
  assert.equal(normalizeEngineTuningValue('nopeNotAField', 5), null);
  assert.equal(normalizeEngineTuningValue('maxToolsPerTurn', null), null);
  assert.equal(normalizeEngineTuningValue('maxToolsPerTurn', ''), null);
  assert.equal(normalizeEngineTuningValue('maxToolsPerTurn', 'abc'), null);
  assert.equal(normalizeEngineTuningValue('maxToolsPerTurn', NaN), null);
  assert.equal(normalizeEngineTuningValue('maxToolsPerTurn', Infinity), null);
  assert.equal(normalizeEngineTuningValue('maxToolsPerTurn', 7.5), null);
  // A float field accepts fractional input where an integer field would not.
  assert.equal(normalizeEngineTuningValue('tokenBudgetAutoCompactRatio', 0.85), 0.85);
});

test('isEngineTuningValueInRange separates invalid from merely-default', () => {
  // The service needs this distinction: writing the default is a legitimate
  // reset, while an out-of-bounds value is a rejection.
  assert.equal(isEngineTuningValueInRange('maxToolsPerTurn', 20), true);
  assert.equal(isEngineTuningValueInRange('maxToolsPerTurn', 999), false);
  assert.equal(isEngineTuningValueInRange('nopeNotAField', 5), false);
  assert.equal(isEngineTuningValueInRange('maxToolsPerTurn', 7.5), false);
});

test('every field carries plain-language help and valid quick picks', () => {
  for (const field of ENGINE_TUNING_FIELDS) {
    assert.ok(field.help.length >= 20, `${field.key} help is a real sentence`);
    assert.ok(Array.isArray(field.presets) && field.presets.length >= 2, `${field.key} has quick picks`);
    for (const preset of field.presets) {
      assert.ok(isEngineTuningValueInRange(field.key, preset.value), `${field.key} preset ${preset.value} in range`);
      assert.equal(typeof preset.label, 'string');
      assert.ok(preset.label.length > 0);
    }
    const values = field.presets.map((preset) => preset.value);
    assert.equal(new Set(values).size, values.length, `${field.key} presets are distinct`);
    assert.deepEqual(values, [...values].sort((a, b) => a - b), `${field.key} presets ascend`);
  }
  for (const group of ENGINE_TUNING_GROUPS) {
    assert.ok(group.help && group.help.length >= 20, `group ${group.id} explains itself`);
  }
});

test('every field persists through the one owned storage path', () => {
  // maxBudgetUsd used to be a bare top-level key with no setter anywhere. Folding
  // it into the owned block leaves exactly one write path, and the
  // managed-sidecar resolver's legacy-key fallback keeps old configs readable.
  for (const field of ENGINE_TUNING_FIELDS) {
    assert.equal(
      field.storage,
      'engineTuning',
      `${field.key}: a second storage path would reintroduce two sources of truth`
    );
  }
});

test('local turn working-time limit is schema-owned and user configurable', () => {
  const field = getFieldDefinition('maxLoopWallSeconds');

  assert.equal(field.rawKey, 'max_loop_wall_seconds');
  // 2026-08-30: local working-time default raised to 1800 seconds.
  assert.equal(field.default, 1_800);
  assert.equal(field.min, 30);
  assert.equal(field.max, 3_600);
  assert.deepEqual(field.presets.map((preset) => preset.value), [600, 1_800, 3_600]);
  assert.match(field.help, /approval.*does not count/i);
  assert.equal(
    ENGINE_TUNING_KEYS.some((key) => getFieldDefinition(key).rawKey === 'cloud_max_loop_wall_seconds'),
    false,
    'cloud timing remains an internal engine profile rather than a misleading local setting'
  );
});
