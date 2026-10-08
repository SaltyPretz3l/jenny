'use strict';

const { validId, workPromptPreview } = require('./contracts');
const { DEFAULT_SESSION_RUNTIME, LIMIT_RANGES } = require('../shell-config-session-runtime');

const PROJECTION_SCHEMA_VERSION = 1;
const MAX_CURSOR_CHARS = 4096;
const CURSOR_PATTERN = /^[a-zA-Z0-9_-]+$/u;
const WORK_STATUSES = new Set([
  'pending', 'paused', 'running', 'completed', 'failed', 'cancelled', 'needs_attention',
]);
const LANE_CLASSES = ['local', 'cloud'];
const LANE_LIMIT_KEYS = ['descendant_depth', 'descendants', 'inference_requests', 'runnable_turns'];
const CONFIGURED_RESOURCE_KEYS = ['native_processes', 'tests', 'tool_operations'];
const EFFECTIVE_RESOURCE_KEYS = ['native_processes', 'sandbox_commands', 'tests', 'tool_operations'];
const RUN_GROUPS = new Set(['needs_you', 'running', 'waiting', 'finished']);
const RECOVERY_KINDS = ['restart_paused', 'transition_repaired'];
const WAIT_KINDS = ['dependency', 'resource'];
const ADMISSION_WAIT_REASONS = new Set(['session_busy', 'model_busy', 'cleanup_unconfirmed']);

class RuntimeProjectionError extends Error {
  constructor(reason = 'runtime_projection_invalid') {
    super(reason);
    this.code = reason;
  }
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value, allowed) {
  return isPlainRecord(value) && Object.keys(value).every(key => allowed.includes(key));
}

function validTimestamp(value) {
  return typeof value === 'string' && value.length >= 20 && value.length <= 40
    && Number.isFinite(Date.parse(value));
}

function boundedCount(value, { positive = false } = {}) {
  return Number.isSafeInteger(value) && value >= (positive ? 1 : 0);
}

// `view: 'runs'` asks for the Runs page shape: every unfinished item plus the
// terminal items updated since `finished_since`, in a stable created_at order,
// without a cursor (which goes stale on every transition while work runs).
function normalizeSnapshotRequest(payload = {}) {
  if (!hasOnlyKeys(payload, ['cursor', 'finished_since', 'limit', 'project_id', 'session_id', 'view'])) return null;
  const projectId = Object.hasOwn(payload, 'project_id') ? payload.project_id : null;
  const sessionId = Object.hasOwn(payload, 'session_id') ? payload.session_id : null;
  const cursor = Object.hasOwn(payload, 'cursor') ? payload.cursor : null;
  const limit = Object.hasOwn(payload, 'limit') ? payload.limit : 50;
  const view = Object.hasOwn(payload, 'view') ? payload.view : 'page';
  const finishedSince = Object.hasOwn(payload, 'finished_since') ? payload.finished_since : null;
  if ((projectId !== null && !validId(projectId))
    || (sessionId !== null && !validId(sessionId))
    || (cursor !== null && (typeof cursor !== 'string' || !CURSOR_PATTERN.test(cursor)
      || cursor.length > MAX_CURSOR_CHARS))
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || !['page', 'runs'].includes(view)
    || (view === 'runs' && (cursor !== null || sessionId !== null))
    || (finishedSince !== null && (view !== 'runs' || !validTimestamp(finishedSince)))) return null;
  return Object.freeze({ cursor, limit, projectId, sessionId, view, finishedSince });
}

function normalizeWorkRequest(payload = {}) {
  if (!hasOnlyKeys(payload, ['work_id', 'child_offset', 'lineage_revision']) || !validId(payload.work_id)
    || (payload.child_offset !== undefined && (!Number.isSafeInteger(payload.child_offset) || payload.child_offset < 0 || payload.child_offset > 512))
    || (payload.lineage_revision !== undefined && (!Number.isSafeInteger(payload.lineage_revision) || payload.lineage_revision < 1))) return null;
  return Object.freeze({ workId: payload.work_id, childOffset: payload.child_offset || 0, lineageRevision: payload.lineage_revision || null });
}

