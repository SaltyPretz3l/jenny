'use strict';

// Row 142: a llama-server build that can read the model, chosen for the user.
// When a model has no saved build and the bundled build cannot read its
// architecture, a launch uses the newest trusted build that can. The choice is
// computed, never saved: the launch order is env override > the model's saved
// build > this automatic build > bundled (llama-server-runtime.js).
//
// Trusted builds are the bundled build, every build already saved on a model
// (each was picked in a main dialog and probed), Jenny's own
// {userData}/runtimes/<folder>/ and the runtime folders the user added through
// a main dialog (<root>/ and <root>/<folder>/, one level). A build counts only
// when its folders are not links, its name passes the shape check and a probe
// reads a real build number from it. prepare() does the probing (async, before
// every launch); everything else reads its cache synchronously, so the launch
// and the chat preflight's relaunch check always agree.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { readGgufArchitecture } = require('../gguf-header');
const { isLlamaServerRuntimePath, isLocalAbsolutePath } = require('../shell-config-engines');
const { runtimeFolderToken, validateRuntimeExecutable } = require('./llama-server-runtime');

const MAX_ARCH_ANSWERS = 128;
// A failed probe is not tried again on the launch path for this long (a hanging build costs
// two 10 s probe timeouts); a user action (options, Use build, a finished download) retries now.
const FAILED_RETRY_MS = 10 * 60 * 1000;
const MAX_TRUSTED_BUILDS = 16;
const MAX_RUNTIME_ROOTS = 8;
const MAX_IDS = 32;
const MAX_CANDIDATES = 3;
const RUNTIME_LIBRARY = Object.freeze({ win32: 'llama.dll', darwin: 'libllama.dylib' });
const SERVER_NAME = Object.freeze({ win32: 'llama-server.exe' });
const ARCHITECTURE = /^[a-z0-9][a-z0-9_.-]{0,39}$/i;

// 'yes' | 'no' | 'unknown': whether a build's llama library carries the
// architecture's name as a NUL-delimited string. A missing library, a read
// error or no architecture is 'unknown', and 'no' is only trusted on Windows,
// where the bundled and downloaded builds were checked (b11513 has "lfm2",
// not "lfm3"; b12098 has "lfm3").
function createArchSupport({ fsImpl = fs, platform = process.platform } = {}) {
  const answers = new Map();
  return function archSupport(binaryPath, architecture) {
    if (!binaryPath || !architecture) return 'unknown';
    const library = path.join(path.dirname(binaryPath), RUNTIME_LIBRARY[platform] || 'libllama.so');
    let stat;
    try {
      stat = fsImpl.statSync(library);
    } catch (_error) {
      return 'unknown';
    }
    const key = `${library}\n${architecture}`;
    const known = answers.get(key);
    if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.answer;
    let answer = 'unknown';
    try {
      const found = fsImpl.readFileSync(library).includes(Buffer.from(`\0${architecture}\0`, 'latin1'));
      answer = found ? 'yes' : (platform === 'win32' ? 'no' : 'unknown');
    } catch (_error) { /* unreadable: unknown */ }
    answers.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, answer });
    while (answers.size > MAX_ARCH_ANSWERS) answers.delete(answers.keys().next().value);
    return answer;
  };
}

