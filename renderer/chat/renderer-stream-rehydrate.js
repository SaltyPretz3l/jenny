(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-turn-reducer'),
      require('./renderer-turn-normalization-utils'),
      require('./renderer-stream-terminal-state')
    );
    return;
  }
  root.rendererStreamRehydrate = factory(
    root.rendererTurnReducer || {},
    root.rendererTurnNormalizationUtils || {},
    root.rendererStreamTerminalState || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (turnReducerUtils, turnNormalizationUtils, terminalStateUtils) {
  'use strict';

  const { createTurnReducerState, applyTurnStreamEvent, sealTurnRows } = turnReducerUtils || {};
  const normalizeId = typeof turnNormalizationUtils.normalizeId === 'function'
    ? turnNormalizationUtils.normalizeId
    : function fallbackNormalizeId(value) { return String(value || '').trim(); };
  const cloneSortKey = typeof turnNormalizationUtils.cloneSortKey === 'function'
    ? turnNormalizationUtils.cloneSortKey
    : function fallbackCloneSortKey(value) {
      const v = Array.isArray(value) ? value : [0, 0, 0];
      return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
      };
  const resolveTerminalPresentation = terminalStateUtils.resolveTerminalPresentation;
  if (typeof resolveTerminalPresentation !== 'function') {
    throw new Error('renderer-stream-terminal-state must load before renderer-stream-rehydrate');
  }

  const REPLAYABLE_KINDS = new Set([
    'started',
    'reasoning_phase',
    'assistant_text_segment',
    'tool_use',
    'tool_executing',
    'tool_result',
    'approval_requested',
    'approval_resolved',
    'stream_reset',
    'complete',
    'error',
    // Everything below became replayable on 2026-08-25, when
    // canonical_renderer_projection went default-on and this replay became the
    // PRODUCER of hydrated rows rather than a side-channel for live state.
    //
    // The list is an allow-list, and shapePersistedEventForReducer returns null
    // for anything outside it. That was harmless while the turn-row projector
    // built the hydrated rows -- these kinds simply were not the fold's business.
    // Under delegation the same silence deletes rows: every one of these kinds
    // renders, and the fold learned to build all of them in Wave 3a.
    'user_prompt',
    'attachment_cluster',
    'assistant_error',
    'system_notice',
    'source_citations',
    'agent_progress',
    'slash_output',
    'interactive_batch',
    'interactive_recap',
    'proactive_suggestion',
    'plan_object',
    // The canonical fold is now the reconcile-time producer of the plan row.
    'plan_document',
    'plan_proposal',
  ]);

  // Kinds that are not the assistant speaking. shapePersistedEventForReducer
  // mirrors primary_message_id onto primary_assistant_message_id, and the fold
  // latches the first one it sees as the turn's assistant message -- so without
  // this the user's own message id becomes the turn's assistant id, because
  // user_prompt is the first event of every turn.
  const NON_ASSISTANT_KINDS = new Set(['user_prompt', 'attachment_cluster']);

  // A persisted turn_failed/turn_cancelled is stored as `assistant_error`
  // (PERSISTED_KIND_BY_TYPE in services/backend/canonical-turn-event.js). It used
  // to be remapped here onto the reducer's terminal `error` kind, which stamps
  // turn.status and builds NO row -- correct while the historical error row was
  // the projector's to build, and a silent row deletion the moment the fold became
  // the producer under canonical_renderer_projection. The remap took the terminal
  // error card off the timeline; tests/renderer-chat-terminal-error-card.test.js
  // caught it.
  //
  // `assistant_error` now replays as itself: the fold builds the system_notice row
  // AND stamps the terminal status, so the turn still settles into Needs-Recovery
  // instead of limbo (empty status -> phantom "Writing"/"Thinking";
  // session-persistence audit #2) without the row going missing.
  const REHYDRATE_KIND_REMAP = Object.freeze({});

  // The backend session summary's `active_turn` is the authoritative "a turn is
  // genuinely in flight" signal for gating live-state rehydration: setActiveTurn
  // and clearActiveTurn always persist, so a settled turn has active_turn === null
  // while an interrupted (orphaned) turn still carries it. turn_id === stream_id
  // (services/backend/managed-sidecar-chat.js: `turnId: streamId`). Returns the
  // in-flight turn_id, or '' when nothing is in flight.
  function resolveInFlightTurnId(activeTurn) {
    if (!activeTurn || typeof activeTurn !== 'object' || Array.isArray(activeTurn)) {
      return '';
    }
    return normalizeId(activeTurn.stream_id || activeTurn.streamId)
      || normalizeId(activeTurn.request_id || activeTurn.requestId);
  }

  // Forward the backend summary's `activeTurn` onto a rehydrate-options object
  // ONLY when the source payload actually carries the key. This is the single
  // definition of the opt-in-by-key-presence gate contract (see the gate in
  // rehydrateSessionLiveState): a stored `activeTurn: null` opts into the
  // settled-skip, while a payload that never set the key keeps the legacy
  // replay-everything behavior used by the reopen bridge
  // (renderer-stream-handler-lifecycle.js).
  function withActiveTurnForwarded(baseOptions, source) {
    return source && Object.prototype.hasOwnProperty.call(source, 'activeTurn')
      ? { ...baseOptions, activeTurn: source.activeTurn }
      : baseOptions;
  }

  function shapePersistedEventForReducer(persistedEvent, ordinal) {
    if (!persistedEvent || typeof persistedEvent !== 'object' || Array.isArray(persistedEvent)) {
      return null;
    }
    const rawKind = normalizeId(persistedEvent.kind);
    const kind = REHYDRATE_KIND_REMAP[rawKind] || rawKind;
    if (!kind || !REPLAYABLE_KINDS.has(kind)) {
      return null;
    }
    const turnId = normalizeId(persistedEvent.turn_id || persistedEvent.turnId);
    if (!turnId) {
      return null;
    }
    const sourceMessageIds = Array.isArray(persistedEvent.source_message_ids)
      ? persistedEvent.source_message_ids.map((value) => normalizeId(value)).filter(Boolean)
      : [];
    const payload = persistedEvent.payload && typeof persistedEvent.payload === 'object' && !Array.isArray(persistedEvent.payload)
      ? persistedEvent.payload
      : {};
    const event = {
      event_id: normalizeId(persistedEvent.event_id) || `${turnId}:${kind}:${ordinal}`,
      turn_id: turnId,
      kind,
      primary_message_id: normalizeId(persistedEvent.primary_message_id),
      primary_assistant_message_id: NON_ASSISTANT_KINDS.has(kind)
        ? ''
        : normalizeId(persistedEvent.primary_message_id),
      source_message_ids: sourceMessageIds,
      sort_key: cloneSortKey([ordinal, 0, 0]),
      payload,
    };
    if (persistedEvent.phase_id) {
      event.phase_id = normalizeId(persistedEvent.phase_id);
    }
    if (persistedEvent.tool_call_id) {
      event.tool_call_id = normalizeId(persistedEvent.tool_call_id);
    }
    if (persistedEvent.status) {
      event.status = normalizeId(persistedEvent.status);
    }
    // assistant_error joins the terminal kinds because the fold now reads
    // event.terminal_status off it to settle the turn -- the job the remap onto
    // `error` used to do before that remap started deleting the error row.
    if (kind === 'complete' || kind === 'error' || kind === 'assistant_error') {
      const rawTerminalStatus = persistedEvent.terminal_status
        || payload.terminal_status
        || payload.terminalStatus
        || payload.recovery_class;
      // assistant_error's own name is not a canonical terminal status, so it
      // falls back to `error` -- the status the remap onto the `error` kind used
      // to produce. Without this a payload with no terminal_status settles as
      // 'unknown' and the deck never reaches Needs-Recovery.
      event.terminal_status = resolveTerminalPresentation(rawTerminalStatus, {
        fallbackStatus: kind === 'assistant_error' ? 'error' : kind,
      }).status;
    }
    return event;
  }

  function replayPersistedEvents(reducerState, persistedEvents, options = {}) {
    if (!reducerState || typeof applyTurnStreamEvent !== 'function') {
      return reducerState;
    }
    const appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : () => {};
    const sessionId = normalizeId(options.sessionId);
    const list = Array.isArray(persistedEvents) ? persistedEvents : [];
    for (let index = 0; index < list.length; index += 1) {
      try {
        const reducerEvent = shapePersistedEventForReducer(list[index], index);
        if (!reducerEvent) {
          continue;
        }
        const turn = reducerState.turns_by_id?.[reducerEvent.turn_id];
        const ignoredBefore = turn?.ignored_terminal_event_count || 0;
        applyTurnStreamEvent(reducerState, reducerEvent);
        const updatedTurn = reducerState.turns_by_id?.[reducerEvent.turn_id];
        if (updatedTurn?.ignored_terminal_event_count > ignoredBefore) {
          appendClientLog('WARN', 'stream.rehydrate_terminal_ignored', {
            sessionId: sessionId.slice(0, 30),
            turnId: reducerEvent.turn_id.slice(0, 30),
            reason: updatedTurn.last_ignored_terminal_reason,
          });
        }
      } catch (error) {
        let kind;
        try {
          kind = normalizeId(list[index]?.kind);
        } catch (_kindError) {
          kind = '';
        }
        try {
          appendClientLog('WARN', 'stream.rehydrate_event_failed', {
            sessionId: sessionId.slice(0, 30),
            eventIndex: index,
            kind,
            message: String(error?.message || error).slice(0, 200),
          });
        } catch (_logError) { /* best effort */ }
      }
    }
    return reducerState;
  }

  function rehydrateSessionLiveState(options = {}) {
    const {
      sessionId,
      turnEvents,
      liveStateStore,
      appendClientLog = () => {},
    } = options;
    const normalizedSessionId = normalizeId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }
    if (typeof createTurnReducerState !== 'function') {
      return null;
    }
    const events = Array.isArray(turnEvents) ? turnEvents : [];
    if (!events.length) {
      return null;
    }
    // Gate live seeding on a genuinely in-flight turn. Replaying a settled
    // session's persisted turn_events[] leaves the reducer's active_turn_id on
    // the last completed turn (empty status), which the Active Turn V2 deck
    // renders as a phantom "Writing"/"Thinking" on reopen (session-persistence
    // audit #2). Callers pass the backend summary's `activeTurn` to opt in;
    // direct callers that omit the key keep the legacy replay-everything behavior
    // (historical row projection is unaffected — persisted rows render on their
    // own path).
    if (Object.prototype.hasOwnProperty.call(options, 'activeTurn')) {
      const inFlightTurnId = resolveInFlightTurnId(options.activeTurn);
      const hasInFlightTurn = Boolean(inFlightTurnId)
        && events.some((event) => normalizeId(event && (event.turn_id || event.turnId)) === inFlightTurnId);
      if (!hasInFlightTurn) {
        try {
          appendClientLog('DEBUG', 'stream.rehydrate_skipped_settled', {
            sessionId: normalizedSessionId.slice(0, 30),
            eventCount: events.length,
            inFlight: Boolean(inFlightTurnId),
          });
        } catch (_logError) { /* best effort */ }
        return null;
      }
    }
    let reducerState;
    try {
      // Thread the DC1 deterministic-row_id opt-in so a reopen-seeded live turn
      // stamps the same row_ids as the hydrated projection it reconciles against.
      reducerState = createTurnReducerState({ deterministicRowId: options.deterministicRowId === true });
      replayPersistedEvents(reducerState, events, {
        sessionId: normalizedSessionId,
        appendClientLog,
      });
    } catch (error) {
      try {
        appendClientLog('WARN', 'stream.rehydrate_failed', {
          sessionId: normalizedSessionId.slice(0, 30),
          message: String(error?.message || error).slice(0, 200),
          eventCount: events.length,
        });
      } catch (_logError) { /* best effort */ }
      return null;
    }
    if (liveStateStore && typeof liveStateStore.set === 'function') {
      liveStateStore.set(normalizedSessionId, reducerState);
    }
    try {
      appendClientLog('DEBUG', 'stream.rehydrate_completed', {
        sessionId: normalizedSessionId.slice(0, 30),
        eventCount: events.length,
        turnCount: reducerState.turns_by_id
          ? Object.keys(reducerState.turns_by_id).length
          : 0,
      });
    } catch (_logError) { /* best effort */ }
    return reducerState;
  }

  function projectPersistedEventsWithReducer(persistedEvents, options = {}) {
    if (typeof createTurnReducerState !== 'function' || typeof applyTurnStreamEvent !== 'function') {
      return null;
    }
    const reducerState = createTurnReducerState({ deterministicRowId: options.deterministicRowId === true });
    replayPersistedEvents(reducerState, persistedEvents, options);
    const requestedTurnId = normalizeId(options.turnId || options.turn_id);
    const turnsById = reducerState && reducerState.turns_by_id ? reducerState.turns_by_id : {};
    const activeTurnId = normalizeId(reducerState.active_turn_id);
    const resolvedTurnId = requestedTurnId && turnsById[requestedTurnId]
      ? requestedTurnId
      : activeTurnId || Object.keys(turnsById)[0] || '';
    const turn = resolvedTurnId ? turnsById[resolvedTurnId] : null;
    if (!turn) {
      return null;
    }
    // This entry point projects a COMPLETE persisted log, unlike
    // rehydrateSessionLiveState above, which restores live state for a turn that
    // may still be streaming. Only here can the fold conclude that a tool left
    // running never got a result -- so only here is it sealed.
    if (typeof sealTurnRows === 'function') {
      sealTurnRows(turn);
    }
    return {
      state: reducerState,
      turn,
      rows: Array.isArray(turn.rows) ? turn.rows.slice() : [],
      viewModel: null,
    };
  }

  return Object.freeze({
    rehydrateSessionLiveState,
    projectPersistedEventsWithReducer,
    shapePersistedEventForReducer,
    replayPersistedEvents,
    resolveInFlightTurnId,
    withActiveTurnForwarded,
    REPLAYABLE_KINDS,
  });
});
