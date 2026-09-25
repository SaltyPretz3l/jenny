'use strict';

// Per-model llama-server builds: the trust boundary between the renderer's
// engine-settings patch and the executable the main process spawns. A path
// becomes launchable only after a main-owned file dialog picked it and a probe
// read a real build number from it (the pick registry). The renderer can echo,
// clear or omit a saved runtime, never introduce one.

const fs = require('fs');
const path = require('path');

const { MAX_RUNTIME_BUILD, isLlamaServerRuntimePath, managedModelKey } = require('../shell-config-engines');
const { peekCapabilities, probeCapabilitiesAsync } = require('../backend/llama-server-capabilities');

const MAX_RUNTIME_PICKS = 8;
const MAX_LOGGED_KEYS = 64;
const MANAGED_KEY_PATTERN = /^[a-z0-9-]{1,128}$/;
// A llama.cpp build tag inside a folder name: "b10683" in "llama-prism-b10683-cuda13.3".
const BUILD_TAG = /(?:^|[^a-z0-9])(b\d{3,9})(?![0-9])/i;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// A build number the saved shape can hold; anything else is no build at all.
function positiveBuild(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_RUNTIME_BUILD ? value : 0;
}

// Paths the user picked this session, keyed by the exact string the dialog
// returned (the renderer echoes it back verbatim). Oldest evicted first.
function createRuntimePickRegistry({ max = MAX_RUNTIME_PICKS } = {}) {
  const picks = new Map();
  return {
    record(runtimePath, { build = 0, supportsMtp = false } = {}) {
      picks.delete(runtimePath);
      picks.set(runtimePath, { path: runtimePath, build: positiveBuild(build), supportsMtp: supportsMtp === true });
      while (picks.size > max) {
        picks.delete(picks.keys().next().value);
      }
    },
    has: (runtimePath) => picks.has(runtimePath),
    get: (runtimePath) => (picks.has(runtimePath) ? { ...picks.get(runtimePath) } : null),
    consume: (runtimePath) => { picks.delete(runtimePath); },
    size: () => picks.size,
  };
}

// Name and shape first (a bad name is never touched on disk, let alone run),
// then a regular file, then a probe that must report a real build: `ok` alone
// only proves `--help` exited 0, which any stand-in executable can do.
async function validateRuntimeExecutable(runtimePath, {
  fsImpl = fs,
  probeImpl = probeCapabilitiesAsync,
  platform = process.platform,
} = {}) {
  if (!isLlamaServerRuntimePath(runtimePath, { platform })) {
    return { ok: false, reason: 'not_llama_server' };
  }
  let stat;
  try {
    stat = fsImpl.statSync(runtimePath);
  } catch (_error) {
    return { ok: false, reason: 'runtime_missing' };
  }
  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) {
    return { ok: false, reason: 'not_llama_server' };
  }
  let probe = null;
  try {
    probe = await probeImpl({ binaryPath: runtimePath, retryFailed: true, fsImpl });
  } catch (_error) { /* a throwing probe fails closed below */ }
  const build = probe && probe.ok === true ? positiveBuild(probe.build) : 0;
  if (!build) {
    return { ok: false, reason: 'runtime_probe_failed' };
  }
  return { ok: true, build, supportsMtp: probe.supportsMtp === true };
}