function projectLimitGroup(value, keys, { zeroAllowed = [] } = {}) {
  if (!isPlainRecord(value)) throw new RuntimeProjectionError();
  const projected = {};
  for (const key of keys) {
    if (!boundedCount(value[key], { positive: !zeroAllowed.includes(key) })) {
      throw new RuntimeProjectionError();
    }
    projected[key] = value[key];
  }
  return Object.freeze(projected);
}

function projectConfiguredLanes(configured) {
  if (!isPlainRecord(configured)) throw new RuntimeProjectionError();
  return Object.freeze(Object.fromEntries(LANE_CLASSES.map(lane => [
    lane, projectLimitGroup(configured[lane], LANE_LIMIT_KEYS, {
      zeroAllowed: ['descendant_depth', 'descendants'],
    }),
  ])));
}

function projectEffectiveLanes(configured, downstream) {
  const limits = projectLimitGroup(downstream, ['inference_requests', 'runnable_turns']);
  return Object.freeze(Object.fromEntries(LANE_CLASSES.map((lane) => {
    const laneLimits = configured[lane];
    return [lane, Object.freeze({
      runnable_turns: Math.min(laneLimits.runnable_turns, limits.runnable_turns),
      inference_requests: Math.min(laneLimits.inference_requests, limits.inference_requests),
      descendants: laneLimits.descendants,
      descendant_depth: laneLimits.descendant_depth,
    })];
  })));
}

function projectLaneCounts(snapshot) {
  if (!boundedCount(snapshot.active_leases) || !boundedCount(snapshot.quarantined)
    || !Array.isArray(snapshot.lanes) || snapshot.lanes.length > 256) {
    throw new RuntimeProjectionError();
  }
  const byLane = snapshot.lanes.map((lane) => {
    if (!isPlainRecord(lane) || typeof lane.lane !== 'string' || !lane.lane
      || lane.lane.length > 256 || !boundedCount(lane.turns)
      || !boundedCount(lane.inference_requests) || !boundedCount(lane.quarantined)) {
      throw new RuntimeProjectionError();
    }
    return Object.freeze({ lane: lane.lane, turns: lane.turns,
      inference_requests: lane.inference_requests, quarantined: lane.quarantined });
  }).sort((left, right) => left.lane.localeCompare(right.lane));
  return Object.freeze({ active_leases: snapshot.active_leases,
    quarantined: snapshot.quarantined, by_lane: Object.freeze(byLane) });
}

function projectResourceLimits(value, keys) {
  return projectLimitGroup(value, keys);
}

function projectResourceCounts(snapshot) {
  if (!boundedCount(snapshot.lease_count) || !boundedCount(snapshot.waiter_count)
    || !boundedCount(snapshot.quarantined_count) || !isPlainRecord(snapshot.capacity)) {
    throw new RuntimeProjectionError();
  }
  const capacity = {};
  for (const key of EFFECTIVE_RESOURCE_KEYS) {
    if (!boundedCount(snapshot.capacity[key])) throw new RuntimeProjectionError();
    capacity[key] = snapshot.capacity[key];
  }
  return Object.freeze({ capacity: Object.freeze(capacity), lease_count: snapshot.lease_count,
    waiter_count: snapshot.waiter_count, quarantined_count: snapshot.quarantined_count });
}

