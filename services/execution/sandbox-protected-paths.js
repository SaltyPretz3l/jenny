'use strict';
// Row 106: which paths the synced-workspace sandbox never writes back into the folder, and which it
// never copies into the Linux mirror. Names are compared after an NTFS-style fold (Unicode compatibility
// form, upper then lower case, trailing dots and spaces stripped) so `.GIT`, `.gıt` and `.git.` all
// mean `.git`. Spellings Windows resolves to another name (8.3 short names like GIT~1, reserved device
// names, trailing dots or spaces) are refused outright by componentProblem rather than folded.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// `head`: a HEAD file beside objects/ and refs/ makes any folder a repository git honours, config and
// hooks included, so no command may write one back.
const PROTECTED_NAMES = Object.freeze(['.git', '.jenny', '.husky', 'node_modules', '.venv', 'venv', 'head']);
const SYNC_EXCLUDED_NAMES = Object.freeze(['.git', '.jenny', '.venv', 'venv']);
const RESERVED_BASE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/u;
// Control bytes, the Windows-invalid set and both separators.
const INVALID_BYTES = /[\u0000-\u001f<>:"|?*\\/]/u; // eslint-disable-line no-control-regex
const MAX_COMPONENT_BYTES = 255;
const MAX_PATH_BYTES = 4096;
const MAX_DEPTH = 64;
const CONFIG_LIMIT = 1024 * 1024;
const MAX_CONFIG_FILES = 16;

function foldName(name) {
  return String(name).normalize('NFKC').toUpperCase().toLowerCase().replace(/[. ]+$/u, '');
}

function componentProblem(name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..') return 'path_invalid';
  if (INVALID_BYTES.test(name) || /[. ]$/u.test(name) || Buffer.byteLength(name) > MAX_COMPONENT_BYTES) return 'path_invalid';
  // An 8.3 short name (GIT~1, PROGRA~1.TXT) can alias any long name on NTFS.
  if (/~[0-9]/u.test(name)) return 'path_short_name';
  if (RESERVED_BASE.test(foldName(name).split('.')[0].trimEnd())) return 'path_reserved_name';
  return null;
}

function validateRelativePath(relative) {
  if (typeof relative !== 'string' || relative.includes('\0') || Buffer.byteLength(relative) > MAX_PATH_BYTES) {
    return { ok: false, reason: 'path_invalid' };
  }
  const components = relative.split('/');
  if (components.length > MAX_DEPTH) return { ok: false, reason: 'path_invalid' };
  for (const component of components) {
    const problem = componentProblem(component);
    if (problem) return { ok: false, reason: problem };
  }
  return { ok: true, components };
}

function foldedComponents(relative) {
  return String(relative).split('/').map(foldName);
}

function normalizeList(values) {
  const seen = new Set();
  for (const value of values || []) {
    if (typeof value === 'string' && value && validateRelativePath(value).ok) seen.add(value);
  }
  return [...seen].sort();
}

// hooks: the core.hooksPath folder; includes: in-root git config include files; gitDirs: in-root git
// directories named by a gitfile (`gitdir: .bare`). All are root-relative POSIX paths.
function protectionPolicy({ hooks = [], includes = [], gitDirs = [] } = {}) {
  return { hooks: normalizeList(hooks), includes: normalizeList(includes), gitDirs: normalizeList(gitDirs) };
}

function startsWithPath(components, prefix) {
  const folded = foldedComponents(prefix);
  return folded.length <= components.length && folded.every((part, index) => components[index] === part);
}

function isProtected(relative, policy = protectionPolicy()) {
  const components = foldedComponents(relative);
  if (components.some((part) => PROTECTED_NAMES.includes(part))) return true;
  return [...policy.hooks, ...policy.includes, ...policy.gitDirs].some((prefix) => startsWithPath(components, prefix));
}

function isSyncExcluded(relative, policy = protectionPolicy()) {
  const components = foldedComponents(relative);
  if (components.some((part) => SYNC_EXCLUDED_NAMES.includes(part))) return true;
  return policy.gitDirs.some((prefix) => startsWithPath(components, prefix));
}

// The folder-relative POSIX form of `target`, or null when it leaves the root.
function insideRelative(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  const posix = relative.split(path.sep).join('/');
  return validateRelativePath(posix).ok ? posix : null;
}

async function readSmallRegular(file, limit) {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) return null;
    return await fs.readFile(file, 'utf8');
  } catch { return null; }
}

