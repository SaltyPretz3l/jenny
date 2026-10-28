'use strict';

// Shared node:test skip predicates for real platform and resource gates. Each
// returns false (run) or a reason string naming the platform or resource, which
// node:test reports as the skip reason. A gate that can never be true on a
// supported platform is deleted rather than routed through here
// (docs/plans/TEST_HEALTH_2026-10-26.md).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IS_WINDOWS = process.platform === 'win32';
const FILE_SYMLINK_REASON = 'Windows file symlinks need Developer Mode or an elevated token';

function windowsOnly(what) {
  return IS_WINDOWS ? false : `Windows only: ${what}`;
}

function posixOnly(what) {
  return IS_WINDOWS ? `POSIX only: ${what}` : false;
}

function linuxOnly(what) {
  return process.platform === 'linux' ? false : `Linux only: ${what}`;
}

let fileSymlinkVerdict;

// Windows creates file symlinks only with Developer Mode or an elevated token;
// POSIX always can. Probed once per process in a throwaway temp directory.
function fileSymlinkSkip() {
  if (fileSymlinkVerdict === undefined) {
    fileSymlinkVerdict = IS_WINDOWS && !canCreateFileSymlink() ? FILE_SYMLINK_REASON : false;
  }
  return fileSymlinkVerdict;
}

function canCreateFileSymlink() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-symlink-probe-'));
  try {
    const target = path.join(dir, 'target.txt');
    fs.writeFileSync(target, '');
    fs.symlinkSync(target, path.join(dir, 'link.txt'), 'file');
    return true;
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) return false;
    throw error;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A directory link that needs no privilege anywhere: a junction on Windows
// (absolute target), a directory symlink elsewhere. It throws instead of skipping.
function linkDirectory(target, linkPath) {
  if (IS_WINDOWS) {
    fs.symlinkSync(path.resolve(target), linkPath, 'junction');
  } else {
    fs.symlinkSync(target, linkPath, 'dir');
  }
}

module.exports = {
  FILE_SYMLINK_REASON,
  IS_WINDOWS,
  fileSymlinkSkip,
  linkDirectory,
  linuxOnly,
  posixOnly,
  windowsOnly,
};
