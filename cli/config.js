'use strict';

// `jenny config list|get|set` (Jenny CLI plan, decision 7). The file is
// <profile>/cli.json, the one layer a caller can write; every value is
// validated exactly as its flag would be, and `--show-origin` says which
// layer (flag, env, file, default) the resolved value came from. Secrets
// never live here: the keys are the non-secret run settings only.

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { DEFAULT_TIMEOUT_SECONDS, PROFILE_CONFIG_KEYS, resolveSettings } = require('./arguments');
const { emit, fail } = require('./command-output');

const CONFIG_FILE = 'cli.json';
const LIST_KEYS = new Set(['allowed_tools', 'disallowed_tools']);

// The resolved value of each key, as `config list` and `config get` print it.
function resolvedEntries(settings) {
  const timeoutSeconds = settings.budgets.timeout_ms / 1000;
  const values = {
    model: settings.model,
    engine: settings.engine,
    output_format: settings.outputFormat,
    permission_mode: settings.permissionMode,
    allowed_tools: [...settings.allowedTools],
    disallowed_tools: [...settings.disallowedTools],
    timeout_seconds: timeoutSeconds,
    profile: settings.profilePath,
    cwd: settings.workspaceRoot,
  };
  return Object.keys(values).map((key) => ({ key, value: values[key], origin: settings.origins[key], settable: PROFILE_CONFIG_KEYS.includes(key) }));
}

function formatValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(',') : '(none)';
  if (value === '' || value === null || value === undefined) return '(unset)';
  return String(value);
}

function formatEntry(entry, showOrigin) {
  return `${entry.key} = ${formatValue(entry.value)}${showOrigin ? `  [${entry.origin}]` : ''}`;
}

// A `set` value in the file's own shape: lists split on commas, the timeout
// is a number, everything else is the string as typed; empty removes the key.
function fileValue(key, raw) {
  const text = String(raw ?? '').trim();
  if (!text) return undefined;
  if (LIST_KEYS.has(key)) return text.split(/[,\s]+/u).map((entry) => entry.trim()).filter(Boolean);
  if (key === 'timeout_seconds') return Number(text);
  return text;
}

function writeConfigAtomically(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.cli-${randomBytes(8).toString('hex')}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch (_cleanup) { /* best effort */ }
    throw error;
  }
}

function runConfig({ verb, args, flags, env, settings, profileConfig, json, stdout, stderr }) {
  const io = { json, stdout, stderr };
  const file = path.join(settings.profilePath, CONFIG_FILE);
  if (verb === 'list') {
    if (args.length) return fail(io, { message: 'jenny config list takes no further arguments.' });
    const entries = resolvedEntries(settings);
    return emit(io, { v: 1, kind: 'config', profile: settings.profilePath, file, entries },
      entries.map((entry) => formatEntry(entry, flags.showOrigin)));
  }
  if (verb === 'get') {
    if (args.length !== 1) return fail(io, { message: 'jenny config get needs exactly one key.' });
    const entry = resolvedEntries(settings).find((candidate) => candidate.key === args[0]);
    if (!entry) return fail(io, { message: `Unknown config key "${String(args[0]).slice(0, 40)}". Keys: ${resolvedEntries(settings).map((e) => e.key).join(', ')}.` });
    return emit(io, { v: 1, kind: 'config_value', key: entry.key, value: entry.value, origin: entry.origin }, [formatValue(entry.value)]);
  }
  if (verb === 'set') {
    if (args.length < 1 || args.length > 2) return fail(io, { message: 'jenny config set needs a key and a value (an empty value removes the key).' });
    const key = String(args[0]);
    if (!PROFILE_CONFIG_KEYS.includes(key)) {
      return fail(io, { message: `"${key.slice(0, 40)}" cannot be set in ${CONFIG_FILE}. Keys: ${PROFILE_CONFIG_KEYS.join(', ')}.` });
    }
    const value = fileValue(key, args[1]);
    const next = { ...profileConfig };
    if (value === undefined) delete next[key];
    else next[key] = value;
    // The same validation every run applies to the file layer, before anything is written.
    try {
      resolveSettings({ flags: {}, env: {}, profileConfig: next });
    } catch (error) {
      return fail(io, { message: error?.message || 'Invalid value.' });
    }
    try {
      writeConfigAtomically(file, next);
    } catch (error) {
      return fail(io, { message: `${file} could not be written (${error?.code || 'error'}).`, exitCode: 1 });
    }
    return emit(io, { v: 1, kind: 'config_set', key, value: value === undefined ? null : value, file },
      [`${key} = ${formatValue(value)} (${value === undefined ? 'removed from' : 'written to'} ${file})`]);
  }
  return fail(io, { message: 'jenny config needs one of: list, get, set.' });
}

module.exports = { CONFIG_FILE, DEFAULT_TIMEOUT_SECONDS, resolvedEntries, runConfig };
