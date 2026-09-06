/* services/workspace-ide-snapshot-store.js - bounded pre-change snapshot store
 * for the Workspace IDE diff review surface. Snapshots are content-addressed
 * by the same `before_hash` the structured-diff pipeline stamps on the change
 * ledger (sha256 over EOL-normalized text), stored as flat files under
 * userData, and LRU-pruned by entry count and total bytes. Every operation is
 * fail-open: capture/read NEVER throw - a missing snapshot only degrades the
 * IDE diff view to its hunks-summary placeholder. */

const crypto = require('crypto');
const fsPromises = require('fs/promises');
const nodePath = require('path');

const { normalizeDiffInputText, sha256Text } = require('./tools/structured-diff');

const SNAPSHOT_DEFAULTS = Object.freeze({
  maxEntries: 200,
  maxTotalBytes: 50 * 1024 * 1024,
  maxSnapshotBytes: 5 * 1024 * 1024,
});
const SNAPSHOT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SNAPSHOT_FILE_EXTENSION = '.snap';

function buildPathLogHint(pathHint) {
  const normalized = String(pathHint || '');
  if (!normalized) {
    return {};
  }
  return {
    file_name: normalized.split(/[\\/]+/).filter(Boolean).pop() || '',
    path_hash: crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12),
  };
}

function normalizePositiveLimit(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function createWorkspaceIdeSnapshotStore({
  rootDir,
  fs = fsPromises,
  path = nodePath,
  logger = null,
  maxEntries = SNAPSHOT_DEFAULTS.maxEntries,
  maxTotalBytes = SNAPSHOT_DEFAULTS.maxTotalBytes,
  maxSnapshotBytes = SNAPSHOT_DEFAULTS.maxSnapshotBytes,
} = {}) {
  const storeDir = String(rootDir || '').trim();
  const limits = {
    maxEntries: normalizePositiveLimit(maxEntries, SNAPSHOT_DEFAULTS.maxEntries),
    maxTotalBytes: normalizePositiveLimit(maxTotalBytes, SNAPSHOT_DEFAULTS.maxTotalBytes),
    maxSnapshotBytes: normalizePositiveLimit(maxSnapshotBytes, SNAPSHOT_DEFAULTS.maxSnapshotBytes),
  };
  let ensureDirPromise = null;

  function log(level, event, details = {}) {
    if (typeof logger === 'function') {
      try {
        logger(level, event, details);
      } catch (_error) {
        /* logging must never break the edit path */
      }
    }
  }

  function snapshotFilePath(hash) {
    return path.join(storeDir, `${hash.slice('sha256:'.length)}${SNAPSHOT_FILE_EXTENSION}`);
  }

  function ensureDir() {
    if (!ensureDirPromise) {
      ensureDirPromise = fs.mkdir(storeDir, { recursive: true }).catch((error) => {
        ensureDirPromise = null;
        throw error;
      });
    }
    return ensureDirPromise;
  }

  // Oldest-first eviction once either cap is exceeded. Runs after each new
  // write; failures are logged and swallowed (a fat store is not a fault).
  async function prune() {
    const names = (await fs.readdir(storeDir))
      .filter((name) => name.endsWith(SNAPSHOT_FILE_EXTENSION));
    const entries = [];
    for (const name of names) {
      try {
        const stats = await fs.stat(path.join(storeDir, name));
        entries.push({ name, size: stats.size, mtimeMs: stats.mtimeMs });
      } catch (_error) {
        /* raced with another delete */
      }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let kept = 0;
    let keptBytes = 0;
    const evict = [];
    for (const entry of entries) {
      if (kept + 1 > limits.maxEntries || keptBytes + entry.size > limits.maxTotalBytes) {
        evict.push(entry);
        continue;
      }
      kept += 1;
      keptBytes += entry.size;
    }
    for (const entry of evict) {
      await fs.unlink(path.join(storeDir, entry.name)).catch(() => {});
    }
    if (evict.length) {
      log('INFO', 'workspace_snapshot.pruned', { evicted: evict.length, kept });
    }
  }

  // Records the pre-change text of a file Jenny is about to overwrite.
  // Content-addressed: an existing snapshot is only touched (LRU refresh).
  async function capture({ pathHint = '', content } = {}) {
    if (!storeDir) {
      return { stored: false, hash: '', reason: 'unconfigured' };
    }
    if (typeof content !== 'string') {
      return { stored: false, hash: '', reason: 'not_text' };
    }
    const normalized = normalizeDiffInputText(content);
    const hash = sha256Text(normalized);
    try {
      if (Buffer.byteLength(normalized, 'utf8') > limits.maxSnapshotBytes) {
        log('INFO', 'workspace_snapshot.skipped_too_large', buildPathLogHint(pathHint));
        return { stored: false, hash, reason: 'too_large' };
      }
      await ensureDir();
      const filePath = snapshotFilePath(hash);
      try {
        const now = new Date();
        await fs.utimes(filePath, now, now);
        return { stored: true, hash, deduped: true };
      } catch (_error) {
        /* not stored yet - fall through to the write */
      }
      const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      await fs.writeFile(tempPath, normalized, 'utf8');
      try {
        await fs.rename(tempPath, filePath);
      } catch (error) {
        await fs.unlink(tempPath).catch(() => {});
        throw error;
      }
      await prune().catch((error) => {
        log('WARN', 'workspace_snapshot.prune_failed', {
          error: String(error?.message || error || ''),
        });
      });
      return { stored: true, hash };
    } catch (error) {
      log('WARN', 'workspace_snapshot.capture_failed', {
        ...buildPathLogHint(pathHint),
        error: String(error?.message || error || ''),
      });
      return { stored: false, hash, reason: 'error' };
    }
  }

  // Returns the snapshot text for a ledger before_hash, or a found:false
  // miss the caller renders as the hunks-summary placeholder. Hash input is
  // strictly validated - it doubles as the file name.
  async function read(beforeHash) {
    const hash = String(beforeHash || '').trim().toLowerCase();
    if (!SNAPSHOT_HASH_PATTERN.test(hash)) {
      return { found: false, reason: 'invalid_hash' };
    }
    if (!storeDir) {
      return { found: false, reason: 'unconfigured' };
    }
    const filePath = snapshotFilePath(hash);
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      return { found: false, reason: error?.code === 'ENOENT' ? 'missing' : 'error' };
    }
    if (sha256Text(content) !== hash) {
      await fs.unlink(filePath).catch(() => {});
      log('WARN', 'workspace_snapshot.integrity_failed', { hash_prefix: hash.slice(0, 19) });
      return { found: false, reason: 'corrupt' };
    }
    const now = new Date();
    await fs.utimes(filePath, now, now).catch(() => {});
    return { found: true, content };
  }

  return {
    capture,
    read,
    getRootDir: () => storeDir,
  };
}

module.exports = {
  createWorkspaceIdeSnapshotStore,
};