function unquote(value) {
  const trimmed = value.replace(/\s[;#].*$/u, '').trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2 ? trimmed.slice(1, -1) : trimmed;
}

// A deliberately small reader for the three keys that matter here; git's own parser is never run.
function configPaths(text) {
  const result = { hooks: [], includes: [] };
  let section = '';
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]$/u.exec(line);
    if (header) { section = header[1].toLowerCase(); continue; }
    const pair = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/u.exec(line);
    if (!pair) continue;
    const key = pair[1].toLowerCase();
    if (section === 'core' && key === 'hookspath') result.hooks.push(unquote(pair[2]));
    if ((section === 'include' || section === 'includeif') && key === 'path') result.includes.push(unquote(pair[2]));
  }
  return result;
}

function resolveInRoot(root, base, value) {
  if (!value || value.startsWith('~')) return null;
  return insideRelative(root, path.resolve(base, value));
}

// The checkout's own git dir (null outside a repository) and the common dir a linked worktree shares.
async function checkoutGitDirs(root, gitDirs) {
  const dotGit = path.join(root, '.git');
  const info = await fs.lstat(dotGit).catch(() => null);
  if (info?.isDirectory() && !info.isSymbolicLink()) return [dotGit, dotGit];
  if (!info?.isFile()) return [null, null];
  const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec(await readSmallRegular(dotGit, 4096) || '')?.[1];
  if (!pointer) return [null, null];
  const gitDir = path.resolve(root, pointer);
  const relative = insideRelative(root, gitDir);
  if (relative) gitDirs.push(relative);
  const common = (await readSmallRegular(path.join(gitDir, 'commondir'), 4096) || '').trim();
  return [gitDir, common ? path.resolve(gitDir, common) : gitDir];
}

// Every config file git reads for this checkout: the user's global files, the shared config and the
// worktree's own, then their include files (relative includes resolve against the including file).
async function discoverProtectionPolicy(root) {
  root = path.resolve(root);
  const gitDirs = [];
  const [gitDir, commonDir] = await checkoutGitDirs(root, gitDirs);
  if (!gitDir) return protectionPolicy({ gitDirs });
  const home = os.homedir();
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const queue = [path.join(xdg, 'git', 'config'), path.join(home, '.gitconfig'), path.join(commonDir, 'config'),
    path.join(commonDir, 'config.worktree'), path.join(gitDir, 'config.worktree')];
  const seen = new Set();
  const hooks = [];
  const includes = [];
  while (queue.length && seen.size < MAX_CONFIG_FILES) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await readSmallRegular(file, CONFIG_LIMIT);
    if (!text) continue;
    const found = configPaths(text);
    for (const value of found.hooks) {
      const relative = resolveInRoot(root, root, value);
      if (relative) hooks.push(relative);
    }
    for (const value of found.includes) {
      const target = value.startsWith('~/') ? path.join(home, value.slice(2)) : path.resolve(path.dirname(file), value);
      const relative = insideRelative(root, target);
      if (relative) includes.push(relative);
      queue.push(target);
    }
  }
  return protectionPolicy({ hooks, includes, gitDirs });
}

// A gitfile met during the walk (`sub/.git` holding `gitdir: ../.bare`) names another in-root gitdir.
function gitDirFromGitfile(root, gitfileRelative, text) {
  const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec(String(text || ''))?.[1];
  if (!pointer) return null;
  const directory = path.dirname(path.join(root, ...gitfileRelative.split('/')));
  return insideRelative(root, path.resolve(directory, pointer));
}

module.exports = { PROTECTED_NAMES, SYNC_EXCLUDED_NAMES, foldName, componentProblem, validateRelativePath,
  protectionPolicy, isProtected, isSyncExcluded, discoverProtectionPolicy, gitDirFromGitfile, insideRelative };
