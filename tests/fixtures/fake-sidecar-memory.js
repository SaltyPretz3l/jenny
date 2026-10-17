// Recall-side fixtures: the stopwords the fake uses to tokenize recall queries.
const RECALL_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'have',
  'what',
  'when',
  'where',
  'your',
  'about',
  'should',
  'would',
  'could',
  'there',
  'their',
  'them',
  'then',
  'into',
  'user',
]);

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeTitle(value) {
  return normalizeSpaces(value).slice(0, 120);
}

function normalizeLessonText(value) {
  const normalized = normalizeSpaces(value).slice(0, 240);
  if (!normalized) {
    return '';
  }
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

function buildFingerprint(lessonKind, lessonText) {
  const normalizedText = normalizeSpaces(lessonText)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${String(lessonKind || '').trim().toLowerCase()}:${normalizedText}`.slice(0, 160);
}

function tokenize(value) {
  return Array.from(
    new Set(
      (String(value || '')
        .toLowerCase()
        .match(/[a-z0-9]{3,}/g) || []).filter((token) => !RECALL_STOPWORDS.has(token))
    )
  );
}

function recencyBonus(updatedAt) {
  const updatedValue = new Date(String(updatedAt || ''));
  if (Number.isNaN(updatedValue.getTime())) {
    return 0;
  }
  const ageMs = Date.now() - updatedValue.getTime();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  if (ageMs <= sevenDaysMs) {
    return 2;
  }
  if (ageMs <= thirtyDaysMs) {
    return 1;
  }
  return 0;
}

const GENERAL_PROJECT_ID = 'project_general';
const MEMORY_KINDS = new Set(['preference', 'fact', 'decision', 'convention', 'person', 'routine', 'lesson']);
const STALE_REVISION = { reason: 'stale_revision', code: 'CMP-MEM-0012' };
const NOT_FOUND = { reason: 'not_found', code: 'CMP-MEM-0004' };
const SUPPRESSED = { reason: 'suppressed', code: 'CMP-MEM-0013' };

// Suppression tombstones and the operation ledger live for the life of the fake process.
const suppressedFingerprints = new Set();
const operations = new Map();
let operationCounter = 0;

function nextOperationId() {
  operationCounter += 1;
  return `rpc:fake-${operationCounter}`;
}

// The shared v9 write payload (sidecar/runtime/memory.py serialize_write_result).
function writeResult(status, memory, extra = {}) {
  return {
    status,
    memory: memory || null,
    operation_id: null,
    duplicate: false,
    replayed: false,
    undoable: false,
    ...extra,
  };
}

function isActive(memory) {
  return memory.status !== 'archived';
}

function listApprovedMemories(savedMemories) {
  return Array.from(savedMemories.values()).filter(isActive).sort((left, right) => {
    const updatedCompare = String(right.updated_at || '').localeCompare(String(left.updated_at || ''));
    if (updatedCompare !== 0) {
      return updatedCompare;
    }
    return Number(right.id || 0) - Number(left.id || 0);
  });
}

function findMemoryById(savedMemories, memoryId, { includeArchived = false } = {}) {
  const normalizedId = Number(memoryId);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
    return null;
  }
  return Array.from(savedMemories.values())
    .find((memory) => memory.id === normalizedId && (includeArchived || isActive(memory))) || null;
}

function staleRevision(params, existing) {
  const expected = params?.expected_revision;
  return Number.isInteger(expected) && expected !== existing.revision;
}

function saveMemory(params, savedMemories, nextMemoryId) {
  const sessionId = String(params?.session_id || '').trim();
  const candidate = params?.candidate && typeof params.candidate === 'object'
    ? { ...params.candidate }
    : null;
  const lessonKind = normalizeSpaces(candidate?.lesson_kind || '').toLowerCase();
  const title = normalizeTitle(candidate?.title || '');
  const lessonText = normalizeLessonText(candidate?.lesson_text || '');
  const fingerprint = buildFingerprint(lessonKind, lessonText);
  if (!sessionId || !candidate || !lessonKind || !title || !lessonText) {
    return {
      errorDetail: 'candidate and session_id are required',
      nextMemoryId,
    };
  }
  if (!MEMORY_KINDS.has(lessonKind)) {
    return {
      errorDetail: `unsupported lesson_kind: ${lessonKind}`,
      nextMemoryId,
    };
  }

  const existing = savedMemories.get(fingerprint);
  if (existing && isActive(existing)) {
    return {
      result: { created: false, ...writeResult('saved', existing, { duplicate: true }) },
      nextMemoryId,
    };
  }
  // A user save of a forgotten fingerprint lifts its tombstone, as production does.
  suppressedFingerprints.delete(fingerprint);
  const timestamp = new Date().toISOString();
  const record = {
    id: existing ? existing.id : nextMemoryId,
    session_id: sessionId,
    title,
    lesson_text: lessonText,
    lesson_kind: lessonKind,
    confidence: Math.max(0, Math.min(Number(candidate.confidence || 0), 1)),
    source_excerpt: normalizeSpaces(candidate.source_excerpt || '').slice(0, 240),
    content_fingerprint: fingerprint,
    provenance: 'user_approved',
    created_at: existing ? existing.created_at : timestamp,
    updated_at: timestamp,
    project_id: String(params?.project_id || GENERAL_PROJECT_ID),
    scope_session_id: null,
    origin: 'user',
    status: 'active',
    archived_at: null,
    revision: existing ? existing.revision + 1 : 1,
    protected: false,
    always_on: false,
    source_message_ids: [],
  };
  savedMemories.set(fingerprint, record);
  return {
    result: {
      created: true,
      ...writeResult('saved', record, { operation_id: nextOperationId(), undoable: true }),
    },
    nextMemoryId: existing ? nextMemoryId : nextMemoryId + 1,
  };
}

function rekeyMemory(savedMemories, previous, next) {
  savedMemories.delete(String(previous.content_fingerprint || '').trim().toLowerCase());
  savedMemories.set(next.content_fingerprint, next);
}

// An operation remembers the revision it produced: undo is a compare-and-set
// on it, so a newer write wins over the undo (production answers `conflict`).
function recordOperation(before, after) {
  const operationId = nextOperationId();
  operations.set(operationId, { before, projectId: before.project_id, resultRevision: after.revision });
  return operationId;
}

// memory.update takes flat fields (schema v9, 2026-10-15); `patch` is refused
// like production does. The reply is the shared write result (`status`), and a
// stale `expected_revision` answers a conflict that carries the current row.
function updateMemory(params, savedMemories) {
  const memoryId = Number(params?.memory_id);
  if (params && Object.prototype.hasOwnProperty.call(params, 'patch')) {
    return { errorDetail: 'memory.update takes flat fields; patch is not supported' };
  }
  const existing = findMemoryById(savedMemories, memoryId);
  if (!existing) {
    return { errorDetail: 'memory not found' };
  }
  if (staleRevision(params, existing)) {
    return { result: writeResult('conflict', existing, STALE_REVISION) };
  }
  const title = normalizeTitle(params?.title || existing.title);
  const lessonText = normalizeLessonText(params?.lesson_text || existing.lesson_text);
  const lessonKind = params?.lesson_kind === undefined
    ? existing.lesson_kind
    : normalizeSpaces(params.lesson_kind).toLowerCase();
  if (!title || !lessonText || !MEMORY_KINDS.has(lessonKind)) {
    return { errorDetail: 'memory.update needs one of lesson_text, lesson_kind, title, always_on, remove_provenance' };
  }

  const nextFingerprint = buildFingerprint(lessonKind, lessonText);
  const duplicate = listApprovedMemories(savedMemories).find((memory) =>
    memory.id !== existing.id && memory.content_fingerprint === nextFingerprint
  );
  if (duplicate) {
    return {
      errorDetail: 'patch.lesson_text duplicates another approved memory',
    };
  }

  const updated = {
    ...existing,
    title,
    lesson_text: lessonText,
    lesson_kind: lessonKind,
    content_fingerprint: nextFingerprint,
    always_on: params?.always_on === undefined ? existing.always_on : params.always_on === true,
    ...(params?.remove_provenance === true ? { source_excerpt: '', provenance: 'source_removed' } : {}),
    revision: existing.revision + 1,
    updated_at: new Date().toISOString(),
  };
  rekeyMemory(savedMemories, existing, updated);
  return {
    result: writeResult('saved', updated, { operation_id: recordOperation(existing, updated), undoable: true }),
  };
}

// memory.delete archives the row and records a 'forgotten' tombstone, which is
// what stops the lesson being suggested again (store_approved.py delete_memory).
function deleteMemory(params, savedMemories) {
  const existing = findMemoryById(savedMemories, params?.memory_id);
  if (!existing) {
    return {
      errorDetail: 'memory_id must be a positive integer',
    };
  }
  if (staleRevision(params, existing)) {
    return { result: { deleted: false, ...writeResult('conflict', existing, STALE_REVISION) } };
  }
  const timestamp = new Date().toISOString();
  const archived = {
    ...existing,
    status: 'archived',
    archived_at: timestamp,
    revision: existing.revision + 1,
    updated_at: timestamp,
  };
  savedMemories.set(archived.content_fingerprint, archived);
  suppressedFingerprints.add(archived.content_fingerprint);
  return {
    result: {
      deleted: true,
      memory_id: existing.id,
      ...writeResult('saved', archived, { operation_id: recordOperation(existing, archived), undoable: true }),
    },
  };
}

// memory.undo inverts one recorded operation of the named project: the row goes
// back to its prior state and a delete's tombstone is lifted.
function undoMemory(params, savedMemories) {
  const operation = operations.get(String(params?.operation_id || ''));
  if (!operation || operation.projectId !== params?.project_id) {
    return writeResult('refused', null, NOT_FOUND);
  }
  const { before } = operation;
  const current = findMemoryById(savedMemories, before.id, { includeArchived: true });
  if (current && current.revision !== operation.resultRevision) {
    return writeResult('conflict', current, STALE_REVISION);
  }
  operations.delete(params.operation_id);
  const restored = { ...before, revision: (current ? current.revision : before.revision) + 1 };
  if (current) {
    rekeyMemory(savedMemories, current, restored);
  } else {
    savedMemories.set(restored.content_fingerprint, restored);
  }
  suppressedFingerprints.delete(restored.content_fingerprint);
  return writeResult('saved', restored, { operation_id: String(params?.undo_operation_id || nextOperationId()) });
}

// memory.pending.accept writes the queued row (found by the caller) into its own
// project; a forgotten fingerprint is refused as `suppressed`.
function acceptPendingMemory(params, pending, savedMemories, nextMemoryId) {
  const refused = (reason) => ({
    result: { accepted: false, ...writeResult('refused', null, reason) },
    nextMemoryId,
  });
  if (!pending) {
    return refused(NOT_FOUND);
  }
  const fingerprint = buildFingerprint(pending.lesson_kind, normalizeLessonText(pending.lesson_text));
  if (suppressedFingerprints.has(fingerprint)) {
    return refused(SUPPRESSED);
  }
  const saved = saveMemory({
    session_id: pending.session_id,
    project_id: pending.project_id || params?.project_id,
    candidate: pending,
  }, savedMemories, nextMemoryId);
  if (saved.errorDetail) {
    return refused(NOT_FOUND);
  }
  const { created: _created, ...write } = saved.result;
  return { result: { accepted: true, ...write }, nextMemoryId: saved.nextMemoryId };
}

function recallMemories(params, savedMemories) {
  const query = normalizeSpaces(params?.query || '');
  if (!query) {
    return [];
  }
  const queryTokens = new Set(tokenize(query));
  if (!queryTokens.size) {
    return [];
  }
  return listApprovedMemories(savedMemories)
    .map((memory) => {
      const titleTokens = new Set(tokenize(memory.title));
      const lessonTokens = new Set(tokenize(memory.lesson_text));
      const sourceTokens = new Set(tokenize(memory.source_excerpt));
      let titleOverlap = 0;
      let lessonOverlap = 0;
      let sourceOverlap = 0;
      for (const token of queryTokens) {
        if (titleTokens.has(token)) {
          titleOverlap += 1;
        }
        if (lessonTokens.has(token)) {
          lessonOverlap += 1;
        }
        if (sourceTokens.has(token)) {
          sourceOverlap += 1;
        }
      }
      const weightedOverlap = titleOverlap * 12 + lessonOverlap * 10 + sourceOverlap * 8;
      if (weightedOverlap <= 0) {
        return { memory, score: 0 };
      }
      return {
        memory,
        score: weightedOverlap + Number(memory.confidence || 0) + recencyBonus(memory.updated_at),
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      const scoreCompare = right.score - left.score;
      if (scoreCompare !== 0) {
        return scoreCompare;
      }
      const updatedCompare = String(right.memory.updated_at || '').localeCompare(String(left.memory.updated_at || ''));
      if (updatedCompare !== 0) {
        return updatedCompare;
      }
      return Number(right.memory.id || 0) - Number(left.memory.id || 0);
    })
    .slice(0, Math.max(1, Math.min(Number(params?.limit || 3), 5)))
    .map((entry) => entry.memory);
}

function buildMemoryContextLessons(params, fallbackContent, savedMemories) {
  const legacyLessons = Array.isArray(params?.learning_context?.lessons)
    ? params.learning_context.lessons
    : [];
  const memoryPolicy = params?.memory_policy && typeof params.memory_policy === 'object'
    ? params.memory_policy
    : null;
  if (!memoryPolicy) {
    return legacyLessons;
  }
  if (memoryPolicy.enabled !== true) {
    return [];
  }

  const recallQuery = (Array.isArray(params?.messages) ? params.messages : [])
    .filter((message) => message?.role === 'user' && !String(message?.kind || '').trim())
    .slice(-3)
    .map((message) => String(message?.content || '').trim())
    .filter(Boolean)
    .join('\n')
    .slice(-600) || fallbackContent;
  const lessons = recallMemories({ query: recallQuery, limit: 3 }, savedMemories);
  return [...new Map(
    lessons.map((memory) => [memory.content_fingerprint, memory])
  ).values()].slice(0, 5);
}

// Chat-scope portable state is keyed by session id, independently of project
// memories and reflection cursors. Callers own the map for test isolation.
function exportSessionMemory(params, sessions) {
  const state = sessions.get(params.session_id);
  return { notes: state?.notes || [], recap: state?.recap || null };
}

function importSessionMemory(params, sessions) {
  const timestamp = new Date().toISOString();
  const notes = params.notes.map(note => ({ ...note, origin: note.origin || 'user', created_at: timestamp }));
  sessions.set(params.session_id, { project_id: params.project_id, notes,
    recap: params.recap ? { text: params.recap, updated_at: timestamp } : null });
  return { status: 'imported', imported: notes.length, skipped: 0 };
}

function chatMemorySessions(params, sessions) {
  const ids = [...sessions.keys()];
  const limit = params.limit ?? 2000;
  return { session_ids: ids.slice(0, limit), truncated: ids.length > limit };
}

function requestSessionMemory(method, params, sessions) {
  if (method === 'memory.export_session') return exportSessionMemory(params, sessions);
  if (method === 'memory.import_session') return importSessionMemory(params, sessions);
  if (method === 'memory.chat_sessions') return chatMemorySessions(params, sessions);
  return undefined;
}

// Settings > Memory page methods (row 58 W4): the archived list, restore,
// erase, the operation ledger and clearing the forgotten list. Returns
// undefined for any other call (the active list stays with the dispatcher).
function settingsMemoryRows(savedMemories, projectId) {
  return Array.from(savedMemories.values()).filter(memory => memory.project_id === projectId);
}

function restoreMemory(params, savedMemories) {
  const existing = settingsMemoryRows(savedMemories, params?.project_id)
    .find(memory => memory.id === params?.memory_id && !isActive(memory));
  if (!existing) return writeResult('refused', null, NOT_FOUND);
  // `target_project_id`: a deleted project's row restored into another project.
  const restored = { ...existing, status: 'active', archived_at: null, revision: existing.revision + 1,
    updated_at: new Date().toISOString(), project_id: params?.target_project_id || existing.project_id };
  savedMemories.set(restored.content_fingerprint, restored);
  suppressedFingerprints.delete(restored.content_fingerprint);
  return writeResult('saved', restored, { operation_id: recordOperation(existing, restored), undoable: true });
}

function eraseMemory(params, savedMemories) {
  const existing = settingsMemoryRows(savedMemories, params?.project_id).find(memory => memory.id === params?.memory_id);
  if (!existing) return { status: 'not_found' };
  savedMemories.delete(existing.content_fingerprint);
  return { status: 'erased' };
}

function memoryOperations(params) {
  const limit = Math.max(1, Math.min(Number(params?.limit) || 50, 50));
  return { operations: [...operations.entries()].filter(([, entry]) => entry.projectId === params?.project_id)
    .slice(-limit).reverse().map(([operationId, entry]) => ({ operation_id: operationId, op: 'update', origin: 'user',
      memory_id: entry.before.id, result_revision: entry.resultRevision, created_at: entry.before.updated_at,
      expires_at: null, undone_at: null, undoable: true })) };
}

function requestSettingsMemory(method, params, savedMemories) {
  if (method === 'memory.list' && params?.status === 'archived') {
    return { memories: settingsMemoryRows(savedMemories, params.project_id).filter(memory => !isActive(memory)),
      next_cursor: null };
  }
  if (method === 'memory.restore') return restoreMemory(params, savedMemories);
  if (method === 'memory.erase') return eraseMemory(params, savedMemories);
  if (method === 'memory.operations') return memoryOperations(params);
  if (method === 'memory.clear_suppressions') {
    const cleared = suppressedFingerprints.size;
    suppressedFingerprints.clear();
    return { cleared };
  }
  return undefined;
}

module.exports = {
  requestSessionMemory,
  requestSettingsMemory,
  acceptPendingMemory,
  buildMemoryContextLessons,
  deleteMemory,
  listApprovedMemories,
  recallMemories,
  saveMemory,
  undoMemory,
  updateMemory,
};
