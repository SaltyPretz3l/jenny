const { readSessionMessagesForReferenceScan, readSessionRecordForReferenceScan } = require('../backend/session-reference-scan');
const { collectAssetPaths } = require('../attachment-service');
const { createArtifactRetentionService } = require('../artifact-retention-service');
const { payloadPathsFromMessages } = require('../backend/ipc-payload-retention');
const { pruneLegacySessionFiles } = require('../backend/session-legacy-file-prune');

// Message attachments only change through message mutations, and every message
// mutation bumps updated_at (append/update/replace/truncate). Tool-result event
// refs (read and cached with the same body) change through turn-event appends,
// which leave updated_at alone but move the store's non-persisted
// getTurnEventStamp. So `updated_at|message_count|eventStamp` is a sound change
// stamp for both; an event-only append re-reads that session at the next sweep.
// A store without the accessor (test fakes) keeps the two-part behaviour.
function sessionAttachmentStamp(summary, sessionStore) {
  const eventStamp = sessionStore?.getTurnEventStamp?.(summary?.id) ?? '';
  return `${summary?.updated_at || ''}|${Number(summary?.message_count || 0)}|${eventStamp}`;
}

function toolResultAssetPaths(refs) {
  return collectAssetPaths((Array.isArray(refs) ? refs : []).map(ref => ({
    kind: 'image', assetPath: ref?.asset_path || ref?.assetPath,
  })));
}

// Both retention sweeps share one walk of the session bodies on a cache miss
// (messages and the persisted turn events, whose tool-result refs are media).
//
// `payloadKeys` is opt-in and only sound on a pass that reads every session: a
// memo hit answers a session without reading it, which is fine for attachments
// (the cached paths ARE that session's answer) but would silently under-count
// payload references, and under-counting deletes data. The caller enforces that
// by asking for payload keys only when the memo is empty; within one such pass
// no cache hit is possible, because each session id is visited once.
// One session's references, read (and memoized) unless the memo already holds
// its current stamp. Throws, failing the whole pass closed, on an incomplete read.
function collectOneSession(sessionStore, session, stamp, { cache, assetPaths, payloadKeys }) {
  const cached = cache ? cache.get(session.id) : null;
  if (cached && cached.stamp === stamp) {
    assetPaths.push(...cached.paths);
    return;
  }
  const { messages, turnEvents } = readSessionRecordForReferenceScan(sessionStore, session);
  const paths = [];
  for (const message of messages) {
    paths.push(...collectAssetPaths(message?.attachments));
    paths.push(...toolResultAssetPaths(message?.tool_result?.trusted_attachment_refs));
  }
  for (const event of turnEvents) {
    if (event?.kind === 'tool_result') paths.push(...toolResultAssetPaths(event.payload?.trusted_attachment_refs));
  }
  if (payloadKeys) {
    for (const key of payloadPathsFromMessages(messages)) {
      payloadKeys.add(key);
    }
  }
  if (cache) {
    cache.set(session.id, { stamp, paths });
  }
  assetPaths.push(...paths);
}

function dropDeadCacheEntries(cache, liveSessionIds) {
  if (!cache) return;
  for (const cachedSessionId of [...cache.keys()]) {
    if (!liveSessionIds.has(cachedSessionId)) {
      cache.delete(cachedSessionId);
    }
  }
}

function emptyReferences(collectPayloadKeys) {
  return { assetPaths: [], payloadKeys: collectPayloadKeys ? new Set() : null };
}

function collectSessionReferences(sessionStore, { cache = null, collectPayloadKeys = false } = {}) {
  if (!sessionStore || typeof sessionStore.listSessions !== 'function') {
    return emptyReferences(collectPayloadKeys);
  }
  const assetPaths = [];
  const payloadKeys = collectPayloadKeys ? new Set() : null;
  const liveSessionIds = new Set();
  for (const session of sessionStore.listSessions()) {
    liveSessionIds.add(session.id);
    collectOneSession(sessionStore, session, sessionAttachmentStamp(session, sessionStore), {
      cache, assetPaths, payloadKeys,
    });
  }
  dropDeadCacheEntries(cache, liveSessionIds);
  return { assetPaths, payloadKeys };
}

// A slice may overrun by one chat read (about 14 ms for a 500-message chat).
const REFERENCE_SCAN_SLICE_MS = 8;
const REFERENCE_SCAN_MAX_ROUNDS = 4;

function yieldToEventLoop() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

