/* services/workspace-pty-profiles.js - shell profiles and the start folder for the
 * Workspace terminal (row 82 slice T2, plan docs/plans/IDE_VSCODE_PARITY_2026-10-26.md
 * section 7.5, owner pick O4).
 *
 * detectProfiles() lists the shells this machine has, by file presence only (no process
 * is started to probe): pwsh, Windows PowerShell, Command Prompt, Git Bash and WSL on
 * win32; bash, zsh and fish on POSIX. A profile is an allowlisted id mapped to an
 * absolute executable and fixed arguments, so the renderer can only ever name an id,
 * never a program or its arguments. PowerShell loads the user's profile (O4: aliases,
 * venv hooks, prompt) and keeps -NoLogo.
 *
 * resolveContainedCwd() maps a root-relative folder to its real path, refusing anything
 * that leaves the workspace root once symlinks and junctions are resolved, and anything
 * that is not an existing directory. */

'use strict';

const nodeFs = require('fs');
const nodePath = require('path');

const MAX_REL_LENGTH = 4096;

// id -> { label, args }; the executable is resolved per platform below.
const WIN_PROFILES = Object.freeze([
  Object.freeze({ id: 'pwsh', label: 'PowerShell', args: Object.freeze(['-NoLogo']) }),
  Object.freeze({ id: 'powershell', label: 'Windows PowerShell', args: Object.freeze(['-NoLogo']) }),
  Object.freeze({ id: 'cmd', label: 'Command Prompt', args: Object.freeze([]) }),
  Object.freeze({ id: 'git-bash', label: 'Git Bash', args: Object.freeze(['--login', '-i']) }),
  Object.freeze({ id: 'wsl', label: 'WSL', args: Object.freeze([]) }),
]);
const POSIX_PROFILES = Object.freeze([
  Object.freeze({ id: 'bash', label: 'bash', args: Object.freeze(['-i']) }),
  Object.freeze({ id: 'zsh', label: 'zsh', args: Object.freeze(['-i']) }),
  Object.freeze({ id: 'fish', label: 'fish', args: Object.freeze(['-i']) }),
]);
const WIN_DEFAULT_ORDER = Object.freeze(['powershell', 'cmd']);
const POSIX_DEFAULT_ORDER = Object.freeze(['bash']);

// A network PATH entry (\\server\share or //server/share) is never probed: a dead share
// stalls existsSync for seconds on every lookup.
function isUncPath(dir) {
  return /^[\\/]{2}/.test(dir);
}

function pathDirs(env, pathImpl) {
  const raw = String(env?.PATH ?? env?.Path ?? '');
  return raw.split(pathImpl.delimiter).map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir && !isUncPath(dir)).slice(0, 256);
}

function firstExisting(candidates, existsSync) {
  for (const file of candidates) {
    try {
      if (file && existsSync(file)) return file;
    } catch (_error) {
      /* an unreadable candidate is simply absent */
    }
  }
  return '';
}

// Absolute executable for a profile id, or '' when this machine does not have it.
function locate(id, { platform, env, existsSync, pathImpl }) {
  const onPath = (name) => pathDirs(env, pathImpl).map((dir) => pathImpl.join(dir, name));
  if (platform === 'win32') {
    const systemRoot = String(env?.SystemRoot || env?.SYSTEMROOT || 'C:\\Windows');
    const programFiles = [env?.ProgramFiles, env?.['ProgramFiles(x86)'], env?.ProgramW6432].filter(Boolean).map(String);
    const localAppData = String(env?.LOCALAPPDATA || '');
    switch (id) {
      case 'pwsh':
        return firstExisting([...programFiles.map((dir) => pathImpl.join(dir, 'PowerShell', '7', 'pwsh.exe')), ...onPath('pwsh.exe')], existsSync);
      case 'powershell':
        return firstExisting([pathImpl.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ...onPath('powershell.exe')], existsSync);
      case 'cmd':
        return firstExisting([String(env?.ComSpec || env?.COMSPEC || ''), pathImpl.join(systemRoot, 'System32', 'cmd.exe')], existsSync);
      case 'git-bash':
        return firstExisting([
          ...programFiles.map((dir) => pathImpl.join(dir, 'Git', 'bin', 'bash.exe')),
          localAppData ? pathImpl.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe') : '',
        ], existsSync);
      case 'wsl':
        return firstExisting([pathImpl.join(systemRoot, 'System32', 'wsl.exe')], existsSync);
      default:
        return '';
    }
  }
  if (!POSIX_PROFILES.some((profile) => profile.id === id)) return '';
  return firstExisting([...onPath(id), `/bin/${id}`, `/usr/bin/${id}`, `/usr/local/bin/${id}`, `/opt/homebrew/bin/${id}`], existsSync);
}

