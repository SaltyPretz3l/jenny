const crypto = require('crypto');
const { API_VERSION } = require('./sidecar-client');
const { normalizeMemorySettings } = require('../shell-config-normalizers');
const {
  ensureArray,
  isPlainObject,
} = require('../value-utils');
const {
  GENERAL_PROJECT_ID,
  normalizeProjectId,
} = require('../projects/project-schema');

const MAX_MEMORY_CANDIDATE_LENGTH = 50_000;
const MEMORY_LIST_PAGE_SIZE = 250;
const MEMORY_LIST_MAX_ITEMS = 10_000;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const WRITE_STATUSES = new Set(['saved', 'conflict', 'refused']);
const REASON_PATTERN = /^[a-z_]{1,64}$/;
// memory.update takes these flat fields (sidecar/runtime/memory.py UPDATE_FIELDS).
const UPDATE_FIELDS = Object.freeze(['lesson_text', 'lesson_kind', 'title', 'always_on', 'remove_provenance']);

async function requestMemoryRpc(service, method, params = {}) {
  return service.sidecarClient.request(method, {
    accept_version: API_VERSION,
    ...params,
  });
}

function captureMemoryAuthority(service, sessionId = null) {
  return sessionId === null
    ? service.projectAuthority.captureProject(GENERAL_PROJECT_ID)
    : service.projectAuthority.captureSession(sessionId);
}

// Settings names the row's revision so a write cannot overwrite a newer one.
function expectedRevisionParam(options) {
  const value = options?.expectedRevision;
  if (value === undefined || value === null) return {};
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('expectedRevision is invalid');
  return { expected_revision: value };
}

const countOf = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);

// The v9 write outcome the renderer may see: status, ids, flags and the reason
// token. Memory text only reaches the renderer inside a returned row.
function summarizeMemoryWrite(payload) {
  const summary = {};
  if (WRITE_STATUSES.has(payload?.status)) summary.status = payload.status;
  if (typeof payload?.operation_id === 'string' && OPERATION_ID_PATTERN.test(payload.operation_id)) {
    summary.operation_id = payload.operation_id;
  }
  if (typeof payload?.duplicate === 'boolean') summary.duplicate = payload.duplicate;
  if (typeof payload?.undoable === 'boolean') summary.undoable = payload.undoable;
  if (typeof payload?.reason === 'string' && REASON_PATTERN.test(payload.reason)) summary.reason = payload.reason;
  return summary;
}

// Memory policy (row 58 W1): the global switches live in the shell config
// `memory` section; a missing section or config service reads as the defaults.
function readMemorySettings(service) {
  const raw = service?.configService?.getState?.()?.memory;
  const settings = normalizeMemorySettings(raw);
  // takeNotes (W2 reflection) defaults on: only an explicit false turns it off.
  const takeNotes = Object.hasOwn(settings, 'takeNotes') ? settings.takeNotes : raw?.takeNotes;
  return { ...settings, takeNotes: takeNotes !== false };
}

// One random epoch source per Electron process (BackendService), so a restarted
// Electron never inherits a higher stale epoch from the sidecar's fence.
function memoryEpochSource(service) {
  if (!service._memoryEpochSource) service._memoryEpochSource = crypto.randomUUID();
  return service._memoryEpochSource;
}

// Best-effort, in bump order: the sidecar's apply fence learns every epoch.
// A failure is a WARN; it never throws into the bump's caller.
function pushMemoryPolicyEpoch(service, epoch) {
  if (typeof service?.sidecarClient?.request !== 'function') return;
  const send = async () => {
    try {
      await requestMemoryRpc(service, 'memory.policy_epoch', {
        policy_epoch: epoch,
        epoch_source: memoryEpochSource(service),
      });
    } catch (error) {
      service._emitServiceLog?.('WARN', 'memory.policy_epoch_push_failed', {
        epoch,
        reason: String(error?.reason || error?.code || 'push_failed').slice(0, 64),
      });
    }
  };
  service._memoryEpochPush = (service._memoryEpochPush || Promise.resolve()).then(send);
}