function projectSummary(summary) {
  if (!isPlainRecord(summary) || !validId(summary.work_id) || !validId(summary.project_id)
    || !validId(summary.session_id) || !validId(summary.turn_id)
    || typeof summary.purpose !== 'string' || !summary.purpose.trim()
    || summary.purpose.length > 256 || !WORK_STATUSES.has(summary.status)
    || !boundedCount(summary.revision, { positive: true })
    || !boundedCount(summary.submission_sequence, { positive: true })
    || !validTimestamp(summary.created_at) || !validTimestamp(summary.updated_at)) {
    throw new RuntimeProjectionError();
  }
  const wait = Object.hasOwn(summary, 'admission_wait') ? summary.admission_wait : null;
  if (wait !== null && (summary.status !== 'pending' || !hasOnlyKeys(wait,
    ['reason', 'since', 'blocking_session_id']) || Object.keys(wait).length !== 3
    || !ADMISSION_WAIT_REASONS.has(wait.reason) || !Number.isFinite(wait.since)
    || wait.since < 0 || (wait.blocking_session_id !== null && !validId(wait.blocking_session_id)))) {
    throw new RuntimeProjectionError();
  }
  let admissionWait = null;
  if (wait !== null) {
    try { admissionWait = Object.freeze({ ...wait, since: new Date(wait.since).toISOString() }); }
    catch (_error) { throw new RuntimeProjectionError(); }
  }
  // Paused work only: whether the scheduler can resume it (null when unknown).
  const resumable = Object.hasOwn(summary, 'resumable') ? summary.resumable : null;
  if (resumable !== null && (summary.status !== 'paused' || typeof resumable !== 'boolean')) {
    throw new RuntimeProjectionError();
  }
  return Object.freeze({ work_id: summary.work_id, project_id: summary.project_id,
    session_id: summary.session_id, turn_id: summary.turn_id, purpose: summary.purpose,
    status: summary.status, revision: summary.revision,
    submission_sequence: summary.submission_sequence,
    created_at: summary.created_at, updated_at: summary.updated_at, admission_wait: admissionWait,
    resumable });
}

function nullableCount(value) {
  return value === null || boundedCount(value);
}

// One Runs row. `group` is the page section (needs_you | running | waiting |
// finished); `queue_position` is the 1-based place of pending work in its lane;
// `progress` is null when the runtime has no durable step count for the item.
function projectRunItem(item) {
  if (!isPlainRecord(item) || !RUN_GROUPS.has(item.group)) throw new RuntimeProjectionError();
  const summary = projectSummary(item);
  if ((item.recovery_kind !== null && !RECOVERY_KINDS.includes(item.recovery_kind))
    || (item.control_kind !== null && !['cancel', 'pause'].includes(item.control_kind))
    || (item.wait_kind !== null && !WAIT_KINDS.includes(item.wait_kind))
    || (item.queue_position !== null && !boundedCount(item.queue_position, { positive: true }))
    || (item.parent_work_id !== null && !validId(item.parent_work_id))
    || (item.progress !== null && (!isPlainRecord(item.progress)
      || !nullableCount(item.progress.steps) || !nullableCount(item.progress.tool_calls)))) {
    throw new RuntimeProjectionError();
  }
  return Object.freeze({ ...summary, group: item.group, recovery_kind: item.recovery_kind,
    control_kind: item.control_kind, wait_kind: item.wait_kind, queue_position: item.queue_position,
    parent_work_id: item.parent_work_id,
    progress: item.progress === null ? null : Object.freeze({ steps: item.progress.steps,
      tool_calls: item.progress.tool_calls }) });
}

function projectLimitDefaults() {
  const ranges = Object.fromEntries(Object.entries(LIMIT_RANGES).map(([key, [min, max]]) => [key,
    Object.freeze({ min, max })]));
  return Object.freeze({ defaults: Object.freeze(Object.fromEntries(Object.entries(DEFAULT_SESSION_RUNTIME)
    .map(([group, values]) => [group, Object.freeze({ ...values })]))), ranges: Object.freeze(ranges) });
}

