'use strict';

/* services/artifact-retention-service.js — WIDE-010: reference-aware retention
 * for artifact-session directories under <workspace>/.jenny/artifacts.
 *
 * Retention authority lives HERE, in Electron — the owner of the persisted
 * generated_artifacts[] references (electron-session-store) — never in the
 * sidecar, whose old startup prune deleted the oldest directories by bare
 * dir-mtime without consulting references at all.
 *
 * Contract:
 *  - The referenced-set is reconciled from ALL persisted sessions'
 *    generated_artifacts[].absolute_path (display_path fallback for redacted
 *    entries). A directory any reference resolves into is NEVER deleted.
 *  - Unreferenced directories are ranked by REAL last use (newest file mtime
 *    inside the directory, not bare dir mtime) and pruned by age plus
 *    count/aggregate-byte quotas.
 *  - Soft-delete only: candidates MOVE to the shared .jenny/quarantine
 *    location using the sidecar guarded-store naming convention
 *    (<kind>-<name>-<reason>-<stamp>-<hex>), reason "retention". Quarantine
 *    entries we created are purged only after their own bounded retention.
 *  - Broken references (artifact file already gone) are surfaced EXPLICITLY
 *    in the structured sweep result and log — never silently dangling.
 *  - Fail closed: if the reference reconciliation is incomplete (any session
 *    unreadable), NOTHING is quarantined on that pass.
 *  - Recency floor: a directory used within the floor window is never touched,
 *    so retention cannot race an active session writing artifacts.
 *  - Logging is redacted per repo conventions: counts and sanitized session
 *    directory names only, never absolute paths.
 */

const fsDefault = require('fs/promises');
const pathDefault = require('path');
const crypto = require('crypto');

const REDACTED_PATH_TOKEN = '[redacted:path]';
const ARTIFACTS_SUBPATH = ['.jenny', 'artifacts'];
const QUARANTINE_SUBPATH = ['.jenny', 'quarantine'];
const QUARANTINE_REASON = 'retention';
const QUARANTINE_KIND = 'artifacts';
const RETENTION_QUARANTINE_NAME_PATTERN = /^artifacts-.+-retention-\d{8}T\d{6}-[0-9a-f]{16}$/;
const MAX_QUARANTINE_SOURCE_CHARS = 160;
const MAX_BROKEN_REFERENCES_LISTED = 50;

const DEFAULT_CAPS = Object.freeze({
  recentUseFloorMs: 30 * 60 * 1000,
  maxUnreferencedAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxUnreferencedDirs: 20,
  maxUnreferencedTotalBytes: 512 * 1024 * 1024,
  quarantineMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxWalkEntriesPerDir: 5000,
});

function sanitizeQuarantineStem(name) {
  const safe = String(name || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, MAX_QUARANTINE_SOURCE_CHARS);
  return safe || 'entry';
}

function quarantineEntryName(sourceName, nowMs) {
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const hex = crypto.randomBytes(8).toString('hex');
  return `${QUARANTINE_KIND}-${sanitizeQuarantineStem(sourceName)}-${QUARANTINE_REASON}-${stamp}-${hex}`;
}

function isRetentionQuarantineEntry(name) {
  return RETENTION_QUARANTINE_NAME_PATTERN.test(String(name || ''));
}

function readSessionMessages(sessionStore, sessionId) {
  if (typeof sessionStore.peekSession === 'function') {
    const record = sessionStore.peekSession(sessionId);
    return Array.isArray(record?.messages) ? record.messages : [];
  }
  const messages = typeof sessionStore.getSessionMessages === 'function'
    ? sessionStore.getSessionMessages(sessionId)
    : [];
  return Array.isArray(messages) ? messages : [];
}