function probeProfiles({ platform, env, existsSync, pathImpl }) {
  const impl = pathImpl || (platform === 'win32' ? nodePath.win32 : nodePath.posix);
  const table = platform === 'win32' ? WIN_PROFILES : POSIX_PROFILES;
  const profiles = [];
  for (const profile of table) {
    const file = locate(profile.id, { platform, env, existsSync, pathImpl: impl });
    if (file) profiles.push({ id: profile.id, label: profile.label, file, args: [...profile.args] });
  }
  return profiles;
}

// One cached probe per process (cleanup T2): a spawn reuses it, while the profile menu
// opening (refresh: true) or an entry older than CACHE_TTL_MS probes the disk again, so a
// shell installed while the app runs still shows up. Keyed by the probe inputs' identity.
const CACHE_TTL_MS = 60_000;
let cached = null; // { key: [platform, env, existsSync, pathImpl], at, profiles }

function cloneProfiles(profiles) {
  return profiles.map((profile) => ({ ...profile, args: [...profile.args] }));
}

// [{ id, label, file, args }] for the shells present, in a stable order.
function detectProfiles({ platform = process.platform, env = process.env, existsSync = nodeFs.existsSync, pathImpl, refresh = false, now = Date.now } = {}) {
  const key = [platform, env, existsSync, pathImpl];
  const at = now();
  const hit = cached && !refresh && at - cached.at < CACHE_TTL_MS && cached.key.every((part, index) => part === key[index]);
  if (!hit) cached = { key, at, profiles: probeProfiles({ platform, env, existsSync, pathImpl }) };
  return cloneProfiles(cached.profiles);
}

function defaultOrder(platform) {
  return platform === 'win32' ? WIN_DEFAULT_ORDER : POSIX_DEFAULT_ORDER;
}

// The platform default profile id among the detected ones ('' when none is present).
function defaultProfileId(profiles, platform = process.platform) {
  const ids = new Set(profiles.map((profile) => profile.id));
  return defaultOrder(platform).find((id) => ids.has(id)) || (profiles[0]?.id || '');
}

// Spawn attempts in order: the requested profile when it is detected, then the platform
// default chain; the bare-name fallback keeps today's behaviour when detection finds
// nothing (an unusual PATH). Each attempt is { profileId, file, args }.
function spawnCandidates(profiles, requestedId, platform = process.platform) {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const order = [];
  const wanted = String(requestedId || '');
  if (wanted && byId.has(wanted)) order.push(wanted);
  for (const id of defaultOrder(platform)) if (!order.includes(id) && byId.has(id)) order.push(id);
  const candidates = order.map((id) => ({ profileId: id, file: byId.get(id).file, args: [...byId.get(id).args] }));
  if (candidates.length === 0) {
    return platform === 'win32'
      ? [{ profileId: 'powershell', file: 'powershell.exe', args: ['-NoLogo'] }, { profileId: 'cmd', file: 'cmd.exe', args: [] }]
      : [{ profileId: 'bash', file: 'bash', args: ['-i'] }];
  }
  return candidates;
}

function isInside(rootReal, candidate, pathImpl) {
  const relative = pathImpl.relative(rootReal, candidate);
  if (relative === '') return true;
  if (relative === '..' || relative.startsWith('..' + pathImpl.sep)) return false;
  return !pathImpl.isAbsolute(relative);
}

// A root-relative folder ('' = the root) -> { ok: true, cwd } with the real path inside
// the real root, or { ok: false, reason }. Absolute paths, '..' escapes, links that lead
// out of the root, missing folders and files are refused.
async function resolveContainedCwd(root, rel, { fs = nodeFs.promises, pathImpl = nodePath } = {}) {
  const relative = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (relative.length > MAX_REL_LENGTH || /[\0]/.test(relative)) return { ok: false, reason: 'invalid_path' };
  if (relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) return { ok: false, reason: 'path_outside_workspace' };
  let rootReal;
  try {
    rootReal = await fs.realpath(root);
  } catch (_error) {
    return { ok: false, reason: 'root_unreadable' };
  }
  const segments = relative.split('/').filter((segment) => segment && segment !== '.');
  const target = pathImpl.resolve(rootReal, ...segments);
  if (!isInside(rootReal, target, pathImpl)) return { ok: false, reason: 'path_outside_workspace' };
  let real;
  try {
    real = await fs.realpath(target);
  } catch (_error) {
    return { ok: false, reason: 'not_found' };
  }
  if (!isInside(rootReal, real, pathImpl)) return { ok: false, reason: 'path_outside_workspace' };
  try {
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) return { ok: false, reason: 'not_a_directory' };
  } catch (_error) {
    return { ok: false, reason: 'not_found' };
  }
  return { ok: true, cwd: real };
}

module.exports = {
  detectProfiles,
  defaultProfileId,
  spawnCandidates,
  resolveContainedCwd,
};