function createRuntimeChooser({
  fsImpl = fs,
  platform = process.platform,
  userDataPath = () => '',
  getManaged = () => null,
  resolveBundledPath = () => '',
  isEnabled = () => true,
  readArchitecture = readGgufArchitecture,
  validateImpl = validateRuntimeExecutable,
  // Tests inject the arch answer; production scans the build's library.
  archSupportImpl = null,
  log = () => {},
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const serverName = SERVER_NAME[platform] || 'llama-server';
  const archSupport = archSupportImpl || createArchSupport({ fsImpl, platform });
  const keyOf = (value) => (platform === 'win32' ? String(value).toLowerCase() : String(value));
  // path key -> { path, build } for every build the last prepare() validated.
  let validated = new Map();
  // path key -> { signature, at } for builds whose probe failed: skipped until the
  // file changes or FAILED_RETRY_MS passes.
  const failed = new Map();
  const idByKey = new Map();
  const pathById = new Map();
  let preparing = null;

  const read = (thunk, fallback) => {
    try {
      const value = typeof thunk === 'function' ? thunk() : thunk;
      return value == null ? fallback : value;
    } catch (_error) {
      return fallback;
    }
  };
  const enabled = () => read(isEnabled, false) === true;
  const bundledPath = () => String(read(resolveBundledPath, '') || '');

  // A folder Jenny may run programs from: local and a real directory, never a
  // junction or symlink itself. A linked ancestor (a relocated profile, a
  // redirected AppData) is the user's own layout and does not make it a link.
  const plainFolder = (folder) => {
    if (!isLocalAbsolutePath(folder, { platform })) return false;
    try {
      const stat = fsImpl.lstatSync(folder);
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch (_error) {
      return false;
    }
  };
  const plainBuild = (binaryPath) => {
    if (!isLlamaServerRuntimePath(binaryPath, { platform }) || !plainFolder(pathApi.dirname(binaryPath))) return false;
    try {
      return fsImpl.lstatSync(binaryPath).isFile();
    } catch (_error) {
      return false;
    }
  };
  const fileSignature = (file) => {
    try {
      const stat = fsImpl.lstatSync(file);
      return stat.isFile() ? `${stat.size}:${stat.mtimeMs}` : '';
    } catch (_error) {
      return '';
    }
  };
  // Folders holding a server file only (so the bound counts real builds), never a
  // dot folder: Jenny's own .downloads and .staging-* sit in {userData}/runtimes.
  const buildsIn = (root) => {
    if (!plainFolder(root)) return [];
    let names = [];
    try {
      names = fsImpl.readdirSync(root).sort();
    } catch (_error) { /* the root alone */ }
    return [pathApi.join(root, serverName), ...names.filter((name) => !name.startsWith('.')).map((name) => pathApi.join(root, name, serverName))]
      .filter((file) => fileSignature(file) !== '');
  };

  // Every place a trusted build may sit, bundled first, bounded and deduped.
  function candidatePaths() {
    const managed = read(getManaged, null) || {};
    const saved = Object.values(managed.perModel && typeof managed.perModel === 'object' ? managed.perModel : {})
      .map((entry) => (typeof entry?.runtimePath === 'string' ? entry.runtimePath : ''));
    const roots = (Array.isArray(managed.runtimeRoots) ? managed.runtimeRoots : [])
      .filter((root) => typeof root === 'string').slice(0, MAX_RUNTIME_ROOTS);
    const home = String(read(userDataPath, '') || '');
    const all = [bundledPath(), ...saved];
    for (const root of [home ? pathApi.join(home, 'runtimes') : '', ...roots]) {
      if (root) all.push(...buildsIn(root));
    }
    const seen = new Set();
    const out = [];
    for (const candidate of all) {
      const key = candidate ? keyOf(candidate) : '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
      if (out.length >= MAX_TRUSTED_BUILDS * 2) break;
    }
    return out;
  }

  async function probeAll() {
    const next = new Map();
    for (const candidate of candidatePaths()) {
      if (next.size >= MAX_TRUSTED_BUILDS) break;
      const key = keyOf(candidate);
      const signature = fileSignature(candidate);
      const failure = failed.get(key);
      if (failure && failure.signature === signature && Date.now() - failure.at < FAILED_RETRY_MS) continue;
      if (!plainBuild(candidate)) continue;
      const known = validated.get(key);
      let result = null;
      try {
        result = await validateImpl(candidate, { fsImpl, platform });
      } catch (_error) { /* a throwing probe fails closed */ }
      if (result && result.ok === true && Number.isSafeInteger(result.build) && result.build > 0) {
        next.set(key, { path: candidate, build: result.build });
        failed.delete(key);
      } else if (!known) {
        failed.set(key, { signature, at: Date.now() });
        while (failed.size > MAX_TRUSTED_BUILDS * 4) failed.delete(failed.keys().next().value);
      }
    }
    validated = next;
    // An option id names a build only while it stays trusted (a removed folder retires it).
    for (const [key, id] of [...idByKey]) {
      if (!validated.has(key)) {
        idByKey.delete(key);
        pathById.delete(id);
      }
    }
    return validated.size;
  }

  // Probes the trusted builds; never throws. Concurrent callers share one run.
  // retryFailed: a user action, so builds whose probe failed are tried again now.
  function prepare({ retryFailed = false } = {}) {
    if (!enabled() || typeof validateImpl !== 'function') {
      validated = new Map();
      return Promise.resolve(0);
    }
    if (retryFailed) failed.clear();
    if (!preparing) {
      preparing = probeAll().catch((error) => {
        log('WARN', 'llama.server.runtime_choice_failed', { code: String(error?.code || 'error').slice(0, 40) });
        return 0;
      }).finally(() => { preparing = null; });
    }
    return preparing;
  }

  const architectureOf = (modelPath) => {
    if (!modelPath) return '';
    const value = String(read(() => readArchitecture(modelPath, { fsImpl }), '') || '');
    return ARCHITECTURE.test(value) ? value.toLowerCase() : '';
  };

  // The newest validated build, other than the bundled one, that answers 'yes'
  // while the bundled build answers 'no'. Null in every other case.
  function chooseForArchitecture(architecture) {
    if (!enabled() || !architecture || validated.size === 0) return null;
    const bundled = bundledPath();
    if (archSupport(bundled, architecture) !== 'no') return null;
    const bundledKey = bundled ? keyOf(bundled) : '';
    const choice = [...validated.values()]
      .filter((entry) => keyOf(entry.path) !== bundledKey && archSupport(entry.path, architecture) === 'yes')
      .sort((a, b) => b.build - a.build || (keyOf(a.path) < keyOf(b.path) ? -1 : 1))[0];
    return choice ? { binaryPath: choice.path, build: choice.build, label: runtimeFolderToken(choice.path, { platform }), architecture } : null;
  }

  // Row 142 S3 "Get a build" asks two questions before it offers a download:
  // does the bundled build read this architecture, and does any other trusted
  // build (as of the last prepare()) read it.
  const bundledReads = (architecture) => archSupport(bundledPath(), architecture);
  function hasReader(architecture) {
    if (!architecture) return false;
    const bundled = bundledPath();
    const bundledKey = bundled ? keyOf(bundled) : '';
    return [...validated.values()]
      .some((entry) => keyOf(entry.path) !== bundledKey && archSupport(entry.path, architecture) === 'yes');
  }

  // The user's saved runtime folders with the builds the last prepare() found
  // in each (the folder itself or one level down). Only the user's own paths.
  function rootSummary() {
    const managed = read(getManaged, null) || {};
    const roots = (Array.isArray(managed.runtimeRoots) ? managed.runtimeRoots : [])
      .filter((root) => typeof root === 'string' && isLocalAbsolutePath(root, { platform }))
      .slice(0, MAX_RUNTIME_ROOTS);
    return roots.map((root) => {
      const rootKey = keyOf(pathApi.resolve(root));
      const found = [...validated.values()].filter((entry) => {
        const dir = pathApi.dirname(entry.path);
        return keyOf(dir) === rootKey || keyOf(pathApi.dirname(dir)) === rootKey;
      });
      return { path: root, builds: found.length, newest: found.reduce((top, entry) => Math.max(top, entry.build), 0) };
    });
  }

  function chooseFor({ modelPath = '', savedRuntimePath = '' } = {}) {
    if (savedRuntimePath || !enabled() || validated.size === 0) return null;
    return chooseForArchitecture(architectureOf(modelPath));
  }

  function idFor(binaryPath) {
    const key = keyOf(binaryPath);
    let id = idByKey.get(key);
    if (!id) {
      id = crypto.randomBytes(8).toString('hex');
      idByKey.set(key, id);
      pathById.set(id, binaryPath);
      while (idByKey.size > MAX_IDS) {
        const [oldKey, oldId] = idByKey.entries().next().value;
        idByKey.delete(oldKey);
        pathById.delete(oldId);
      }
    }
    return id;
  }

  // What a model runs on now, and up to three other builds worth offering
  // (reads 'yes' before 'unknown', newest first). Paths never leave main.
  function optionsFor({ modelPath = '', savedRuntimePath = '' } = {}) {
    const architecture = architectureOf(modelPath);
    const bundled = bundledPath();
    const auto = chooseFor({ modelPath, savedRuntimePath });
    let current = { source: 'bundled', build: validated.get(keyOf(bundled))?.build || 0, label: 'bundled', path: bundled };
    if (savedRuntimePath) {
      current = { source: 'saved', build: validated.get(keyOf(savedRuntimePath))?.build || 0, label: runtimeFolderToken(savedRuntimePath, { platform }), path: savedRuntimePath };
    } else if (auto) {
      current = { source: 'auto', build: auto.build, label: auto.label, path: auto.binaryPath };
    }
    const currentKey = current.path ? keyOf(current.path) : '';
    const rank = { yes: 0, unknown: 1 };
    const candidates = enabled() ? [...validated.values()]
      .filter((entry) => keyOf(entry.path) !== currentKey)
      .map((entry) => ({ entry, reads: archSupport(entry.path, architecture) }))
      .filter((item) => item.reads !== 'no')
      .sort((a, b) => rank[a.reads] - rank[b.reads] || b.entry.build - a.entry.build)
      .slice(0, MAX_CANDIDATES)
      .map(({ entry, reads }) => ({
        id: idFor(entry.path), build: entry.build, reads,
        label: keyOf(entry.path) === keyOf(bundled) ? 'bundled' : runtimeFolderToken(entry.path, { platform }),
      })) : [];
    return {
      architecture,
      current: { source: current.source, build: current.build, label: current.label },
      candidates,
    };
  }

  return {
    prepare,
    chooseFor,
    chooseForArchitecture,
    optionsFor,
    pathForId: (id) => (typeof id === 'string' && pathById.get(id)) || '',
    isTrusted: (binaryPath) => Boolean(binaryPath) && validated.has(keyOf(binaryPath)),
    isBundled: (binaryPath) => Boolean(binaryPath) && Boolean(bundledPath()) && keyOf(binaryPath) === keyOf(bundledPath()),
    archSupport,
    bundledReads,
    hasReader,
    rootSummary,
    size: () => validated.size,
  };
}

module.exports = {
  MAX_RUNTIME_ROOTS,
  MAX_TRUSTED_BUILDS,
  createArchSupport,
  createRuntimeChooser,
};