function createArtifactRetentionService({
  getWorkspaceRoot,
  getSessionStore,
  fsImpl = fsDefault,
  pathImpl = pathDefault,
  logger = () => {},
  nowFn = Date.now,
  caps = {},
} = {}) {
  const limits = { ...DEFAULT_CAPS, ...caps };
  const readRoot = typeof getWorkspaceRoot === 'function' ? getWorkspaceRoot : () => '';
  const readStore = typeof getSessionStore === 'function' ? getSessionStore : () => null;

  function ownedDirName(artifactsRoot, resolvedPath) {
    const relative = pathImpl.relative(artifactsRoot, resolvedPath);
    if (!relative || relative.startsWith('..') || pathImpl.isAbsolute(relative)) return '';
    return relative.split(/[\\/]/)[0] || '';
  }

  // Reconcile the referenced-set from every persisted session. Fail closed:
  // an unreadable session makes the reconciliation incomplete, and an
  // incomplete reconciliation must never authorize deletion.
  async function collectReferences(sessionStore, workspaceRoot, artifactsRoot) {
    const referencedDirs = new Set();
    const brokenReferences = [];
    let brokenReferenceCount = 0;
    let complete = true;
    const seenPaths = new Set();
    let sessions;
    try {
      sessions = sessionStore.listSessions() || [];
    } catch (_error) {
      return { referencedDirs, brokenReferences, brokenReferenceCount, complete: false };
    }
    for (const session of sessions) {
      let messages;
      try {
        messages = readSessionMessages(sessionStore, session.id);
      } catch (_error) {
        complete = false;
        continue;
      }
      for (const message of messages) {
        const artifacts = Array.isArray(message?.tool_result?.generated_artifacts)
          ? message.tool_result.generated_artifacts
          : [];
        for (const entry of artifacts) {
          const stored = String(entry?.absolute_path || '').trim();
          const displayPath = String(entry?.display_path || '').trim();
          const usable = stored && stored !== REDACTED_PATH_TOKEN
            ? stored
            : (displayPath ? pathImpl.join(workspaceRoot, displayPath) : '');
          if (!usable) continue;
          const resolved = pathImpl.resolve(usable);
          const dirName = ownedDirName(artifactsRoot, resolved);
          if (!dirName) continue;
          referencedDirs.add(dirName);
          if (seenPaths.has(resolved)) continue;
          seenPaths.add(resolved);
          const stats = await fsImpl.stat(resolved).catch(() => null);
          if (!stats?.isFile()) {
            brokenReferenceCount += 1;
            if (brokenReferences.length < MAX_BROKEN_REFERENCES_LISTED) {
              brokenReferences.push({
                session_id: String(session.id || ''),
                artifact_id: String(entry?.artifact_id || ''),
              });
            }
          }
        }
      }
    }
    return { referencedDirs, brokenReferences, brokenReferenceCount, complete };
  }

  // Real last use + aggregate bytes for one artifact-session directory:
  // newest file mtime inside the tree (bounded walk, link objects never
  // followed), falling back to the directory's own mtime for empty dirs.
  async function measureDirUsage(dirPath, dirStats) {
    let lastUseMs = Number(dirStats?.mtimeMs || 0);
    let bytes = 0;
    let walked = 0;
    const stack = [dirPath];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try {
        entries = await fsImpl.readdir(current, { withFileTypes: true });
      } catch (_error) {
        continue;
      }
      for (const entry of entries) {
        if (walked >= limits.maxWalkEntriesPerDir) return { lastUseMs, bytes, truncated: true };
        walked += 1;
        const entryPath = pathImpl.join(current, entry.name);
        if (entry.isSymbolicLink?.()) continue;
        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }
        const stats = await fsImpl.lstat(entryPath).catch(() => null);
        if (!stats?.isFile()) continue;
        bytes += Number(stats.size || 0);
        if (Number(stats.mtimeMs || 0) > lastUseMs) lastUseMs = Number(stats.mtimeMs);
      }
    }
    return { lastUseMs, bytes, truncated: false };
  }

  async function purgeExpiredQuarantine(quarantineRoot, nowMs, result) {
    let entries;
    try {
      entries = await fsImpl.readdir(quarantineRoot, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    for (const entry of entries) {
      // Only entries THIS sweep family created (kind "artifacts", reason
      // "retention") are ever purged — sidecar guarded-store quarantine
      // entries are left alone.
      if (!entry.isDirectory() || !isRetentionQuarantineEntry(entry.name)) continue;
      const entryPath = pathImpl.join(quarantineRoot, entry.name);
      const stats = await fsImpl.stat(entryPath).catch(() => null);
      if (!stats || nowMs - Number(stats.mtimeMs || 0) < limits.quarantineMaxAgeMs) continue;
      try {
        await fsImpl.rm(entryPath, { recursive: true, force: true });
        result.purgedQuarantine += 1;
      } catch (_error) {
        result.errors += 1;
      }
    }
  }

  async function sweep({ activeSessionIds = [] } = {}) {
    const nowMs = nowFn();
    const result = {
      ok: true,
      scannedDirs: 0,
      referencedDirs: 0,
      keptUnreferenced: 0,
      quarantined: 0,
      quarantinedBytes: 0,
      quarantinedNames: [],
      purgedQuarantine: 0,
      skippedRecent: 0,
      skippedActive: 0,
      brokenReferences: [],
      brokenReferenceCount: 0,
      referencesComplete: true,
      errors: 0,
    };
    const workspaceRoot = String(readRoot() || '').trim();
    const sessionStore = readStore();
    if (!workspaceRoot || !sessionStore) {
      return { ...result, ok: false, skippedReason: !workspaceRoot ? 'no_root' : 'no_session_store' };
    }
    const rootResolved = pathImpl.resolve(workspaceRoot);
    const artifactsRoot = pathImpl.join(rootResolved, ...ARTIFACTS_SUBPATH);
    const quarantineRoot = pathImpl.join(rootResolved, ...QUARANTINE_SUBPATH);
    await purgeExpiredQuarantine(quarantineRoot, nowMs, result);
    const rootStats = await fsImpl.stat(artifactsRoot).catch(() => null);
    if (!rootStats?.isDirectory()) {
      return result;
    }

    const references = await collectReferences(sessionStore, rootResolved, artifactsRoot);
    result.brokenReferences = references.brokenReferences;
    result.brokenReferenceCount = references.brokenReferenceCount;
    result.referencesComplete = references.complete;

    const activeSet = new Set(
      (Array.isArray(activeSessionIds) ? activeSessionIds : []).map((value) => String(value || ''))
    );
    let entries;
    try {
      entries = await fsImpl.readdir(artifactsRoot, { withFileTypes: true });
    } catch (_error) {
      return { ...result, ok: false, skippedReason: 'artifacts_unreadable' };
    }

    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink?.()) continue;
      result.scannedDirs += 1;
      const dirName = entry.name;
      if (references.referencedDirs.has(dirName)) {
        result.referencedDirs += 1;
        continue;
      }
      if (activeSet.has(dirName)) {
        result.skippedActive += 1;
        continue;
      }
      const dirPath = pathImpl.join(artifactsRoot, dirName);
      const dirStats = await fsImpl.stat(dirPath).catch(() => null);
      if (!dirStats?.isDirectory()) continue;
      const usage = await measureDirUsage(dirPath, dirStats);
      if (nowMs - usage.lastUseMs < limits.recentUseFloorMs) {
        result.skippedRecent += 1;
        continue;
      }
      candidates.push({ dirName, dirPath, ...usage });
    }

    // Fail closed: never quarantine on an incomplete reference reconciliation.
    if (!references.complete) {
      logSweep(result);
      return result;
    }

    // Rank by REAL last use, newest first; keep within count + byte quotas
    // and inside the age cap, quarantine the rest.
    candidates.sort((a, b) => b.lastUseMs - a.lastUseMs || a.dirName.localeCompare(b.dirName));
    let keptBytes = 0;
    const doomed = [];
    for (const candidate of candidates) {
      const expired = nowMs - candidate.lastUseMs > limits.maxUnreferencedAgeMs;
      const overCount = result.keptUnreferenced >= limits.maxUnreferencedDirs;
      const overBytes = keptBytes + candidate.bytes > limits.maxUnreferencedTotalBytes;
      if (expired || overCount || overBytes) {
        doomed.push(candidate);
        continue;
      }
      result.keptUnreferenced += 1;
      keptBytes += candidate.bytes;
    }

    if (doomed.length) {
      await fsImpl.mkdir(quarantineRoot, { recursive: true }).catch(() => {});
    }
    for (const candidate of doomed) {
      const destination = pathImpl.join(quarantineRoot, quarantineEntryName(candidate.dirName, nowMs));
      try {
        await fsImpl.rename(candidate.dirPath, destination);
        result.quarantined += 1;
        result.quarantinedBytes += candidate.bytes;
        result.quarantinedNames.push(candidate.dirName);
      } catch (_error) {
        // Per-directory failures are isolated: report and continue.
        result.errors += 1;
      }
    }

    logSweep(result);
    return result;
  }

  function logSweep(result) {
    if (!result.quarantined && !result.purgedQuarantine
      && !result.brokenReferenceCount && !result.errors && result.referencesComplete) {
      return;
    }
    // Redacted: counts and sanitized session-directory names only, no paths.
    logger('INFO', 'artifacts.retention_swept', {
      scannedDirs: result.scannedDirs,
      referencedDirs: result.referencedDirs,
      keptUnreferenced: result.keptUnreferenced,
      quarantined: result.quarantined,
      quarantinedBytes: result.quarantinedBytes,
      quarantinedNames: result.quarantinedNames.slice(0, 20),
      purgedQuarantine: result.purgedQuarantine,
      skippedRecent: result.skippedRecent,
      skippedActive: result.skippedActive,
      brokenReferenceCount: result.brokenReferenceCount,
      referencesComplete: result.referencesComplete,
      errors: result.errors,
    });
  }

  return { sweep };
}

module.exports = {
  ARTIFACT_RETENTION_DEFAULT_CAPS: DEFAULT_CAPS,
  createArtifactRetentionService,
  isRetentionQuarantineEntry,
  quarantineEntryName,
};
