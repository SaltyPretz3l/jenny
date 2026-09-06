'use strict';

// Plugins safe mode: the launch-level switch that forces the plugin control
// plane inert (PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md's Stage-3 gate table
// names "safe mode" as part of the disabled-only control plane's exit proof).
//
// This module is a PURE resolver. It takes argv and env as parameters and
// touches no filesystem, no `process`, no clock, so it can be evaluated at the
// very top of a lifecycle operation before anything durable is read or written
// -- which is the whole point: safe mode must cost nothing and touch nothing.
//
// Safe mode is INDEPENDENT of `JENNY_ENABLE_PLUGINS`. This module deliberately
// never reads that flag. The feature flag answers "is the plugin control plane
// composed at all"; safe mode answers "even if it is, refuse every mutation".
// A user recovering from a bad plugin state reaches for safe mode precisely
// because they cannot be sure what the stored state or the flag says, so
// coupling the two would defeat it (services/feature-flags.js says the same
// thing from the other side: "Independent of the launch-level plugins-safe-mode
// switch, which bypasses activation regardless of this flag").
//
// EITHER SOURCE TURNING IT ON WINS. argv-off does not cancel env-on and env-off
// does not cancel argv-on. Safe mode is a recovery aid, so the ambiguous case
// resolves to *safer* rather than to a precedence rule that a user would have
// to remember while their app is broken. `source` reports which source(s)
// actually triggered it, so the refusal can say why.
//
// Parsing vocabulary is borrowed verbatim, not reinvented: the `=`-form and the
// env var use `isFeatureEnabledByDefault`'s truthy/falsey regexes
// (services/feature-flags.js), and the argv shapes match the house idiom in
// services/main/packaged-smoke.js (`--flag=value`, trimmed, one pass over argv).
// NOTE: this module does not `require` either of those files -- feature-flags.js
// is Electron-core and services/main/ is an activation surface, both forbidden
// to services/plugins/ by check_plugin_stage_boundary.py. The vocabulary is
// duplicated as two regexes and pinned by a test that asserts agreement.

const { PLUGIN_ERROR_CODES } = require('../backend/error-codes');

const SAFE_MODE_SWITCH = '--plugins-safe-mode';
const SAFE_MODE_ENV_VAR = 'JENNY_PLUGINS_SAFE_MODE';

// Exactly isFeatureEnabledByDefault's vocabulary (services/feature-flags.js).
const TRUTHY = /^(1|true|yes|on)$/;
const FALSEY = /^(0|false|no|off)$/;

// Tri-state parse of a `=`-form / env value: true, false, or null for "not a
// recognized token". Null means "no opinion", which resolves to the default
// (off) -- same as isFeatureEnabledByDefault returning its defaultValue for an
// unrecognized string, rather than guessing a direction.
function parseSwitchValue(rawValue) {
  const normalized = String(rawValue === undefined || rawValue === null ? '' : rawValue).trim().toLowerCase();
  if (!normalized) return null;
  if (TRUTHY.test(normalized)) return true;
  if (FALSEY.test(normalized)) return false;
  return null;
}

// One pass over argv in the packaged-smoke.js idiom. A LATER argv occurrence
// overrides an earlier one within argv itself (ordinary CLI expectation); the
// argv-vs-env "either wins" rule is applied afterwards, in the resolver.
function resolveArgvOpinion(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let opinion = null;
  for (const rawArg of args) {
    const arg = String(rawArg || '').trim();
    if (!arg) continue;
    if (arg === SAFE_MODE_SWITCH) {
      // The bare switch is an explicit ON. It carries no value to parse, so it
      // is never subject to the unrecognized-token fallback.
      opinion = true;
      continue;
    }
    if (arg.startsWith(`${SAFE_MODE_SWITCH}=`)) {
      const parsed = parseSwitchValue(arg.slice(SAFE_MODE_SWITCH.length + 1));
      if (parsed !== null) opinion = parsed;
    }
  }
  return opinion;
}

function resolveEnvOpinion(env) {
  const source = env && typeof env === 'object' ? env : {};
  return parseSwitchValue(source[SAFE_MODE_ENV_VAR]);
}

// `source` vocabulary: 'none' | 'argv' | 'env' | 'argv+env'. It names every
// source that voted ON, so a refusal can tell the user which one to undo.
function describeSource(argvOn, envOn) {
  if (argvOn && envOn) return 'argv+env';
  if (argvOn) return 'argv';
  if (envOn) return 'env';
  return 'none';
}

// Returns { active, source, reason }. `reason` is bounded printable ASCII with
// no path or secret shape, so it can cross the same redaction gate as
// operation-result.js's recovery guidance.
function resolvePluginsSafeMode({ argv = [], env = {} } = {}) {
  const argvOpinion = resolveArgvOpinion(argv);
  const envOpinion = resolveEnvOpinion(env);
  const argvOn = argvOpinion === true;
  const envOn = envOpinion === true;
  const active = argvOn || envOn;
  const source = describeSource(argvOn, envOn);
  return {
    active,
    source,
    reason: active
      ? `plugins safe mode is active via ${source}; the control plane refuses every mutation`
      : 'plugins safe mode is not active',
  };
}

// The one refusal shape every call site returns, so "safe mode refused" looks
// identical whether it came from install, uninstall, or a desired-state record.
//
// Deliberately NOT a PluginOperationResultV1 value: that contract requires
// `authority_state_before`, which cannot be known without reading the store,
// and reading the store is exactly what safe mode must not do. Emitting a
// fabricated 'absent' before-state to satisfy the schema would be a lie about
// durable state; refusing with a bounded envelope and `result: null` is honest.
function safeModeRefusal(resolved) {
  const detail = resolved && typeof resolved === 'object' ? resolved : null;
  return {
    ok: false,
    stage: 'safe_mode',
    reason: 'safe_mode_active',
    wireCode: PLUGIN_ERROR_CODES.SAFE_MODE_ACTIVE,
    retryable: false,
    result: null,
    source: detail ? detail.source : 'unknown',
    recoveryGuidance: 'restart without plugins safe mode to change plugin state',
  };
}

module.exports = {
  SAFE_MODE_SWITCH,
  SAFE_MODE_ENV_VAR,
  parseSwitchValue,
  resolvePluginsSafeMode,
  safeModeRefusal,
};
