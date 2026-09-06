'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { trackDirectory } = require('./resource-cleanup');

function createTrackedUserDataPath(prefix) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackDirectory(userDataPath);
  return userDataPath;
}

function writeTurnDiagnostic(userDataPath, dateSegment, streamId, payload) {
  const dir = path.join(userDataPath, 'diagnostics', dateSegment);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${streamId}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8'
  );
}

module.exports = {
  createTrackedUserDataPath,
  writeTurnDiagnostic,
};