// Resolves once every epoch push sent so far has settled.
async function flushMemoryPolicyEpochPush(service) {
  await service?._memoryEpochPush;
}

function bumpMemoryPolicyEpoch(service, reason) {
  service._memoryPolicyEpoch = (Number(service._memoryPolicyEpoch) || 0) + 1;
  service._emitServiceLog?.('INFO', 'memory.policy_epoch_bumped', {
    epoch: service._memoryPolicyEpoch,
    reason: String(reason || 'unspecified').slice(0, 64),
  });
  pushMemoryPolicyEpoch(service, service._memoryPolicyEpoch);
  return service._memoryPolicyEpoch;
}

// In-process and monotonic (not persisted in W1). A settings change is noticed
// on the next read, which is the next request that carries the policy.
function memoryPolicyEpoch(service) {
  const signature = JSON.stringify(readMemorySettings(service));
  if (service._memorySettingsSignature !== undefined && service._memorySettingsSignature !== signature) {
    bumpMemoryPolicyEpoch(service, 'memory_settings_changed');
  }
  service._memorySettingsSignature = signature;
  return Number(service._memoryPolicyEpoch) || 0;
}

function buildMemoryPolicy(service, { includeMemory, memoryOptOut, projectId }) {
  const settings = readMemorySettings(service);
  const recall = includeMemory === true && settings.useInChats;
  let capture = 'auto';
  if (settings.pauseSaving || memoryOptOut === true) capture = 'off';
  else if (settings.askBeforeSaving) capture = 'ask';
  const epoch = typeof service.memoryPolicyEpoch === 'function' ? service.memoryPolicyEpoch() : 0;
  return {
    enabled: recall,
    project_id: projectId,
    capture,
    recall,
    policy_epoch: Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : 0,
  };
}

// Wraps a session preference write: a changed memory_opt_out moves the epoch.
async function trackMemoryOptOutChange(service, sessionId, write) {
  const optedOut = () => service.sessionStore?.getSession?.(sessionId)?.context_preferences?.memory_opt_out === true;
  const before = optedOut();
  const result = await write();
  if (optedOut() !== before) bumpMemoryPolicyEpoch(service, 'session_memory_opt_out_changed');
  return result;
}

function unavailableMemoryStatus(reason) {
  return {
    available: false,
    schema_version: null,
    recall_index: 'unavailable',
    counts: {},
    storage: { state: 'unavailable' },
    maintenance: { state: 'unavailable' },
    preserved: false,
    repair_required: false,
    degraded_reasons: [reason],
  };
}

async function getMemoryStatus(service) {
  if (!service.sidecarClient) {
    // The renderer asks before the sidecar has attached on every launch; the
    // page shows "unavailable" until it does, so this is not a warning.
    const reason = 'sidecar_unavailable';
    service._emitServiceLog(
      'INFO',
      'memory.status_unavailable',
      { reason }
    );
    return unavailableMemoryStatus(reason);
  }
  try {
    const authority = captureMemoryAuthority(service);
    // The management page lists every project, so its counts span every project too.
    return await requestMemoryRpc(service, 'memory.status', { project_id: authority.project_id, scope: 'all' });
  } catch (error) {
    const reason = String(error?.reason || 'sidecar_request_failed');
    service._emitServiceLog('WARN', 'memory.status_unavailable', {
      reason,
      method: 'memory.status',
    });
    return unavailableMemoryStatus(reason);
  }
}

