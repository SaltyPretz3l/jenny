'use strict';
const { editable } = require('./pending-input');
const { TERMINAL } = require('./terminal-retention-contract');
function projectWorkCoordination(runtime, work, { childOffset = 0, lineageRevision = null } = {}) {
  const result = { editable: editable(work), root_run_id: null, parent_work_id: null,
    children: [], child_count: 0, next_child_offset: null, lineage_revision: null, budget: null, progress: null,
    wait: null, cleanup_confirmed: TERMINAL.has(work.status)
      && !runtime.scheduler.active?.has(work.work_id) && !runtime.scheduler.cancellationFences?.has(work.work_id),
    attention: work.status === 'needs_attention', available: true };
  try {
    const rootId = work.input?.root_run?.root_run_id || work.input?.child_run?.root_run_id;
    result.parent_work_id = work.input?.child_run?.parent_work_id || null;
    if (rootId) {
      result.root_run_id = rootId;
      const budget = runtime.budgetStore.inspect(rootId, { limit: 1 });
      result.budget = { limits: budget.limits, charged: budget.charged, over_limit: budget.over_limit,
        unresolved_reservation_count: budget.unresolved_reservation_count,
        unknown_consumption_count: budget.unknown_consumption_count };
      if (runtime.lineageStore.rootIds.has(rootId)) {
        const lineage = runtime.lineageStore.get(rootId);
        if (childOffset && lineageRevision !== lineage.revision) throw new Error('lineage_page_stale');
        result.lineage_revision = lineage.revision;
        const children = lineage.children.filter(child => child.parent_work_id === work.work_id);
        result.child_count = children.length;
        result.next_child_offset = childOffset + 50 < children.length ? childOffset + 50 : null;
        result.children = children.slice(childOffset, childOffset + 50).map(child => ({ work_id: child.work_id,
          purpose: runtime.store.get(child.work_id)?.purpose || null,
          session_id: child.session_id, turn_id: child.turn_id, depth: child.depth,
          status: runtime.store.get(child.work_id)?.status || 'preparing' }));
        if (lineage.cancelled) result.cleanup_confirmed = result.cleanup_confirmed
          && lineage.children.every(child => TERMINAL.has(runtime.store.get(child.work_id)?.status)
            && !runtime.scheduler.active?.has(child.work_id) && !runtime.scheduler.cancellationFences?.has(child.work_id)
            && !runtime.children?.publications.has(child.work_id));
      }
    }
    if (work.checkpoint_ref) {
      const view = runtime.checkpointStore.inspectReference(work.checkpoint_ref);
      result.progress = view.progress;
      if (work.status === 'paused') result.wait = view.wait;
    }
    if (work.control_request) result.wait = { kind: work.control_request.kind === 'cancel' ? 'cancellation' : 'pause_requested' };
    return result;
  } catch (_error) { return { ...result, available: false, cleanup_confirmed: false }; }
}
function projectCanonicalResult(runtime, work) {
  if (!work || !TERMINAL.has(work.status)) throw new Error('runtime_result_not_terminal');
  const session = runtime.chatAdapter?.service?.sessionStore?.getSession(work.session_id);
  return { ok: true, work_id: work.work_id, session_id: work.session_id, turn_id: work.turn_id,
    status: work.status, available: Boolean(session?.messages.some(row => row.turn_id === work.turn_id)) };
}
module.exports = { projectWorkCoordination, projectCanonicalResult };
