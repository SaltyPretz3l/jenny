'use strict';

// Canonical production-owned Ollama executable discovery. Linux uses Jenny's
// user-space target from config/ollama-install-manifest.json (installRoot:
// "xdg-data"); callers still fall back to PATH for a system Ollama install.
const fs = require('fs');
const os = require('os');
const path = require('path');

function ollamaUserInstallRoot(env = process.env, homedir = os.homedir) {
  try {
    const source = env && typeof env === 'object' ? env : {};
    const xdgDataHome = String(source.XDG_DATA_HOME || '').trim();
    const xdgIsAbsolute = path.posix.isAbsolute(xdgDataHome) || path.win32.isAbsolute(xdgDataHome);
    if (xdgDataHome && xdgIsAbsolute) {
      return path.posix.join(xdgDataHome, 'jenny', 'ollama');
    }
    const home = String(source.HOME || '').trim()
      || (typeof homedir === 'function' ? String(homedir() || '').trim() : '');
    return home ? path.posix.join(home, '.local', 'share', 'jenny', 'ollama') : '';
  } catch (_error) {
    return '';
  }
}

function ollamaInstallDirs(platform = process.platform, env = process.env) {
  if (platform === 'linux') {
    const root = ollamaUserInstallRoot(env);
    return root ? [path.posix.join(root, 'bin')] : [];
  }
  if (platform !== 'win32') {
    return [];
  }
  const dirs = [];
  if (env.LOCALAPPDATA) {
    dirs.push(path.join(env.LOCALAPPDATA, 'Programs', 'Ollama'));
  }
  dirs.push(path.join(env.ProgramFiles || env.ProgramW6432 || 'C:\\Program Files', 'Ollama'));
  return dirs;
}

function ollamaBinaryPath(platform = process.platform, env = process.env, fileExists = fs.existsSync) {
  const executable = platform === 'win32' ? 'ollama.exe' : 'ollama';
  for (const directory of ollamaInstallDirs(platform, env)) {
    const candidate = platform === 'linux'
      ? path.posix.join(directory, executable)
      : path.join(directory, executable);
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return '';
}

function resolveOllamaCommand({
  platform = process.platform,
  env = process.env,
  fileExists = fs.existsSync,
} = {}) {
  return ollamaBinaryPath(platform, env, fileExists) || 'ollama';
}

module.exports = { ollamaUserInstallRoot, ollamaInstallDirs, ollamaBinaryPath, resolveOllamaCommand };