async function saveMemoryForSession(service, sessionId, candidate) {
  const resolvedSessionId = String(sessionId || '').trim();
  if (!resolvedSessionId) {
    throw new Error('sessionId is required');
  }
  if (!isPlainObject(candidate)) {
    throw new Error('candidate is required');
  }
  const authority = captureMemoryAuthority(service, resolvedSessionId);
  const normalizedCandidate = {
    title: String(candidate.title || ''),
    lesson_text: String(candidate.lesson_text || ''),
    lesson_kind: String(candidate.lesson_kind || ''),
    // Non-numeric values stay rejectable sidecar-side (null), missing stays the sidecar default.
    confidence: typeof candidate.confidence === 'number' ? candidate.confidence
      : (candidate.confidence === undefined ? 0 : null),
    source_excerpt: String(candidate.source_excerpt || ''),
    content_fingerprint: String(candidate.content_fingerprint || ''),
  };
  const serializedCandidateLength = Buffer.byteLength(JSON.stringify(normalizedCandidate), 'utf8');
  if (serializedCandidateLength > MAX_MEMORY_CANDIDATE_LENGTH) {
    throw new Error(
      `Memory candidate payload exceeds limit (${serializedCandidateLength} > ${MAX_MEMORY_CANDIDATE_LENGTH}).`
    );
  }
  if (!service.sidecarClient) {
    service._emitServiceLog('INFO', 'memory.save_skipped', {
      sessionId: resolvedSessionId,
      reason: 'sidecar_unavailable',
    });
    return {
      created: false,
      memory: null,
    };
  }

  const payload = await requestMemoryRpc(service, 'memory.save', {
    project_id: authority.project_id,
    session_id: resolvedSessionId,
    candidate: normalizedCandidate,
  });
  return {
    created: payload?.created === true,
    memory:
      isPlainObject(payload?.memory)
        ? payload.memory
      : null,
    ...summarizeMemoryWrite(payload),
  };
}

async function listApprovedMemories(service) {
  if (!service.sidecarClient) {
    service._emitServiceLog('INFO', 'memory.list_skipped', {
      reason: 'sidecar_unavailable',
    });
    return { memories: [] };
  }
  const memories = [];
  let cursor = null;
  const seenCursors = new Set();
  do {
    const payload = await requestMemoryRpc(service, 'memory.list', {
      scope: 'all',
      cursor,
      limit: MEMORY_LIST_PAGE_SIZE,
    });
    memories.push(...ensureArray(payload?.memories));
    cursor = String(payload?.next_cursor || '').trim() || null;
    if (cursor && seenCursors.has(cursor)) {
      break;
    }
    if (cursor) {
      seenCursors.add(cursor);
    }
  } while (cursor && memories.length < MEMORY_LIST_MAX_ITEMS);
  return { memories: memories.slice(0, MEMORY_LIST_MAX_ITEMS) };
}

async function listPendingMemories(service) {
  if (!service.sidecarClient) {
    service._emitServiceLog('INFO', 'memory.pending_list_skipped', {
      reason: 'sidecar_unavailable',
    });
    return { candidates: [] };
  }
  const candidates = [];
  let cursor = null;
  const seenCursors = new Set();
  do {
    const payload = await requestMemoryRpc(service, 'memory.pending.list', {
      scope: 'all',
      cursor,
      limit: MEMORY_LIST_PAGE_SIZE,
    });
    candidates.push(...ensureArray(payload?.candidates));
    cursor = String(payload?.next_cursor || '').trim() || null;
    if (cursor && seenCursors.has(cursor)) {
      break;
    }
    if (cursor) {
      seenCursors.add(cursor);
    }
  } while (cursor && candidates.length < MEMORY_LIST_MAX_ITEMS);
  return { candidates: candidates.slice(0, MEMORY_LIST_MAX_ITEMS) };
}