// Rewrites the runtime fields of an untrusted `managed` patch against the saved
// settings and this session's picks. Per perModel entry:
//   field absent            -> keep the saved runtime (the drawer rebuilds entries whole)
//   ''                      -> clear it
//   equal to the saved path -> keep it, with the saved build
//   picked, valid, unused   -> accept it, with the pick's build
//   anything else           -> keep the saved runtime and report the key
// A renderer-sent runtimeBuild is always dropped. Keys are canonicalized, the
// last sorted raw key winning per canonical key exactly as the normalizer merges.
function reconcileManagedRuntimePaths(patch, { persisted = null, picks = null, platform = process.platform } = {}) {
  const result = { patch: {}, acceptedPaths: [], acceptedKeys: [], rejectedKeys: [] };
  if (!isPlainObject(patch)) {
    return result;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (key !== 'perModel' && key !== '__proto__') {
      result.patch[key] = value;
    }
  }
  const rawPerModel = hasOwn(patch, 'perModel') ? patch.perModel : undefined;
  if (!isPlainObject(rawPerModel)) {
    return result;
  }
  const savedPerModel = isPlainObject(persisted?.perModel) ? persisted.perModel : {};
  const byKey = new Map();
  for (const rawKey of Object.keys(rawPerModel).sort()) {
    const key = rawKey === '__proto__' ? '' : managedModelKey(rawKey);
    if (MANAGED_KEY_PATTERN.test(key)) {
      byKey.set(key, rawPerModel[rawKey]);
    }
  }
  const usedPaths = new Set();
  const entries = [];
  for (const key of [...byKey.keys()].sort()) {
    const value = byKey.get(key);
    if (value === null) {
      entries.push([key, null]);
      continue;
    }
    const raw = isPlainObject(value) ? value : {};
    const entry = Object.fromEntries(Object.entries(raw).filter(
      ([field]) => field !== '__proto__' && field !== 'runtimePath' && field !== 'runtimeBuild'
    ));
    const saved = hasOwn(savedPerModel, key) && isPlainObject(savedPerModel[key]) ? savedPerModel[key] : null;
    const savedPath = typeof saved?.runtimePath === 'string' ? saved.runtimePath : '';
    const keepSaved = () => {
      if (!savedPath) return;
      entry.runtimePath = savedPath;
      const savedBuild = positiveBuild(saved.runtimeBuild);
      if (savedBuild) entry.runtimeBuild = savedBuild;
    };
    const requested = hasOwn(raw, 'runtimePath') ? raw.runtimePath : undefined;
    if (requested === undefined) {
      keepSaved();
    } else if (requested === '') {
      // Cleared: the replacing entry carries no runtime fields.
    } else if (typeof requested === 'string'
      && isLlamaServerRuntimePath(requested, { platform })
      && picks?.has?.(requested) === true
      && !usedPaths.has(requested)) {
      // A fresh pick, including the saved build picked again after new files
      // were copied over it: the probe's build replaces the saved number.
      const build = positiveBuild(picks.get(requested)?.build);
      entry.runtimePath = requested;
      if (build) entry.runtimeBuild = build;
      usedPaths.add(requested);
      result.acceptedPaths.push(requested);
      result.acceptedKeys.push(key);
    } else if (typeof requested === 'string' && savedPath && requested === savedPath) {
      keepSaved();
    } else {
      keepSaved();
      result.rejectedKeys.push(key);
    }
    entries.push([key, entry]);
  }
  result.patch.perModel = Object.fromEntries(entries);
  return result;
}

// The single write path for a renderer `managed` patch. A pick is consumed only
// once its runtime is actually saved: a write can throw, or succeed without
// landing (a newer config version blocks it; the per-model cap drops a new
// key), and either way the user can Apply again with the same pick. The saved
// build is compared too: a re-pick of the saved path changes only the number.
// Logs carry canonical model keys, never paths.
function writeManagedPatch({
  shellConfigService,
  patch,
  picks = null,
  log = () => {},
  platform = process.platform,
} = {}) {
  const persisted = shellConfigService?.getLocalEngines?.()?.openaiCompatible?.managed || null;
  const reconciled = reconcileManagedRuntimePaths(patch, { persisted, picks, platform });
  if (reconciled.rejectedKeys.length) {
    log('WARN', 'engines.managed_runtime_rejected', { keys: reconciled.rejectedKeys.slice(0, MAX_LOGGED_KEYS) });
  }
  const state = shellConfigService?.updateManagedLlamaServer?.(reconciled.patch);
  const savedPerModel = shellConfigService?.getLocalEngines?.()?.openaiCompatible?.managed?.perModel;
  const landedKeys = reconciled.acceptedKeys.filter((key, index) => {
    const saved = isPlainObject(savedPerModel) && hasOwn(savedPerModel, key) ? savedPerModel[key] : null;
    const sent = reconciled.patch.perModel[key];
    if (saved?.runtimePath !== reconciled.acceptedPaths[index]
      || positiveBuild(saved?.runtimeBuild) !== positiveBuild(sent?.runtimeBuild)) {
      return false;
    }
    picks?.consume?.(reconciled.acceptedPaths[index]);
    return true;
  });
  if (landedKeys.length) {
    log('INFO', 'engines.managed_runtime_accepted', { keys: landedKeys.slice(0, MAX_LOGGED_KEYS) });
  }
  return state;
}

