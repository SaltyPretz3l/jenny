const { API_VERSION } = require('./sidecar-client');
const {
  RESPONSE_STYLE_RECALL_LIMIT,
  buildMemorySuggestionMessages,
} = require('./backend-service-utils');
const {
  ensureArray,
  isPlainObject,
} = require('../value-utils');
const {
  GENERAL_PROJECT_ID,
  normalizeProjectId,
} = require('../projects/project-schema');

const MAX_MEMORY_CANDIDATE_LENGTH = 50_000;
const MAX_MEMORY_SUGGESTION_USER_MESSAGES = 3;
const MEMORY_LIST_PAGE_SIZE = 250;
const MEMORY_LIST_MAX_ITEMS = 10_000;

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

function dismissedFingerprintKey(projectId, fingerprint) {
  const normalized = String(fingerprint || '').trim().toLowerCase();
  return normalized ? `${projectId}\0${normalized}` : '';
}

function resolveDismissedFingerprint(service, sessionIdOrFingerprint, fingerprint) {
  const usesSessionScope = fingerprint !== undefined;
  const authority = captureMemoryAuthority(
    service,
    usesSessionScope ? String(sessionIdOrFingerprint || '').trim() : null
  );
  return {
    authority,
    key: dismissedFingerprintKey(
      authority.project_id,
      usesSessionScope ? fingerprint : sessionIdOrFingerprint
    ),
  };
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
    const reason = 'sidecar_unavailable';
    service._emitServiceLog(
      'WARN',
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

function dismissMemorySuggestion(service, sessionIdOrFingerprint, fingerprint) {
  const { key } = resolveDismissedFingerprint(service, sessionIdOrFingerprint, fingerprint);
  if (key) {
    service._dismissedMemoryFingerprints.delete(key);
    service._dismissedMemoryFingerprints.add(key);
    if (typeof service.trimDismissedMemoryFingerprints === 'function') {
      service.trimDismissedMemoryFingerprints();
    }
  }
}

function isMemorySuggestionDismissed(service, sessionIdOrFingerprint, fingerprint) {
  const { key } = resolveDismissedFingerprint(service, sessionIdOrFingerprint, fingerprint);
  return key ? service._dismissedMemoryFingerprints.has(key) : false;
}

async function suggestMemoriesForSession(service, sessionId) {
  const resolvedSessionId = String(sessionId || '').trim();
  const authority = captureMemoryAuthority(service, resolvedSessionId);
  if (!service.sidecarClient) {
    service._emitServiceLog('INFO', 'memory.suggest_skipped', {
      sessionId: resolvedSessionId,
      reason: 'sidecar_unavailable',
    });
    return { suggestions: [] };
  }

  const messages = buildMemorySuggestionMessages(
    service.sessionStore.getSessionMessages(resolvedSessionId),
    { maxUserMessages: MAX_MEMORY_SUGGESTION_USER_MESSAGES }
  );
  const payload = await requestMemoryRpc(service, 'memory.suggest', {
    project_id: authority.project_id,
    session_id: resolvedSessionId,
    messages,
  });
  const suggestions = ensureArray(payload?.suggestions)
    .filter((s) => {
      const fp = String(s?.content_fingerprint || '').trim().toLowerCase();
      return !fp || !service._dismissedMemoryFingerprints.has(
        dismissedFingerprintKey(authority.project_id, fp)
      );
    });
  return { suggestions };
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
  projectId = GENERAL_PROJECT_ID
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
  const payload = await requestMemoryRpc(service, 'memory.update', {
    project_id: resolvedProjectId,
    memory_id: resolvedMemoryId,
    patch,
  });
  return {
    updated: payload?.updated === true,
    memory:
      isPlainObject(payload?.memory)
        ? payload.memory
        : null,
  };
}

async function deleteApprovedMemory(service, memoryId, projectId = GENERAL_PROJECT_ID) {
  const resolvedMemoryId = Number(memoryId);
  if (!Number.isInteger(resolvedMemoryId) || resolvedMemoryId <= 0) {
    throw new Error('memoryId is required');
  }
  const resolvedProjectId = normalizeProjectId(projectId);
  if (!resolvedProjectId) {
    throw new Error('projectId is invalid');
  }
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
  });
  return {
    deleted: payload?.deleted === true,
    memory_id: Number.isInteger(payload?.memory_id) ? payload.memory_id : null,
  };
}

async function deletePendingMemory(service, sessionId, contentFingerprint) {
  const resolvedSessionId = String(sessionId || '').trim();
  const resolvedFingerprint = String(contentFingerprint || '').trim().toLowerCase();
  if (!resolvedSessionId) {
    throw new Error('sessionId is required');
  }
  if (!resolvedFingerprint) {
    throw new Error('contentFingerprint is required');
  }
  const authority = captureMemoryAuthority(service, resolvedSessionId);
  if (!service.sidecarClient) {
    service._emitServiceLog('INFO', 'memory.pending_delete_skipped', {
      sessionId: resolvedSessionId,
      reason: 'sidecar_unavailable',
    });
    return { deleted: false };
  }
  const payload = await requestMemoryRpc(service, 'memory.pending.delete', {
    project_id: authority.project_id,
    session_id: resolvedSessionId,
    content_fingerprint: resolvedFingerprint,
  });
  return {
    deleted: payload?.deleted === true,
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

async function recallRecentApprovedMemories(
  service,
  lessonKind,
  limit = 2,
  { sessionId = null } = {}
) {
  const normalizedLessonKind = String(lessonKind || '').trim().toLowerCase();
  const normalizedLimit = Number.isInteger(limit) ? limit : RESPONSE_STYLE_RECALL_LIMIT;
  const authority = captureMemoryAuthority(service, sessionId);
  if (!normalizedLessonKind) {
    service._emitServiceLog('INFO', 'memory.recall_recent_skipped', {
      reason: 'blank_lesson_kind',
    });
    return { memories: [] };
  }
  if (!service.sidecarClient) {
    service._emitServiceLog('INFO', 'memory.recall_recent_skipped', {
      reason: 'sidecar_unavailable',
      lessonKind: normalizedLessonKind,
    });
    return { memories: [] };
  }
  const payload = await requestMemoryRpc(service, 'memory.recall_recent', {
    project_id: authority.project_id,
    ...(sessionId === null ? {} : { include_general: true }),
    lesson_kind: normalizedLessonKind,
    limit: normalizedLimit,
  });
  return {
    memories: Array.isArray(payload?.memories) ? payload.memories : [],
  };
}

module.exports = {
  getMemoryStatus,
  dismissMemorySuggestion,
  isMemorySuggestionDismissed,
  suggestMemoriesForSession,
  saveMemoryForSession,
  listApprovedMemories,
  listPendingMemories,
  updateApprovedMemory,
  deleteApprovedMemory,
  deletePendingMemory,
  recallApprovedMemories,
  recallRecentApprovedMemories,
};