async function updateApprovedMemory(
  service,
  memoryId,
  patch,
  projectId = GENERAL_PROJECT_ID,
  options = {}
) {
  const resolvedMemoryId = Number(memoryId);
  if (!Number.isInteger(resolvedMemoryId) || resolvedMemoryId <= 0) {
    throw new Error('memoryId is required');
  }
  if (!isPlainObject(patch)) {
    throw new Error('patch is required');
  }
  const resolvedProjectId = normalizeProjectId(projectId);
  if (!resolvedProjectId) {
    throw new Error('projectId is invalid');
  }
  const revisionParam = expectedRevisionParam(options);
  if (!service.sidecarClient) {
    service._emitServiceLog('INFO', 'memory.update_skipped', {
      memoryId: resolvedMemoryId,
      reason: 'sidecar_unavailable',
    });
    return {
      updated: false,
      memory: null,
    };
  }
  const changes = {};
  for (const field of UPDATE_FIELDS) {
    if (patch[field] !== undefined) changes[field] = patch[field];
  }
  if (Object.keys(changes).length === 0) {
    throw new Error('patch has no updatable field');
  }
  const payload = await requestMemoryRpc(service, 'memory.update', {
    project_id: resolvedProjectId,
    memory_id: resolvedMemoryId,
    ...revisionParam,
    ...changes,
  });
  return {
    updated: payload?.status === 'saved',
    memory:
      isPlainObject(payload?.memory)
        ? payload.memory
        : null,
    ...summarizeMemoryWrite(payload),
  };
}

async function deleteApprovedMemory(service, memoryId, projectId = GENERAL_PROJECT_ID, options = {}) {
  const resolvedMemoryId = Number(memoryId);
  if (!Number.isInteger(resolvedMemoryId) || resolvedMemoryId <= 0) {
    throw new Error('memoryId is required');
  }
  const resolvedProjectId = normalizeProjectId(projectId);
  if (!resolvedProjectId) {
    throw new Error('projectId is invalid');
  }
  const revisionParam = expectedRevisionParam(options);
  if (!service.sidecarClient) {
    service._emitServiceLog('INFO', 'memory.delete_skipped', {
      memoryId: resolvedMemoryId,
      reason: 'sidecar_unavailable',
    });
    return { deleted: false };
  }
  const payload = await requestMemoryRpc(service, 'memory.delete', {
    project_id: resolvedProjectId,
    memory_id: resolvedMemoryId,
    ...revisionParam,
  });
  const deletedId = Number.isInteger(payload?.memory_id) ? payload.memory_id : payload?.memory?.id;
  return {
    deleted: payload?.deleted === true,
    memory_id: Number.isInteger(deletedId) ? deletedId : null,
    memory: isPlainObject(payload?.memory) ? payload.memory : null,
    ...summarizeMemoryWrite(payload),
  };
}

// The chat chip's Undo (row 58 W1): inverts one recorded operation in the
// session's project. Refusals and conflicts come back as results.
async function undoMemoryOperation(service, sessionId, operationId) {
  const resolvedSessionId = String(sessionId || '').trim();
  if (!resolvedSessionId) {
    throw new Error('sessionId is required');
  }
  const resolvedOperationId = String(operationId || '').trim();
  if (!OPERATION_ID_PATTERN.test(resolvedOperationId)) {
    throw new Error('operationId is invalid');
  }
  const authority = captureMemoryAuthority(service, resolvedSessionId);
  if (!service.sidecarClient) {
    service._emitServiceLog('INFO', 'memory.undo_skipped', { sessionId: resolvedSessionId, reason: 'sidecar_unavailable' });
    return { status: 'refused', reason: 'sidecar_unavailable' };
  }
  // A global-scope write from a project chat lives in General: the store answers
  // not_found for the session's project, so the undo is retried once there. The
  // project choice stays main-side; the renderer never names one.
  const undoOperationId = `ui:${crypto.randomUUID()}`;
  const send = (projectId) => requestMemoryRpc(service, 'memory.undo', {
    project_id: projectId,
    operation_id: resolvedOperationId,
    undo_operation_id: undoOperationId,
  });
  let summary = summarizeMemoryWrite(await send(authority.project_id));
  if (summary.reason === 'not_found' && authority.project_id !== GENERAL_PROJECT_ID) {
    summary = summarizeMemoryWrite(await send(GENERAL_PROJECT_ID));
  }
  return summary;
}

