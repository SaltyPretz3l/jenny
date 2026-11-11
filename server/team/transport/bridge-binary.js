'use strict';

// Where the `jenny-team-bridge` binary is: `<resources>/sidecar/` in a packaged
// app, `build/sidecar/` in a source checkout. No binary means the transport is
// unavailable, which the team host reports as `team_transport_down`.

const fs = require('node:fs');
const path = require('node:path');

const { spawnBridgeChild } = require('./control-channel');

const BINARY_NAME = process.platform === 'win32' ? 'jenny-team-bridge.exe' : 'jenny-team-bridge';
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** The first existing candidate, or null. */
function resolveBridgeBinary({
  resourcesPath = process.resourcesPath, root = REPO_ROOT, exists = fs.existsSync,
} = {}) {
  const candidates = [];
  if (typeof resourcesPath === 'string' && resourcesPath !== '') {
    candidates.push(path.join(resourcesPath, 'sidecar', BINARY_NAME));
  }
  candidates.push(path.join(root, 'build', 'sidecar', BINARY_NAME));
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** Spawns the resolved binary in `mode`; throws `transport_unavailable` when there is none. */
function defaultSpawnChild(mode) {
  const binaryPath = resolveBridgeBinary();
  if (!binaryPath) throw Object.assign(new Error('transport_unavailable'), { code: 'transport_unavailable' });
  return spawnBridgeChild(mode, { binaryPath });
}

module.exports = { BINARY_NAME, defaultSpawnChild, resolveBridgeBinary };
