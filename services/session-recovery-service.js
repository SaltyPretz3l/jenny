const { LOOP_PROTOCOL_ERROR_CODES } = require('./backend/error-codes');

function normalizeMessages(messages) {
  return Array.isArray(messages) ? messages.filter((message) => message && typeof message === 'object') : [];
}

function toolCallIdFromMessage(message) {
  if (!message || typeof message !== 'object') {
    return '';
  }
  if (message.kind === 'tool_use') {
    return String(message.tool_call?.call_id || '').trim();
  }
  if (message.kind === 'tool_result' || message.role === 'tool') {
    return String(message.tool_result?.call_id || '').trim();
  }
  return '';
}

function toolStreamIdFromMessage(message) {
  if (!message || typeof message !== 'object') {
    return '';
  }
  if (message.kind === 'tool_use') {
    return String(message.tool_call?.parent_stream_id || '').trim();
  }
  if (message.kind === 'tool_result' || message.role === 'tool') {
    return String(message.tool_result?.parent_stream_id || '').trim();
  }
  return '';
}

function toolPairKeyFromMessage(message) {
  const callId = toolCallIdFromMessage(message);
  if (!callId) {
    return '';
  }
  const streamId = toolStreamIdFromMessage(message);
  return streamId ? `${streamId}:${callId}` : callId;
}

function isWhitespaceOnlyAssistant(message) {
  if (!message || typeof message !== 'object') {
    return false;
  }
  return (
    String(message.role || '').trim() === 'assistant'
    && !String(message.kind || '').trim()
    && !String(message.content || '').trim()
  );
}

function matchesActiveTurnUserMessage(message, activeTurn) {
  if (!message || typeof message !== 'object' || !activeTurn || typeof activeTurn !== 'object') {
    return false;
  }
  const messageId = String(message.client_message_id || message.id || '').trim();
  return Boolean(messageId) && messageId === String(activeTurn.user_message_id || '').trim();
}

function detectInterruptionState(messages, activeTurn = null) {
  const normalized = normalizeMessages(messages);
  const lastMessage = normalized[normalized.length - 1];
  if (!lastMessage) {
    return 'clean';
  }
  if (String(lastMessage.kind || '').trim() === 'tool_use') {
    return 'mid_turn';
  }
  if (
    String(lastMessage.kind || '').trim() === 'tool_result'
    || String(lastMessage.role || '').trim() === 'tool'
  ) {
    return 'mid_turn';
  }
  if (
    String(lastMessage.role || '').trim() === 'user'
    && !String(lastMessage.kind || '').trim()
  ) {
    if (matchesActiveTurnUserMessage(lastMessage, activeTurn)) {
      return 'mid_turn';
    }
    return 'mid_prompt';
  }
  return 'clean';
}

/**
 * Repair tool_use/tool_result pairing in a message array.
 *
 * Handles four failure modes that arise from crashes and replays:
 * - Orphaned tool_use (no matching tool_result): inject synthetic error result.
 * - Orphaned tool_result (no matching tool_use): drop.
 * - Duplicate tool_result (same call_id appears twice): keep first, drop rest.
 * - Correct pairs: preserve untouched.
 */
function repairToolPairing(messages) {
  const normalized = normalizeMessages(messages);
  const toolUseIds = new Set();
  const toolResultIds = new Set();

  // Pass 1: collect all call_ids present in each role.
  for (const msg of normalized) {
    const kind = String(msg.kind || '').trim();
    const pairKey = toolPairKeyFromMessage(msg);
    if (!pairKey) continue;
    if (kind === 'tool_use') toolUseIds.add(pairKey);
    if (kind === 'tool_result' || String(msg.role || '').trim() === 'tool') {
      toolResultIds.add(pairKey);
    }
  }

  // Pass 2: rebuild with repairs.
  const seenResults = new Set();
  const repaired = [];

  for (const msg of normalized) {
    const kind = String(msg.kind || '').trim();

    if (kind === 'tool_use') {
      repaired.push(msg);
      const callId = toolCallIdFromMessage(msg);
      const pairKey = toolPairKeyFromMessage(msg);
      // Orphaned tool_use: inject synthetic error tool_result.
      if (callId && pairKey && !toolResultIds.has(pairKey)) {
        repaired.push({
          role: 'tool',
          kind: 'tool_result',
          content: 'System error: tool execution interrupted. Retry if needed.',
          tool_result: {
            call_id: callId,
            tool_name: msg.tool_call?.tool_name || '',
            parent_stream_id: msg.tool_call?.parent_stream_id || '',
            is_error: true,
            error_code: LOOP_PROTOCOL_ERROR_CODES.TOOL_INTERRUPTED,
          },
        });
      }
    } else if (kind === 'tool_result' || String(msg.role || '').trim() === 'tool') {
      const pairKey = toolPairKeyFromMessage(msg);
      // Orphaned tool_result: no matching tool_use -- drop.
      if (pairKey && !toolUseIds.has(pairKey)) continue;
      // Duplicate tool_result: already emitted for this call_id -- drop.
      if (pairKey && seenResults.has(pairKey)) continue;
      if (pairKey) seenResults.add(pairKey);
      repaired.push(msg);
    } else {
      repaired.push(msg);
    }
  }
  return repaired;
}

