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
const { readSessionMessagesForReferenceScan } = require('./backend/session-reference-scan');
const { ensureJennyDirGitignore } = require('./jenny-project-dir');

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

function createArtifactRetentionService({
  getWorkspaceRoot,
  getWorkspaceScopes,
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
  // One pass over every persisted session body, shared by every workspace root
  // in a sweep. It yields between sessions so a large profile never holds the
  // main thread for the whole walk.
  async function scanSessionArtifacts(sessionStore) {
    const references = [];
    let sessions;
    try {
      sessions = sessionStore.listSessions();
      if (!Array.isArray(sessions)) throw new Error('Session index is unreadable.');
    } catch (_error) {
      return { references, complete: false };
    }
    let complete = true;
    for (const [index, session] of sessions.entries()) {
      if (index > 0 && index % 8 === 0) await new Promise((resolve) => setImmediate(resolve));
      let messages;
      try {
        messages = readSessionMessagesForReferenceScan(sessionStore, session);
      } catch (_error) {
        complete = false;
        continue;
      }
      for (const message of messages) {
        const artifacts = Array.isArray(message?.tool_result?.generated_artifacts)
          ? message.tool_result.generated_artifacts
          : [];
        for (const entry of artifacts) references.push({ sessionId: String(session.id || ''), entry });
      }
    }
    return { references, complete };
  }

  async function collectReferences(scan, workspaceRoot, artifactsRoot, checkBroken = true) {
    const referencedDirs = new Set();
    const brokenReferences = [];
    let brokenReferenceCount = 0;
    const seenPaths = new Set();
    for (const { sessionId, entry } of scan.references) {
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
      if (!checkBroken) continue;
      if (seenPaths.has(resolved)) continue;
      seenPaths.add(resolved);
      const stats = await fsImpl.stat(resolved).catch(() => null);
      if (!stats?.isFile()) {
        brokenReferenceCount += 1;
        if (brokenReferences.length < MAX_BROKEN_REFERENCES_LISTED) {
          brokenReferences.push({
            session_id: sessionId,
            artifact_id: String(entry?.artifact_id || ''),
          });
        }
      }
    }
    return { referencedDirs, brokenReferences, brokenReferenceCount, complete: scan.complete };
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

  async function purgeExpiredQuarantine(quarantineRoot, nowMs, result, validateMutation) {
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
      const stamp = entry.name.match(/-retention-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})-[0-9a-f]{16}$/);
      const quarantinedAt = Date.parse(`${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}Z`);
      if (!Number.isFinite(quarantinedAt) || nowMs - quarantinedAt < limits.quarantineMaxAgeMs) continue;
      try {
        await validateMutation(entryPath);
        await fsImpl.rm(entryPath, { recursive: true, force: true });
        result.purgedQuarantine += 1;
      } catch (_error) {
        result.errors += 1;
      }
    }
  }

  async function sweepRoot(scope, { activeSessionIds = [], orphanOnly = false } = {}, scanOnce = null) {
    const nowMs = nowFn();
    const result = {
      ok: true,
      scannedDirs: 0,
      referencedDirs: 0,
      keptUnreferenced: 0,
      quarantined: 0,
      quarantinedBytes: 0,
      quarantinedNames: [],
      restored: 0,
      purgedQuarantine: 0,
      skippedRecent: 0,
      skippedActive: 0,
      brokenReferences: [],
      brokenReferenceCount: 0,
      referencesComplete: true,
      errors: 0,
    };
    const workspaceRoot = String(scope.rootPath || '').trim();
    const sessionStore = readStore();
    if (!workspaceRoot || !sessionStore) {
      return { ...result, ok: false, skippedReason: !workspaceRoot ? 'no_root' : 'no_session_store' };
    }
    const rootResolved = pathImpl.resolve(workspaceRoot);
    const artifactsRoot = pathImpl.join(rootResolved, ...ARTIFACTS_SUBPATH);
    const quarantineRoot = pathImpl.join(rootResolved, ...QUARANTINE_SUBPATH);
    let rootReal;
    let rootIdentity;
    try {
      await scope.assertCurrent?.();
      rootReal = await fsImpl.realpath(rootResolved);
      rootIdentity = await fsImpl.stat(rootReal);
      if (!rootIdentity.isDirectory()) throw new Error('Workspace is unavailable.');
    } catch (_) {
      return { ...result, ok: false, skippedReason: 'invalid_root' };
    }
    const validateMutation = async (...targets) => {
      await scope.assertCurrent?.();
      const currentRoot = await fsImpl.realpath(rootResolved);
      const identity = await fsImpl.stat(currentRoot);
      if (pathImpl.relative(rootReal, currentRoot) || identity.dev !== rootIdentity.dev
        || identity.ino !== rootIdentity.ino) throw new Error('Workspace changed.');
      for (const target of targets) {
        let current = target;
        while (pathImpl.relative(rootResolved, current)) {
          const relative = pathImpl.relative(rootResolved, current);
          if (relative.startsWith('..') || pathImpl.isAbsolute(relative)) throw new Error('Path escapes workspace.');
          const stat = await fsImpl.lstat(current);
          const real = await fsImpl.realpath(current);
          const realRelative = pathImpl.relative(rootReal, real);
          if (stat.isSymbolicLink() || realRelative.startsWith('..') || pathImpl.isAbsolute(realRelative)) {
            throw new Error('Path escapes workspace.');
          }
          current = pathImpl.dirname(current);
        }
      }
      await scope.assertCurrent?.();
    };
    if (!orphanOnly) await purgeExpiredQuarantine(quarantineRoot, nowMs, result, validateMutation);
    const rootStats = await fsImpl.stat(artifactsRoot).catch(() => null);
    if (!rootStats?.isDirectory()) {
      return result;
    }

    scanOnce = scanOnce || (() => scanSessionArtifacts(sessionStore));
    const references = await collectReferences(await scanOnce(), rootResolved, artifactsRoot);
    result.brokenReferences = references.brokenReferences;
    result.brokenReferenceCount = references.brokenReferenceCount;
    result.referencesComplete = references.complete;

    const resolveActiveSet = () => {
      const ids = typeof activeSessionIds === 'function' ? activeSessionIds() : activeSessionIds;
      if (!Array.isArray(ids)) throw new Error('Active session index is unreadable.');
      const persisted = orphanOnly ? sessionStore.listSessions() : [];
      if (!Array.isArray(persisted)) throw new Error('Session index is unreadable.');
      return new Set([...ids, ...persisted.map(session => session.id)].map(value => String(value || '')));
    };
    let activeSet;
    try { activeSet = resolveActiveSet(); } catch (_) {
      return { ...result, ok: false, skippedReason: 'sessions_unreadable' };
    }
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
      try {
        await validateMutation(artifactsRoot);
        await fsImpl.mkdir(quarantineRoot, { recursive: true });
        await ensureJennyDirGitignore(pathImpl.dirname(quarantineRoot), { fs: fsImpl });
      } catch (_) {
        return { ...result, ok: false, skippedReason: 'invalid_root' };
      }
    }
    // ONE fresh reference scan, then each rename behind its own containment
    // check: a reference written while this pass measured still protects its
    // directory, without re-reading every session per candidate.
    let fresh = { referencedDirs: new Set(), complete: true };
    if (doomed.length) {
      fresh = await collectReferences(await scanSessionArtifacts(sessionStore), rootResolved, artifactsRoot, false);
      if (!fresh.complete) result.referencesComplete = false;
    }
    const moved = [];
    for (const candidate of fresh.complete ? doomed : []) {
      const destination = pathImpl.join(quarantineRoot, quarantineEntryName(candidate.dirName, nowMs));
      try {
        if (fresh.referencedDirs.has(candidate.dirName) || resolveActiveSet().has(candidate.dirName)) continue;
        await validateMutation(candidate.dirPath, quarantineRoot);
        await fsImpl.rename(candidate.dirPath, destination);
        moved.push({ candidate, destination });
      } catch (_error) {
        // Per-directory failures are isolated: report and continue.
        result.errors += 1;
      }
    }
    // Nothing fences a session restore or branch against this pass, so a
    // reference published during the renames is reconciled here: its directory
    // moves straight back (all of them when this scan cannot complete).
    const after = moved.length
      ? await collectReferences(await scanSessionArtifacts(sessionStore), rootResolved, artifactsRoot, false)
      : fresh;
    for (const { candidate, destination } of moved) {
      if (!after.complete || after.referencedDirs.has(candidate.dirName) || resolveActiveSet().has(candidate.dirName)) {
        try {
          await fsImpl.rename(destination, candidate.dirPath);
          result.restored += 1;
        } catch (_error) {
          result.errors += 1;
        }
        continue;
      }
      result.quarantined += 1;
      result.quarantinedBytes += candidate.bytes;
      result.quarantinedNames.push(candidate.dirName);
    }

    logSweep(result);
    return result;
  }

  async function sweep(options = {}) {
    const scopes = typeof getWorkspaceScopes === 'function'
      ? await getWorkspaceScopes() : [{ rootPath: readRoot() }];
    if (!Array.isArray(scopes)) throw new Error('Artifact workspace index is unreadable.');
    if (!scopes.length) return sweepRoot({ rootPath: '' }, options);
    let result;
    let scan = null;
    const scanOnce = () => {
      const sessionStore = readStore();
      scan = scan || (sessionStore ? scanSessionArtifacts(sessionStore) : Promise.resolve({ references: [], complete: false }));
      return scan;
    };
    for (const scope of scopes) {
      const current = await sweepRoot(scope, options, scanOnce);
      if (!result) { result = current; continue; }
      for (const key of Object.keys(current)) {
        if (typeof current[key] === 'number') result[key] += current[key];
        else if (Array.isArray(current[key])) result[key].push(...current[key]);
      }
      result.ok = result.ok && current.ok;
      result.referencesComplete = result.referencesComplete && current.referencesComplete;
    }
    return result;
  }

  function logSweep(result) {
    if (!result.quarantined && !result.restored && !result.purgedQuarantine
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
      restored: result.restored,
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
