/* renderer/chat/renderer-stream-handler-reducer-wiring.js -- reducer-context builder + live-turn apply/reconcile helpers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamHandlerReducerWiring = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createReducerWiring(options = {}) {
    const {
      streamSegmentState,
      normalizeId,
      normalizeString,
      getSessionMessages,
      isRowModelEnabled,
      getSessionLiveTurnState,
      pruneEmptySessionLiveState,
      buildRolloutRowKey,
      buildTurnEventFromStreamPayload,
      applyTurnStreamEvent,
      reconcileTurnRows,
      turnTreeProjectorUtils,
      turnRowProjectorUtils,
      streamRehydrateUtils,
      isCanonicalRendererProjectionEnabled,
      // DC1 flicker cure: per-session resolver for the deterministic-row_id
      // opt-in. Absent/false (the default) => reconcile + its hydrated
      // projection are byte-identical.
      isDeterministicRowIdEnabled,
      recordChatTimelineRolloutSignal,
      // chat_timeline_render_telemetry (Track A): TEMPORARY per-session
      // resolver for the streaming-flicker diagnostics. Absent/false (the
      // default) => the affirmative "clean reconcile" signal below never
      // fires; reconcile itself is completely untouched either way.
      isRenderTelemetryEnabled,
      appendClientLog,
    } = options || {};

    if (!(streamSegmentState instanceof Map)) {
      throw new Error('createReducerWiring requires options.streamSegmentState (Map)');
    }
    if (typeof normalizeId !== 'function' || typeof normalizeString !== 'function') {
      throw new Error('createReducerWiring requires options.normalizeId and options.normalizeString');
    }
    if (typeof getSessionMessages !== 'function') {
      throw new Error('createReducerWiring requires options.getSessionMessages');
    }
    if (typeof isRowModelEnabled !== 'function'
      || typeof getSessionLiveTurnState !== 'function'
      || typeof pruneEmptySessionLiveState !== 'function'
      || typeof buildRolloutRowKey !== 'function') {
      throw new Error('createReducerWiring requires row-model sibling helpers');
    }
    if (typeof buildTurnEventFromStreamPayload !== 'function'
      || typeof applyTurnStreamEvent !== 'function'
      || typeof reconcileTurnRows !== 'function') {
      throw new Error('createReducerWiring requires turn-reducer helpers');
    }

    const safeRecordRolloutSignal = typeof recordChatTimelineRolloutSignal === 'function'
      ? recordChatTimelineRolloutSignal
      : () => ({ logged: false, count: 0 });

    function buildAssistantShellMessageId(streamId, segmentIndex) {
      const normalizedStreamId = normalizeId(streamId);
      const normalizedSegmentIndex = Number(segmentIndex) || 0;
      // A stream_reset may carry main's authoritative id for the segment it
      // hands over to (main spells index 0 as `_seg0`, the renderer's own
      // scheme spells it as the bare base id). handleStreamReset latches that
      // id together with the INDEX it names; honour it here so every caller —
      // text deltas, reasoning phases — keys the segment the way main persists
      // it. Matching on the latched index, not on segState.segmentIndex: that
      // counter also advances at every tool boundary
      // (renderer-stream-handler-tools.js, which clears the latch), and
      // comparing against it made the latch answer for a segment it does not
      // name. Any other index falls through to the renderer's own scheme, so a
      // stale latch can never leak forward.
      const segState = streamSegmentState.get(streamId);
      const authoritativeId = segState ? normalizeString(segState.authoritativeAssistantMessageId) : '';
      const latchedSegmentIndex = segState && segState.authoritativeAssistantSegmentIndex != null
        ? Number(segState.authoritativeAssistantSegmentIndex)
        : null;
      if (authoritativeId && latchedSegmentIndex === normalizedSegmentIndex) {
        return authoritativeId;
      }
      return normalizedSegmentIndex > 0
        ? `assistant_${normalizedStreamId}_seg${normalizedSegmentIndex}`
        : `assistant_${normalizedStreamId}`;
    }

    function buildToolShellMessageId(callId) {
      return `tool_use_${normalizeId(callId)}`;
    }

    function buildToolResultMessageId(callId) {
      return `tool_result_${normalizeId(callId)}`;
    }

    function resolvePrimaryUserMessageId(sessionId) {
      const messages = getSessionMessages(sessionId);
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (normalizeString(message?.role) === 'user') {
          return normalizeId(message?.id);
        }
      }
      return '';
    }

    function buildReducerContext(payload, callOptions = {}) {
      const segState = streamSegmentState.get(payload.streamId) || { segmentIndex: 0 };
      const sessionLiveState = getSessionLiveTurnState(payload.sessionId, { create: true });
      const turnId = normalizeId(payload.streamId || payload.requestId || payload.request_id);
      const turn = sessionLiveState?.turns_by_id?.[turnId] || null;
      const messageIndex = turn?.rows?.length || 0;
      const intraOrder = turn?.next_sort_ordinal || 0;
      return {
        turn_id: turnId,
        ordinal: intraOrder,
        message_index: messageIndex,
        intra_message_order: intraOrder,
        primary_user_message_id: turn?.primary_user_message_id || resolvePrimaryUserMessageId(payload.sessionId),
        primary_assistant_message_id: normalizeId(callOptions.primaryAssistantMessageId || buildAssistantShellMessageId(payload.streamId, segState.segmentIndex)),
        next_assistant_message_id: normalizeId(callOptions.nextAssistantMessageId || ''),
        primary_tool_message_id: normalizeId(callOptions.primaryToolMessageId || buildToolShellMessageId(payload.callId)),
        tool_result_message_id: normalizeId(callOptions.toolResultMessageId || buildToolResultMessageId(payload.callId)),
        segment_text: Object.prototype.hasOwnProperty.call(callOptions, 'segmentText') ? callOptions.segmentText : undefined,
        assistant_phase: normalizeId(callOptions.assistantPhase),
        segment_index: Number(callOptions.segmentIndex != null ? callOptions.segmentIndex : segState.segmentIndex) || 0,
        // Reasoning deltas carry only thinkingId while phase_started carries
        // the sidecar phase_id — stamping deltas with the thinkingId gave the
        // live row a DIFFERENT dedup key than the phase shell, so a stale
        // truncated copy survived next to the settled row. The turn's open
        // phase (latched below) wins over the thinkingId fallback.
        phase_id: normalizeId(
          callOptions.phaseId
          || payload.phaseId
          || (turn && turn.open_reasoning_phase_id)
          || payload.thinkingId
        ),
      };
    }

    function latchOpenReasoningPhase(sessionLiveState, payload, events) {
      const payloadType = normalizeId(payload.type);
      if (payloadType !== 'phase_started' && payloadType !== 'phase_completed') {
        return;
      }
      const turnId = normalizeId(payload.streamId || payload.requestId || payload.request_id);
      const turn = sessionLiveState?.turns_by_id?.[turnId];
      if (!turn) {
        return;
      }
      for (const event of Array.isArray(events) ? events : [events]) {
        if (!event || event.kind !== 'reasoning_phase') {
          continue;
        }
        if (payloadType === 'phase_started') {
          turn.open_reasoning_phase_id = normalizeId(event.phase_id);
        } else if (normalizeId(event.phase_id) === normalizeId(turn.open_reasoning_phase_id)) {
          turn.open_reasoning_phase_id = '';
        }
      }
    }

    function applyLiveTurnPayload(payload, callOptions = {}) {
      if (!isRowModelEnabled(payload.sessionId)) {
        return null;
      }
      const sessionLiveState = getSessionLiveTurnState(payload.sessionId, { create: true });
      const turnId = normalizeId(payload.streamId || payload.requestId || payload.request_id);
      const ignoredBefore = sessionLiveState?.turns_by_id?.[turnId]?.ignored_terminal_event_count || 0;
      const reducerContext = buildReducerContext(payload, callOptions);
      const nextEvents = buildTurnEventFromStreamPayload(payload, reducerContext);
      if (!nextEvents) {
        return sessionLiveState;
      }
      applyTurnStreamEvent(sessionLiveState, nextEvents);
      const turn = sessionLiveState?.turns_by_id?.[turnId];
      // The first payload creates the turn inside applyTurnStreamEvent, so it
      // cannot be advanced while the context is built. Advance after a real
      // event is applied for both new and existing turns; otherwise the first
      // two payloads receive the same synthetic event id and the reducer
      // correctly discards the second as a duplicate.
      if (turn) {
        turn.next_sort_ordinal = Math.max(
          Number(turn.next_sort_ordinal) || 0,
          (Number(reducerContext.intra_message_order) || 0) + 1
        );
      }
      if (turn?.ignored_terminal_event_count > ignoredBefore && typeof appendClientLog === 'function') {
        appendClientLog('WARN', 'stream.terminal_event_ignored', {
          sessionId: normalizeId(payload.sessionId).slice(0, 30),
          streamId: turnId.slice(0, 30),
          reason: turn.last_ignored_terminal_reason,
        });
      }
      latchOpenReasoningPhase(sessionLiveState, payload, nextEvents);
      return sessionLiveState;
    }

    function reconcileLiveTurnWithHydratedRows(
      sessionId,
      streamId,
      messages,
      turnEventState = null,
      canonicalTurnEvents = undefined
    ) {
      const normalizedSessionId = normalizeId(sessionId);
      const normalizedTurnId = normalizeId(streamId);
      if (!normalizedSessionId
        || !normalizedTurnId
        || typeof turnTreeProjectorUtils?.projectTurnTree !== 'function'
        || typeof turnRowProjectorUtils?.projectTurnRows !== 'function') {
        return null;
      }
      const sessionLiveState = getSessionLiveTurnState(normalizedSessionId);
      const provisionalTurn = sessionLiveState?.turns_by_id?.[normalizedTurnId] || null;
      if (!provisionalTurn) {
        return null;
      }
      // DC1 flicker cure: when the session opted in, the hydrated projection
      // must stamp the same deterministic row_ids as the live provisional rows
      // (which getSessionLiveTurnState already stamped), and reconcile must key
      // on that shared row_id. Off by default => byte-identical reconcile.
      const deterministicRowId = typeof isDeterministicRowIdEnabled === 'function'
        && isDeterministicRowIdEnabled(normalizedSessionId) === true;
      const projectionInput = { messages: Array.isArray(messages) ? messages : [] };
      const persistedState = turnEventState && typeof turnEventState === 'object' ? turnEventState : {};
      const persistedTurnEvents = Array.isArray(persistedState.turnEvents)
        ? persistedState.turnEvents
        : (Array.isArray(persistedState.turn_events) ? persistedState.turn_events : []);
      const persistedLogVersion = Number(
        persistedState.turnEventLogVersion
        || persistedState.turn_event_log_version
        || 0
      ) || 0;
      // The store still holds pre-finalization captures here. buildFinalizedTurnEvents
      // settles reasoning retroactively from finalized messages, while cold reopen reads
      // that settled log, so a non-empty carried log must win for live/reopen parity. It
      // has no independent version; the persisted version remains the log contract.
      //
      // Which is why a supported persisted version is REQUIRED to prefer it: projectTurnTree
      // gates the whole persisted-events path on isTurnEventLogSupported(version >= 1), so
      // with an empty store the carried log would be handed over and then silently dropped
      // for a message-built tree. Behaviour is the same either way there -- the damage would
      // be to projectionSource below, which would report a fold that never happened, which is
      // the exact false-green this program has now hit seven times.
      const useFinalizedTurnEvents = Array.isArray(canonicalTurnEvents)
        && canonicalTurnEvents.length > 0
        && persistedLogVersion >= 1;
      const projectionTurnEvents = useFinalizedTurnEvents
        ? canonicalTurnEvents
        : persistedTurnEvents;
      if (projectionTurnEvents.length) {
        projectionInput.turnEventLogVersion = persistedLogVersion;
        projectionInput.turn_event_log_version = persistedLogVersion;
        projectionInput.turnEvents = projectionTurnEvents;
        projectionInput.turn_events = projectionTurnEvents;
      }
      const projectedTurnTree = turnTreeProjectorUtils.projectTurnTree(projectionInput);
      const turns = Array.isArray(projectedTurnTree?.turns) ? projectedTurnTree.turns : [];
      const hydratedTurn = turns.find((entry) => normalizeId(entry?.turn_id) === normalizedTurnId) || null;
      if (!hydratedTurn) {
        delete sessionLiveState.turns_by_id[normalizedTurnId];
        delete sessionLiveState.reconciled_rows_by_turn_id[normalizedTurnId];
        delete sessionLiveState.pending_reconciliation_by_turn_id[normalizedTurnId];
        if (sessionLiveState.active_turn_id === normalizedTurnId) {
          sessionLiveState.active_turn_id = '';
        }
        pruneEmptySessionLiveState(normalizedSessionId, sessionLiveState);
        return null;
      }
      // Phase 2 adoption: when the row projector exposes the composite
      // projectTurn API, use it so hydrated rows pick up canonical
      // view-model enrichments (raw terminal substatus) alongside the rows.
      // Live reconciliation stays non-destructive (no row_id changes) and
      // the view-model is stored on the reconciled entry for downstream
      // consumers that want canonical semantics without re-walking events.
      let hydratedRows;
      let hydratedViewModel = null;
      const useCanonicalReducerProjection = typeof isCanonicalRendererProjectionEnabled === 'function'
        && isCanonicalRendererProjectionEnabled(normalizedSessionId) === true
        && typeof streamRehydrateUtils?.projectPersistedEventsWithReducer === 'function';
      if (useCanonicalReducerProjection) {
        const projection = streamRehydrateUtils.projectPersistedEventsWithReducer(
          Array.isArray(hydratedTurn.events) ? hydratedTurn.events : [],
          { sessionId: normalizedSessionId, turnId: normalizedTurnId, deterministicRowId }
        );
        if (projection && Array.isArray(projection.rows)) {
          hydratedRows = projection.rows;
          hydratedViewModel = projection.viewModel || null;
          safeRecordRolloutSignal(normalizedSessionId, 'canonical_projection_applied', {
            turnId: normalizedTurnId.slice(0, 30),
            rowCount: hydratedRows.length,
          });
        } else {
          // Named deliberately. The flag can be ON and this path still fall back to
          // the projector -- when the replay resolves no turn, projection is null
          // and the next branch quietly takes over. Wave 1 spent an entire owner
          // telemetry pass on exactly that shape of anonymous fallback, and naming
          // it is what turned "the fix works" into "the fix works 22% of the time".
          safeRecordRolloutSignal(normalizedSessionId, 'canonical_projection_fallback', {
            turnId: normalizedTurnId.slice(0, 30),
            eventCount: Array.isArray(hydratedTurn.events) ? hydratedTurn.events.length : 0,
          });
        }
      }
      if (!Array.isArray(hydratedRows) && typeof turnRowProjectorUtils.projectTurn === 'function') {
        const messageByIdForTurn = new Map();
        for (const message of Array.isArray(messages) ? messages : []) {
          const id = normalizeId(message && message.id);
          if (id && !messageByIdForTurn.has(id)) messageByIdForTurn.set(id, message);
        }
        const toolMessageIdsByCallIdForTurn = new Map();
        for (const message of Array.isArray(messages) ? messages : []) {
          if (!message) continue;
          const id = normalizeId(message.id);
          if (!id) continue;
          const kind = normalizeId(message.kind);
          let callId = '';
          if (kind === 'tool_use') callId = normalizeId(message.tool_call && message.tool_call.call_id);
          else if (kind === 'tool_result') callId = normalizeId(message.tool_result && message.tool_result.call_id);
          if (!callId) continue;
          const ids = toolMessageIdsByCallIdForTurn.get(callId) || [];
          if (!ids.includes(id)) ids.push(id);
          toolMessageIdsByCallIdForTurn.set(callId, ids);
        }
        const projection = turnRowProjectorUtils.projectTurn(hydratedTurn, {
          messageById: messageByIdForTurn,
          toolMessageIdsByCallId: toolMessageIdsByCallIdForTurn,
          deterministicRowId,
        });
        hydratedRows = Array.isArray(projection && projection.rows) ? projection.rows : [];
        hydratedViewModel = projection && projection.viewModel ? projection.viewModel : null;
      } else if (!Array.isArray(hydratedRows)) {
        hydratedRows = turnRowProjectorUtils.projectTurnRows(
          Array.isArray(hydratedTurn.events) ? hydratedTurn.events : [],
          { deterministicRowId }
        );
      }
      const reconciliation = reconcileTurnRows(
        Array.isArray(provisionalTurn.rows) ? provisionalTurn.rows : [],
        hydratedRows,
        { deterministicRowId }
      );
      if (Array.isArray(reconciliation.staleRows) && reconciliation.staleRows.length > 0) {
        // Stale provisional rows are discarded; canonical is the authority.
        // Telemetered so we can detect real content loss in the wild — if it
        // happens, prefer targeted recovery over re-adding a blanket splice.
        safeRecordRolloutSignal(normalizedSessionId, 'stale_row_deletion', {
          turnId: normalizedTurnId,
          staleRowCount: reconciliation.staleRows.length,
          staleRowKeys: reconciliation.staleRows.map((row) => buildRolloutRowKey(row)),
        });
      }
      // DC1: under the deterministic-row_id flag the first pass should key on the
      // shared row_id and match structurally, so the second-pass recovery net
      // should never fire. Telemeter any fire (goal: zero) so the second pass can
      // be retired after a clean soak. Only meaningful with the flag on — flag-off
      // relies on the second pass by design, so we don't signal there.
      if (
        deterministicRowId
        && Array.isArray(reconciliation.secondPassMatches)
        && reconciliation.secondPassMatches.length > 0
      ) {
        safeRecordRolloutSignal(normalizedSessionId, 'deterministic_row_id_second_pass', {
          turnId: normalizedTurnId,
          recoveredCount: reconciliation.secondPassMatches.length,
          recoveredKeys: reconciliation.secondPassMatches.map((match) => String(match && match.key || '')),
        });
      }
      // chat_timeline_render_telemetry (Track A): affirmative zero-count signal —
      // this turn's terminal reconcile needed neither stale-row deletion nor the
      // deterministic-row_id second-pass recovery net. Kept as an independent
      // `if` (disjoint from the DC1 branch above: it requires both counts 0, that
      // branch requires secondPassMatches > 0) so Track A can land separately.
      const isEmptyList = (arr) => !Array.isArray(arr) || arr.length === 0;
      if (
        typeof isRenderTelemetryEnabled === 'function'
        && isRenderTelemetryEnabled(normalizedSessionId) === true
        && isEmptyList(reconciliation.staleRows)
        && isEmptyList(reconciliation.secondPassMatches)
      ) {
        safeRecordRolloutSignal(normalizedSessionId, 'terminal_reconcile_clean', {
          turnId: normalizedTurnId,
          finalRowCount: Array.isArray(reconciliation.finalRows) ? reconciliation.finalRows.length : 0,
        });
      }
      if (
        typeof isRenderTelemetryEnabled === 'function'
        && isRenderTelemetryEnabled(normalizedSessionId) === true
      ) {
        // This evidence decides whether the terminal handoff can fold canonical
        // events. It is deliberately counts-only; row-level diffing is a later instrument.
        const canonicalEventsPresent = Array.isArray(canonicalTurnEvents);
        safeRecordRolloutSignal(normalizedSessionId, 'terminal_canonical_parity', {
          turnId: normalizedTurnId,
          canonicalEventsPresent,
          canonicalEventCount: canonicalEventsPresent ? canonicalTurnEvents.length : 0,
          projectionSource: useFinalizedTurnEvents ? 'finalized_canonical_events' : 'persisted_store',
          hydratedRowCount: hydratedRows.length,
          finalRowCount: Array.isArray(reconciliation.finalRows) ? reconciliation.finalRows.length : 0,
        });
      }
      for (let rowIndex = 0; rowIndex < hydratedRows.length; rowIndex += 1) {
        const row = hydratedRows[rowIndex];
        const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
        const subkind = normalizeId(payload.subkind);
        if (row?.kind === 'system_notice' && subkind.startsWith('orphan_')) {
          safeRecordRolloutSignal(normalizedSessionId, 'orphan_row', {
            turnId: normalizedTurnId,
            subkind,
            primaryMessageId: normalizeId(row?.primary_message_id),
          });
        }
        if (row?.kind === 'tool_call' && normalizeId(payload.state) === 'interrupted') {
          safeRecordRolloutSignal(normalizedSessionId, 'interrupted_running_tool_hydration', {
            turnId: normalizedTurnId,
            toolCallId: normalizeId(row?.tool_call_id || payload.tool_call_id),
            primaryMessageId: normalizeId(row?.primary_message_id),
          });
        }
      }
      const provisionalTerminalStatus = normalizeId(provisionalTurn.status);
      sessionLiveState.reconciled_rows_by_turn_id[normalizedTurnId] = {
        turn: {
          ...hydratedTurn,
          ...(provisionalTerminalStatus ? { status: provisionalTerminalStatus } : {}),
        },
        rows: Array.isArray(reconciliation.finalRows) ? reconciliation.finalRows : [],
        staleRows: Array.isArray(reconciliation.staleRows) ? reconciliation.staleRows : [],
        viewModel: hydratedViewModel,
      };
      sessionLiveState.pending_reconciliation_by_turn_id[normalizedTurnId] = true;
      delete sessionLiveState.turns_by_id[normalizedTurnId];
      if (sessionLiveState.active_turn_id === normalizedTurnId) {
        sessionLiveState.active_turn_id = '';
      }
      return reconciliation;
    }

    return {
      buildAssistantShellMessageId,
      applyLiveTurnPayload,
      reconcileLiveTurnWithHydratedRows,
    };
  }

  return { createReducerWiring };
});
