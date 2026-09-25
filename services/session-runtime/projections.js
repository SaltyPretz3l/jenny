'use strict';

const { validId } = require('./contracts');

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

function normalizeSnapshotRequest(payload = {}) {
  if (!hasOnlyKeys(payload, ['cursor', 'limit', 'project_id', 'session_id'])) return null;
  const projectId = Object.hasOwn(payload, 'project_id') ? payload.project_id : null;
  const sessionId = Object.hasOwn(payload, 'session_id') ? payload.session_id : null;
  const cursor = Object.hasOwn(payload, 'cursor') ? payload.cursor : null;
  const limit = Object.hasOwn(payload, 'limit') ? payload.limit : 50;
  if ((projectId !== null && !validId(projectId))
    || (sessionId !== null && !validId(sessionId))
    || (cursor !== null && (typeof cursor !== 'string' || !CURSOR_PATTERN.test(cursor)
      || cursor.length > MAX_CURSOR_CHARS))
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null;
  return Object.freeze({ cursor, limit, projectId, sessionId });
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
  return Object.freeze({ work_id: summary.work_id, project_id: summary.project_id,
    session_id: summary.session_id, turn_id: summary.turn_id, purpose: summary.purpose,
    status: summary.status, revision: summary.revision,
    submission_sequence: summary.submission_sequence,
    created_at: summary.created_at, updated_at: summary.updated_at });
}

function projectRuntimeSnapshot({ runtime, storeStatus, laneSnapshot, resourceSnapshot, page }) {
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
    work: Object.freeze(page.items.map(projectSummary)),
    next_cursor: page.next_cursor,
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
  return Object.freeze({ ok: true, schema_version: PROJECTION_SCHEMA_VERSION,
    work: Object.freeze({ ...summary, attempt: projectAttempt(record.attempt),
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
