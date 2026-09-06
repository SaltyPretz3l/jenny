'use strict';

const { joinPath } = require('../store/fs-facade');
const { readCleanupState, buildCleanupState, writeCleanupState } = require('../store/cleanup-state');
const { pluginSettingsDir } = require('../paths/store-paths');
const { readCommittedState } = require('./commit-sequence');
const { collectRetainedGenerations, reclaimUnreachableContent } = require('./uninstall-operation');

const MAX_CANDIDATES = 256;
const PUBLISHER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const PLUGIN_ID = /^[a-z][a-z0-9_-]{0,63}$/;

function pendingAbsent(state) {
  return state?.cleanup_target?.kind === 'absent'
    && ['pending_restart', 'termination_failed', 'settling'].includes(state.cleanup_status);
}

async function discoverCandidates(facade, baseDir) {
  const candidates = [];
  for (const publisherId of await facade.list(joinPath(baseDir, 'data'))) {
    if (!PUBLISHER_ID.test(publisherId)) continue;
    for (const pluginId of await facade.list(joinPath(baseDir, 'data', publisherId))) {
      if (!PLUGIN_ID.test(pluginId) || candidates.length >= MAX_CANDIDATES) continue;
      const read = await readCleanupState(facade, baseDir, publisherId, pluginId);
      if (read.ok && pendingAbsent(read.state)) {
        candidates.push({ publisherId, pluginId, state: read.state });
      }
    }
  }
  return candidates;
}

async function reconcileStartupCleanup({ facade, baseDir = '', processCleanupReady = null,
  listProcessReceipts = async () => ({ ok: true, receipts: [] }), log = () => {} } = {}) {
  await Promise.resolve(processCleanupReady).catch(() => null);
  const candidates = await discoverCandidates(facade, baseDir);
  if (!candidates.length) return { ok: true, settled: 0, deferred: 0 };

  const committed = await readCommittedState(facade, baseDir);
  if (committed.pointerStatus !== 'ok' || !committed.generation) {
    log('WARN', 'plugins.cleanup.startup_deferred', { reason_code: 'authority_unavailable' });
    return { ok: false, reason: 'authority_unavailable', settled: 0, deferred: candidates.length };
  }
  const receipts = await listProcessReceipts();
  if (!receipts?.ok) {
    return { ok: false, reason: 'process_receipts_unavailable', settled: 0,
      deferred: candidates.length };
  }
  const retained = await collectRetainedGenerations(facade, baseDir);
  if (!retained.ok) {
    return { ok: false, reason: retained.reason, settled: 0, deferred: candidates.length };
  }

  const eligible = candidates.filter(({ publisherId, pluginId }) => {
    const stillInstalled = committed.generation.plugins.some((entry) => (
      entry.publisher_id === publisherId && entry.plugin_id === pluginId
    ));
    const processPending = receipts.receipts.some((entry) => (
      entry.publisher_id === publisherId && entry.plugin_id === pluginId
    ));
    return !stillInstalled && !processPending;
  });
  const settingsFailed = new Set();
  for (const candidate of eligible) {
    try {
      await facade.removeTree(pluginSettingsDir(baseDir, candidate.publisherId, candidate.pluginId));
    } catch (_error) {
      settingsFailed.add(`${candidate.publisherId}\0${candidate.pluginId}`);
    }
  }
  let reclaim;
  try {
    reclaim = await reclaimUnreachableContent(facade, baseDir, {
      activeGeneration: committed.generation,
      retainedGenerations: retained.records,
    });
  } catch (_error) {
    reclaim = { failed: [{ error: 'startup_gc_failed' }] };
  }

  let settled = 0;
  for (const candidate of eligible) {
    const key = `${candidate.publisherId}\0${candidate.pluginId}`;
    if (settingsFailed.has(key) || reclaim.failed.length) continue;
    const next = buildCleanupState({ cleanupStatus: 'complete', cleanupTarget: { kind: 'absent' },
      lifecycleEpoch: candidate.state.lifecycle_epoch, commitEpoch: candidate.state.commit_epoch,
      cleanupDetail: { code: 'cleanup_complete', retryable: false } });
    const written = await writeCleanupState(
      facade, baseDir, candidate.publisherId, candidate.pluginId, next
    );
    if (written.ok) settled += 1;
  }
  const deferred = candidates.length - settled;
  log(deferred ? 'WARN' : 'INFO', deferred
    ? 'plugins.cleanup.startup_deferred' : 'plugins.cleanup.startup_settled', {
    settled_count: settled, deferred_count: deferred,
  });
  return { ok: deferred === 0, settled, deferred,
    ...(deferred ? { reason: 'cleanup_pending_restart' } : {}) };
}

module.exports = { MAX_CANDIDATES, discoverCandidates, reconcileStartupCleanup };
