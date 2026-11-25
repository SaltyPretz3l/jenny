'use strict';

// Finds the owner's own Strata install under %LOCALAPPDATA%\Strata (row 200 S2 step 2).
// Read-only: nothing here spawns Strata or downloads anything. Every byte of Strata's files is untrusted,
// so reads are bounded, parsed in try/catch and type-checked, and a link anywhere on a path is refused.
// The one link ever followed is terminal\current, and only to a real version folder directly under terminal.

const fs = require('fs');
const path = require('path');

const PINNED_TERMINAL_VERSION = '0.1.67';
const ENGINE_COMPONENT_ID = 'strata-inkling';
const ENGINE_PLATFORM = 'windows-x86_64';
const ENGINE_SUBPATH = ['components', 'shapes', 'inkling2', 'engine'];
const VERSION_FILE_BYTES = 32;
const ENGINE_MANIFEST_MAX_BYTES = 64 * 1024;
const DOTTED_VERSION = /^\d+(\.\d+)*$/;
const VERSION_FILE_PATTERN = /^\d+(\.\d+){1,3}$/;

function normalizeForCompare(value, platform) {
  const resolved = path.resolve(String(value).replace(/^\\\\\?\\/, ''));
  const trimmed = resolved.length > 3 ? resolved.replace(/[\\/]+$/, '') : resolved;
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

function samePath(a, b, platform = process.platform) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return normalizeForCompare(a, platform) === normalizeForCompare(b, platform);
}

