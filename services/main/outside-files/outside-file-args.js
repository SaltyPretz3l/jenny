'use strict';

// Which files a launch asked Jenny to open ("Open with Jenny", row 137).
// Pure and light: the boot gate requires it before the single-instance lock,
// so every launch pays for what it pulls in.
//
// The Windows registration runs `Jenny.exe -- "%1"`: `--` ends Chromium's
// switch parsing, and only the entries after it are files. Packaged Linux is
// the one exception, because the .desktop Exec line passes `%U` without `--`.
// macOS delivers files through the 'open-file' event, never argv. Requiring
// `--` everywhere else keeps `electron --inspect .`, test probes and dev
// flags from ever being read as files.

const path = require('node:path');
const { fileURLToPath } = require('node:url');

const MAX_OUTSIDE_PATHS_PER_LAUNCH = 16;
const MAX_PATH_LENGTH = 4096;
const SECOND_LAUNCH_DATA_VERSION = 1;

function toFilePath(entry, cwd) {
  const text = String(entry || '').trim();
  if (!text || text.length > MAX_PATH_LENGTH || text.startsWith('-') || text.includes('\0')) return '';
  if (/^file:\/\//i.test(text)) {
    try {
      return fileURLToPath(text);
    } catch (_error) {
      return '';
    }
  }
  // Any other URL scheme (http:, jenny:, ...) is not a file. A Windows drive
  // path (C:\x) has a one-letter "scheme" and stays a path.
  if (/^[a-z][a-z0-9+.-]+:/i.test(text)) return '';
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(String(cwd || process.cwd()), text);
}

function extractOutsideFilePaths(argv, { isPackaged = false, platform = process.platform, cwd } = {}) {
  const args = Array.isArray(argv) ? argv.map((value) => String(value == null ? '' : value)) : [];
  const separator = args.indexOf('--');
  let candidates;
  if (separator >= 0) {
    candidates = args.slice(separator + 1);
  } else if (isPackaged && platform === 'linux') {
    candidates = args.slice(1);
  } else {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const entry of candidates) {
    const filePath = toFilePath(entry, cwd);
    if (!filePath) continue;
    const key = platform === 'win32' || platform === 'darwin' ? filePath.toLowerCase() : filePath;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(filePath);
    if (out.length >= MAX_OUTSIDE_PATHS_PER_LAUNCH) break;
  }
  return out;
}

// What a second launch hands the running app through
// requestSingleInstanceLock(additionalData). Explicit data avoids parsing a
// commandLine that Chromium may have reordered or appended switches to.
function buildSecondLaunchData(argv, options = {}) {
  return {
    v: SECOND_LAUNCH_DATA_VERSION,
    outsidePaths: extractOutsideFilePaths(argv, options),
    cwd: String(options.cwd || process.cwd()),
  };
}

// The running app's side: prefer validated additionalData, and fall back to
// parsing the forwarded commandLine (a second instance from an older build).
function readSecondLaunchPaths({ argv, cwd, additionalData, isPackaged = false, platform = process.platform } = {}) {
  const data = additionalData && typeof additionalData === 'object' ? additionalData : null;
  if (data && data.v === SECOND_LAUNCH_DATA_VERSION && Array.isArray(data.outsidePaths)) {
    const out = [];
    for (const entry of data.outsidePaths.slice(0, MAX_OUTSIDE_PATHS_PER_LAUNCH)) {
      if (typeof entry !== 'string') continue;
      const filePath = toFilePath(entry, data.cwd || cwd);
      if (filePath && path.isAbsolute(filePath)) out.push(filePath);
    }
    return out;
  }
  // The uninstall assistant also locks ({ mode: 'uninstall-assistant' }); it
  // carries no files.
  if (data && data.mode) return [];
  return extractOutsideFilePaths(argv, { isPackaged, platform, cwd });
}

module.exports = {
  MAX_OUTSIDE_PATHS_PER_LAUNCH,
  SECOND_LAUNCH_DATA_VERSION,
  buildSecondLaunchData,
  extractOutsideFilePaths,
  readSecondLaunchPaths,
};
