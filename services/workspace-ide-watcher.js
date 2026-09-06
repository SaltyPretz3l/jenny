/* services/workspace-ide-watcher.js - generation-bound external-change watcher
 * for the Workspace IDE. Native listeners, timers, stats, and canonical writes
 * are all tied to one immutable root identity. */

'use strict';

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const fsPromises = require('node:fs/promises');
const nodePath = require('node:path');

const { workspaceIdePathKey } = require('./workspace-ide-config-schema');
const { mapWithConcurrency } = require('./bounded-concurrency');
const { WORKSPACE_FS_ERROR_CODES, workspaceFsError } = require('./workspace-ide-errors');
const { resolveGitMetaLayout } = require('./workspace-ide-gitdir');
const { createWalkIgnorePolicy } = require('./workspace-ide-ignore-policy');

const WATCH_DEBOUNCE_MS = 200;
const WATCH_MAX_BATCH = 500;
const WRITE_TICKET_CAP = 256;
const WRITE_TICKET_TTL_MS = 30_000;
const WRITE_SUPPRESSION_TTL_MS = 5_000;
const SERVICE_TEMP_FILE_RE = /(?:\.tmp-\d+-[0-9a-f]+|\.[^/]+\.jenny-vfs-\d+-[0-9a-f]+)$/i;
const WATCH_IGNORE_POLICY = createWalkIgnorePolicy({ extraSkipNames: ['node_modules'] });

function normalizeWatchedRelPath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return '';
  const segments = raw.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (!segments.length || segments.some((segment) => segment === '..') || segments.includes('.git')) return '';
  return segments.join('/');
}

function isGitMetaPath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  const segments = raw.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length < 2 || segments[0] !== '.git') return false;
  // WIDE-028 (b): `.git/index` is a git-meta move too - external `git add`/
  // `git reset` touch only the index, and excluding it meant no SCM refresh.
  // The self-echo loop the old exclusion feared (our own `git status`
  // opportunistically rewriting the index) is broken at the source instead:
  // every workspace git invocation runs with GIT_OPTIONAL_LOCKS=0 (see
  // git-runner buildScrubbedGitEnv), so reads never write the index.
  // `.git/index.lock` intentionally does not match (segment !== 'index').
  return segments[1] === 'HEAD' || segments[1] === 'packed-refs' || segments[1] === 'refs'
    || segments[1] === 'index';
}

function legacyRootId(rootPath) {
  return `legacy-${crypto.createHash('sha256').update(String(rootPath || '')).digest('hex').slice(0, 12)}`;
}

function normalizeContext(value, fallbackRoot = '') {
  const rootPath = String(value?.rootPath || fallbackRoot || '').trim();
  const rootId = typeof value?.rootId === 'string' && value.rootId
    ? value.rootId
    : legacyRootId(rootPath);
  const generation = Number.isSafeInteger(value?.generation) && value.generation >= 0
    ? value.generation
    : 0;
  return Object.freeze({
    rootPath,
    rootId,
    generation,
    phase: value?.phase === 'transitioning' || value?.phase === 'error' ? value.phase : 'ready',
  });
}

function sameContext(left, right) {
  return Boolean(left && right
    && left.rootId === right.rootId
    && left.generation === right.generation);
}

function statFingerprint(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const result = {};
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) {
    const value = stats[key];
    if (typeof value === 'bigint') result[key] = value.toString();
    else if (typeof value === 'string') result[key] = value;
    else if (Number.isFinite(value)) result[key] = String(value);
    else result[key] = '';
  }
  return result;
}

function sameFingerprint(left, right) {
  return Boolean(left && right
    && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => left[key] === right[key]));
}

