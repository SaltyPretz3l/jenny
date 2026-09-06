'use strict';

const fsPromises = require('node:fs/promises');
const nodePath = require('node:path');

const { sameFileIdentity } = require('./versioned-workspace-file-bytes');

const DEFAULT_MAX_DIRECTORIES = 2_048;
const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_DELETIONS = 256;
const DEFAULT_MAX_ELAPSED_MS = 2_000;
const TEMP_NAME_RE = /^\..+\.jenny-vfs-(\d{1,10})-([0-9a-f]{16})$/i;

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isInside(pathApi, rootPath, candidatePath) {
  const relative = pathApi.relative(rootPath, candidatePath);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relative)
  );
}

function samePath(pathApi, left, right) {
  return pathApi.resolve(left) === pathApi.resolve(right);
}

function defaultIsProcessAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves that an owner is gone. Permission and platform errors
    // are treated as live/unknown so recovery cannot race another Jenny process.
    return error?.code !== 'ESRCH';
  }
}

function baseOutcome(status, reason = null) {
  return {
    status,
    reason,
    directories_scanned: 0,
    entries_scanned: 0,
    deleted: 0,
    live_or_unknown_owners: 0,
    errors: 0,
    truncated: false,
  };
}

/**
 * Conservatively removes crash-orphaned atomic-save temps from one persisted
 * workspace root. Node filesystem promises cannot cancel an in-flight kernel
 * operation, so this deliberately does not race them against fake timeouts.
 * Instead the recovery runs in the background, outside the per-path write
 * queue, and enforces directory/entry/delete/time budgets between operations.
 */
