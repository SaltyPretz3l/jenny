'use strict';

const { HOST_ERROR_CODES } = require('../backend/error-codes');

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { readJson, writeJson } = require('./durable-json');

const MARKER = 'profile-owner.json';
const OWNER_TEMP_PATTERN = /^\.profile-owner-[a-f0-9]{32}\.tmp$/u;
const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function ownershipError(message) {
  return Object.assign(new Error(message), { code: HOST_ERROR_CODES.CONFLICT });
}

function markerValue(mode) {
  return { schema_version: 1, host_mode: mode };
}

function hasHostedProfileEvidence(directory) {
  return fs.existsSync(path.join(directory, 'host-profile.json'))
    || fs.existsSync(path.join(directory, '.host.lock'));
}

function fsyncDirectory(directory) {
  if (process.platform === 'win32') return;
  const directoryFd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
}

function retryNormalMarkerRead(markerPath) {
  try { return readJson(markerPath, { maxBytes: 4096 }); } catch (_error) { return undefined; }
}

function recoverLinkedOwnerMarker(directory, markerPath, originalError) {
  let markerStat;
  try { markerStat = fs.lstatSync(markerPath); } catch (_error) { throw originalError; }
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 2) {
    if (markerStat.nlink > 1) throw ownershipError('Profile ownership marker is ambiguous.');
    throw originalError;
  }
  const matches = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !OWNER_TEMP_PATTERN.test(entry.name)) continue;
    let candidateStat;
    try { candidateStat = fs.lstatSync(path.join(directory, entry.name)); } catch (_error) { continue; }
    if (candidateStat.isFile() && !candidateStat.isSymbolicLink()
      && candidateStat.dev === markerStat.dev && candidateStat.ino === markerStat.ino) {
      matches.push(entry.name);
    }
  }
  if (matches.length === 0) {
    const retried = retryNormalMarkerRead(markerPath);
    if (retried !== undefined) return retried;
    throw ownershipError('Profile ownership marker is ambiguous.');
  }
  if (matches.length !== 1) throw ownershipError('Profile ownership marker is ambiguous.');

  let fd;
  try {
    fd = fs.openSync(markerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.dev !== markerStat.dev || before.ino !== markerStat.ino
      || before.size < 1 || before.size > 4096 || ![1, 2].includes(before.nlink)) {
      throw ownershipError('Profile ownership marker is ambiguous.');
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || ![1, 2].includes(after.nlink)) {
      throw ownershipError('Profile ownership marker is ambiguous.');
    }
    let value;
    try { value = JSON.parse(STRICT_UTF8_DECODER.decode(bytes)); } catch (_error) {
      throw ownershipError('Profile ownership marker is ambiguous.');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 2
      || !Object.hasOwn(value, 'schema_version') || !Object.hasOwn(value, 'host_mode')
      || value.schema_version !== 1 || !['desktop', 'server'].includes(value.host_mode)) {
      throw ownershipError('Profile ownership marker is ambiguous.');
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try { fs.unlinkSync(path.join(directory, matches[0])); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fsyncDirectory(directory);
  const recovered = retryNormalMarkerRead(markerPath);
  if (recovered === undefined) throw ownershipError('Profile ownership marker is ambiguous.');
  return recovered;
}

function readOwnerMarker(directory, markerPath) {
  try {
    return readJson(markerPath, { maxBytes: 4096 });
  } catch (error) {
    return recoverLinkedOwnerMarker(directory, markerPath, error);
  }
}

function isRepairableTornDesktopMarker(markerPath) {
  let identity;
  try { identity = fs.lstatSync(markerPath); } catch (_error) { return false; }
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1
    || identity.size > 4096) return false;
  let fd;
  try {
    fd = fs.openSync(markerPath, fs.constants.O_RDONLY
      | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.dev !== identity.dev || before.ino !== identity.ino
      || before.nlink !== 1 || before.size !== identity.size) return false;
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!count) break;
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (offset !== before.size || after.dev !== before.dev || after.ino !== before.ino
      || after.nlink !== 1 || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) return false;
    if (offset === 0) return true;
    try {
      JSON.parse(STRICT_UTF8_DECODER.decode(buffer.subarray(0, offset)));
      return false;
    } catch (_error) {
      return true;
    }
  } catch (_error) {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Publish a fully written inode without ever replacing an existing owner. A
// hard-link publish gives both contenders an atomic create-if-absent boundary;
// the private temporary name is removed before readers validate link count.
function createOwnerMarkerExclusive(markerPath, value) {
  const directory = path.dirname(markerPath);
  const temp = path.join(directory, `.profile-owner-${randomBytes(16).toString('hex')}.tmp`);
  let fd;
  let created = false;
  let failure = null;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.linkSync(temp, markerPath);
      created = true;
    } catch (error) {
      if (error.code === 'EEXIST') created = false;
      else throw error;
    }
    if (created) {
      try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fsyncDirectory(directory);
    }
  } catch (error) {
    failure = error;
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); } catch (error) { failure ||= error; }
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') failure ||= error; }
  }
  if (failure) throw failure;
  return created;
}