function createWorkspaceIdeWatcher({
  getRoot,
  getContext = null,
  service,
  emitChange,
  emitGitMeta = () => {},
  // WIDE-028: typed lifecycle push (main -> renderer). Phases:
  //   'watching'  the native watch is live for the context in the payload
  //   'stopped'   an orderly stop (renderer watchStop, root switch restart)
  //   'degraded'  the native watcher errored and is no longer delivering events
  // The renderer watch-controller resets its ownership latch on these instead
  // of staying latched forever after a silent async watcher death.
  emitLifecycle = () => {},
  watchImpl = (root, options, listener) => nodeFs.watch(root, options, listener),
  // WIDE-028 (b): resolves where the git metadata for the root ACTUALLY lives
  // (linked-worktree HEAD/index/refs are outside the root); injectable so unit
  // tests can force a layout without a real repo on disk.
  resolveGitMetaLayoutImpl = resolveGitMetaLayout,
  statImpl = null,
  logger = null,
  debounceMs = WATCH_DEBOUNCE_MS,
  maxBatch = WATCH_MAX_BATCH,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  nowImpl = Date.now,
  platform = process.platform,
} = {}) {
  if (typeof getRoot !== 'function') throw new TypeError('createWorkspaceIdeWatcher requires getRoot');
  if (typeof emitChange !== 'function') throw new TypeError('createWorkspaceIdeWatcher requires emitChange');
  const log = typeof logger === 'function'
    ? (level, event, details) => { try { logger(level, event, details); } catch (_error) { /* diagnostics only */ } }
    : () => {};
  const statEntry = typeof statImpl === 'function'
    ? statImpl
    : async (absPath) => {
      try { return await fsPromises.lstat(absPath); }
      catch (error) { return error?.code === 'ENOENT' ? null : undefined; }
    };

  let watcher = null;
  let watchedContext = null;
  let watchEpoch = 0;
  // WIDE-028 (b): auxiliary watches on EXTERNAL git metadata dirs (linked
  // worktrees keep HEAD/index/refs outside the root, invisible to the root
  // watch). Armed asynchronously after start(); closed with the main watch.
  let auxGitWatchers = [];
  let flushTimer = null;
  let gitMetaTimer = null;
  let pending = new Map();
  let overflowed = false;
  let ignoredEventCount = 0;
  let gitMetaPending = false;
  let writeSequence = 0;
  const activeWrites = new Map();
  const activeWriteByPath = new Map();
  const completedSuppressions = new Map();

  function publicContext(context = watchedContext) {
    return context ? { rootId: context.rootId, generation: context.generation } : null;
  }

  // Best-effort lifecycle push: a throwing bridge (window mid-teardown) must
  // never derail the watcher itself.
  function pushLifecycle(phase, reason, context) {
    try { emitLifecycle({ phase, reason: String(reason || ''), context: context || null }); }
    catch (_error) { /* diagnostics only */ }
  }

  function liveContext() {
    if (typeof getContext !== 'function') return watchedContext;
    try { return normalizeContext(getContext(), String(getRoot() || '')); }
    catch (_error) { return null; }
  }

  function requestedContext(explicitContext) {
    if (explicitContext) return normalizeContext(explicitContext, String(getRoot() || ''));
    if (typeof getContext === 'function') {
      try { return normalizeContext(getContext(), String(getRoot() || '')); }
      catch (_error) { /* fall through to the configured root */ }
    }
    return normalizeContext(null, String(getRoot() || ''));
  }

  function contextReady(context) {
    const live = liveContext();
    return Boolean(live && live.phase === 'ready' && sameContext(live, context));
  }

  function clearTimer(timer) {
    if (timer) clearTimeoutImpl(timer);
  }

  function clearPending() {
    clearTimer(flushTimer); clearTimer(gitMetaTimer);
    flushTimer = null; gitMetaTimer = null;
    pending = new Map(); overflowed = false; ignoredEventCount = 0; gitMetaPending = false;
    activeWrites.clear(); activeWriteByPath.clear(); completedSuppressions.clear();
    service?.clearRecentWrites?.();
  }

  function scheduleFlush() {
    if (flushTimer || !watcher) return;
    const epoch = watchEpoch;
    flushTimer = setTimeoutImpl(() => {
      flushTimer = null;
      flush(epoch).catch((error) => log('WARN', 'workspace_fs.watch_flush_failed', {
        code: String(error?.code || ''),
      }));
    }, debounceMs);
    flushTimer?.unref?.();
  }

  function scheduleGitMetaEmit() {
    if (!watcher) return;
    clearTimer(gitMetaTimer);
    const epoch = watchEpoch;
    gitMetaTimer = setTimeoutImpl(() => {
      gitMetaTimer = null;
      if (epoch !== watchEpoch || !gitMetaPending) return;
      if (!contextReady(watchedContext)) { scheduleGitMetaEmit(); return; }
      gitMetaPending = false;
      try { emitGitMeta({ context: publicContext() }); }
      catch (error) { log('WARN', 'workspace_fs.git_meta_emit_failed', { code: String(error?.code || '') }); }
    }, debounceMs);
    gitMetaTimer?.unref?.();
  }

  function queueRelPath(relPath) {
    const pathKey = workspaceIdePathKey(relPath, { platform });
    if (!pathKey) return;
    if (!pending.has(pathKey) && pending.size >= maxBatch) overflowed = true;
    else pending.set(pathKey, relPath);
    scheduleFlush();
  }

  function handleRawEvent(epoch, context, _eventType, filename) {
    if (epoch !== watchEpoch || !sameContext(context, watchedContext)) return;
    if (isGitMetaPath(filename)) {
      gitMetaPending = true; scheduleGitMetaEmit(); return;
    }
    const relPath = normalizeWatchedRelPath(filename);
    if (!relPath || SERVICE_TEMP_FILE_RE.test(relPath)) return;
    if (WATCH_IGNORE_POLICY.shouldSkipPath(relPath)) {
      ignoredEventCount = Math.min(Number.MAX_SAFE_INTEGER, ignoredEventCount + 1);
      scheduleFlush();
      return;
    }
    queueRelPath(relPath);
  }

  function releaseHeld(ticket) {
    if (ticket?.held?.relPath && sameContext(ticket.context, watchedContext)) queueRelPath(ticket.held.relPath);
  }

  function closeAuxGitWatchers() {
    for (const aux of auxGitWatchers.splice(0)) {
      try { aux?.close?.(); } catch (_error) { /* already closed */ }
    }
  }

  // Any non-lock event inside an external git metadata dir is a git-meta move
  // (the dirs contain nothing else we care to distinguish); lock-file churn is
  // filtered so a single external `git add` doesn't double-fire, and the
  // debounced coalescer absorbs the rest.
  function handleAuxGitEvent(epoch, _eventType, filename) {
    if (epoch !== watchEpoch || !watcher) return;
    const name = String(filename || '').replace(/\\/g, '/');
    if (/\.lock$/i.test(name) || SERVICE_TEMP_FILE_RE.test(name)) return;
    gitMetaPending = true;
    scheduleGitMetaEmit();
  }

  // Arm auxiliary watches when the metadata lives OUTSIDE the root (linked
  // worktree / detached gitdir): gitDir (HEAD/index), commonDir (packed-refs),
  // and commonDir/refs (branch tips). Best-effort: a failing aux watch is
  // logged and skipped - it degrades git freshness, never the file watch.
  async function armExternalGitMeta(epoch, context) {
    let layout;
    try {
      layout = await resolveGitMetaLayoutImpl(context.rootPath);
    } catch (error) {
      log('WARN', 'workspace_fs.git_meta_layout_failed', { code: String(error?.code || '') });
      return;
    }
    if (epoch !== watchEpoch || !watcher || !layout || layout.mode !== 'external') return;
    const targets = [{ dir: layout.gitDir, recursive: false }];
    if (layout.commonDir && layout.commonDir !== layout.gitDir) {
      targets.push({ dir: layout.commonDir, recursive: false });
    }
    targets.push({ dir: nodePath.join(layout.commonDir || layout.gitDir, 'refs'), recursive: true });
    for (const target of targets) {
      try {
        const aux = watchImpl(target.dir, { recursive: target.recursive, persistent: false },
          (eventType, filename) => handleAuxGitEvent(epoch, eventType, filename));
        aux?.on?.('error', () => {
          try { aux?.close?.(); } catch (_error) { /* already closed */ }
          log('WARN', 'workspace_fs.git_meta_watch_error', {});
        });
        auxGitWatchers.push(aux);
      } catch (error) {
        log('WARN', 'workspace_fs.git_meta_watch_failed', { code: String(error?.code || '') });
      }
    }
  }

  function pruneWriteState() {
    const now = nowImpl();
    for (const [token, ticket] of activeWrites) {
      if (ticket.expiresAt > now) continue;
      activeWrites.delete(token);
      if (activeWriteByPath.get(ticket.pathKey) === token) activeWriteByPath.delete(ticket.pathKey);
      releaseHeld(ticket);
    }
    for (const [pathKey, record] of completedSuppressions) {
      if (record.expiresAt <= now) completedSuppressions.delete(pathKey);
    }
  }

  function holdForActiveWrite(pathKey, change, fingerprint) {
    const token = activeWriteByPath.get(pathKey);
    const ticket = token && activeWrites.get(token);
    if (!ticket || !sameContext(ticket.context, watchedContext)) return false;
    ticket.held = { ...change, fingerprint };
    return true;
  }

  function consumeCompletedSuppression(pathKey, fingerprint) {
    const record = completedSuppressions.get(pathKey);
    if (!record) return false;
    completedSuppressions.delete(pathKey);
    return sameContext(record.context, watchedContext) && sameFingerprint(record.fingerprint, fingerprint);
  }

  // consumeRecentWrite is the only service-side suppression: it is single-consume,
  // compares dev/ino/size/mtime/ctime, and expires by TTL.
  async function legacySelfWrite(absPath, stats) {
    return typeof service?.consumeRecentWrite === 'function'
      ? service.consumeRecentWrite(absPath, stats) === true
      : false;
  }

  async function flush(epoch = watchEpoch) {
    if (epoch !== watchEpoch || !watcher) return;
    if (!contextReady(watchedContext)) { scheduleFlush(); return; }
    pruneWriteState();
    const entries = [...pending.entries()];
    const truncated = overflowed;
    pending = new Map(); overflowed = false;
    if (ignoredEventCount > 0) {
      log('DEBUG', 'workspace_fs.watch_events_ignored', { ignored_event_count: ignoredEventCount });
      ignoredEventCount = 0;
    }
    const rootPath = watchedContext.rootPath;
    const statsByEntry = await mapWithConcurrency(
      entries,
      8,
      ([, relPath]) => statEntry(nodePath.join(rootPath, relPath))
    );
    const changes = [];
    for (let index = 0; index < entries.length; index += 1) {
      const [pathKey, relPath] = entries[index];
      const absPath = nodePath.join(rootPath, relPath);
      const stats = statsByEntry[index];
      if (epoch !== watchEpoch || !contextReady(watchedContext)) return;
      const change = { relPath, pathKey, kind: stats === null ? 'deleted' : 'changed' };
      const fingerprint = statFingerprint(stats);
      if (holdForActiveWrite(pathKey, change, fingerprint)) continue;
      if (consumeCompletedSuppression(pathKey, fingerprint)) continue;
      if (await legacySelfWrite(absPath, stats)) continue;
      changes.push(change);
    }
    if (changes.length || truncated) emitChange({ context: publicContext(), changes, truncated });
  }

  function removeTicket(token) {
    const ticket = activeWrites.get(String(token || ''));
    if (!ticket) return null;
    activeWrites.delete(ticket.token);
    if (activeWriteByPath.get(ticket.pathKey) === ticket.token) activeWriteByPath.delete(ticket.pathKey);
    return ticket;
  }

  const writeObserver = {
    begin(identity = {}) {
      pruneWriteState();
      const pathKey = String(identity.pathKey || '');
      const context = normalizeContext(identity, watchedContext?.rootPath || '');
      if (!watcher || !pathKey || !sameContext(context, watchedContext)) return null;
      const previousToken = activeWriteByPath.get(pathKey);
      if (previousToken) releaseHeld(removeTicket(previousToken));
      while (activeWrites.size >= WRITE_TICKET_CAP) releaseHeld(removeTicket(activeWrites.keys().next().value));
      writeSequence += 1;
      const token = `write-${watchEpoch}-${writeSequence}`;
      const ticket = {
        token,
        pathKey,
        relPath: normalizeWatchedRelPath(identity.path),
        context: watchedContext,
        expiresAt: nowImpl() + WRITE_TICKET_TTL_MS,
        held: null,
      };
      activeWrites.set(token, ticket); activeWriteByPath.set(pathKey, token);
      return token;
    },
    commit(token, fingerprint) {
      pruneWriteState();
      const ticket = removeTicket(token);
      if (!ticket || !sameContext(ticket.context, watchedContext)) return false;
      const normalized = statFingerprint(fingerprint);
      if (!normalized) { releaseHeld(ticket); return false; }
      if (ticket.held) {
        if (!sameFingerprint(ticket.held.fingerprint, normalized)) {
          releaseHeld(ticket);
          return true;
        }
        completedSuppressions.set(ticket.pathKey, {
          context: ticket.context,
          fingerprint: normalized,
          expiresAt: nowImpl() + WRITE_SUPPRESSION_TTL_MS,
        });
        while (completedSuppressions.size > WRITE_TICKET_CAP) {
          completedSuppressions.delete(completedSuppressions.keys().next().value);
        }
        return true;
      }
      completedSuppressions.delete(ticket.pathKey);
      completedSuppressions.set(ticket.pathKey, {
        context: ticket.context,
        fingerprint: normalized,
        expiresAt: nowImpl() + WRITE_SUPPRESSION_TTL_MS,
      });
      while (completedSuppressions.size > WRITE_TICKET_CAP) {
        completedSuppressions.delete(completedSuppressions.keys().next().value);
      }
      return true;
    },
    abort(token) {
      const ticket = removeTicket(token);
      if (!ticket) return false;
      releaseHeld(ticket);
      return true;
    },
  };

  function stop({ phase = 'stopped', reason = 'stopped' } = {}) {
    watchEpoch += 1; clearPending();
    closeAuxGitWatchers();
    const closing = watcher; const closingContext = watchedContext;
    watcher = null; watchedContext = null;
    try { closing?.close?.(); } catch (_error) { /* already closed */ }
    // Only a stop that actually tore down a live watch is worth announcing;
    // an idle stop() (no watcher) is a no-op the renderer never needs to see.
    if (closing) pushLifecycle(phase, reason, publicContext(closingContext));
    return { watching: false };
  }

  function start(explicitContext = null) {
    const context = requestedContext(explicitContext);
    if (!context.rootPath) {
      stop();
      throw workspaceFsError(WORKSPACE_FS_ERROR_CODES.ROOT_MISSING, 'No workspace root is configured; choose a workspace folder first.');
    }
    if (watcher && sameContext(context, watchedContext) && context.rootPath === watchedContext.rootPath) {
      return { watching: true };
    }
    // 'restarting' lets the renderer distinguish an orderly root-switch
    // teardown (a 'watching' push follows immediately) from a lasting stop.
    stop({ reason: 'restarting' });
    watchEpoch += 1;
    const epoch = watchEpoch;
    watchedContext = context;
    try {
      watcher = watchImpl(context.rootPath, { recursive: true, persistent: false },
        (eventType, filename) => handleRawEvent(epoch, context, eventType, filename));
    } catch (error) {
      watcher = null; watchedContext = null;
      throw workspaceFsError(WORKSPACE_FS_ERROR_CODES.WATCH_FAILED, 'Could not watch the workspace folder for changes.', {
        code: String(error?.code || ''),
      });
    }
    watcher?.on?.('error', (error) => {
      if (epoch !== watchEpoch || !sameContext(context, watchedContext)) return;
      log('WARN', 'workspace_fs.watch_error', { code: String(error?.code || '') });
      // WIDE-028: a native watcher death is no longer silent — 'degraded'
      // tells the renderer to reset its latch and retry with backoff.
      stop({ phase: 'degraded', reason: String(error?.code || 'watch_error') });
    });
    log('INFO', 'workspace_fs.watch_started', publicContext(context));
    pushLifecycle('watching', '', publicContext(context));
    // Fire-and-forget: external git-metadata coverage (linked worktrees) arms
    // in the background and is epoch-guarded against a racing stop/restart.
    armExternalGitMeta(epoch, context).catch(() => {});
    return { watching: true };
  }

  function syncRoot(explicitContext = null) {
    if (!watcher) return;
    const context = requestedContext(explicitContext);
    if (!context.rootPath) { stop(); return; }
    if (!sameContext(context, watchedContext) || context.rootPath !== watchedContext.rootPath) start(context);
  }

  return {
    start,
    stop,
    syncRoot,
    flush,
    isRunning: () => Boolean(watcher),
    getWatchedRoot: () => watchedContext?.rootPath || '',
    getWatchedContext: () => (watchedContext ? { ...watchedContext } : null),
    writeObserver,
  };
}

module.exports = {
  createWorkspaceIdeWatcher,
  isGitMetaPath,
  normalizeWatchedRelPath,
};
