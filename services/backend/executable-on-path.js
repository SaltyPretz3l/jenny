'use strict';

// Bare-name launches that never resolve from the current directory (security
// review 2026-10-25, item 8). On Windows both libuv's spawn and where.exe look
// in the cwd before PATH, so a planted docker.exe or ollama.exe in whatever
// directory Jenny was started from would win over the real one.
const fs = require('node:fs');
const path = require('node:path');

function pathValue(env) {
  return String(env.PATH ?? env.Path ?? '');
}

function isExecutableFile(candidate, platform) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// First match of `name` in the absolute PATH entries; null on a miss. On Windows only the
// .com/.exe forms libuv's spawn would launch for a bare name (a .cmd hit cannot run shell-less).
function findOnPath(name, { env = process.env, platform = process.platform } = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const delimiter = platform === 'win32' ? ';' : ':';
  const extensions = platform === 'win32' ? ['.com', '.exe'] : [''];
  for (const raw of pathValue(env).split(delimiter)) {
    const directory = raw.replace(/^"|"$/gu, '');
    if (!directory || !pathApi.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, name + extension);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

// The [command, args] of a PATH-only lookup: System32 where.exe scoped with
// `$PATH:` on Windows (bare `where` is itself found via the cwd), `which` elsewhere.
function pathLookupCommand(name, { env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return ['which', [name]];
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.WINDIR || 'C:\\Windows';
  return [path.win32.join(systemRoot, 'System32', 'where.exe'), [`$PATH:${name}`]];
}

module.exports = { findOnPath, pathLookupCommand };
