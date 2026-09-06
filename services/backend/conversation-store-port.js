const { isDeepStrictEqual } = require('node:util');
const {
  normalizeMessageFields,
  normalizeTurnEvent,
} = require('./message-normalization');
const { normalizeId } = require('../shared/normalize');

const TERMINAL_TOOL_STATUSES = new Set([
  'complete',
  'error',
  'cancelled',
  'denied',
  'interrupted',
]);
const COMMIT_RESULT_KEYS = [
  'ok', 'applied', 'durable', 'reason', 'commitEpoch', 'dirtyEpoch', 'durableEpoch', 'value',
];

function normalizeTerminalToolStatus(value) {
  const status = normalizeId(value).toLowerCase();
  if (status === 'completed') return 'complete';
  if (status === 'failed') return 'error';
  if (status === 'canceled') return 'cancelled';
  return status;
}

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeEpoch(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function getStoreEpochs(store, sessionId) {
  const state = store?._backend?.getSessionDurability?.(sessionId) || null;
  return {
    dirtyEpoch: normalizeEpoch(state?.dirtyEpoch),
    durableEpoch: normalizeEpoch(state?.durableEpoch),
  };
}

function buildCommitResult({
  ok = false,
  applied = false,
  durable = false,
  reason = null,
  commitEpoch = 0,
  dirtyEpoch = 0,
  durableEpoch = 0,
  value = null,
} = {}) {
  return {
    ok: ok === true,
    applied: applied === true,
    durable: durable === true,
    reason: reason ? String(reason) : null,
    commitEpoch: normalizeEpoch(commitEpoch),
    dirtyEpoch: normalizeEpoch(dirtyEpoch),
    durableEpoch: normalizeEpoch(durableEpoch),
    value,
  };
}

function hasDurableProof(result) {
  return Boolean(
    isCommitResult(result)
    && result.ok === true
    && result?.durable === true
    && Number.isSafeInteger(result.commitEpoch)
    && result.commitEpoch > 0
    && Number.isSafeInteger(result.durableEpoch)
    && result.durableEpoch >= result.commitEpoch
  );
}

function isCommitResult(value) {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === COMMIT_RESULT_KEYS.length
    && COMMIT_RESULT_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && typeof value.ok === 'boolean'
    && typeof value.applied === 'boolean'
    && typeof value.durable === 'boolean'
    && (value.reason === null || typeof value.reason === 'string')
    && Number.isSafeInteger(value.commitEpoch) && value.commitEpoch >= 0
    && Number.isSafeInteger(value.dirtyEpoch) && value.dirtyEpoch >= 0
    && Number.isSafeInteger(value.durableEpoch) && value.durableEpoch >= 0
  );
}

function finalizeCommit(store, sessionId, {
  accepted,
  applied = false,
  reason = null,
  value = null,
  durableRequested = false,
} = {}) {
  let epochs = getStoreEpochs(store, sessionId);
  let durable = epochs.dirtyEpoch > 0 && epochs.durableEpoch >= epochs.dirtyEpoch;
  if (accepted && durableRequested && !durable) {
    const flushed = store?.flushSession?.(sessionId) === true;
    epochs = getStoreEpochs(store, sessionId);
    durable = flushed
      && epochs.dirtyEpoch > 0
      && epochs.durableEpoch >= epochs.dirtyEpoch;
  }
  const ok = accepted === true && (!durableRequested || durable);
  return buildCommitResult({
    ok,
    applied,
    durable,
    reason: ok ? reason : (accepted ? 'durability_failed' : reason || 'mutation_refused'),
    commitEpoch: accepted ? epochs.dirtyEpoch : 0,
    dirtyEpoch: epochs.dirtyEpoch,
    durableEpoch: epochs.durableEpoch,
    value,
  });
}