function assertDesktopProfile(userDataPath) {
  if (hasHostedProfileEvidence(userDataPath)) {
    throw ownershipError('Hosted profiles must be opened by the Jenny server.');
  }
  const markerPath = path.join(userDataPath, MARKER);
  const marker = readOwnerMarker(path.dirname(markerPath), markerPath);
  if (marker && (marker.schema_version !== 1 || marker.host_mode !== 'desktop')) {
    throw ownershipError('Hosted profiles must be opened by the Jenny server.');
  }
}

function readHostedProfile(directory) {
  const markerPath = path.join(directory, MARKER);
  const marker = readOwnerMarker(directory, markerPath);
  if (marker && (marker.schema_version !== 1 || marker.host_mode !== 'server')) {
    throw Object.assign(new Error('invalid_host_profile'), { code: HOST_ERROR_CODES.CONFLICT });
  }
  // Absence of sessions.json is not evidence that a profile is unowned.
  if (!marker && fs.existsSync(directory) && fs.readdirSync(directory)
    .some((name) => name !== '.host.lock' && !OWNER_TEMP_PATTERN.test(name))) {
    throw ownershipError('desktop_profile_requires_import');
  }
  return marker;
}

function claimDesktopMarker(directory, markerPath) {
  if (hasHostedProfileEvidence(directory)) {
    throw ownershipError('Hosted profiles must be opened by the Jenny server.');
  }
  try {
    return readOwnerMarker(directory, markerPath);
  } catch (error) {
    // A desktop launch may repair a torn/unreadable marker only when no hosted
    // sentinel or lock exists. Atomic server publication prevents a first-boot
    // hosted claim from creating this ambiguous state.
    if (hasHostedProfileEvidence(directory)) {
      throw ownershipError('Hosted profiles must be opened by the Jenny server.');
    }
    if (error.code === HOST_ERROR_CODES.CONFLICT) throw error;
    if (!(error instanceof SyntaxError)) throw error;
    if (!isRepairableTornDesktopMarker(markerPath)) throw error;
    writeJson(markerPath, markerValue('desktop'));
    return readOwnerMarker(directory, markerPath);
  }
}

function claimProfileOwner(userDataPath, mode) {
  if (!['desktop', 'server'].includes(mode) || !path.isAbsolute(userDataPath)) throw new Error('invalid_profile_owner');
  if (mode === 'server') readHostedProfile(userDataPath);
  fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  const directory = fs.realpathSync(userDataPath);
  const markerPath = path.join(directory, MARKER);
  const marker = mode === 'desktop'
    ? claimDesktopMarker(directory, markerPath)
    : readOwnerMarker(directory, markerPath);
  if (!marker) createOwnerMarkerExclusive(markerPath, markerValue(mode));
  const claimed = readOwnerMarker(directory, markerPath);
  if (claimed?.schema_version !== 1 || claimed.host_mode !== mode) {
    throw ownershipError('Profile ownership does not match this host.');
  }
  return directory;
}

function claimDesktopProfile(userDataPath) {
  return claimProfileOwner(userDataPath, 'desktop');
}

function acquireProfile({ userDataPath, pythonExecutable }) {
  // Refuse existing desktop data before chmod, mkdir, or lock-file creation.
  readHostedProfile(userDataPath);
  if (process.platform !== 'linux') {
    throw Object.assign(new Error('Hosted profile locking requires Linux.'), { code: HOST_ERROR_CODES.UNAVAILABLE });
  }
  const directory = claimProfileOwner(userDataPath, 'server');
  if (!fs.statSync(directory).isDirectory()) throw new Error('invalid_profile_directory');
  fs.chmodSync(directory, 0o700);
  const fd = fs.openSync(path.join(directory, '.host.lock'),
    fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  let retained = false;
  try {
    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).nlink !== 1) throw new Error('invalid_profile_lock');
    const challenge = randomBytes(32).toString('hex');
    const result = spawnSync(pythonExecutable, [path.join(__dirname, 'profile_lock.py'), challenge], {
      stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 10_000, maxBuffer: 1024, windowsHide: true,
    });
    if (result.status === 2) {
      throw Object.assign(new Error('Profile is locked or locking is unavailable.'), { code: HOST_ERROR_CODES.CONFLICT });
    }
    if (result.error || result.status !== 0 || result.stdout?.toString('utf8') !== `locked:${challenge}`) {
      throw Object.assign(new Error('Profile lock helper did not acknowledge acquisition.'), { code: HOST_ERROR_CODES.UNAVAILABLE });
    }
    retained = true;
    let closed = false;
    return { directory, release() { if (!closed) { closed = true; fs.closeSync(fd); } } };
  } finally {
    if (!retained) fs.closeSync(fd);
  }
}

module.exports = { acquireProfile, assertDesktopProfile, claimDesktopProfile, claimProfileOwner };