// collectSessionReferences in slices of about REFERENCE_SCAN_SLICE_MS, yielding
// to the event loop between them so a sweep over a large history never blocks
// IPC or streaming for the whole walk (about 1 s at 1000 chats).
//
// Yielding lets chats change mid-walk, and every deletion behind this result
// relies on it covering each live chat as it is NOW. So a walk ends with a
// synchronous check, with no yield between it and the return: every chat
// listed at that moment must have been read at exactly its current change
// stamp. A chat that is new or changed since its read is read again in another
// round (references only accumulate: over-counting keeps a file one more pass,
// under-counting deletes it). `onCollected(result)` runs in that same
// synchronous stretch, so a prune there sees exactly the checked state. A walk still unsettled after
// REFERENCE_SCAN_MAX_ROUNDS rounds throws, which aborts the prunes (fail closed),
// as does any incomplete read.
async function collectSessionReferencesAsync(sessionStore, {
  cache = null,
  collectPayloadKeys = false,
  sliceMs = REFERENCE_SCAN_SLICE_MS,
  maxRounds = REFERENCE_SCAN_MAX_ROUNDS,
  now = () => performance.now(),
  yieldFn = yieldToEventLoop,
  onCollected = null,
} = {}) {
  if (!sessionStore || typeof sessionStore.listSessions !== 'function') {
    const result = emptyReferences(collectPayloadKeys);
    if (typeof onCollected === 'function') onCollected(result);
    return result;
  }
  const assetPaths = [];
  const payloadKeys = collectPayloadKeys ? new Set() : null;
  const readStamps = new Map();
  let sliceStart = now();
  for (let round = 0; ; round += 1) {
    const sessions = sessionStore.listSessions();
    const pending = [];
    for (const session of sessions) {
      const stamp = sessionAttachmentStamp(session, sessionStore);
      if (readStamps.get(session.id) !== stamp) pending.push({ session, stamp });
    }
    if (pending.length === 0) {
      dropDeadCacheEntries(cache, new Set(sessions.map((session) => session.id)));
      const result = { assetPaths, payloadKeys };
      if (typeof onCollected === 'function') onCollected(result);
      return result;
    }
    if (round >= maxRounds) {
      throw new Error(`reference scan did not settle after ${maxRounds} rounds (${pending.length} chats changed)`);
    }
    for (const { session, stamp } of pending) {
      if (now() - sliceStart >= sliceMs) {
        await yieldFn();
        sliceStart = now();
      }
      collectOneSession(sessionStore, session, stamp, { cache, assetPaths, payloadKeys });
      readStamps.set(session.id, stamp);
    }
  }
}

function collectReferencedAttachmentAssetPaths(sessionStore, options = {}) {
  return collectSessionReferences(sessionStore, options).assetPaths;
}

function unrefInterval(interval) {
  if (typeof interval?.unref === 'function') {
    interval.unref();
  }
}

// Synchronous retention walks wait for backend readiness to avoid competing
// with model cold-load; a fallback timer and per-task stagger guarantee eventual
// execution.
function runInitialRetentionTaskWhenReady(backendService, task, {
  setTimeoutRef = setTimeout,
  fallbackMs = 60000,
  staggerMs = 0,
} = {}) {
  let started = false;
  const runOnce = () => {
    if (started) {
      return;
    }
    started = true;
    if (staggerMs > 0) {
      const handle = setTimeoutRef(task, staggerMs);
      if (typeof handle?.unref === 'function') {
        handle.unref();
      }
    } else {
      task();
    }
  };
  const currentPhase = (typeof backendService.getBackendStatus === 'function'
    ? backendService.getBackendStatus()?.phase
    : '') || '';
  if (currentPhase === 'ready') {
    runOnce();
    return;
  }
  const onStatus = (status) => {
    if (status?.phase === 'ready') {
      backendService.off?.('backend-status', onStatus);
      runOnce();
    }
  };
  if (typeof backendService.on === 'function') {
    backendService.on('backend-status', onStatus);
  }
  const fallback = setTimeoutRef(() => {
    backendService.off?.('backend-status', onStatus);
    runOnce();
  }, fallbackMs);
  if (typeof fallback?.unref === 'function') {
    fallback.unref();
  }
}

