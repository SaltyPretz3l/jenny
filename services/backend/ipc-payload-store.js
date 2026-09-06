'use strict';

const path = require('path');
const {
  DEFAULT_PAYLOAD_GRACE_MS,
  normalizePayloadKey,
  selectOrphanPayloads,
} = require('./ipc-payload-retention');

function createIpcPayloadStore({ userDataPath, fsImpl = require('fs'), now = Date.now } = {}) {
  const rootDir = typeof userDataPath === 'string' && userDataPath.length
    ? path.join(userDataPath, 'background-memory', 'ipc-payloads')
    : '';

  function resolveTiming(options = {}) {
    return {
      nowMs: options.nowMs === undefined ? now() : options.nowMs,
      graceMs: options.graceMs === undefined ? DEFAULT_PAYLOAD_GRACE_MS : options.graceMs,
    };
  }

  // Everything the directory actually holds, as { name, mtimeMs }. The name is
  // the REAL on-disk name -- never a normalized key -- because it is what gets
  // unlinked. Any file whose state cannot be read is simply omitted, which
  // keeps it.
  function listPayloadEntries() {
    let directoryEntries;
    try {
      directoryEntries = fsImpl.readdirSync(rootDir, { withFileTypes: true });
    } catch (_error) {
      return [];
    }
    if (!Array.isArray(directoryEntries)) return [];

    const entries = [];
    for (const entry of directoryEntries) {
      if (!entry?.isFile?.()) continue;
      try {
        const stats = fsImpl.statSync(path.join(rootDir, entry.name));
        if (typeof stats?.isFile === 'function' && !stats.isFile()) continue;
        entries.push({ name: entry.name, mtimeMs: stats?.mtimeMs });
      } catch (_error) {
        // Keep files whose metadata cannot be read.
      }
    }
    return entries;
  }

  function listOrphanCandidates(options = {}) {
    if (!rootDir) return [];
    const { nowMs, graceMs } = resolveTiming(options);
    return selectOrphanPayloads({
      entries: listPayloadEntries(), referenced: new Set(), nowMs, graceMs,
    });
  }

  function prunePayloadPaths(candidateNames, referencedKeys, options = {}) {
    if (!rootDir) return { deleted: 0 };
    const { nowMs, graceMs } = resolveTiming(options);
    // Candidates arrive as normalized keys (they came from persisted message
    // references), so they are matched against the listing by the same key
    // rather than statted directly -- statting a lowercased name only finds the
    // file on a case-insensitive filesystem, and a mixed-case payload would
    // silently never be pruned anywhere else.
    const candidateKeys = new Set(
      (Array.isArray(candidateNames) ? candidateNames : []).map(normalizePayloadKey)
    );
    const removable = selectOrphanPayloads({
      entries: listPayloadEntries().filter(
        (entry) => candidateKeys.has(normalizePayloadKey(entry.name))
      ),
      referenced: referencedKeys,
      nowMs,
      graceMs,
    });
    let deleted = 0;
    for (const name of removable) {
      try {
        fsImpl.unlinkSync(path.join(rootDir, name));
        deleted += 1;
      } catch (_error) {
        // Best effort cleanup - file may already be deleted or locked.
      }
    }
    return { deleted };
  }

  function pruneUnreferencedPayloads(referencedKeys, options = {}) {
    if (!rootDir) return { deleted: 0 };
    const timing = resolveTiming(options);
    return prunePayloadPaths(listOrphanCandidates(timing), referencedKeys, timing);
  }

  return {
    rootDir,
    listOrphanCandidates,
    prunePayloadPaths,
    pruneUnreferencedPayloads,
  };
}

module.exports = {
  createIpcPayloadStore,
};