function messageIntentMatches(existing, incoming) {
  const source = incoming && typeof incoming === 'object' && !Array.isArray(incoming)
    ? incoming
    : {};
  const candidate = normalizeMessageFields({
    ...source,
    timestamp: source.timestamp || existing?.timestamp,
    event_seq: Number.isInteger(source.event_seq) ? source.event_seq : existing?.event_seq,
  }, existing?.model_used || '');
  if (!candidate) return false;
  for (const key of Object.keys(source)) {
    if (key === 'event_seq') continue;
    if (!isDeepStrictEqual(candidate[key], existing?.[key])) return false;
  }
  return normalizeId(candidate.id) === normalizeId(existing?.id);
}

function matchingMessageIndexes(messages, messageId) {
  const targetId = normalizeId(messageId);
  const matches = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (normalizeId(messages[index]?.id) === targetId) matches.push(index);
  }
  return matches;
}

function applySessionPatch(store, sessionId, patch) {
  if (typeof store?.updateSession === 'function') {
    return store.updateSession(sessionId, patch);
  }
  if (typeof store?.upsertSession === 'function') {
    return store.upsertSession(sessionId, patch, { allowCreate: false });
  }
  return null;
}

function identityFailure(sessionId, session, identity, activeTurn, clearMatch, epochs) {
  const expected = identity && typeof identity === 'object' && !Array.isArray(identity)
    ? identity
    : {};
  if (normalizeId(expected.sessionId) !== sessionId) return 'session_identity_mismatch';
  if (!normalizeId(expected.sessionIncarnation)
    || normalizeId(expected.sessionIncarnation) !== normalizeId(session.session_incarnation)) {
    return 'session_incarnation_mismatch';
  }
  const generation = Number(expected.generation);
  if (!Number.isSafeInteger(generation) || generation <= 0
    || generation !== Number(session.turn_generation)) {
    return 'turn_generation_mismatch';
  }
  const expectedRevision = Number(expected.sessionRevision ?? expected.expectedRevision);
  if (Number.isSafeInteger(expectedRevision) && expectedRevision > 0
    && expectedRevision !== epochs.dirtyEpoch) {
    return 'session_revision_mismatch';
  }
  if (!activeTurn) return 'active_turn_missing';
  const comparisons = [
    [expected.turnId, activeTurn.turn_id || activeTurn.request_id, 'turn_id_mismatch'],
    [expected.streamId, activeTurn.stream_id, 'stream_id_mismatch'],
    [expected.userMessageId, activeTurn.user_message_id, 'user_message_id_mismatch'],
    [expected.sessionIncarnation, activeTurn.session_incarnation, 'active_incarnation_mismatch'],
    [expected.generation, activeTurn.generation, 'active_generation_mismatch'],
  ];
  for (const [wanted, actual, reason] of comparisons) {
    if (!normalizeId(wanted) || normalizeId(wanted) !== normalizeId(actual)) return reason;
  }
  const match = clearMatch && typeof clearMatch === 'object' && !Array.isArray(clearMatch)
    ? clearMatch
    : {};
  const requestedMatch = [
    [match.requestId ?? match.request_id, activeTurn.request_id, 'clear_request_mismatch'],
    [match.streamId ?? match.stream_id, activeTurn.stream_id, 'clear_stream_mismatch'],
    [match.turnId ?? match.turn_id, activeTurn.turn_id, 'clear_turn_mismatch'],
    [match.sessionIncarnation ?? match.session_incarnation,
      activeTurn.session_incarnation, 'clear_incarnation_mismatch'],
    [match.generation, activeTurn.generation, 'clear_generation_mismatch'],
    [match.userMessageId ?? match.user_message_id,
      activeTurn.user_message_id, 'clear_user_message_mismatch'],
  ];
  if (!requestedMatch.some(([wanted]) => normalizeId(wanted))) return 'clear_match_missing';
  for (const [wanted, actual, reason] of requestedMatch) {
    if (wanted != null && normalizeId(wanted) !== normalizeId(actual)) return reason;
  }
  return null;
}

