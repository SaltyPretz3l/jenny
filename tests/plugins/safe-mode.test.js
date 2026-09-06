'use strict';

// Safe mode is the recovery aid that makes the plugin control plane inert. The
// properties worth pinning are the ones a user reaches for while their app is
// broken: either source can turn it on, neither can cancel the other, and the
// refusal shape is identical everywhere.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SAFE_MODE_SWITCH,
  SAFE_MODE_ENV_VAR,
  parseSwitchValue,
  resolvePluginsSafeMode,
  safeModeRefusal,
} = require('../../services/plugins/safe-mode');
const { isFeatureEnabledByDefault } = require('../../services/feature-flags');
const { PLUGIN_ERROR_CODES } = require('../../services/backend/error-codes');

test('the bare switch and the =-form both activate safe mode', () => {
  assert.equal(resolvePluginsSafeMode({ argv: [SAFE_MODE_SWITCH] }).active, true);
  for (const value of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
    const resolved = resolvePluginsSafeMode({ argv: [`${SAFE_MODE_SWITCH}=${value.trim()}`] });
    assert.equal(resolved.active, true, `argv value ${value} should activate`);
    assert.equal(resolved.source, 'argv');
  }
  for (const value of ['0', 'false', 'no', 'off']) {
    assert.equal(resolvePluginsSafeMode({ argv: [`${SAFE_MODE_SWITCH}=${value}`] }).active, false);
  }
});

test('the env var uses feature-flags.js vocabulary exactly', () => {
  // The module duplicates the two regexes rather than requiring feature-flags.js
  // (an Electron-core module services/plugins may not import). This test is what
  // stops the duplicate from drifting: every token is compared against the
  // original parser's own answer.
  const tokens = ['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off', '', 'banana', 'TrUe', ' off '];
  for (const token of tokens) {
    const viaFeatureFlags = isFeatureEnabledByDefault(token, false);
    const viaSafeMode = resolvePluginsSafeMode({ env: { [SAFE_MODE_ENV_VAR]: token } }).active;
    assert.equal(viaSafeMode, viaFeatureFlags, `token ${JSON.stringify(token)} parsed differently`);
  }
});

test('parseSwitchValue is tri-state: on, off, or no opinion', () => {
  assert.equal(parseSwitchValue('yes'), true);
  assert.equal(parseSwitchValue('off'), false);
  assert.equal(parseSwitchValue('banana'), null);
  assert.equal(parseSwitchValue(''), null);
  assert.equal(parseSwitchValue(undefined), null);
});

test('either source turning safe mode on wins, over all four combinations', () => {
  const cases = [
    { argvOn: false, envOn: false, expectActive: false, expectSource: 'none' },
    { argvOn: true, envOn: false, expectActive: true, expectSource: 'argv' },
    { argvOn: false, envOn: true, expectActive: true, expectSource: 'env' },
    { argvOn: true, envOn: true, expectActive: true, expectSource: 'argv+env' },
  ];
  for (const item of cases) {
    const resolved = resolvePluginsSafeMode({
      argv: [`${SAFE_MODE_SWITCH}=${item.argvOn ? '1' : '0'}`],
      env: { [SAFE_MODE_ENV_VAR]: item.envOn ? '1' : '0' },
    });
    assert.equal(resolved.active, item.expectActive, `argv=${item.argvOn} env=${item.envOn}`);
    assert.equal(resolved.source, item.expectSource);
  }

  // The two asymmetric cases stated explicitly: an explicit OFF on one source
  // must NOT cancel an ON on the other. Safe mode resolves to safer.
  assert.equal(
    resolvePluginsSafeMode({ argv: [`${SAFE_MODE_SWITCH}=0`], env: { [SAFE_MODE_ENV_VAR]: 'on' } }).active,
    true,
    'argv-off must not cancel env-on'
  );
  assert.equal(
    resolvePluginsSafeMode({ argv: [SAFE_MODE_SWITCH], env: { [SAFE_MODE_ENV_VAR]: 'off' } }).active,
    true,
    'env-off must not cancel argv-on'
  );
});

test('safe mode is independent of JENNY_ENABLE_PLUGINS in both directions', () => {
  // Swept over every value the feature flag can take: the resolved result must
  // be byte-identical, so the flag can neither activate nor suppress safe mode.
  for (const flagValue of ['1', 'true', '0', 'false', '', 'banana']) {
    const off = resolvePluginsSafeMode({ env: { JENNY_ENABLE_PLUGINS: flagValue } });
    assert.deepEqual(off, resolvePluginsSafeMode({ env: {} }), `flag ${flagValue} changed the inactive result`);
    const on = resolvePluginsSafeMode({
      env: { JENNY_ENABLE_PLUGINS: flagValue, [SAFE_MODE_ENV_VAR]: '1' },
    });
    assert.deepEqual(
      on,
      resolvePluginsSafeMode({ env: { [SAFE_MODE_ENV_VAR]: '1' } }),
      `flag ${flagValue} changed the active result`
    );
    assert.equal(on.active, true);
  }
});

test('defaults, malformed input, and non-array argv all resolve to inactive', () => {
  assert.equal(resolvePluginsSafeMode().active, false);
  assert.equal(resolvePluginsSafeMode({}).active, false);
  assert.equal(resolvePluginsSafeMode({ argv: null, env: null }).active, false);
  assert.equal(resolvePluginsSafeMode({ argv: ['--unrelated', ''] }).active, false);
  assert.equal(resolvePluginsSafeMode({ argv: [`${SAFE_MODE_SWITCH}=banana`] }).active, false);
});

test('a later argv occurrence overrides an earlier one within argv', () => {
  assert.equal(resolvePluginsSafeMode({ argv: [`${SAFE_MODE_SWITCH}=1`, `${SAFE_MODE_SWITCH}=0`] }).active, false);
  assert.equal(resolvePluginsSafeMode({ argv: [`${SAFE_MODE_SWITCH}=0`, SAFE_MODE_SWITCH] }).active, true);
});

test('safeModeRefusal carries the imported SAFE_MODE_ACTIVE code and no contract result', () => {
  const resolved = resolvePluginsSafeMode({ argv: [SAFE_MODE_SWITCH] });
  const refusal = safeModeRefusal(resolved);
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, 'safe_mode_active');
  assert.equal(refusal.wireCode, PLUGIN_ERROR_CODES.SAFE_MODE_ACTIVE);
  assert.equal(refusal.retryable, false);
  assert.equal(refusal.source, 'argv');
  // No PluginOperationResultV1: emitting one would require an authority state
  // this refusal deliberately never read.
  assert.equal(refusal.result, null);
  assert.equal(typeof refusal.recoveryGuidance, 'string');
  assert.ok(refusal.recoveryGuidance.length <= 200);
});

test('the resolved reason is bounded printable ASCII', () => {
  for (const argv of [[], [SAFE_MODE_SWITCH]]) {
    const { reason } = resolvePluginsSafeMode({ argv });
    assert.ok(/^[\x20-\x7E]{1,200}$/.test(reason), `reason not bounded printable ASCII: ${reason}`);
  }
});