function projectRuntimeSnapshot({ runtime, storeStatus, laneSnapshot, resourceSnapshot, page, runs = null }) {
  if (runs !== null && (!isPlainRecord(runs) || !Array.isArray(runs.items) || runs.items.length > 100
    || typeof runs.truncated !== 'boolean')) throw new RuntimeProjectionError();
  if (runs !== null) page = { items: [], next_cursor: null, revision: runs.revision };
  if (!isPlainRecord(storeStatus) || typeof storeStatus.read_only !== 'boolean'
    || !boundedCount(storeStatus.revision) || !isPlainRecord(laneSnapshot)
    || !isPlainRecord(resourceSnapshot) || !isPlainRecord(page)
    || !Array.isArray(page.items) || page.items.length > 100
    || (page.next_cursor !== null && (typeof page.next_cursor !== 'string'
      || !page.next_cursor || page.next_cursor.length > MAX_CURSOR_CHARS))
    || page.revision !== storeStatus.revision || typeof runtime.scheduler?.enabled !== 'boolean'
    || typeof runtime.scheduler?.closing !== 'boolean') throw new RuntimeProjectionError();
  const configuredLanes = projectConfiguredLanes(laneSnapshot.configured);
  const configuredResources = projectResourceLimits(
    laneSnapshot.configured.resources,
    CONFIGURED_RESOURCE_KEYS
  );
  const downstreamLimits = projectLimitGroup(
    laneSnapshot.downstream,
    ['inference_requests', 'runnable_turns']
  );
  const effectiveResources = projectResourceLimits(
    resourceSnapshot.limits,
    EFFECTIVE_RESOURCE_KEYS
  );
  if (effectiveResources.sandbox_commands > 1) throw new RuntimeProjectionError();
  return Object.freeze({
    ok: true,
    schema_version: PROJECTION_SCHEMA_VERSION,
    enabled: runtime.scheduler.enabled,
    closing: runtime.scheduler.closing,
    read_only: storeStatus.read_only,
    revision: storeStatus.revision,
    lanes: Object.freeze({ configured_limits: configuredLanes,
      downstream_limits: downstreamLimits,
      effective_limits: projectEffectiveLanes(configuredLanes, downstreamLimits),
      counts: projectLaneCounts(laneSnapshot) }),
    resources: Object.freeze({ configured_limits: configuredResources,
      effective_limits: effectiveResources, counts: projectResourceCounts(resourceSnapshot) }),
    ...(runs === null ? { work: Object.freeze(page.items.map(projectSummary)), next_cursor: page.next_cursor }
      : { view: 'runs', limit_defaults: projectLimitDefaults(), work: Object.freeze(runs.items.map(projectRunItem)),
        next_cursor: null, truncated: runs.truncated }),
  });
}

function projectAttempt(value) {
  if (value === null) return null;
  if (!isPlainRecord(value) || !validId(value.attempt_id) || !validId(value.stream_id)
    || !validId(value.incarnation)) throw new RuntimeProjectionError();
  return Object.freeze({ attempt_id: value.attempt_id, stream_id: value.stream_id,
    incarnation: value.incarnation });
}

function projectWorkRecord(record) {
  if (!isPlainRecord(record)) throw new RuntimeProjectionError();
  const summary = projectSummary(record);
  const checkpoint = record.checkpoint_ref;
  if (checkpoint !== null && (!isPlainRecord(checkpoint) || !boundedCount(checkpoint.bytes, {
    positive: true,
  }) || checkpoint.bytes > 1024 * 1024)) throw new RuntimeProjectionError();
  const control = record.control_request === null ? null : (() => {
    if (!isPlainRecord(record.control_request) || !['cancel', 'pause'].includes(record.control_request.kind)
      || !validTimestamp(record.control_request.requested_at)) throw new RuntimeProjectionError();
    return Object.freeze({ kind: record.control_request.kind, requested_at: record.control_request.requested_at });
  })();
  const recovery = record.recovery === null ? null : (() => {
    if (!isPlainRecord(record.recovery)
      || !['restart_paused', 'transition_repaired'].includes(record.recovery.kind)
      || !WORK_STATUSES.has(record.recovery.previous_status)
      || !validTimestamp(record.recovery.at)) throw new RuntimeProjectionError();
    return Object.freeze({ kind: record.recovery.kind,
      previous_status: record.recovery.previous_status, at: record.recovery.at });
  })();
  // FG-007: only the work read carries the record, so only it names the prompt;
  // snapshot rows stay index-only.
  return Object.freeze({ ok: true, schema_version: PROJECTION_SCHEMA_VERSION,
    work: Object.freeze({ ...summary, prompt_preview: workPromptPreview(record.input),
      attempt: projectAttempt(record.attempt),
      checkpoint: Object.freeze({ recorded: checkpoint !== null,
        bytes: checkpoint?.bytes || 0 }), control, recovery }) });
}

module.exports = {
  PROJECTION_SCHEMA_VERSION,
  RuntimeProjectionError,
  normalizeSnapshotRequest,
  normalizeWorkRequest,
  projectRuntimeSnapshot,
  projectWorkRecord,
};
