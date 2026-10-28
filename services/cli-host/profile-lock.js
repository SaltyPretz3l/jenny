'use strict';

// The CLI's profile identity and liveness lock (Jenny CLI plan, decision 5).
// Two orthogonal guards keep a profile with one host at a time: the ownership
// marker records the MODE (`cli`, never opened by the desktop or the server),
// and a live process lock records LIVENESS. On Windows the lock is a named
// pipe held for the process lifetime: libuv opens it with
// FILE_FLAG_FIRST_PIPE_INSTANCE, a second listen fails EADDRINUSE and the
// kernel releases it when the process dies, so no stale-pid file can wedge a
// profile. On POSIX the existing flock helper (`services/host/profile_lock.py`)
// holds `.cli.lock` through an inherited descriptor for the same reason.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { CLI_ERROR_CODES } = require('../backend/error-codes');
const { claimCliProfile } = require('../host/profile-ownership');

const CLI_PROFILE_ERROR_CODES = Object.freeze({
  BUSY: CLI_ERROR_CODES.PROFILE_BUSY,
  LOCK_LOST: CLI_ERROR_CODES.PROFILE_LOCK_LOST,
  LOCK_UNAVAILABLE: CLI_ERROR_CODES.PROFILE_LOCK_UNAVAILABLE,
});

const LOCK_FILE = '.cli.lock';
const DEFAULT_LOCK_HELPER = path.join(__dirname, '..', 'host', 'profile_lock.py');
const PIPE_PREFIX = '\\\\.\\pipe\\jenny-cli-';

function lockError(code, reason, message) {
  return Object.assign(new Error(message), { code, reason });
}

function userName() {
  try { return String(os.userInfo().username || ''); } catch (_error) { return ''; }
}

// One pipe per (profile, user): the real path, case-folded where the file
// system is, so two spellings of one directory share a lock; the user so two
// accounts never collide on a name.
function cliLockName(directory) {
  const key = process.platform === 'win32' ? String(directory).toLowerCase() : String(directory);
  const digest = createHash('sha256').update(`${key}\0${userName()}`).digest('hex').slice(0, 32);
  return `${PIPE_PREFIX}${digest}`;
}

function listenExclusive(name) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', reject);
    server.listen({ path: name, exclusive: true }, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

async function acquirePipeLock(directory, onLost) {
  let server;
  try {
    server = await listenExclusive(cliLockName(directory));
  } catch (error) {
    if (error && error.code === 'EADDRINUSE') {
      throw lockError(CLI_PROFILE_ERROR_CODES.BUSY, 'profile_busy', 'Another Jenny CLI holds this profile.');
    }
    throw lockError(CLI_PROFILE_ERROR_CODES.LOCK_UNAVAILABLE, 'lock_unavailable',
      `The profile lock could not be created (${error && error.code ? error.code : 'unknown'}).`);
  }
  // Holding the lock must not keep an otherwise finished CLI alive.
  server.unref();
  let released = false;
  const lost = (error) => {
    if (released) return;
    released = true;
    onLost(lockError(CLI_PROFILE_ERROR_CODES.LOCK_LOST, 'lock_lost',
      `The profile lock was lost (${error && error.code ? error.code : 'closed'}).`));
  };
  server.on('error', lost);
  server.on('close', () => lost(null));
  return {
    kind: 'pipe',
    release() {
      if (released) return;
      released = true;
      server.close();
    },
  };
}

// Refuses before the lock file is opened when either half of the helper is
// missing: an installed copy reads the helper from app.asar.unpacked, which an
// external interpreter can reach; a path inside the asar it cannot.
function acquireFlockLock(directory, pythonExecutable, helperPath = DEFAULT_LOCK_HELPER) {
  if (!pythonExecutable) {
    throw lockError(CLI_PROFILE_ERROR_CODES.LOCK_UNAVAILABLE, 'lock_unavailable',
      'The profile lock needs the sidecar Python on this platform.');
  }
  if (!helperPath || !fs.existsSync(helperPath)) {
    throw lockError(CLI_PROFILE_ERROR_CODES.LOCK_UNAVAILABLE, 'lock_unavailable',
      `The profile lock helper was not found at ${helperPath || '(no path)'}.`);
  }
  const fd = fs.openSync(path.join(directory, LOCK_FILE),
    fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  let retained = false;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw lockError(CLI_PROFILE_ERROR_CODES.LOCK_UNAVAILABLE, 'lock_unavailable', 'The profile lock file is not a plain file.');
    }
    const challenge = randomBytes(32).toString('hex');
    const result = spawnSync(pythonExecutable, [helperPath, challenge], {
      stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 10_000, maxBuffer: 1024, windowsHide: true,
    });
    if (result.status === 2) {
      throw lockError(CLI_PROFILE_ERROR_CODES.BUSY, 'profile_busy', 'Another Jenny CLI holds this profile.');
    }
    if (result.error || result.status !== 0 || result.stdout?.toString('utf8') !== `locked:${challenge}`) {
      throw lockError(CLI_PROFILE_ERROR_CODES.LOCK_UNAVAILABLE, 'lock_unavailable',
        'The profile lock helper did not acknowledge acquisition.');
    }
    retained = true;
    let released = false;
    return { kind: 'flock', release() { if (!released) { released = true; fs.closeSync(fd); } } };
  } finally {
    if (!retained) fs.closeSync(fd);
  }
}

// Claim the `cli` marker, then hold the live lock. Resolves
// { directory, kind, release() }; rejects with a typed error (BUSY when
// another CLI holds the profile). `onLost` fires once if the lock is lost
// after acquisition so the host can fail closed.
async function acquireCliProfile({ userDataPath, pythonExecutable = '', lockHelperPath = DEFAULT_LOCK_HELPER, onLost = () => {} } = {}) {
  const directory = claimCliProfile(userDataPath);
  const lock = process.platform === 'win32'
    ? await acquirePipeLock(directory, onLost)
    : acquireFlockLock(directory, pythonExecutable, lockHelperPath);
  return { directory, kind: lock.kind, release: lock.release };
}

module.exports = { CLI_PROFILE_ERROR_CODES, acquireCliProfile, acquireFlockLock, cliLockName };