function scheduleStartupRetentionTasks({
  artifactService = null,
  backendService = null,
  attachmentAssetStore = null,
  artifactRetentionService = null,
  setTimeoutRef = setTimeout,
  setIntervalRef = setInterval,
  log = () => {},
} = {}) {
  if (artifactService && backendService) {
    const pruneArtifacts = () => {
      // A provider, not a snapshot: the prune re-resolves it right before
      // each deletion so a branch session persisted mid-pass (fork artifact
      // carry) is never treated as orphaned.
      const resolveActiveIds = () =>
        (backendService.sessionStore?.listSessions() || []).map((s) => s.id);
      return artifactService.pruneOrphanedArtifacts(resolveActiveIds).catch((err) => {
        log('WARN', 'artifacts.orphan_prune_failed', { error: String(err?.message || err) });
      });
    };
    runInitialRetentionTaskWhenReady(backendService, pruneArtifacts, { setTimeoutRef, staggerMs: 1000 });
    unrefInterval(setIntervalRef(pruneArtifacts, 30 * 60 * 1000));

    // WIDE-010: reference-aware artifact-session retention (Electron is the
    // authority — it owns the persisted generated_artifacts references; the
    // sidecar no longer deletes artifact directories at all). Soft-deletes
    // unreferenced dirs past age/byte quotas into .jenny/quarantine.
    const retentionService = artifactRetentionService || createArtifactRetentionService({
      getWorkspaceRoot: () => artifactService.getWorkspaceRoot(),
      getWorkspaceScopes: artifactService.getRetentionScopes
        ? () => artifactService.getRetentionScopes() : undefined,
      getSessionStore: () => backendService.sessionStore || null,
      logger: log,
    });
    const sweepArtifactRetention = () => {
      return Promise.resolve(retentionService.sweep()).catch((err) => {
        log('WARN', 'artifacts.retention_sweep_failed', { error: String(err?.message || err) });
      });
    };
    runInitialRetentionTaskWhenReady(backendService, sweepArtifactRetention, { setTimeoutRef, staggerMs: 4000 });
    unrefInterval(setIntervalRef(sweepArtifactRetention, 30 * 60 * 1000));
  }
  const ipcPayloadStore = backendService?.ipcPayloadStore || null;
  if ((attachmentAssetStore || ipcPayloadStore) && backendService) {
    // ONE walk of the session bodies feeds both prunes. They were two staggered
    // tasks four seconds apart, each doing a full cache-neutral read of every
    // session -- about 132MB of main-thread JSON parsing at startup on a
    // 149-session profile to do one pass of useful work.
    //
    // Persistent per-schedule memo: only sessions whose change stamp moved
    // since the last sweep are re-read. The first pass of a run still reads
    // everything once -- which is exactly why the payload half rides along with
    // that pass and then stops.
    const attachmentSweepCache = new Map();
    let payloadSweepPending = ipcPayloadStore !== null;
    let sweepInFlight = null;
    const runSessionReferenceSweep = async () => {
      // Payload keys are only collectable on a pass that reads every session.
      const collectPayloadKeys = payloadSweepPending && attachmentSweepCache.size === 0;
      let payloadKeys;
      try {
        const collected = await collectSessionReferencesAsync(backendService.sessionStore, {
          cache: attachmentSweepCache,
          collectPayloadKeys,
          // Same synchronous stretch as the walk's final settle check.
          onCollected: ({ assetPaths }) => {
            if (!attachmentAssetStore) return;
            const result = attachmentAssetStore.pruneUnreferencedAssets(assetPaths);
            if (result.deletedCount > 0) {
              log('INFO', 'attachments.assets_swept', { deletedCount: result.deletedCount });
            }
          },
        });
        payloadKeys = collected.payloadKeys;
      } catch (err) {
        // An incomplete read aborts BOTH prunes for this pass, deliberately:
        // the reference set behind them is the same one. Each affected feature
        // gets its own WARN so neither reads as unaffected in the logs.
        const error = String(err?.message || err);
        if (attachmentAssetStore) {
          log('WARN', 'attachments.asset_sweep_failed', { error });
        }
        if (collectPayloadKeys) {
          log('WARN', 'ipc_payloads.orphan_sweep_failed', { error });
        }
        return;
      }
      if (!payloadKeys) {
        return;
      }
      // Crash orphans only: a payload written mid-turn whose message was never
      // persisted. Session deletion collects the referenced ones live
      // (cleanupDeletedSession's ipc_payloads step), so this runs ONCE per
      // launch -- an orphan created during this run is collectable at the next
      // start. The default one-hour grace applies here, unlike the delete
      // path's graceMs: 0, because a file may have been written moments ago by
      // a turn still in flight.
      payloadSweepPending = false;
      try {
        const result = ipcPayloadStore.pruneUnreferencedPayloads(payloadKeys);
        if (result.deleted > 0) {
          log('INFO', 'ipc_payloads.orphans_swept', { deletedCount: result.deleted });
        }
      } catch (err) {
        log('WARN', 'ipc_payloads.orphan_sweep_failed', { error: String(err?.message || err) });
      }
    };
    // The walk yields between slices; an interval tick never starts a second one.
    const sweepSessionReferences = () => {
      if (!sweepInFlight) sweepInFlight = runSessionReferenceSweep().finally(() => { sweepInFlight = null; });
      return sweepInFlight;
    };
    // Heavier disk-walking sweep is staggered after the artifact prune.
    runInitialRetentionTaskWhenReady(backendService, sweepSessionReferences, { setTimeoutRef, staggerMs: 8000 });
    if (attachmentAssetStore) {
      unrefInterval(setIntervalRef(sweepSessionReferences, 30 * 60 * 1000));
    }
  }
  const legacySessionFilePath = backendService?.sessionStore?.filePath;
  if (typeof legacySessionFilePath === 'string' && legacySessionFilePath) {
    // Once per launch, no interval: the leftovers (crash-orphaned atomic-write
    // temps, the one-time split-migration backup) are only ever created before
    // or during startup, and each was ~63MB on a real profile.
    const pruneLegacyFiles = () => {
      pruneLegacySessionFiles({ legacyFilePath: legacySessionFilePath, log }).catch((err) => {
        log('WARN', 'session_store.legacy_file_prune_failed', { error: String(err?.message || err) });
      });
    };
    runInitialRetentionTaskWhenReady(backendService, pruneLegacyFiles, { setTimeoutRef, staggerMs: 12000 });
  }
}

module.exports = {
  collectReferencedAttachmentAssetPaths,
  collectSessionReferences,
  collectSessionReferencesAsync,
  readSessionMessagesForReferenceScan,
  runInitialRetentionTaskWhenReady,
  scheduleStartupRetentionTasks,
};
