'use strict';
// Pure normalization for Workspace IDE Test Runner configurations. A test
// configuration is a named command the user can run from the IDE; the store is
// user-authored (userData, per workspace root) so this module only shapes/guards
// it — never executes anything.

const CONFIG_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const MAX_CONFIG_ID_LENGTH = 80;
const MAX_LABEL_LENGTH = 160;
const MAX_COMMAND_LENGTH = 8192;
const MAX_CWD_LENGTH = 1024;
const MAX_ENV_ENTRIES = 64;
const MAX_ENV_KEY_LENGTH = 128;
const MAX_ENV_VALUE_LENGTH = 4096;
const MAX_SUMMARY_REGEX_LENGTH = 200;
const MAX_TEST_TIMEOUT_MS = 24 * 60 * 60 * 1000;
// Verification gate: at most ONE configuration in a workspace may be the gate the
// turn-finalization hook runs, and that is enforced here rather than in the UI --
// normalize is the only path into the store, so a hand-edited file or a racing
// save can never produce two gates. `gateOnFailure` is meaningless without
// `gate`, so it is only kept on the designated row.
const GATE_ON_FAILURE_MODES = Object.freeze(['retry', 'report']);
const DEFAULT_GATE_ON_FAILURE = 'retry';

function hasNullByte(value) {
  return String(value || '').includes('\0');
}

function truncate(value, limit) {
  const text = String(value || '');
  return text.length > limit ? text.slice(0, limit) : text;
}

function normalizeEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return {};
  }
  const out = {};
  for (const rawKey of Object.keys(env)) {
    if (Object.keys(out).length >= MAX_ENV_ENTRIES) {
      break;
    }
    const key = String(rawKey || '').trim();
    const value = env[rawKey];
    if (!key || key.length > MAX_ENV_KEY_LENGTH || key.includes('=') || hasNullByte(key)) {
      continue;
    }
    if (typeof value !== 'string' || value.length > MAX_ENV_VALUE_LENGTH || hasNullByte(value)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function normalizeTimeout(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = Number(value);
  return Number.isInteger(ms) && ms > 0 ? Math.min(ms, MAX_TEST_TIMEOUT_MS) : null;
}

function normalizeGateOnFailure(value) {
  const mode = String(value || '').trim().toLowerCase();
  return GATE_ON_FAILURE_MODES.includes(mode) ? mode : DEFAULT_GATE_ON_FAILURE;
}

/** The single configuration designated as the verification gate, or null. */
function findGateConfig(configs) {
  if (!Array.isArray(configs)) {
    return null;
  }
  return configs.find((config) => config && config.gate === true) || null;
}

// Why an entry was dropped by normalization. Surfaced so the authoring UI can
// say "that id is not allowed" or "you already have a `unit`" instead of
// reporting success for a configuration that silently never appears.
// `over_cap` is produced by the service, which owns MAX_CONFIGS.
const REJECT_REASONS = Object.freeze({
  MALFORMED: 'malformed',
  INVALID_ID: 'invalid_id',
  DUPLICATE_ID: 'duplicate_id',
  INVALID_COMMAND: 'invalid_command',
  INVALID_CWD: 'invalid_cwd',
  OVER_CAP: 'over_cap',
});
const MAX_REJECTED_ID_LENGTH = 120;

/**
 * Normalize a raw configs array into validated
 * { id, label, command, cwd, env, timeoutMs, summaryRegex, gate, gateOnFailure }
 * records, and report every entry that was dropped and why.
 * Malformed/absent input -> no configs; unknown fields ignored; idempotent;
 * first occurrence wins on duplicate ids.
 */
function normalizeConfigsDetailed(raw) {
  if (!Array.isArray(raw)) {
    return { configs: [], rejected: [] };
  }
  const seen = new Set();
  const out = [];
  const rejected = [];
  let gateClaimed = false;
  const reject = (entry, reason) => {
    const id = entry && typeof entry === 'object' && !Array.isArray(entry) ? String(entry.id || '') : '';
    rejected.push({ id: id.trim().slice(0, MAX_REJECTED_ID_LENGTH), reason });
  };
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      reject(entry, REJECT_REASONS.MALFORMED);
      continue;
    }
    const id = String(entry.id || '').trim();
    if (!CONFIG_ID_PATTERN.test(id) || id.length > MAX_CONFIG_ID_LENGTH) {
      reject(entry, REJECT_REASONS.INVALID_ID);
      continue;
    }
    if (seen.has(id)) {
      reject(entry, REJECT_REASONS.DUPLICATE_ID);
      continue;
    }
    const command = String(entry.command || '').trim();
    if (!command || command.length > MAX_COMMAND_LENGTH || hasNullByte(command)) {
      reject(entry, REJECT_REASONS.INVALID_COMMAND);
      continue;
    }
    const cwd = typeof entry.cwd === 'string' ? entry.cwd.trim() : '';
    if (cwd.length > MAX_CWD_LENGTH || hasNullByte(cwd)) {
      reject(entry, REJECT_REASONS.INVALID_CWD);
      continue;
    }
    const summaryRegex = typeof entry.summaryRegex === 'string'
      && entry.summaryRegex.length <= MAX_SUMMARY_REGEX_LENGTH
      && !hasNullByte(entry.summaryRegex)
      ? entry.summaryRegex
      : '';
    // Only the FIRST valid gate row wins; later ones normalize to plain configs.
    const gate = entry.gate === true && !gateClaimed;
    if (gate) {
      gateClaimed = true;
    }
    seen.add(id);
    out.push({
      id,
      label: truncate(String(entry.label || '').trim() || id, MAX_LABEL_LENGTH),
      command,
      cwd,
      env: normalizeEnv(entry.env),
      timeoutMs: normalizeTimeout(entry.timeoutMs),
      // Optional, user-authored stdout-tail parse pattern (S17). Kept verbatim as
      // a string (no trim — leading/trailing matters in a regex); non-string -> ''.
      summaryRegex,
      gate,
      // Persisted only on the gate row, so a config that later loses the
      // designation cannot carry a stale mode back when it regains it.
      gateOnFailure: gate ? normalizeGateOnFailure(entry.gateOnFailure) : '',
    });
  }
  return { configs: out, rejected };
}

/** The normalized records only (see normalizeConfigsDetailed for the drops). */
function normalizeConfigs(raw) {
  return normalizeConfigsDetailed(raw).configs;
}

/** Find a normalized config by id, or null. */
function findConfig(configs, id) {
  if (!Array.isArray(configs)) {
    return null;
  }
  const target = String(id || '').trim();
  if (!target) {
    return null;
  }
  return configs.find((config) => config && config.id === target) || null;
}

module.exports = {
  MAX_CONFIG_ID_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_COMMAND_LENGTH,
  MAX_CWD_LENGTH,
  MAX_ENV_ENTRIES,
  MAX_ENV_KEY_LENGTH,
  MAX_ENV_VALUE_LENGTH,
  MAX_SUMMARY_REGEX_LENGTH,
  MAX_TEST_TIMEOUT_MS,
  GATE_ON_FAILURE_MODES,
  DEFAULT_GATE_ON_FAILURE,
  REJECT_REASONS,
  normalizeConfigs,
  normalizeConfigsDetailed,
  normalizeGateOnFailure,
  findConfig,
  findGateConfig,
};
