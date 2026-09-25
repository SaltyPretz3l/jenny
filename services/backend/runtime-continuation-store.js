'use strict';

const {
  assertCandidate,
  prepareRuntimeContinuation,
  sameAttempt,
  stableJson,
  strictHeader,
  validateEntryAgainst,
  validateHistoricalEntryAgainst,
} = require('./runtime-continuation-records');

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function validatePendingContinuationsArchive(value) {
  if (value?.schema_version > 1) throw new Error('runtime_continuation_archive_future_schema');
  if (!value || Object.keys(value).sort().join(',') !== 'schema_version,sessions'
    || value.schema_version !== 1 || !Array.isArray(value.sessions) || value.sessions.length > 10_000) {
    throw new Error('runtime_continuation_archive_invalid');
  }
  const sessionIds = new Set();
  const sessions = value.sessions.map((row) => {
    if (!row || Object.keys(row).sort().join(',')
      !== 'runtime_continuations,session_id,session_incarnation,turn_events,turn_generation'
      || typeof row.session_id !== 'string' || !row.session_id
      || typeof row.session_incarnation !== 'string' || !row.session_incarnation
      || !Number.isSafeInteger(row.turn_generation) || row.turn_generation < 0
      || !Array.isArray(row.turn_events) || row.turn_events.length > 5000
      || sessionIds.has(row.session_id)) throw new Error('runtime_continuation_archive_invalid');
    const header = strictHeader(row.runtime_continuations);
    const eventIds = new Set();
    for (const event of row.turn_events) {
      const id = String(event?.event_id || '');
      if (!id || eventIds.has(id)) throw new Error('runtime_continuation_archive_invalid');
      eventIds.add(id);
    }
    const referenced = new Set(header.entries.flatMap(entry => entry.body.turn_selector.ordered_event_ids));
    if (referenced.size !== eventIds.size || [...referenced].some(id => !eventIds.has(id))) {
      throw new Error('runtime_continuation_archive_event_mismatch');
    }
    sessionIds.add(row.session_id);
    return { session_id: row.session_id, session_incarnation: row.session_incarnation,
      turn_generation: row.turn_generation, runtime_continuations: header,
      turn_events: cloneJson(row.turn_events) };
  });
  return Object.freeze({ schema_version: 1, sessions: Object.freeze(sessions) });
}

function exportPendingContinuationsForArchive(store, { getWork } = {}) {
  if (typeof getWork !== 'function') throw new TypeError('runtime_continuation_archive_work_reader_required');
  const sessions = [];
  for (const summary of store?.listSessions?.() || []) {
    const session = store.getSession(summary.id);
    const header = strictHeader(session?.runtime_continuations);
    if (!header.entries.length) continue;
    const eventIds = new Set();
    for (const entry of header.entries) {
      const work = getWork(entry.body.work_id);
      validateHistoricalEntryAgainst(entry, session, work);
      for (const id of entry.body.turn_selector.ordered_event_ids) eventIds.add(id);
    }
    const turnEvents = (session.turn_events || []).filter(event => eventIds.has(String(event?.event_id || '')));
    sessions.push({ session_id: session.id, session_incarnation: session.session_incarnation,
      turn_generation: session.turn_generation, runtime_continuations: header, turn_events: turnEvents });
  }
  sessions.sort((left, right) => left.session_id.localeCompare(right.session_id));
  return validatePendingContinuationsArchive({ schema_version: 1, sessions });
}

function installPendingContinuationsFromArchive(store, value) {
  const archive = validatePendingContinuationsArchive(value);
  for (const row of archive.sessions) {
    const session = store?.getSession?.(row.session_id);
    if (!session || strictHeader(session.runtime_continuations).entries.length
      || (session.turn_events || []).length) throw new Error('runtime_continuation_restore_conflict');
    const updated = store._updateSessionRecord?.(row.session_id, {
      session_incarnation: row.session_incarnation, turn_generation: row.turn_generation,
      runtime_continuations: row.runtime_continuations, turn_events: row.turn_events,
    }, { bumpUpdatedAt: false });
    if (!updated || store.flushSession?.(row.session_id) !== true) {
      throw new Error('runtime_continuation_restore_failed');
    }
  }
  return archive.sessions.length;
}

function epochsFor(store, sessionId) {
  const value = store?._backend?.getSessionDurability?.(sessionId) || {};
  return {
    dirtyEpoch: Number.isSafeInteger(value.dirtyEpoch) ? value.dirtyEpoch : 0,
    durableEpoch: Number.isSafeInteger(value.durableEpoch) ? value.durableEpoch : 0,
  };
}

