'use strict';

const fs = require('fs');
const path = require('path');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function listDirectory(dir, result) {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      result.failed += 1;
    }
    return [];
  }
}

// Removes `name` from `dir` when it is a regular file; links and directories are
// never followed or entered. A file that vanished first counts as removed.
function removeRegularFile(dir, name, result) {
  const filePath = path.join(dir, name);
  try {
    if (fs.lstatSync(filePath).isFile()) {
      fs.unlinkSync(filePath);
      result.removed += 1;
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      result.removed += 1;
    } else {
      result.failed += 1;
    }
  }
}

// Deletes the recovery leftovers that still hold one chat's transcript after
// its live file is gone:
//   <rootDir>/corrupt/<id>.<ms>.json              quarantined original of a
//                                                 chat file that failed to parse
//   <rootDir>/<id>.json.<ms>.<12 hex>.tmp         atomic-write temp left by a
//                                                 process killed before rename
//   <rootDir>/<id>.<epoch>.journal                append-only journal of the chat
//   <rootDir>/corrupt/<id>.<ms>.<epoch>.journal   quarantined or copied journal
// Only direct children whose name matches exactly this chat's id are touched.
// Never throws; `failed` counts files that could not be removed.
function purgeSessionRecoveryCopies(backend, sessionId) {
  const result = { removed: 0, failed: 0 };
  try {
    const base = escapeRegExp(path.basename(backend._sessionFilePath(sessionId), '.json'));
    const quarantineName = new RegExp(`^${base}\\.\\d{10,16}\\.json$`);
    const tempName = new RegExp(`^${base}\\.json\\.\\d{10,16}\\.[0-9a-f]{12}\\.tmp$`);
    const quarantineJournalName = new RegExp(`^${base}\\.\\d{10,16}\\.\\d+\\.journal$`);
    const liveJournalName = new RegExp(`^${base}\\.\\d+\\.journal$`);
    const quarantineDir = path.join(backend._rootDir, 'corrupt');
    for (const name of listDirectory(quarantineDir, result)) {
      if (quarantineName.test(name) || quarantineJournalName.test(name)) {
        removeRegularFile(quarantineDir, name, result);
      }
    }
    // A chat created again under this id owns the journals beside its file.
    const chatExists = fs.existsSync(backend._sessionFilePath(sessionId));
    for (const name of listDirectory(backend._rootDir, result)) {
      if (tempName.test(name) || (!chatExists && liveJournalName.test(name))) {
        removeRegularFile(backend._rootDir, name, result);
      }
    }
  } catch (_error) {
    result.failed += 1;
  }
  return result;
}

module.exports = { purgeSessionRecoveryCopies };
