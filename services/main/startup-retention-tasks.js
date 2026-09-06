const { collectAssetPaths } = require('../attachment-service');
const { createArtifactRetentionService } = require('../artifact-retention-service');
const { payloadPathsFromMessages } = require('../backend/ipc-payload-retention');

// Attachments only change through message mutations, and every message
// mutation bumps updated_at (append/update/replace/truncate) — the
// non-bumping writes (active-turn touches, turn events, pin/archive/meta)
// never touch attachments. So `updated_at|message_count` is a sound
// change stamp for a session's referenced-asset set, letting the periodic
// sweep skip re-reading unchanged sessions entirely.
function sessionAttachmentStamp(summary) {
  return `${summary?.updated_at || ''}|${Number(summary?.message_count || 0)}`;
}

// Reads one session's messages for a reference scan and FAILS CLOSED unless the
// read is provably complete. Every sweep in this file deletes files that nothing
// references, so the governing asymmetry is that under-counting references
// destroys user data while over-counting only leaves a stale file until the next
// pass. A session we cannot read in full must abort the pass, never contribute
// an empty reference set.
//
// Two distinct incomplete reads, and the second is the non-obvious one:
//   * `peekSession` returns null for an unreadable/empty file and for a
//     future-schema freeze (a newer app version wrote that session).
//   * A CORRUPT file is quarantined and RE-SEEDED as an empty stub --
//     `_quarantineAndRecoverCorruptSession` in session-storage-backend.js
//     persists `messages: []` and returns that record -- so `messages: []` is
//     NOT proof of an empty session and a null check alone misses it. The index
//     summary read at the top of the walk still carries the pre-quarantine
//     `message_count`, which is what makes the stub detectable. (The scan's own
//     peek is what can trigger that quarantine.)
function readSessionMessagesForReferenceScan(sessionStore, summary) {
  const sessionId = summary?.id;
  const expectedCount = Number(summary?.message_count || 0);
  let messages = null;
  if (typeof sessionStore?.peekSession === 'function') {
    // Cache-neutral peek so the scan never churns the session LRU.
    const record = sessionStore.peekSession(sessionId);
    messages = Array.isArray(record?.messages) ? record.messages : null;
  } else if (typeof sessionStore?.getSessionMessages === 'function') {
    const read = sessionStore.getSessionMessages(sessionId);
    messages = Array.isArray(read) ? read : null;
  }
  if (!messages) {
    throw new Error(`reference scan could not read session ${sessionId}`);
  }
  if (messages.length === 0 && expectedCount > 0) {
    throw new Error(
      `reference scan read an empty stub for session ${sessionId} (index expects ${expectedCount})`
    );
  }
  return messages;
}

// Walks every session body ONCE and returns whichever reference sets the caller
// asked for. Both retention sweeps read the same message arrays, so collecting
// them separately meant parsing every session file twice at startup.
//
// `payloadKeys` is opt-in and only sound on a pass that reads every session: a
// memo hit answers a session without reading it, which is fine for attachments
// (the cached paths ARE that session's answer) but would silently under-count
// payload references, and under-counting deletes data. The caller enforces that
// by asking for payload keys only when the memo is empty; within one such pass
// no cache hit is possible, because each session id is visited once.
function collectSessionReferences(sessionStore, { cache = null, collectPayloadKeys = false } = {}) {
  if (!sessionStore || typeof sessionStore.listSessions !== 'function') {
    return { assetPaths: [], payloadKeys: collectPayloadKeys ? new Set() : null };
  }
  const assetPaths = [];
  const payloadKeys = collectPayloadKeys ? new Set() : null;
  const liveSessionIds = cache ? new Set() : null;
  for (const session of sessionStore.listSessions()) {
    const stamp = sessionAttachmentStamp(session);
    if (cache) {
      liveSessionIds.add(session.id);
      const cached = cache.get(session.id);
      if (cached && cached.stamp === stamp) {
        assetPaths.push(...cached.paths);
        continue;
      }
    }
    const messages = readSessionMessagesForReferenceScan(sessionStore, session);
    const paths = [];
    for (const message of messages) {
      paths.push(...collectAssetPaths(message?.attachments));
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
  if (cache) {
    for (const cachedSessionId of [...cache.keys()]) {
      if (!liveSessionIds.has(cachedSessionId)) {
        cache.delete(cachedSessionId);
      }
    }
  }
  return { assetPaths, payloadKeys };
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
      artifactService.pruneOrphanedArtifacts(resolveActiveIds).catch((err) => {
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
      getSessionStore: () => backendService.sessionStore || null,
      logger: log,
    });
    const sweepArtifactRetention = () => {
      Promise.resolve(retentionService.sweep()).catch((err) => {
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
    // since the last sweep are re-read, so the 30-minute interval stops
    // re-parsing every session file. The first pass of a run still reads
    // everything once -- which is exactly why the payload half rides along with
    // that pass and then stops.
    const attachmentSweepCache = new Map();
    let payloadSweepPending = ipcPayloadStore !== null;
    const sweepSessionReferences = () => {
      // Payload keys are only collectable on a pass that reads every session.
      const collectPayloadKeys = payloadSweepPending && attachmentSweepCache.size === 0;
      let payloadKeys;
      try {
        const collected = collectSessionReferences(backendService.sessionStore, {
          cache: attachmentSweepCache,
          collectPayloadKeys,
        });
        payloadKeys = collected.payloadKeys;
        if (attachmentAssetStore) {
          const result = attachmentAssetStore.pruneUnreferencedAssets(collected.assetPaths);
          if (result.deletedCount > 0) {
            log('INFO', 'attachments.assets_swept', { deletedCount: result.deletedCount });
          }
        }
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
    // Heavier disk-walking sweep is staggered after the artifact prune.
    runInitialRetentionTaskWhenReady(backendService, sweepSessionReferences, { setTimeoutRef, staggerMs: 8000 });
    if (attachmentAssetStore) {
      unrefInterval(setIntervalRef(sweepSessionReferences, 30 * 60 * 1000));
    }
  }
}

module.exports = {
  collectReferencedAttachmentAssetPaths,
  collectSessionReferences,
  readSessionMessagesForReferenceScan,
  runInitialRetentionTaskWhenReady,
  scheduleStartupRetentionTasks,
};
