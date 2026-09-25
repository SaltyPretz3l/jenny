'use strict';

const { TERMINAL } = require('./terminal-retention-contract');

function cancellationScope(runtime, work) {
  const rootId = work.input?.root_run?.root_run_id || work.input?.child_run?.root_run_id;
  if (!rootId || !runtime.lineageStore) return { works: [work], ids: new Set([work.work_id]), rootId: null };
  let lineage;
  try { lineage = runtime.lineageStore.get(rootId); }
  catch (error) { if (error?.message === 'lineage_not_found') return { works: [work], ids: new Set([work.work_id]), rootId: null }; throw error; }
  const ids = new Set([work.work_id]);
  for (const child of [...lineage.children].sort((a, b) => a.depth - b.depth)) {
    if (ids.has(child.parent_work_id)) ids.add(child.work_id);
  }
  const works = [...ids].map(id => runtime.store.get(id)).filter(Boolean);
  return { works, ids, rootId: lineage.root_work_id === work.work_id ? rootId : null };
}

// Fence the complete known subtree before any abort can settle a producer or wake
// eligibility. Durable lineage cancellation prevents publication after root exit.
function cancelRuntimeSubtree(runtime, workId, options = {}) {
  const work = runtime.store.get(workId);
  if (!work) return runtime.scheduler.requestCancellation(workId, options);
  if (options.expectedRevision !== undefined && work.revision !== options.expectedRevision) {
    return Object.freeze({ status: 'rejected', work_id: workId, cleanup_confirmed: false, reason: 'revision_conflict' });
  }
  runtime.eligibilityCoordinator?.forget(work.work_id);
  let scope;
  let failure = null;
  try { scope = cancellationScope(runtime, work); }
  catch (error) {
    failure = error;
    scope = { works: [work], ids: new Set([workId]), rootId: null };
    for (const entry of runtime.scheduler.active.values()) {
      let ancestor = entry.work;
      for (let depth = 0; ancestor && depth <= 8; depth++) {
        if (ancestor.work_id === workId) {
          if (!scope.ids.has(entry.work.work_id)) scope.works.push(entry.work);
          scope.ids.add(entry.work.work_id);
          break;
        }
        const parentId = ancestor.input?.child_run?.parent_work_id;
        try { ancestor = parentId ? runtime.store.get(parentId) : null; }
        catch (_error) { break; }
      }
    }
  }
  if (!failure && !scope.rootId && scope.ids.size === 1) return runtime.scheduler.requestCancellation(workId, options);
  const addedFences = new Set();
  for (const item of scope.works) {
    runtime.eligibilityCoordinator?.forget(item.work_id);
    if (!runtime.scheduler.cancellationFences.has(item.work_id)) {
      addedFences.add(item.work_id);
      runtime.scheduler.cancellationFences.set(item.work_id, Object.freeze({
        attempt: item.attempt, session_id: item.session_id, subtree: workId, reason: options.reason || 'user' }));
    }
  }
  if (scope.rootId) {
    try { runtime.lineageStore.cancelRoot(scope.rootId); }
    catch (error) { failure = error; }
  }
  const results = scope.works.map(item => {
    // A terminal ancestor has no remaining publisher. Its root lineage is now
    // revoked; on write failure retain the fence until a successful explicit retry.
    if (TERMINAL.has(item.status) && (addedFences.has(item.work_id)
      || runtime.scheduler.cancellationFences.get(item.work_id)?.subtree === workId)
      && !(failure && item.work_id === workId)) runtime.scheduler.cancellationFences.delete(item.work_id);
    return runtime.scheduler.requestCancellation(item.work_id, { ...options,
      expectedRevision: item.revision, abort: item.work_id === workId ? options.abort !== false : true,
      deletionHandle: item.work_id === workId ? options.deletionHandle : null });
  });
  const publications = [...scope.ids].map(id => runtime.children?.publications.get(id)?.promise).filter(Boolean);
  const snapshot = () => ({ status: TERMINAL.has(runtime.store.get(workId)?.status)
    ? runtime.store.get(workId).status : results[0].status, work_id: workId,
    descendant_count: scope.ids.size - 1,
    persisted: !failure && results.every(result => result.persisted !== false),
    cleanup_confirmed: !failure && [...scope.ids].every(id => {
      const current = runtime.store.get(id);
      return (!current || TERMINAL.has(current.status)) && !runtime.scheduler.active.has(id)
        && !runtime.scheduler.cancellationFences.has(id) && !runtime.children?.publications.has(id);
    }), ...(failure ? { reason: 'runtime_subtree_cancellation_incomplete' } : {}) });
  const pending = [...results.map(result => result.settlement).filter(Boolean), ...publications];
  return Object.freeze({ ...results[0], ...snapshot(), ...(pending.length ? {
    settlement: Promise.allSettled(pending).then(() => Object.freeze(snapshot())) } : {}) });
}

function recoverRuntimeCancellationTrees(runtime) {
  let roots = 0;
  let requested = 0;
  let incomplete = 0;
  try {
    for (const { document } of runtime.lineageStore.exportPortableSnapshot().records) {
      roots += 1;
      const covered = new Set();
      for (const id of [document.root_work_id, ...document.children.map(child => child.work_id)]) {
        if (covered.has(id)) continue;
        const work = runtime.store.get(id);
        if (!work || !(id === document.root_work_id && document.cancelled)
          && work.status !== 'cancelled' && work.control_request?.kind !== 'cancel') continue;
        const scope = cancellationScope(runtime, work);
        for (const descendant of scope.ids) covered.add(descendant);
        const result = cancelRuntimeSubtree(runtime, id, { expectedRevision: work.revision,
          reason: 'recovered_cancellation', abort: true });
        requested += 1;
        if (!result.cleanup_confirmed) incomplete += 1;
      }
    }
    return { roots, requested, incomplete };
  } catch (_error) { return { roots, requested, incomplete: incomplete + 1 }; }
}

module.exports = { cancelRuntimeSubtree, recoverRuntimeCancellationTrees };