function isUnderPath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isMissingError(error) {
  return Boolean(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

async function realPathInside(root, candidate, { fsImpl = fs } = {}) {
  const resolved = path.resolve(String(candidate || ''));
  if (!candidate || !isUnderPath(root, resolved)) {
    return { ok: false, reason: 'outside_root' };
  }
  let real;
  try {
    real = await fsImpl.promises.realpath(resolved);
  } catch (error) {
    if (isMissingError(error)) return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'link_refused' };
  }
  if (!samePath(real, resolved)) {
    return { ok: false, reason: 'link_refused' };
  }
  return { ok: true, path: real };
}

async function lstatOrNull(fsImpl, target) {
  try {
    return await fsImpl.promises.lstat(target);
  } catch (_error) {
    void _error;
    return null;
  }
}

async function statIsFile(fsImpl, target) {
  try {
    return (await fsImpl.promises.stat(target)).isFile();
  } catch (_error) {
    void _error;
    return false;
  }
}

// Reads at most maxBytes from the start of a file; returns null when it cannot be read.
async function readBounded(fsImpl, file, maxBytes) {
  let handle;
  try {
    handle = await fsImpl.promises.open(file, 'r');
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    return { text: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString('utf8'), truncated: bytesRead > maxBytes };
  } catch (_error) {
    void _error;
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Real (non-link) child directories of a folder, in name order.
async function listRealDirs(fsImpl, dir) {
  let names;
  try {
    names = await fsImpl.promises.readdir(dir);
  } catch (_error) {
    void _error;
    return [];
  }
  const dirs = [];
  for (const name of names.sort()) {
    const full = path.join(dir, name);
    const stat = await lstatOrNull(fsImpl, full);
    if (stat && stat.isDirectory() && !stat.isSymbolicLink()) dirs.push({ name, full });
  }
  return dirs;
}

async function readTerminalCurrent(fsImpl, terminalRoot, platform) {
  const currentPath = path.join(terminalRoot, 'current');
  const stat = await lstatOrNull(fsImpl, currentPath);
  if (!stat) return { dir: null, warning: null };
  const ignored = (reason) => ({ dir: null, warning: { code: 'terminal_current_ignored', reason } });
  if (!stat.isSymbolicLink()) return ignored('not_a_link');
  let target;
  try {
    target = await fsImpl.promises.realpath(currentPath);
  } catch (_error) {
    void _error;
    return ignored('unresolved');
  }
  if (!samePath(path.dirname(target), terminalRoot, platform)) return ignored('outside_terminal');
  const targetStat = await lstatOrNull(fsImpl, target);
  if (!targetStat || !targetStat.isDirectory() || targetStat.isSymbolicLink()) return ignored('not_a_real_folder');
  return { dir: target, warning: null };
}

async function hasServerPy(fsImpl, root, dir) {
  const server = await realPathInside(root, path.join(dir, 'serve', 'server.py'), { fsImpl });
  return server.ok && (await statIsFile(fsImpl, server.path));
}

async function chooseTerminalDir(fsImpl, root, terminalRoot, platform) {
  const warnings = [];
  const current = await readTerminalCurrent(fsImpl, terminalRoot, platform);
  if (current.warning) warnings.push(current.warning);
  if (current.dir && (await hasServerPy(fsImpl, root, current.dir))) return { dir: current.dir, warnings };
  if (current.dir) warnings.push({ code: 'terminal_current_ignored', reason: 'no_server' });
  let best = null;
  for (const { name, full } of await listRealDirs(fsImpl, terminalRoot)) {
    if (!DOTTED_VERSION.test(name) || !(await hasServerPy(fsImpl, root, full))) continue;
    if (!best || compareVersions(name, best.name) > 0) best = { name, full };
  }
  return { dir: best ? best.full : null, name: best ? best.name : null, warnings };
}

async function readTerminalVersion(fsImpl, root, dir, folderName) {
  const file = await realPathInside(root, path.join(dir, 'VERSION'), { fsImpl });
  const fallback = folderName || path.basename(dir);
  if (!file.ok) return fallback;
  const read = await readBounded(fsImpl, file.path, VERSION_FILE_BYTES);
  const text = read && !read.truncated ? read.text.trim() : '';
  return VERSION_FILE_PATTERN.test(text) ? text : fallback;
}

async function resolveTerminal(fsImpl, root, platform) {
  const terminalRoot = await realPathInside(root, path.join(root, 'terminal'), { fsImpl });
  if (!terminalRoot.ok) {
    const reason = terminalRoot.reason === 'link_refused' ? 'link_refused' : 'no_terminal';
    return { ok: false, reason };
  }
  const chosen = await chooseTerminalDir(fsImpl, root, terminalRoot.path, platform);
  if (!chosen.dir) return { ok: false, reason: 'no_terminal' };
  const python = await realPathInside(root, path.join(chosen.dir, 'python', 'python.exe'), { fsImpl });
  if (!python.ok) {
    return { ok: false, reason: python.reason === 'link_refused' ? 'link_refused' : 'no_python' };
  }
  if (!(await statIsFile(fsImpl, python.path))) return { ok: false, reason: 'no_python' };
  const server = await realPathInside(root, path.join(chosen.dir, 'serve', 'server.py'), { fsImpl });
  const version = await readTerminalVersion(fsImpl, root, chosen.dir, chosen.name);
  return { ok: true, terminalDir: chosen.dir, pythonExe: python.path, serverPy: server.path, version, warnings: chosen.warnings };
}

function parseEngineManifest(text, platform) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (_error) {
    void _error;
    return null;
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  if (manifest.id !== ENGINE_COMPONENT_ID) return null;
  if (platform === 'win32' && manifest.platform !== ENGINE_PLATFORM) return null;
  const { entrypoint, version } = manifest;
  if (typeof entrypoint !== 'string' || !entrypoint || entrypoint.length > 128 || /[\\/]/.test(entrypoint) || entrypoint === '..') return null;
  if (typeof version !== 'string' || !DOTTED_VERSION.test(version)) return null;
  const backend = typeof manifest.backend === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(manifest.backend) ? manifest.backend : '';
  return { entrypoint, version, backend };
}

async function readEngineCandidate(fsImpl, root, dir, platform) {
  const manifestFile = await realPathInside(root, path.join(dir, 'engine-component.json'), { fsImpl });
  if (!manifestFile.ok) return null;
  const read = await readBounded(fsImpl, manifestFile.path, ENGINE_MANIFEST_MAX_BYTES);
  if (!read || read.truncated) return null;
  const manifest = parseEngineManifest(read.text, platform);
  if (!manifest) return null;
  const exe = await realPathInside(root, path.join(dir, manifest.entrypoint), { fsImpl });
  if (!exe.ok || !(await statIsFile(fsImpl, exe.path))) return null;
  return { exe: exe.path, dir, version: manifest.version, backend: manifest.backend };
}

async function resolveEngine(fsImpl, root, platform) {
  const engineRoot = await realPathInside(root, path.join(root, ...ENGINE_SUBPATH), { fsImpl });
  if (!engineRoot.ok) {
    return { ok: false, reason: engineRoot.reason === 'link_refused' ? 'link_refused' : 'no_engine' };
  }
  let best = null;
  for (const { full } of await listRealDirs(fsImpl, engineRoot.path)) {
    const candidate = await readEngineCandidate(fsImpl, root, full, platform);
    if (candidate && (!best || compareVersions(candidate.version, best.version) > 0)) best = candidate;
  }
  if (!best) return { ok: false, reason: 'no_engine' };
  return { ok: true, engine: best };
}

async function resolveRoot(fsImpl, localAppData) {
  if (typeof localAppData !== 'string' || !localAppData) return { ok: false, reason: 'no_localappdata' };
  const strataDir = path.join(localAppData, 'Strata');
  const stat = await lstatOrNull(fsImpl, strataDir);
  if (!stat || !stat.isDirectory() && !stat.isSymbolicLink()) return { ok: false, reason: 'not_installed' };
  if (stat.isSymbolicLink()) return { ok: false, reason: 'link_refused' };
  try {
    return { ok: true, root: await fsImpl.promises.realpath(strataDir) };
  } catch (_error) {
    void _error;
    return { ok: false, reason: 'not_installed' };
  }
}

function versionWarnings(version, engineVersion) {
  const warnings = [];
  if (version !== PINNED_TERMINAL_VERSION) warnings.push({ code: 'version_unpinned', found: version, pinned: PINNED_TERMINAL_VERSION });
  if (engineVersion !== PINNED_TERMINAL_VERSION) warnings.push({ code: 'engine_version_unpinned', found: engineVersion, pinned: PINNED_TERMINAL_VERSION });
  return warnings;
}

async function discoverStrataInstall({ localAppData = process.env.LOCALAPPDATA, fsImpl = fs, platform = process.platform } = {}) {
  const rooted = await resolveRoot(fsImpl, localAppData);
  if (!rooted.ok) return rooted;
  const { root } = rooted;
  const terminal = await resolveTerminal(fsImpl, root, platform);
  if (!terminal.ok) return terminal;
  const engine = await resolveEngine(fsImpl, root, platform);
  if (!engine.ok) return engine;
  return {
    ok: true,
    root,
    terminalDir: terminal.terminalDir,
    pythonExe: terminal.pythonExe,
    serverPy: terminal.serverPy,
    version: terminal.version,
    componentsDir: path.join(root, 'components'),
    engine: engine.engine,
    warnings: [...terminal.warnings, ...versionWarnings(terminal.version, engine.engine.version)],
  };
}

module.exports = {
  PINNED_TERMINAL_VERSION,
  discoverStrataInstall,
  isUnderPath,
  readBounded,
  realPathInside,
  samePath,
};