function filterHistoryForResume(messages) {
  const cleaned = normalizeMessages(messages).filter((message) => !isWhitespaceOnlyAssistant(message));
  return repairToolPairing(cleaned);
}

function buildResumePayload(session) {
  const messages = normalizeMessages(session?.messages);
  const activeTurn = session?.active_turn;
  const interruptionKind = detectInterruptionState(messages, activeTurn);
  let filteredMessages = filterHistoryForResume(messages);
  if (interruptionKind === 'mid_prompt') {
    const lastMessage = filteredMessages[filteredMessages.length - 1];
    if (
      lastMessage
      && String(lastMessage.role || '').trim() === 'user'
      && !String(lastMessage.kind || '').trim()
    ) {
      filteredMessages = filteredMessages.slice(0, -1);
    }
  }
  const resumeMessage = interruptionKind === 'mid_turn'
    ? {
        role: 'user',
        content: 'Resume the interrupted turn using the existing context and completed tool results. Avoid repeating finished work unless it is necessary.',
      }
    : null;
  return {
    messages: filteredMessages,
    interruptionKind,
    resumeMessage,
  };
}

function recoverTurnEventJournal({ sessionStore, journal, logger = null } = {}) {
  if (
    !sessionStore
    || !journal
    || typeof journal.listAll !== 'function'
    || typeof journal.clear !== 'function'
    || typeof sessionStore.appendTurnEvents !== 'function'
    || typeof sessionStore.getSession !== 'function'
  ) {
    return { replayed: 0, sessions: 0, turns: 0 };
  }
  let replayed = 0;
  let sessions = 0;
  let turns = 0;
  const journalSessions = journal.listAll();
  for (const [sessionId, journalSession] of Object.entries(journalSessions || {})) {
    const session = sessionStore.getSession(sessionId);
    if (!session?.active_turn) {
      continue;
    }
    const activeTurnId = String(session.active_turn.stream_id || session.active_turn.request_id || '').trim();
    const turnEntries = journalSession?.turns && typeof journalSession.turns === 'object'
      ? journalSession.turns
      : {};
    for (const [turnId, events] of Object.entries(turnEntries)) {
      if (activeTurnId && turnId !== activeTurnId) {
        continue;
      }
      const sourceEvents = Array.isArray(events) ? events : [];
      // durable:true forces the replayed events to disk before we clear the
      // journal, and the STRUCTURED result tells us whether they actually
      const appendResult = sessionStore.appendTurnEvents(sessionId, sourceEvents, {
        updateLogVersion: true,
        bumpUpdatedAt: false,
        durable: true,
      });
      if (
        !appendResult
        || appendResult.ok !== true
        || appendResult.durable !== true
        || !Number.isSafeInteger(appendResult.commitEpoch)
        || appendResult.commitEpoch <= 0
        || !Number.isSafeInteger(appendResult.durableEpoch)
        || appendResult.durableEpoch < appendResult.commitEpoch
      ) {
        // Persist failed: KEEP the journal entry so a later recovery pass can
        // retry; replay dedupes on event_id, so a re-append is safe.
        if (logger) {
          logger('WARN', 'turn_journal.retained_after_persist_failure', {
            sessionId,
            turnId,
            reason: (appendResult && appendResult.reason) || 'unknown',
          });
        }
        continue;
      }
      replayed += Number.isFinite(Number(appendResult.value?.appended))
        ? Math.max(0, Number(appendResult.value.appended))
        : 0;
      turns += 1;
      journal.clear(sessionId, turnId, { commitResult: appendResult });
    }
    sessions += 1;
  }
  if (logger && replayed > 0) {
    logger('INFO', 'session_recovery.turn_event_journal_replayed', {
      replayed,
      sessions,
      turns,
    });
  }
  return { replayed, sessions, turns };
}

module.exports = {
  buildResumePayload,
  detectInterruptionState,
  filterHistoryForResume,
  recoverTurnEventJournal,
  repairToolPairing,
};