// What lastError and Diagnostics may say about a runtime's folder: the build
// tag in its name ("b10683"), else 'runtime'. Never the folder text itself,
// which can carry a user's or a project's name.
function runtimeFolderToken(runtimePath, { platform = process.platform } = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const folder = pathApi.basename(pathApi.dirname(String(runtimePath || '')));
  const tag = BUILD_TAG.exec(folder);
  return tag ? tag[1].toLowerCase() : 'runtime';
}

// Launch precedence: the env override (a developer escape hatch that shadows a
// saved runtime), then the model's saved runtime, then the bundled build. A
// saved runtime that is gone fails the launch; it never falls back to bundled.
function resolveLaunchRuntime({
  binaryOverride = '',
  runtimePath = '',
  resolveBundledPath = () => '',
  fsImpl = fs,
  platform = process.platform,
} = {}) {
  const override = typeof binaryOverride === 'string' ? binaryOverride.trim() : '';
  const saved = typeof runtimePath === 'string' ? runtimePath : '';
  if (override) {
    return { binaryPath: override, source: 'env', shadowed: Boolean(saved), error: '' };
  }
  if (saved) {
    let isFile = false;
    // Shape first, as in validateRuntimeExecutable: whatever a caller passes,
    // a network path is never stat'd.
    if (isLlamaServerRuntimePath(saved, { platform })) {
      try {
        isFile = fsImpl.statSync(saved).isFile();
      } catch (_error) { /* missing: fails the launch below */ }
    }
    return isFile
      ? { binaryPath: saved, source: 'saved', shadowed: false, error: '' }
      : {
        binaryPath: '',
        source: 'saved',
        shadowed: false,
        error: `llama_server_runtime_missing:${runtimeFolderToken(saved, { platform })}`,
      };
  }
  let bundled = '';
  try {
    bundled = String(resolveBundledPath() || '');
  } catch (_error) { /* no bundled build: the lifecycle reports it */ }
  return { binaryPath: bundled, source: 'bundled', shadowed: false, error: '' };
}

// Status token for the running build: 'bundled', 'env', 'build <N>' or
// 'custom' (a saved runtime whose build is unknown); '' when nothing launched.
// Reads the probe cache (filled by the picker or the launch-time probe) and
// falls back to the build recorded at pick time; it never spawns.
function describeRuntimeLabel(runtime, { runtimeBuild = 0, peekImpl = peekCapabilities, fsImpl = fs } = {}) {
  if (!isPlainObject(runtime) || runtime.error || !runtime.binaryPath) {
    return '';
  }
  if (runtime.source === 'env' || runtime.source === 'bundled') {
    return runtime.source;
  }
  let peeked = null;
  try {
    peeked = peekImpl(runtime.binaryPath, { fsImpl });
  } catch (_error) { /* no cache entry: fall back to the saved build */ }
  const build = (peeked && peeked.ok === true ? positiveBuild(peeked.build) : 0) || positiveBuild(runtimeBuild);
  return build ? `build ${build}` : 'custom';
}

module.exports = {
  MAX_RUNTIME_PICKS,
  createRuntimePickRegistry,
  describeRuntimeLabel,
  reconcileManagedRuntimePaths,
  resolveLaunchRuntime,
  runtimeFolderToken,
  validateRuntimeExecutable,
  writeManagedPatch,
};