function preparePendingContinuation(store, sessionId, proposal, work) {
  const session = store?.getSession?.(sessionId);
  if (!session) throw Object.assign(new Error('unknown_session'), { code: 'unknown_session' });
  return prepareRuntimeContinuation({ session, epochs: epochsFor(store, sessionId), proposal, work });
}

function publishPendingContinuation(store, candidate) {
  const prepared = assertCandidate(candidate);
  const session = store?.getSession?.(prepared.sessionId);
  const epochs = epochsFor(store, prepared.sessionId);
  if (!session) return { accepted: false, reason: 'unknown_session' };
  let header;
  try {
    header = strictHeader(session.runtime_continuations);
    validateEntryAgainst(prepared.entry, session, {
      work_id: prepared.workId,
      turn_id: prepared.entry.body.turn_id,
      attempt: prepared.sourceAttempt,
      submission_hash: prepared.canonicalRefs.request_ref.sha256,
    });
  } catch (error) {
    return { accepted: false, reason: error?.code || 'runtime_continuation_publish_invalid' };
  }
  const existing = header.entries.find(entry => entry.checkpoint_id === prepared.checkpointId);
  if (existing) {
    const idempotent = stableJson(existing) === stableJson(prepared.entry);
    return { accepted: idempotent, applied: false,
      reason: idempotent ? 'idempotent' : 'runtime_continuation_checkpoint_conflict',
      value: idempotent ? { candidate: prepared } : null };
  }
  if (session.session_incarnation !== prepared.expectedSessionIncarnation
    || session.turn_generation !== prepared.expectedTurnGeneration
    || epochs.dirtyEpoch !== prepared.expectedDirtyEpoch) {
    return { accepted: false, reason: 'runtime_continuation_publish_stale' };
  }
  const nextHeader = { schema_version: 1, entries: [...header.entries, prepared.entry] };
  try { strictHeader(nextHeader); } catch (error) {
    return { accepted: false, reason: error?.code || 'runtime_continuation_capacity' };
  }
  const updated = store._updateSessionRecord?.(prepared.sessionId,
    { runtime_continuations: nextHeader }, { bumpUpdatedAt: false });
  return { accepted: Boolean(updated), applied: Boolean(updated),
    reason: updated ? null : 'runtime_continuation_write_refused',
    value: updated ? { candidate: prepared } : null };
}

function resolvePendingContinuation(store, continuation, work, { includePayload = false, historical = false } = {}) {
  try {
    const sessionId = String(continuation?.identity?.session_id || '');
    const checkpointId = String(continuation?.identity?.checkpoint_id || '');
    const session = store?.getSession?.(sessionId);
    const header = strictHeader(session?.runtime_continuations);
    const entry = header.entries.find(item => item.checkpoint_id === checkpointId);
    if (!entry) return { valid: false, bytes: 0 };
    if (historical && continuation?.canonical_refs?.request_ref?.sha256 !== work?.submission_hash) {
      return { valid: false, bytes: 0 };
    }
    const validated = historical ? validateHistoricalEntryAgainst(entry, session, work, continuation)
      : validateEntryAgainst(entry, session, work, continuation);
    const result = { valid: true, bytes: validated.bytes };
    if (includePayload === true) {
      result.toolBatch = structuredClone(validated.entry.body.tool_batch);
      result.toolBatchBytes = validated.entry.body.tool_batch_bytes;
      result.frozenFirstInput = structuredClone(validated.entry.body.frozen_first_input);
      result.frozenInputBytes = validated.entry.body.frozen_input_bytes;
      if (validated.entry.body.approval_inputs_bytes) {
        result.approvalInputsBytes = validated.entry.body.approval_inputs_bytes;
        result.approvalInputsRef = structuredClone(validated.refs.approvalInputsRef);
      }
      result.historySelector = structuredClone(validated.entry.body.history_selector);
      result.userMessageId = validated.entry.body.user_message_id;
      const historyCount = validated.entry.body.history_selector.canonical_cutoff.boundary_message_count;
      const messages = session.messages || [];
      const byId = new Map(messages.map(message => [String(message?.id || ''), message]));
      result.canonicalHistoryMessages = structuredClone(messages.slice(0, historyCount));
      result.turnMessages = structuredClone(validated.entry.body.message_selector.ordered_message_ids
        .map(id => byId.get(id)));
      const eventsById = new Map((session.turn_events || [])
        .map(event => [String(event?.event_id || ''), event]));
      result.turnEvents = structuredClone(validated.entry.body.turn_selector.ordered_event_ids
        .map(id => eventsById.get(id)));
      result.compactionSnapshot = validated.entry.body.history_selector.compaction_ref
        ? structuredClone(session.compaction_snapshot) : null;
      result.recoveryFence = {
        sessionId: validated.entry.body.session_id,
        turnId: validated.entry.body.turn_id,
        userMessageId: validated.entry.body.user_message_id,
        streamId: validated.entry.body.stream_id,
        sessionIncarnation: validated.entry.body.session_incarnation,
        generation: validated.entry.body.source_turn_generation,
      };
      result.canonicalRefs = structuredClone(validated.refs.canonicalRefs);
      result.frozenInputRef = structuredClone(validated.refs.frozenInputRef);
    }
    return result;
  } catch (_error) {
    return { valid: false, bytes: 0 };
  }
}

