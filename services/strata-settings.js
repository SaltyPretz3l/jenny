'use strict';

// The managed Strata runtime's saved settings (row 200), one rule for the shell
// config (services/shell-config-engines.js), the engine config builder
// (services/strata-config.js) and the manager. No dependencies: the shell config
// loads it at startup.
//
// Launch settings are the owner's choice (plan D5 revisit, D6 picks): slots and
// KV format pick the window from the measured fit; `context: null` means the
// largest that fits; drafting starts off; vision starts on.

const STRATA_SLOTS = Object.freeze([1, 2, 4]);
const STRATA_KV_FORMATS = Object.freeze(['auto', 'k8v8', 'k8v4']);
const STRATA_DRAFTING = Object.freeze(['off', 'dspark']);
const MIN_CONTEXT = 1024;
const MAX_CONTEXT = 1048576;
const LEARNED_FIT_KEY = /^[124]:(auto|k8v8|k8v4)$/;

const DEFAULT_STRATA_SETTINGS = Object.freeze({ slots: 4, kv: 'k8v8', context: null, vision: true, drafting: 'off' });
const DEFAULT_STRATA_WATCHDOG = Object.freeze({ enabled: false, maxWatts: 460, maxTempC: 83 });

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStrataSettings(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const d = DEFAULT_STRATA_SETTINGS;
  const contextOk = Number.isInteger(source.context) && source.context >= MIN_CONTEXT && source.context <= MAX_CONTEXT;
  return {
    slots: STRATA_SLOTS.includes(source.slots) ? source.slots : d.slots,
    kv: STRATA_KV_FORMATS.includes(source.kv) ? source.kv : d.kv,
    context: contextOk ? source.context : d.context,
    vision: typeof source.vision === 'boolean' ? source.vision : d.vision,
    drafting: STRATA_DRAFTING.includes(source.drafting) ? source.drafting : d.drafting,
  };
}

// Windows the engine reported at pairings with no measured fit; bounded to the
// nine pairings, each an integer window.
function normalizeLearnedFits(raw) {
  const fits = {};
  if (!isPlainObject(raw)) return fits;
  for (const [key, value] of Object.entries(raw)) {
    if (LEARNED_FIT_KEY.test(key) && Number.isInteger(value) && value >= MIN_CONTEXT && value <= MAX_CONTEXT) fits[key] = value;
  }
  return fits;
}

// The whole saved block: launch settings, the boot target, learned windows and
// the opt-in watchdog. Total over older configs (no CONFIG_VERSION bump).
function normalizeStrataBlock(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const watchdog = isPlainObject(source.watchdog) ? source.watchdog : {};
  const bounded = (value, min, max, fallback) => (Number.isInteger(value) && value >= min && value <= max ? value : fallback);
  return {
    ...normalizeStrataSettings(source),
    lastUsed: source.lastUsed === true,
    learnedFits: normalizeLearnedFits(source.learnedFits),
    watchdog: {
      enabled: watchdog.enabled === true,
      maxWatts: bounded(watchdog.maxWatts, 100, 1000, DEFAULT_STRATA_WATCHDOG.maxWatts),
      maxTempC: bounded(watchdog.maxTempC, 40, 110, DEFAULT_STRATA_WATCHDOG.maxTempC),
    },
  };
}

module.exports = {
  DEFAULT_STRATA_SETTINGS,
  DEFAULT_STRATA_WATCHDOG,
  MAX_CONTEXT,
  MIN_CONTEXT,
  STRATA_DRAFTING,
  STRATA_KV_FORMATS,
  STRATA_SLOTS,
  normalizeLearnedFits,
  normalizeStrataBlock,
  normalizeStrataSettings,
};