// The Settings Undo (row 58 W1b): Settings lists the row's own project, so there
// is no General retry. Refusals and conflicts come back as results.
async function undoApprovedMemoryChange(service, operationId, projectId = GENERAL_PROJECT_ID) {
  const resolvedOperationId = String(operationId || '').trim();
  if (!OPERATION_ID_PATTERN.test(resolvedOperationId)) {
    throw new Error('operationId is invalid');
  }
  const resolvedProjectId = normalizeProjectId(projectId);
  if (!resolvedProjectId) {
    throw new Error('projectId is invalid');
  }
  if (!service.sidecarClient) {
    service._emitServiceLog('INFO', 'memory.undo_skipped', { reason: 'sidecar_unavailable' });
    return { status: 'refused', reason: 'sidecar_unavailable' };
  }
  return summarizeMemoryWrite(await requestMemoryRpc(service, 'memory.undo', {
    project_id: resolvedProjectId,
    operation_id: resolvedOperationId,
    undo_operation_id: `ui:${crypto.randomUUID()}`,
  }));
}

// Chat delete (row 58 W1): drops the deleted chat's chat-scope memories. The
// caller treats a throw or a missing sidecar as a skip; startup reconciliation retries it.
async function purgeSessionMemories(service, sessionId) {
  const resolvedSessionId = String(sessionId || '').trim();
  if (!resolvedSessionId) {
    throw new Error('sessionId is required');
  }
  if (!service.sidecarClient) {
    return { ok: false, reason: 'sidecar_unavailable' };
  }
  const payload = await requestMemoryRpc(service, 'memory.purge_session', { session_id: resolvedSessionId });
  bumpMemoryPolicyEpoch(service, 'session_purged');
  return { ok: true, removed: countOf(payload?.removed) };
}

// The Settings Memory page's "clear the forgotten list" (row 58 W4).
async function clearMemorySuppressions(service, projectId = null) {
  const resolvedProjectId = projectId === null ? null : normalizeProjectId(projectId);
  if (projectId !== null && !resolvedProjectId) {
    throw new Error('projectId is invalid');
  }
  if (!service.sidecarClient) {
    return { cleared: 0 };
  }
  const payload = await requestMemoryRpc(service, 'memory.clear_suppressions',
    resolvedProjectId ? { project_id: resolvedProjectId } : {});
  return { cleared: countOf(payload?.cleared) };
}

// The queued row a pending action names. Settings passes the listed
// candidate's own project (row 58 W4), so a proposal queued before its chat
// moved still resolves; without it the session's current project is used.
function pendingTarget(service, sessionId, contentFingerprint, projectId) {
  const session = String(sessionId || '').trim();
  const fingerprint = String(contentFingerprint || '').trim().toLowerCase();
  if (!session) throw new Error('sessionId is required');
  if (!fingerprint) throw new Error('contentFingerprint is required');
  const named = projectId === undefined || projectId === null ? null : normalizeProjectId(projectId);
  if (named === '') throw new Error('projectId is invalid');
  return {
    session_id: session,
    content_fingerprint: fingerprint,
    project_id: named || captureMemoryAuthority(service, session).project_id,
  };
}

async function deletePendingMemory(service, sessionId, contentFingerprint, projectId) {
  const target = pendingTarget(service, sessionId, contentFingerprint, projectId);
  if (!service.sidecarClient) {
    service._emitServiceLog('INFO', 'memory.pending_delete_skipped', {
      sessionId: target.session_id,
      reason: 'sidecar_unavailable',
    });
    return { deleted: false };
  }
  const payload = await requestMemoryRpc(service, 'memory.pending.delete', target);
  return { deleted: payload?.deleted === true };
}