function removePendingContinuation(store, sessionId, checkpointId, sourceAttempt) {
  const session = store?.getSession?.(sessionId);
  if (!session) return { accepted: false, reason: 'unknown_session' };
  let header;
  try { header = strictHeader(session.runtime_continuations); } catch (error) {
    return { accepted: false, reason: error?.code || 'invalid_runtime_continuation_header' };
  }
  const index = header.entries.findIndex(entry => entry.checkpoint_id === checkpointId);
  if (index < 0) return { accepted: true, applied: false, reason: 'idempotent', value: null };
  if (!sameAttempt(header.entries[index].body.source_attempt, sourceAttempt)) {
    return { accepted: false, reason: 'runtime_continuation_attempt_mismatch' };
  }
  const selected = header.entries[index].body;
  const messageIds = new Set(selected.message_selector.ordered_message_ids);
  const eventIds = new Set(selected.turn_selector.ordered_event_ids);
  const dependedOn = header.entries.slice(index + 1).some(entry => (
    !sameAttempt(entry.body.source_attempt, selected.source_attempt)
      && (entry.body.message_selector.ordered_message_ids.some(id => messageIds.has(id))
        || entry.body.turn_selector.ordered_event_ids.some(id => eventIds.has(id)))
  ));
  if (dependedOn) {
    return { accepted: false, reason: 'runtime_continuation_dependency_active' };
  }
  const entries = header.entries.filter((_entry, entryIndex) => entryIndex !== index);
  const updated = store._updateSessionRecord?.(sessionId,
    { runtime_continuations: { schema_version: 1, entries } }, { bumpUpdatedAt: false });
  return { accepted: Boolean(updated), applied: Boolean(updated),
    reason: updated ? null : 'runtime_continuation_write_refused', value: null };
}

function createRuntimeContinuationPort(store, { finalizeCommit, normalizeId }) {
  if (typeof finalizeCommit !== 'function' || typeof normalizeId !== 'function') {
    throw new TypeError('runtime_continuation_port_dependencies_invalid');
  }
  return {
    preparePendingContinuation(sessionId, proposal, work) {
      return preparePendingContinuation(store, normalizeId(sessionId), proposal, work);
    },
    publishPendingContinuation(candidate, { durable = true } = {}) {
      const raw = publishPendingContinuation(store, candidate);
      return finalizeCommit(store, candidate?.sessionId, {
        accepted: raw.accepted, applied: raw.applied, reason: raw.reason,
        value: raw.accepted ? {
          canonicalRefs: candidate.canonicalRefs,
          frozenInputRef: candidate.frozenInputRef,
          encodedArtifactBytes: candidate.encodedArtifactBytes,
        } : null,
        durableRequested: durable,
      });
    },
    resolvePendingContinuation(continuation, work, options = {}) {
      return resolvePendingContinuation(store, continuation, work, options);
    },
    removePendingContinuation(sessionId, checkpointId, sourceAttempt, { durable = true } = {}) {
      const id = normalizeId(sessionId);
      const raw = removePendingContinuation(store, id, checkpointId, sourceAttempt);
      return finalizeCommit(store, id, {
        accepted: raw.accepted, applied: raw.applied, reason: raw.reason,
        value: null, durableRequested: durable,
      });
    },
    exportPendingContinuationsForArchive(options) {
      return exportPendingContinuationsForArchive(store, options);
    },
    installPendingContinuationsFromArchive(value) {
      return installPendingContinuationsFromArchive(store, value);
    },
  };
}

module.exports = {
  createRuntimeContinuationPort,
  epochsFor,
  exportPendingContinuationsForArchive,
  installPendingContinuationsFromArchive,
  preparePendingContinuation,
  publishPendingContinuation,
  removePendingContinuation,
  resolvePendingContinuation,
  validatePendingContinuationsArchive,
};
