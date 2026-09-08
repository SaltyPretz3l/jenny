// AppImage launch variables are inherited by child processes.
// APPIMAGE alone can therefore describe an unrelated parent app.
// The static runtime also exports APPDIR and starts Jenny from it.
// Package detection must anchor on the running executable under APPDIR.
// This prevents system installs from adopting AppImage behavior.
// Keep this helper pure so all Linux callers share one decision.

'use strict';

const path = require('path');

function normalizePath(value) {
  return path.posix.normalize(value.trim()).replace(/\/+$/, '');
}

function resolveLinuxPackageKind({
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
} = {}) {
  if (platform !== 'linux') return null;
  const appImage = typeof env?.APPIMAGE === 'string' ? env.APPIMAGE.trim() : '';
  const appDir = typeof env?.APPDIR === 'string' ? env.APPDIR.trim() : '';
  if (!appImage || !appDir || typeof execPath !== 'string') return 'system';
  const normalizedAppDir = normalizePath(appDir);
  const normalizedExecPath = normalizePath(execPath);
  return normalizedExecPath === normalizedAppDir
    || normalizedExecPath.startsWith(`${normalizedAppDir}/`)
    ? 'appimage'
    : 'system';
}

function appImagePath(options) {
  if (resolveLinuxPackageKind(options) !== 'appimage') return '';
  const env = options?.env ?? process.env;
  return env.APPIMAGE.trim();
}

module.exports = { appImagePath, resolveLinuxPackageKind };