function mergedToolRepair(message, repair) {
  const patch = repair?.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
  const merged = {
    ...message,
    ...patch,
    id: message.id,
    timestamp: message.timestamp,
    event_seq: message.event_seq,
    ...(patch.tool_call && typeof patch.tool_call === 'object'
      ? { tool_call: { ...(message.tool_call || {}), ...patch.tool_call } }
      : {}),
    ...(patch.tool_result && typeof patch.tool_result === 'object'
      ? { tool_result: { ...(message.tool_result || {}), ...patch.tool_result } }
      : {}),
  };
  const callId = normalizeId(repair.callId);
  if (callId) {
    const observed = normalizeId(merged.tool_call?.call_id || merged.tool_result?.call_id);
    if (observed !== callId) return null;
  }
  const statuses = [];
  if (merged.tool_call) {
    merged.tool_call.status = normalizeTerminalToolStatus(merged.tool_call.status);
    statuses.push(merged.tool_call.status);
  }
  if (merged.tool_result && merged.tool_result.status != null) {
    merged.tool_result.status = normalizeTerminalToolStatus(merged.tool_result.status);
    statuses.push(merged.tool_result.status);
  }
  if (!statuses.length) {
    merged.status = normalizeTerminalToolStatus(merged.status);
    statuses.push(merged.status);
  }
  return statuses.length > 0 && statuses.every((status) => TERMINAL_TOOL_STATUSES.has(status))
    ? merged
    : null;
}

function buildTerminalPatch(store, sessionId, session, request) {
  const source = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
  const epochs = getStoreEpochs(store, sessionId);
  const identityReason = identityFailure(
    sessionId,
    session,
    source.identity,
    session.active_turn,
    source.clearActiveTurnMatch,
    epochs
  );
  if (identityReason) return { ok: false, reason: identityReason };

  const messages = Array.isArray(session.messages) ? session.messages.map((item) => ({ ...item })) : [];
  const persistedMessageIds = [];
  const seenRequestIds = new Set();
  let nextMessageSeq = Math.max(Number(session.message_seq_counter) || 0, messages.length);
  for (const incoming of Array.isArray(source.messages) ? source.messages : []) {
    const messageId = normalizeId(incoming?.id);
    if (!messageId || seenRequestIds.has(messageId)) {
      return { ok: false, reason: messageId ? 'duplicate_terminal_message_id' : 'missing_message_id' };
    }
    seenRequestIds.add(messageId);
    const matches = matchingMessageIndexes(messages, messageId);
    if (matches.length > 1) return { ok: false, reason: 'ambiguous_message_id' };
    if (matches.length === 1) {
      const current = messages[matches[0]];
      messages[matches[0]] = {
        ...incoming,
        id: current.id,
        timestamp: incoming.timestamp || current.timestamp,
        event_seq: Number.isInteger(current.event_seq) ? current.event_seq : incoming.event_seq,
      };
    } else {
      messages.push({ ...incoming, event_seq: nextMessageSeq });
      nextMessageSeq += 1;
    }
    persistedMessageIds.push(messageId);
  }

  const repairedToolMessageIds = [];
  const repairedIds = new Set();
  for (const repair of Array.isArray(source.toolRepairs) ? source.toolRepairs : []) {
    const messageId = normalizeId(repair?.messageId);
    if (!messageId || repairedIds.has(messageId)) {
      return { ok: false, reason: messageId ? 'duplicate_tool_repair' : 'missing_tool_repair_id' };
    }
    const matches = matchingMessageIndexes(messages, messageId);
    if (matches.length !== 1) {
      return { ok: false, reason: matches.length ? 'ambiguous_tool_repair' : 'missing_tool_repair' };
    }
    const repaired = mergedToolRepair(messages[matches[0]], repair);
    if (!repaired) return { ok: false, reason: 'nonterminal_tool_repair' };
    messages[matches[0]] = repaired;
    repairedIds.add(messageId);
    repairedToolMessageIds.push(messageId);
  }

  const turnEvents = Array.isArray(session.turn_events)
    ? session.turn_events.map((event) => ({ ...event }))
    : [];
  const eventIndexes = new Map();
  for (let index = 0; index < turnEvents.length; index += 1) {
    const eventId = normalizeId(turnEvents[index]?.event_id);
    if (eventId) {
      if (eventIndexes.has(eventId)) return { ok: false, reason: 'ambiguous_turn_event_id' };
      eventIndexes.set(eventId, index);
    }
  }
  let nextEventSeq = Math.max(Number(session.turn_event_seq_counter) || 0, turnEvents.length);
  for (const incoming of Array.isArray(source.turnEvents) ? source.turnEvents : []) {
    const normalized = normalizeTurnEvent(incoming, nextEventSeq);
    if (!normalized) return { ok: false, reason: 'invalid_turn_event' };
    const existingIndex = eventIndexes.get(normalized.event_id);
    if (existingIndex != null) {
      const candidate = { ...normalized, event_seq: turnEvents[existingIndex].event_seq };
      if (!isDeepStrictEqual(candidate, turnEvents[existingIndex])) {
        return { ok: false, reason: 'turn_event_id_conflict' };
      }
      continue;
    }
    normalized.event_seq = nextEventSeq;
    eventIndexes.set(normalized.event_id, turnEvents.length);
    turnEvents.push(normalized);
    nextEventSeq += 1;
  }
  const compactedEvents = typeof store._compactTurnEvents === 'function'
    ? store._compactTurnEvents(sessionId, turnEvents)
    : turnEvents;
  const preferencePatch = source.preferencePatch
    && typeof source.preferencePatch === 'object'
    && !Array.isArray(source.preferencePatch)
      ? source.preferencePatch
      : {};
  const lastMessage = messages[messages.length - 1] || null;
  return {
    ok: true,
    patch: {
      ...preferencePatch,
      ...(typeof source.title === 'string' ? { title: source.title } : {}),
      messages,
      message_count: messages.length,
      message_seq_counter: nextMessageSeq,
      ...(lastMessage?.content
        ? { last_message_preview: String(lastMessage.content).slice(0, 160) }
        : {}),
      turn_events: compactedEvents,
      turn_event_seq_counter: nextEventSeq,
      turn_event_log_version: Math.max(
        Number(session.turn_event_log_version) || 0,
        Number(store.turnEventLogVersion) || 0
      ),
      active_turn: null,
    },
    persistedMessageIds,
    repairedToolMessageIds,
  };
}

