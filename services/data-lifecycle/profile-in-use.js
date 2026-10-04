'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const WINDOWS_LOCK_BUSY_CODES = Object.freeze(['EBUSY', 'EPERM', 'EACCES']);

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === 'EPERM';
  }
}

// Chromium's process singleton keeps <userData>\lockfile open without write
// sharing for the life of the instance and deletes it on close, so a failed
// read/write open proves a live Jenny. The file is only probed, never written
// or deleted.
function detectWindowsInstance(userDataPath, fsImpl) {
  const lockfile = path.win32.join(userDataPath, 'lockfile');
  let descriptor;
  try {
    descriptor = fsImpl.openSync(lockfile, 'r+');
  } catch (error) {
    return WINDOWS_LOCK_BUSY_CODES.includes(error?.code)
      ? { inUse: true, evidence: 'lockfile' }
      : { inUse: false, evidence: '' };
  }
  try {
    fsImpl.closeSync(descriptor);
  } catch (_error) {
    // The probe handle is released with the process; the lock was free.
  }
  return { inUse: false, evidence: '' };
}

// Elsewhere <userData>/SingletonLock is a symlink whose target is
// "<hostname>-<pid>" while an instance runs.
function detectPosixInstance(userDataPath, { fsImpl, hostname, isProcessAlive }) {
  let target;
  try {
    target = String(fsImpl.readlinkSync(path.posix.join(userDataPath, 'SingletonLock')));
  } catch (_error) {
    return { inUse: false, evidence: '' };
  }
  const split = target.lastIndexOf('-');
  const pid = Number(target.slice(split + 1));
  if (split <= 0 || !Number.isInteger(pid) || pid <= 0) return { inUse: false, evidence: '' };
  // A lock written by another machine (shared profile) cannot be disproved here.
  if (target.slice(0, split) !== hostname) return { inUse: true, evidence: 'singleton-lock-foreign-host' };
  return isProcessAlive(pid)
    ? { inUse: true, evidence: 'singleton-lock' }
    : { inUse: false, evidence: '' };
}

function detectRunningJenny(userDataPath, {
  platform = process.platform,
  fsImpl = fs,
  hostname = os.hostname(),
  isProcessAlive = processIsAlive,
} = {}) {
  return platform === 'win32'
    ? detectWindowsInstance(userDataPath, fsImpl)
    : detectPosixInstance(userDataPath, { fsImpl, hostname, isProcessAlive });
}

module.exports = { detectRunningJenny };