// Pending Approve: the sidecar resolves the queued row by session and fingerprint
// and writes it into the row's own project; refusals come back as results.
async function acceptPendingMemory(service, sessionId, contentFingerprint, projectId) {
  const target = pendingTarget(service, sessionId, contentFingerprint, projectId);
  if (!service.sidecarClient) {
    service._emitServiceLog('INFO', 'memory.pending_accept_skipped', {
      sessionId: target.session_id,
      reason: 'sidecar_unavailable',
    });
    return { accepted: false };
  }
  const payload = await requestMemoryRpc(service, 'memory.pending.accept', target);
  return {
    accepted: payload?.accepted === true,
    memory: isPlainObject(payload?.memory) ? payload.memory : null,
    ...summarizeMemoryWrite(payload),
  };
}

async function recallApprovedMemories(service, query, limit = 3, { sessionId = null } = {}) {
  const normalizedQuery = String(query || '').trim();
  const normalizedLimit = Number.isInteger(limit) ? limit : 3;
  const authority = captureMemoryAuthority(service, sessionId);
  if (!normalizedQuery) {
    service._emitServiceLog('INFO', 'memory.recall_skipped', {
      reason: 'blank_query',
    });
    return { memories: [] };
  }
  if (!service.sidecarClient) {
    service._emitServiceLog('INFO', 'memory.recall_skipped', {
      reason: 'sidecar_unavailable',
    });
    return { memories: [] };
  }
  const payload = await requestMemoryRpc(service, 'memory.recall', {
    project_id: authority.project_id,
    ...(sessionId === null ? {} : { include_general: true }),
    query: normalizedQuery,
    limit: normalizedLimit,
  });
  return {
    memories: Array.isArray(payload?.memories) ? payload.memories : [],
  };
}

// Project delete (row 58 W1, replacing the D10 move to General): the sidecar
// archives every memory of `projectId` and drops its pending candidates in one
// SQLite transaction; archived rows stay restorable. Idempotent, so the
// reconcile pass may re-issue it.
//
// The caller (project-delete-operation.js) must tell "nothing committed" from
// "unknown": a returned `ok: false` is definite (no request was sent, or the
// sidecar answered with an error, which means its transaction rolled back); a
// throw means the request went out and no answer came back (timeout, pipe
// drop, restart), so the archive may have committed.
async function archiveProjectMemories(service, projectId) {
  const resolvedProjectId = normalizeProjectId(projectId);
  if (!resolvedProjectId || resolvedProjectId === GENERAL_PROJECT_ID) {
    throw new Error('projectId is invalid');
  }
  if (!service.sidecarClient || service.sidecarClient.connected === false) {
    return { ok: false, reason: 'sidecar_unavailable' };
  }
  let payload;
  try {
    payload = await requestMemoryRpc(service, 'memory.archive_project', { project_id: resolvedProjectId });
  } catch (error) {
    // `rpc` is set only for an error response the sidecar sent.
    if (!error?.rpc) throw error;
    return { ok: false, reason: String(error.error_code || 'memory_archive_refused').slice(0, 120) };
  }
  const archived = countOf(payload?.archived);
  const pendingRemoved = countOf(payload?.pending_removed);
  service._emitServiceLog?.('INFO', 'memory.project_archived', { archived, pendingRemoved });
  bumpMemoryPolicyEpoch(service, 'project_archived');
  return { ok: true, archived, pending_removed: pendingRemoved };
}

module.exports = {
  OPERATION_ID_PATTERN,
  REASON_PATTERN,
  acceptPendingMemory,
  archiveProjectMemories,
  buildMemoryPolicy,
  bumpMemoryPolicyEpoch,
  clearMemorySuppressions,
  flushMemoryPolicyEpochPush,
  memoryEpochSource,
  memoryPolicyEpoch,
  readMemorySettings,
  requestMemoryRpc,
  purgeSessionMemories,
  summarizeMemoryWrite,
  trackMemoryOptOutChange,
  undoApprovedMemoryChange,
  undoMemoryOperation,
  getMemoryStatus,
  saveMemoryForSession,
  listApprovedMemories,
  listPendingMemories,
  updateApprovedMemory,
  deleteApprovedMemory,
  deletePendingMemory,
  recallApprovedMemories,
};
