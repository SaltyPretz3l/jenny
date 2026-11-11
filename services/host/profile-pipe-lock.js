'use strict';

// A process-lifetime exclusive named pipe, shared by the CLI and the hosted
// server for their Windows profile lock. libuv opens the pipe with
// FILE_FLAG_FIRST_PIPE_INSTANCE, so a second listen on a held name fails
// EADDRINUSE, and the kernel releases the pipe when the process dies: no
// stale-pid file can wedge a profile. Each caller maps the typed rejection
// (`reason` is `busy` or `unavailable`) to its own error codes.

const net = require('node:net');
const os = require('node:os');
const { createHash } = require('node:crypto');

function userName() {
  try { return String(os.userInfo().username || ''); } catch (_error) { return ''; }
}

// One pipe per (prefix, profile, user): the real path, case-folded where the
// file system is, so two spellings of one directory share a lock; the user so
// two accounts never collide on a name. The path itself never appears.
function pipeLockName(prefix, directory) {
  const key = process.platform === 'win32' ? String(directory).toLowerCase() : String(directory);
  const digest = createHash('sha256').update(`${key}\0${userName()}`).digest('hex').slice(0, 32);
  return `${prefix}${digest}`;
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

function pipeLockFailure(reason, cause) {
  return Object.assign(new Error(`pipe_lock_${reason}`), { reason, cause, osCode: cause && cause.code ? cause.code : undefined });
}

// Resolves { kind: 'pipe', release() }. `release()` is idempotent and returns a
// promise that settles once the pipe is closed. `onLost(error|null)` fires once
// if the listener dies while the lock is held, never after `release()`.
async function acquirePipeLock({ prefix, directory, onLost = () => {} }) {
  let server;
  try {
    server = await listenExclusive(pipeLockName(prefix, directory));
  } catch (error) {
    throw pipeLockFailure(error && error.code === 'EADDRINUSE' ? 'busy' : 'unavailable', error);
  }
  // Holding the lock must not keep an otherwise finished process alive.
  server.unref();
  let released = false;
  const lost = (error) => {
    if (released) return;
    released = true;
    onLost(error);
  };
  server.on('error', lost);
  server.on('close', () => lost(null));
  return {
    kind: 'pipe',
    release() {
      if (released) return Promise.resolve();
      released = true;
      return new Promise((resolve) => {
        if (!server.listening) { resolve(); return; }
        server.close(() => resolve());
      });
    },
  };
}

module.exports = { acquirePipeLock, pipeLockName };
