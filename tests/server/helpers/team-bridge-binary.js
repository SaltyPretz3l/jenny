'use strict';

// Finds a built `jenny-team-bridge` for the native test, or null. Looked up in
// build/sidecar (the packaged location), then the crate's release and debug
// output. The test skips itself when this returns null.

const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const NAME = process.platform === 'win32' ? 'jenny-team-bridge.exe' : 'jenny-team-bridge';

function findTeamBridgeBinary() {
  const candidates = [
    path.join(ROOT, 'build', 'sidecar', NAME),
    path.join(ROOT, 'native', 'jenny-team-bridge', 'target', 'release', NAME),
    path.join(ROOT, 'native', 'jenny-team-bridge', 'target', 'debug', NAME),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

// Puts `"loopback_only": true` into the child's `start` line, so the real binary binds
// loopback sockets only: no socket on a real interface, so no firewall prompt on a
// test run. Every other line passes through unchanged.
function forceLoopbackOnly(child) {
  let buffered = '';
  let rewritten = false;
  const rewrite = new Transform({
    transform(chunk, _encoding, callback) {
      if (rewritten) {
        callback(null, chunk);
        return;
      }
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline === -1) {
        callback();
        return;
      }
      rewritten = true;
      const start = JSON.parse(buffered.slice(0, newline));
      if (start.t === 'start') start.loopback_only = true;
      const rest = buffered.slice(newline + 1);
      buffered = '';
      callback(null, `${JSON.stringify(start)}\n${rest}`);
    },
  });
  rewrite.on('error', () => {});
  // The real pipe may close first (EPIPE) once the child exits.
  child.stdin.on('error', () => {});
  rewrite.pipe(child.stdin);
  Object.defineProperty(child, 'stdin', { value: rewrite, configurable: true });
  return child;
}

module.exports = { findTeamBridgeBinary, forceLoopbackOnly };