async function recoverVersionedWorkspaceTemps({
  rootContext,
  fs = fsPromises,
  path = nodePath,
  isProcessAlive = defaultIsProcessAlive,
  now = Date.now,
  maxDirectories = DEFAULT_MAX_DIRECTORIES,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxDeletions = DEFAULT_MAX_DELETIONS,
  maxElapsedMs = DEFAULT_MAX_ELAPSED_MS,
} = {}) {
  if (!rootContext
    || typeof rootContext.captureContext !== 'function'
    || typeof rootContext.isCurrent !== 'function') {
    return baseOutcome('skipped', 'root_context_unavailable');
  }

  let context;
  try {
    context = rootContext.captureContext();
  } catch (_error) {
    return baseOutcome('skipped', 'root_context_unavailable');
  }
  if (context?.phase !== 'ready' || !path.isAbsolute(String(context.rootPath || ''))) {
    return baseOutcome('skipped', 'root_unavailable');
  }

  const limits = {
    directories: positiveInteger(maxDirectories, DEFAULT_MAX_DIRECTORIES),
    entries: positiveInteger(maxEntries, DEFAULT_MAX_ENTRIES),
    deletions: positiveInteger(maxDeletions, DEFAULT_MAX_DELETIONS),
    elapsedMs: positiveInteger(maxElapsedMs, DEFAULT_MAX_ELAPSED_MS),
  };
  const outcome = baseOutcome('complete');
  const startedAt = now();
  const current = () => {
    try {
      return rootContext.isCurrent(context) === true;
    } catch (_error) {
      return false;
    }
  };
  const expired = () => (now() - startedAt) >= limits.elapsedMs;
  let rootRealPath;
  let rootStats;
  try {
    rootRealPath = await fs.realpath(context.rootPath);
    rootStats = await fs.lstat(rootRealPath);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      return baseOutcome('skipped', 'root_unavailable');
    }
  } catch (_error) {
    return baseOutcome('skipped', 'root_unavailable');
  }
  if (!current()) return baseOutcome('skipped', 'root_changed');

  const queue = [rootRealPath];
  const ownerLiveness = new Map();
  let queueHead = 0;
  let queuedDirectories = 1;
  let truncationReason = null;

  scan: while (queueHead < queue.length) {
    if (!current()) {
      outcome.status = 'cancelled';
      outcome.reason = 'root_changed';
      break;
    }
    if (expired()) {
      truncationReason = 'time_limit';
      break;
    }
    if (outcome.directories_scanned >= limits.directories) {
      truncationReason = 'directory_limit';
      break;
    }

    const directoryPath = queue[queueHead];
    queueHead += 1;
    let directoryRealPath;
    let directoryStats;
    try {
      directoryStats = await fs.lstat(directoryPath);
      directoryRealPath = await fs.realpath(directoryPath);
      if (!directoryStats.isDirectory()
        || directoryStats.isSymbolicLink()
        || !samePath(path, directoryPath, directoryRealPath)
        || !isInside(path, rootRealPath, directoryRealPath)) {
        continue;
      }
    } catch (_error) {
      outcome.errors += 1;
      continue;
    }
    outcome.directories_scanned += 1;

    try {
      const directory = await fs.opendir(directoryPath);
      for await (const entry of directory) {
        if (!current()) {
          outcome.status = 'cancelled';
          outcome.reason = 'root_changed';
          break scan;
        }
        if (expired()) {
          truncationReason = 'time_limit';
          break scan;
        }
        if (outcome.entries_scanned >= limits.entries) {
          truncationReason = 'entry_limit';
          break scan;
        }
        outcome.entries_scanned += 1;

        const candidatePath = path.join(directoryPath, entry.name);
        const match = TEMP_NAME_RE.exec(entry.name);
        if (match) {
          const ownerPid = Number(match[1]);
          let ownerAlive = ownerLiveness.get(ownerPid);
          if (ownerAlive === undefined) {
            try {
              ownerAlive = isProcessAlive(ownerPid) !== false;
            } catch (_error) {
              ownerAlive = true;
              outcome.errors += 1;
            }
            ownerLiveness.set(ownerPid, ownerAlive);
          }
          if (ownerAlive) {
            outcome.live_or_unknown_owners += 1;
            continue;
          }
          try {
            const candidateStats = await fs.lstat(candidatePath);
            if (!candidateStats.isFile() || candidateStats.isSymbolicLink()) continue;
            const [candidateRealPath, currentParentRealPath] = await Promise.all([
              fs.realpath(candidatePath),
              fs.realpath(directoryPath),
            ]);
            if (!samePath(path, candidatePath, candidateRealPath)
              || !isInside(path, rootRealPath, candidateRealPath)
              || !samePath(path, directoryRealPath, currentParentRealPath)
              || !isInside(path, rootRealPath, currentParentRealPath)) {
              continue;
            }
            if (!current()) {
              outcome.status = 'cancelled';
              outcome.reason = 'root_changed';
              break scan;
            }
            const [finalStats, finalParentStats, finalRootStats] = await Promise.all([
              fs.lstat(candidatePath),
              fs.lstat(directoryPath),
              fs.lstat(rootRealPath),
            ]);
            if (!sameFileIdentity(candidateStats, finalStats)
              || !sameFileIdentity(directoryStats, finalParentStats)
              || !sameFileIdentity(rootStats, finalRootStats)) {
              continue;
            }
            if (!current()) {
              outcome.status = 'cancelled';
              outcome.reason = 'root_changed';
              break scan;
            }
            // A PID can be reused after the first directory-level liveness
            // check. Reconfirm immediately before deletion and retain the
            // candidate on every ambiguous result.
            try {
              if (isProcessAlive(ownerPid) !== false) {
                outcome.live_or_unknown_owners += 1;
                continue;
              }
            } catch (_error) {
              outcome.live_or_unknown_owners += 1;
              outcome.errors += 1;
              continue;
            }
            await fs.unlink(candidatePath);
            outcome.deleted += 1;
            if (!current()) {
              outcome.status = 'cancelled';
              outcome.reason = 'root_changed';
              break scan;
            }
            if (outcome.deleted >= limits.deletions) {
              truncationReason = 'delete_limit';
              break scan;
            }
          } catch (error) {
            if (error?.code !== 'ENOENT') outcome.errors += 1;
          }
          continue;
        }

        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          if (queuedDirectories < limits.directories) {
            queue.push(candidatePath);
            queuedDirectories += 1;
          } else {
            truncationReason = truncationReason || 'directory_limit';
          }
        }
      }
      if (!current()) {
        outcome.status = 'cancelled';
        outcome.reason = 'root_changed';
        break;
      }
    } catch (_error) {
      outcome.errors += 1;
    }
  }

  if (truncationReason && outcome.status === 'complete') {
    outcome.status = 'partial';
    outcome.reason = truncationReason;
    outcome.truncated = true;
  }
  return outcome;
}

async function startVersionedWorkspaceTempRecovery({ logger = null, ...options } = {}) {
  let outcome;
  try {
    outcome = await recoverVersionedWorkspaceTemps(options);
  } catch (error) {
    outcome = {
      ...baseOutcome('failed', 'unexpected_failure'),
      errors: 1,
      os_code: String(error?.code || ''),
    };
  }
  if (typeof logger === 'function') {
    try {
      logger(
        outcome.status === 'failed' || outcome.errors > 0 ? 'WARN' : 'INFO',
        'workspace_file.temp_recovery',
        outcome
      );
    } catch (_error) {
      /* diagnostics never break recovery */
    }
  }
  return outcome;
}

module.exports = {
  recoverVersionedWorkspaceTemps,
  startVersionedWorkspaceTempRecovery,
};
