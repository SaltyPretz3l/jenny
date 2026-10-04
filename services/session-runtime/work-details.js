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
      if (work.status === 'paused') {
        result.wait = view.wait;
        if (['resource', 'dependency'].includes(view.wait?.kind)
          && runtime.eligibilityCoordinator?.isTracked(work.work_id) !== true) result.attention = true;
      }
    }
    if (work.control_request) result.wait = { kind: work.control_request.kind === 'cancel' ? 'cancellation' : 'pause_requested' };
    // Runs pre-fills the instructions box with what was submitted; only work
    // that can still be edited (pending, never attempted) exposes its prompt.
    if (result.editable) {
      const request = work.input?.request;
      const prompt = typeof request?.visiblePrompt === 'string' ? request.visiblePrompt : request?.prompt;
      if (typeof prompt === 'string') result.prompt = prompt;
    }
    return result;
  } catch (_error) { return { ...result, available: false, cleanup_confirmed: false }; }
}
function laneOf(record) {
  const route = record?.input?.route;
  if (route?.resource_class === 'local') return 'local';
  if (route?.resource_class === 'cloud') return `cloud:${String(route.provider_id || '')}`;
  return 'default';
}
// Queue place of every pending item: 1-based, per lane, in submission order
// (the order the scheduler offers ready work). Only lanes that the page shows
// are resolved, so a page with nothing waiting reads no records.
function queuePositions(runtime, wanted) {
  const positions = new Map();
  if (!wanted.size) return positions;
  const last = Math.max(...[...wanted.values()].map(entry => entry.submission_sequence));
  const pending = runtime.store.listReadyCandidates({ limit: 256 })
    .filter(entry => entry.submission_sequence <= last)
    .sort((left, right) => left.submission_sequence - right.submission_sequence);
  const counts = new Map();
  for (const entry of pending) {
    let lane = 'default';
    try { lane = laneOf(runtime.store.get(entry.work_id)); } catch (_error) { /* default lane */ }
    const place = (counts.get(lane) || 0) + 1;
    counts.set(lane, place);
    if (wanted.has(entry.work_id)) positions.set(entry.work_id, place);
  }
  return positions;
}
function runProgress(runtime, record) {
  if (record.checkpoint_ref) {
    const view = runtime.checkpointStore.inspectReference(record.checkpoint_ref);
    return { steps: view.progress.completed_iterations, tool_calls: view.progress.tool_calls_consumed, wait: view.wait };
  }
  const rootId = record.input?.root_run?.root_run_id || record.input?.child_run?.root_run_id;
  if (!rootId) return null;
  const budget = runtime.budgetStore.inspect(rootId, { limit: 1 });
  return { steps: budget.charged.inference_requests, tool_calls: null, wait: null };
}
// One Runs row per summary. Terminal rows use the index summary only (their
// records are not cached, and a finished row shows no live detail).
function projectRunItems(runtime, summaries) {
  const pending = new Map(summaries.filter(entry => entry.status === 'pending').map(entry => [entry.work_id, entry]));
  let positions = new Map();
  try { positions = queuePositions(runtime, pending); } catch (_error) { /* positions stay unknown */ }
  return summaries.map((summary) => {
    const item = { ...summary, group: TERMINAL.has(summary.status) ? 'finished'
      : summary.status === 'running' ? 'running' : summary.status === 'pending' ? 'waiting' : 'needs_you',
    recovery_kind: null, control_kind: null, wait_kind: null, parent_work_id: null, progress: null,
    queue_position: positions.get(summary.work_id) || null };
    if (item.group === 'finished') return item;
    try {
      const record = runtime.store.get(summary.work_id);
      if (!record) return item;
      item.recovery_kind = record.recovery?.kind || null;
      item.control_kind = record.control_request?.kind || null;
      item.parent_work_id = record.input?.child_run?.parent_work_id || null;
      if (['running', 'paused'].includes(record.status)) {
        const progress = runProgress(runtime, record);
        if (progress) item.progress = { steps: progress.steps, tool_calls: progress.tool_calls };
        // A paused continuation that waits on capacity or on its own subagents
        // resumes by itself: it is waiting, not asking for the person.
        const waitKind = record.status === 'paused' && !record.control_request && !record.recovery
          ? progress?.wait?.kind : null;
        if (['resource', 'dependency'].includes(waitKind)
          && runtime.eligibilityCoordinator?.isTracked(record.work_id) === true) {
          item.group = 'waiting'; item.wait_kind = waitKind;
        }
      }
    } catch (_error) { /* the row keeps its summary-only shape */ }
    return item;
  });
}
function projectCanonicalResult(runtime, work) {
  if (!work || !TERMINAL.has(work.status)) throw new Error('runtime_result_not_terminal');
  const session = runtime.chatAdapter?.service?.sessionStore?.getSession(work.session_id);
  return { ok: true, work_id: work.work_id, session_id: work.session_id, turn_id: work.turn_id,
    status: work.status, available: Boolean(session?.messages.some(row => row.turn_id === work.turn_id)) };
}
module.exports = { projectWorkCoordination, projectCanonicalResult, projectRunItems };