function createConversationStorePort(store, { kind = 'unknown' } = {}) {
  if (!store || typeof store.getSession !== 'function') {
    throw new TypeError('createConversationStorePort requires a session store.');
  }
  const port = {
    kind,
    getSession(sessionId) {
      return cloneValue(store.getSession(sessionId));
    },
    getSessionMessages(sessionId) {
      const reader = store.getSessionMessages || store.getMessages;
      return cloneValue(typeof reader === 'function' ? reader.call(store, sessionId) : []) || [];
    },
    getSessionTurnEvents(sessionId) {
      const reader = store.getSessionTurnEvents || store.getTurnEvents;
      return cloneValue(typeof reader === 'function' ? reader.call(store, sessionId) : []) || [];
    },
    getActiveTurn(sessionId) {
      return cloneValue(store.getActiveTurn?.(sessionId) || null);
    },
    getEpochs(sessionId) {
      return getStoreEpochs(store, sessionId);
    },
    getRollbackSnapshot(sessionId) {
      const id = normalizeId(sessionId);
      const session = id ? store.getSession(id) : null;
      return session ? {
        session: cloneValue(session),
        index: cloneValue(store._backend?.getIndexSnapshot?.() || null),
      } : null;
    },
    restoreSnapshot(sessionId, snapshot) {
      const id = normalizeId(sessionId);
      const restored = Boolean(
        id && snapshot?.session
        && store._backend?.restoreSessionSnapshot?.(id, snapshot.session, snapshot.index)
      );
      const epochs = getStoreEpochs(store, id);
      return buildCommitResult({
        ok: restored,
        applied: restored,
        durable: restored && epochs.durableEpoch >= epochs.dirtyEpoch && epochs.dirtyEpoch > 0,
        reason: restored ? null : 'snapshot_restore_failed',
        commitEpoch: restored ? epochs.dirtyEpoch : 0,
        dirtyEpoch: epochs.dirtyEpoch,
        durableEpoch: epochs.durableEpoch,
        value: restored ? { restored: true } : null,
      });
    },
    createSession(sessionId, patch = {}, { durable = false } = {}) {
      const id = normalizeId(sessionId);
      if (!id) return buildCommitResult({ reason: 'invalid_session_id' });
      if (store.getSession(id)) return finalizeCommit(store, id, {
        accepted: false, reason: 'session_exists', value: null,
      });
      const raw = typeof store.createSessionWithId === 'function'
        ? store.createSessionWithId(id, patch)
        : store.upsertSession?.(id, patch, { allowCreate: true });
      return finalizeCommit(store, id, {
        accepted: Boolean(raw), applied: Boolean(raw), value: raw,
        reason: raw ? null : 'create_refused', durableRequested: durable,
      });
    },
    updateSession(sessionId, patch = {}, { durable = false } = {}) {
      const id = normalizeId(sessionId);
      const raw = id ? applySessionPatch(store, id, patch) : null;
      return finalizeCommit(store, id, {
        accepted: Boolean(raw), applied: Boolean(raw), value: raw,
        reason: raw ? null : 'update_refused', durableRequested: durable,
      });
    },
    appendMessage(sessionId, message, { durable = false, updatePreview = true } = {}) {
      const id = normalizeId(sessionId);
      const messageId = normalizeId(message?.id);
      const session = id ? store.getSession(id) : null;
      if (!session || !messageId) return finalizeCommit(store, id, {
        accepted: false, reason: session ? 'missing_message_id' : 'unknown_session',
      });
      const matches = session.messages.filter((entry) => normalizeId(entry?.id) === messageId);
      if (matches.length) {
        const idempotent = matches.length === 1 && messageIntentMatches(matches[0], message);
        return finalizeCommit(store, id, {
          accepted: idempotent,
          applied: false,
          reason: idempotent ? 'idempotent' : 'message_id_conflict',
          value: idempotent ? matches[0] : null,
          durableRequested: durable,
        });
      }
      const appender = store.appendMessage || store.appendLocalMessage;
      const raw = appender?.call(store, id, message, { durable, updatePreview });
      return finalizeCommit(store, id, {
        accepted: Boolean(raw), applied: Boolean(raw), value: raw,
        reason: raw ? null : 'append_refused', durableRequested: durable,
      });
    },
    updateMessage(sessionId, messageId, patch = {}, { durable = false } = {}) {
      const id = normalizeId(sessionId);
      const messages = port.getSessionMessages(id);
      const matches = matchingMessageIndexes(messages, messageId);
      if (matches.length !== 1) return finalizeCommit(store, id, {
        accepted: false,
        reason: matches.length ? 'ambiguous_message_id' : 'message_not_found',
      });
      const raw = store.updateMessage?.(id, messageId, patch);
      return finalizeCommit(store, id, {
        accepted: Boolean(raw), applied: Boolean(raw), value: raw,
        reason: raw ? null : 'update_refused', durableRequested: durable,
      });
    },
    appendTurnEvents(sessionId, events, options = {}) {
      const result = store.appendTurnEvents?.(sessionId, events, options);
      return isCommitResult(result)
        ? result
        : buildCommitResult({ reason: 'invalid_commit_result' });
    },
    truncateAfterMessage(sessionId, messageId, options = {}, { durable = false } = {}) {
      const id = normalizeId(sessionId);
      const raw = store.truncateAfterMessage?.(id, messageId, options);
      const survivingTurnIds = Array.isArray(raw?.survivingTurnIds)
        ? [...raw.survivingTurnIds]
        : null;
      return finalizeCommit(store, id, {
        accepted: Boolean(raw && survivingTurnIds), applied: Boolean(raw && survivingTurnIds),
        reason: raw && survivingTurnIds ? null : 'truncate_refused',
        value: raw && survivingTurnIds ? { session: raw, survivingTurnIds } : null,
        durableRequested: durable,
      });
    },
    setActiveTurn(sessionId, activeTurn, options = {}, { durable = false } = {}) {
      const id = normalizeId(sessionId);
      const raw = store.setActiveTurn?.(id, activeTurn, options);
      return finalizeCommit(store, id, {
        accepted: Boolean(raw), applied: Boolean(raw), value: cloneValue(activeTurn),
        reason: raw ? null : 'active_turn_refused', durableRequested: durable,
      });
    },
    touchActiveTurn(sessionId, match, patch, { durable = false } = {}) {
      const id = normalizeId(sessionId);
      const raw = store.touchActiveTurn?.(id, match, patch);
      return finalizeCommit(store, id, {
        accepted: Boolean(raw), applied: Boolean(raw), value: port.getActiveTurn(id),
        reason: raw ? null : 'active_turn_refused', durableRequested: durable,
      });
    },
    clearActiveTurn(sessionId, match, { durable = false } = {}) {
      const id = normalizeId(sessionId);
      const raw = store.clearActiveTurn?.(id, match);
      return finalizeCommit(store, id, {
        accepted: Boolean(raw), applied: Boolean(raw), value: null,
        reason: raw ? null : 'active_turn_refused', durableRequested: durable,
      });
    },
    commitTerminal(sessionId, request, { durable = true } = {}) {
      const id = normalizeId(sessionId);
      const session = id ? store.getSession(id) : null;
      if (!session) return finalizeCommit(store, id, {
        accepted: false, reason: 'unknown_session',
      });
      const prepared = buildTerminalPatch(store, id, session, request);
      if (!prepared.ok) return finalizeCommit(store, id, {
        accepted: false, reason: prepared.reason,
      });
      const indexSnapshot = store._backend?.getIndexSnapshot?.() || null;
      const raw = applySessionPatch(store, id, prepared.patch);
      if (!raw) return finalizeCommit(store, id, {
        accepted: false, reason: 'terminal_write_refused',
      });
      const value = {
        session: raw,
        persistedMessageIds: prepared.persistedMessageIds,
        repairedToolMessageIds: prepared.repairedToolMessageIds,
      };
      let epochs = getStoreEpochs(store, id);
      const commitEpoch = epochs.dirtyEpoch;
      let durableCommit = epochs.durableEpoch >= commitEpoch && commitEpoch > 0;
      if (durable && !durableCommit) {
        const flushed = store.flushSession?.(id) === true;
        epochs = getStoreEpochs(store, id);
        durableCommit = flushed && epochs.durableEpoch >= commitEpoch;
      }
      if (!durable || durableCommit) return buildCommitResult({
        ok: true,
        applied: true,
        durable: durableCommit,
        commitEpoch,
        dirtyEpoch: epochs.dirtyEpoch,
        durableEpoch: epochs.durableEpoch,
        value,
      });
      const restored = store._backend?.restoreSessionSnapshot?.(id, session, indexSnapshot) === true;
      const rollbackRestored = restored && isDeepStrictEqual(
        cloneValue(store.getSession(id)),
        cloneValue(session)
      );
      epochs = getStoreEpochs(store, id);
      return buildCommitResult({
        ok: false,
        applied: !rollbackRestored,
        durable: false,
        reason: rollbackRestored ? 'durability_failed' : 'terminal_rollback_failed',
        commitEpoch,
        dirtyEpoch: epochs.dirtyEpoch,
        durableEpoch: epochs.durableEpoch,
        value: rollbackRestored ? { ...value, rollbackRestored: true } : value,
      });
    },
  };
  return Object.freeze(port);
}

module.exports = {
  buildCommitResult,
  createConversationStorePort,
  finalizeCommit,
  hasDurableProof,
  messageIntentMatches,
};
