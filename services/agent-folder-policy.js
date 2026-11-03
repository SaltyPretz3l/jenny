'use strict';

/* services/agent-folder-policy.js - which folders the Jenny chat may bind to a new project (row 94 P2,
 * docs/plans/APP_CONTROL_P2_CHAT_PLACEMENT_2026-11-02.md section 4.A). The user's own folder picker is the
 * consent for a folder the user binds; a folder the model names gets this policy on top of
 * `canonicalizeProjectRoot`, which already resolves junctions and symlinks, requires a directory and refuses
 * Jenny's state dirs. The policy reads the canonical path only, never the model's spelling.
 *
 * Refused: a drive, volume or share root; a protected folder (the OS, program and app-data folders, Jenny's
 * own data and install folders, passed in by the caller), anything inside one, and anything that contains one
 * (so the home folder and `C:\Users` are refused because they hold app data); and any path through a
 * credential or tool-config folder (AGENTS.md: never read another tool's credentials). Pure: the platform,
 * environment and home folder are arguments, so both path flavours are testable on one machine.
 */

const fs = require('fs');
const nodePath = require('path');

// Folders that hold credentials or another tool's login, refused anywhere in the path (compared lower-case).
const CREDENTIAL_SEGMENTS = Object.freeze(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.codex', '.claude']);
// Two-segment credential folders (`.config/gh` holds the GitHub CLI token).
const CREDENTIAL_PAIRS = Object.freeze([['.config', 'gh']]);
const WINDOWS_ENV_FOLDERS = Object.freeze(['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'APPDATA', 'LOCALAPPDATA']);
const POSIX_SYSTEM_FOLDERS = Object.freeze(['/etc', '/usr', '/bin', '/sbin', '/lib', '/var', '/private', '/System', '/Library', '/Applications', '/proc', '/dev', '/boot', '/opt/homebrew']);

function pathFor(platform) {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

function comparable(value, platform) {
  const resolved = pathFor(platform).resolve(String(value));
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function within(parent, child, platform) {
  const flavour = pathFor(platform);
  const relative = flavour.relative(parent, child);
  // `..x` is a folder name, not a step up.
  const upward = relative === '..' || relative.startsWith(`..${flavour.sep}`);
  return relative === '' || (!upward && !flavour.isAbsolute(relative));
}

// The target is a realpath, so a guard reached through a link (a junctioned home or AppData) is resolved too;
// a guard that cannot be resolved, or belongs to another platform's paths, is compared as written.
function resolveGuard(value, platform, realpath) {
  if (platform !== process.platform) return value;
  try { return realpath(value) || value; } catch { return value; }
}

function protectedFolders({ platform, env, homedir, extra }) {
  const source = env && typeof env === 'object' ? env : {};
  const list = platform === 'win32'
    ? WINDOWS_ENV_FOLDERS.map((key) => source[key]).filter((value) => typeof value === 'string' && value.trim())
    : [...POSIX_SYSTEM_FOLDERS];
  if (platform === 'darwin' && typeof homedir === 'string' && homedir) list.push(nodePath.posix.join(homedir, 'Library'));
  if (platform !== 'win32' && platform !== 'darwin' && typeof homedir === 'string' && homedir) {
    list.push(nodePath.posix.join(homedir, '.config'), nodePath.posix.join(homedir, '.local', 'share'));
  }
  for (const value of Array.isArray(extra) ? extra : []) if (typeof value === 'string' && value.trim()) list.push(value);
  return list.filter((value) => pathFor(platform).isAbsolute(value));
}

// Windows drops trailing dots and spaces from a segment at the I/O layer, so `.ssh.` is `.ssh` on disk.
function hasCredentialSegment(canonical, platform) {
  const segments = String(canonical).split(/[\\/]+/).filter(Boolean)
    .map((segment) => (platform === 'win32' ? segment.replace(/[.\s]+$/, '') : segment).toLowerCase());
  if (segments.some((segment) => CREDENTIAL_SEGMENTS.includes(segment))) return true;
  return CREDENTIAL_PAIRS.some(([first, second]) => segments.some((segment, index) => segment === first && segments[index + 1] === second));
}

/**
 * The refusal token for a canonical folder the model asked to bind, or null when it may be bound.
 * @param {string} canonical - the realpath'd, normalized folder (`canonicalizeProjectRoot` output)
 * @param {{platform?: string, env?: object, homedir?: string, protectedPaths?: string[], realpath?: function}} [options]
 * @returns {null|'root_folder'|'home_folder'|'protected_folder'|'credential_folder'}
 */
function agentFolderRefusal(canonical, {
  platform = process.platform, env = process.env, homedir = '', protectedPaths = [], realpath = (value) => fs.realpathSync.native(value),
} = {}) {
  const flavour = pathFor(platform);
  if (typeof canonical !== 'string' || !flavour.isAbsolute(canonical)) return 'protected_folder';
  const target = comparable(canonical, platform);
  if (comparable(flavour.parse(target).root, platform) === target) return 'root_folder';
  if (typeof homedir === 'string' && homedir) {
    const home = comparable(resolveGuard(homedir, platform, realpath), platform);
    if (home === target || comparable(homedir, platform) === target) return 'home_folder';
    // Another account's home (`C:\\Users\\other`, `/home/other`) is as off-limits as this one; the folder above them too.
    const homes = flavour.dirname(home);
    if (comparable(flavour.parse(homes).root, platform) !== homes) {
      if (target === homes) return 'protected_folder';
      if (flavour.dirname(target) === homes) return 'home_folder';
    }
  }
  if (hasCredentialSegment(canonical, platform)) return 'credential_folder';
  for (const folder of protectedFolders({ platform, env, homedir, extra: protectedPaths })) {
    const guarded = comparable(resolveGuard(folder, platform, realpath), platform);
    if (within(guarded, target, platform) || within(target, guarded, platform)) return 'protected_folder';
  }
  return null;
}

module.exports = { agentFolderRefusal };
