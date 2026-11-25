'use strict';

// Where the `jenny-computer` helper binary is: `<resources>/sidecar/` in a
// packaged app, `build/sidecar/` in a source checkout (the same lookup as the
// team bridge, server/team/transport/bridge-binary.js). No binary means the
// feature is unavailable, which is not an error.

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function binaryNameFor(platform) {
  return platform === 'win32' ? 'jenny-computer.exe' : 'jenny-computer';
}

const BINARY_NAME = binaryNameFor(process.platform);

/** The first existing candidate (absolute when its inputs are), or '' when there is none. */
function resolveHelperBinary({
  resourcesPath = process.resourcesPath,
  root = REPO_ROOT,
  exists = fs.existsSync,
  platform = process.platform,
} = {}) {
  const name = binaryNameFor(platform);
  const candidates = [];
  if (typeof resourcesPath === 'string' && resourcesPath !== '') {
    candidates.push(path.join(resourcesPath, 'sidecar', name));
  }
  candidates.push(path.join(root, 'build', 'sidecar', name));
  return candidates.find((candidate) => exists(candidate)) ?? '';
}

module.exports = { BINARY_NAME, resolveHelperBinary };
