'use strict';

// Canonical production-owned Ollama executable discovery. Source bootstrap
// imports this same module so stale parent-process PATH values are harmless.
const fs = require('fs');
const path = require('path');

function ollamaInstallDirs(platform = process.platform, env = process.env) {
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
    const candidate = path.join(directory, executable);
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

module.exports = { ollamaInstallDirs, ollamaBinaryPath, resolveOllamaCommand };
