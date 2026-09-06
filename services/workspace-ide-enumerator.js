'use strict';

const ENUMERATION_DEFAULTS = Object.freeze({
  maxDirectories: 20000,
  maxEntries: 100000,
  maxDurationMs: 2000,
});

const ENUMERATION_CEILINGS = Object.freeze({
  maxDirectories: 50000,
  maxEntries: 250000,
  maxDurationMs: 30000,
});

function normalizePositiveInteger(value, fallback, ceiling) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), ceiling);
}

function cancellationReason({ signal = null, assertCurrent = null } = {}) {
  if (typeof assertCurrent === 'function') assertCurrent();
  return signal?.aborted === true ? 'cancelled' : null;
}

function isAlreadyClosedDirectoryError(error) {
  return error?.code === 'ERR_DIR_CLOSED' || error?.code === 'ERR_INVALID_STATE';
}

async function* iterateDirectoryEntries(fs, directoryPath, { onCleanupError = null } = {}) {
  if (typeof fs?.opendir === 'function') {
    const directory = await fs.opendir(directoryPath);
    try {
      for await (const entry of directory) yield entry;
    } finally {
      try {
        await directory.close?.();
      } catch (error) {
        // Async iteration normally closes the handle itself. A redundant or
        // degraded cleanup must never replace cancellation/budget outcomes.
        if (!isAlreadyClosedDirectoryError(error)) {
          try {
            onCleanupError?.();
          } catch (_callbackError) {
            // Diagnostics callbacks are non-fatal by contract.
          }
        }
      }
    }
    return;
  }

  // Compatibility for injected test/donor filesystem adapters. Production
  // Node/Electron always takes the streaming opendir path above.
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) yield entry;
}

function buildEnumerationMeta(state, truncationReason = null) {
  return {
    truncated: Boolean(truncationReason),
    truncationReason,
    totalsKnown: !truncationReason,
    filesScanned: state.filesScanned,
    directoriesScanned: state.directoriesScanned,
    entriesScanned: state.entriesScanned,
    elapsedMs: Math.max(0, state.now() - state.startedAt),
  };
}

async function walkWorkspaceFiles({
  fs,
  initialRelPath = '',
  resolveDirectory,
  onFile,
  shouldSkipDirectory = () => false,
  shouldSkipError = () => false,
  maxFiles,
  maxDirectories = ENUMERATION_DEFAULTS.maxDirectories,
  maxEntries = ENUMERATION_DEFAULTS.maxEntries,
  maxDurationMs = ENUMERATION_DEFAULTS.maxDurationMs,
  signal = null,
  assertCurrent = null,
  now = Date.now,
  onCleanupError = null,
} = {}) {
  if (!fs || typeof resolveDirectory !== 'function' || typeof onFile !== 'function') {
    throw new TypeError('walkWorkspaceFiles requires fs, resolveDirectory, and onFile');
  }
  const limits = {
    maxFiles: normalizePositiveInteger(maxFiles, 20000, 50000),
    maxDirectories: normalizePositiveInteger(
      maxDirectories,
      ENUMERATION_DEFAULTS.maxDirectories,
      ENUMERATION_CEILINGS.maxDirectories
    ),
    maxEntries: normalizePositiveInteger(
      maxEntries,
      ENUMERATION_DEFAULTS.maxEntries,
      ENUMERATION_CEILINGS.maxEntries
    ),
    maxDurationMs: normalizePositiveInteger(
      maxDurationMs,
      ENUMERATION_DEFAULTS.maxDurationMs,
      ENUMERATION_CEILINGS.maxDurationMs
    ),
  };
  const state = {
    now: typeof now === 'function' ? now : Date.now,
    startedAt: 0,
    filesScanned: 0,
    directoriesScanned: 0,
    entriesScanned: 0,
  };
  state.startedAt = state.now();
  const queue = [String(initialRelPath || '')];
  let queueHead = 0;
  let directoriesQueued = 1;
  let stopReason = null;
  let partialReason = null;

  const checkStop = () => {
    const cancelled = cancellationReason({ signal, assertCurrent });
    if (cancelled) return cancelled;
    if (state.now() - state.startedAt >= limits.maxDurationMs) return 'time_limit';
    if (state.entriesScanned >= limits.maxEntries) return 'entry_limit';
    return null;
  };

  walk:
  while (queueHead < queue.length) {
    stopReason = checkStop();
    if (stopReason) break;
    const relPath = queue[queueHead];
    queueHead += 1;

    let directoryPath;
    try {
      directoryPath = await resolveDirectory(relPath);
      stopReason = checkStop();
      if (stopReason) break;
    } catch (error) {
      if (shouldSkipError(error, relPath)) {
        partialReason = partialReason || 'io_error';
        continue;
      }
      throw error;
    }
    if (!directoryPath) continue;
    state.directoriesScanned += 1;

    try {
      for await (const dirent of iterateDirectoryEntries(fs, directoryPath, { onCleanupError })) {
        stopReason = checkStop();
        if (stopReason) break walk;
        state.entriesScanned += 1;
        if (dirent?.isSymbolicLink?.()) continue;

        const name = String(dirent?.name || '');
        if (!name) continue;
        const entryRelPath = relPath ? `${relPath}/${name}` : name;
        if (dirent.isDirectory?.()) {
          if (shouldSkipDirectory(name, entryRelPath)) continue;
          if (directoriesQueued >= limits.maxDirectories) {
            stopReason = 'directory_limit';
            break walk;
          }
          queue.push(entryRelPath);
          directoriesQueued += 1;
          continue;
        }
        if (!dirent.isFile?.()) continue;
        if (state.filesScanned >= limits.maxFiles) {
          stopReason = 'file_limit';
          break walk;
        }
        state.filesScanned += 1;
        const keepGoing = await onFile(entryRelPath, state);
        stopReason = checkStop();
        if (stopReason) break walk;
        if (keepGoing === false) {
          stopReason = 'consumer_limit';
          break walk;
        }
      }
    } catch (error) {
      if (shouldSkipError(error, relPath)) {
        partialReason = partialReason || 'io_error';
        continue;
      }
      throw error;
    }
  }

  return buildEnumerationMeta(state, stopReason || partialReason);
}

module.exports = {
  ENUMERATION_DEFAULTS,
  buildEnumerationMeta,
  cancellationReason,
  iterateDirectoryEntries,
  normalizePositiveInteger,
  walkWorkspaceFiles,
};
