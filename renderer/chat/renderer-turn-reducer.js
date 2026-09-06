(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-turn-normalization-utils'),
      require('./renderer-reasoning-entry-merge-utils'),
      require('./renderer-turn-reducer-stream-event-utils'),
      require('./renderer-turn-reducer-approval-gap'),
      require('./renderer-turn-reducer-tool-rows'),
      require('./renderer-turn-reducer-canonical-rows'),
      require('./renderer-row-identity-utils'),
      require('./renderer-stream-terminal-state')
    );
    return;
  }
  root.rendererTurnReducer = factory(
    root.rendererTurnNormalizationUtils || {},
    root.rendererReasoningEntryMergeUtils || {},
    root.rendererTurnReducerStreamEventUtils || {},
    root.rendererTurnReducerApprovalGap || {},
    root.rendererTurnReducerToolRows || {},
    root.rendererTurnReducerCanonicalRows || {},
    root.rendererRowIdentityUtils || {},
    root.rendererStreamTerminalState || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (turnNormalizationUtils, reasoningEntryMergeUtils, streamEventUtilsFactory, approvalGapUtilsFactory, toolRowBuildersFactory, canonicalRowBuildersFactory, rowIdentityUtils, terminalStateUtils) {
  'use strict';

  // Row identity + reconcile live in the shared renderer-row-identity-utils
  // module (the ONE source of truth for how a row's identity is derived), so the
  // reducer and the projector cannot drift apart (flicker RCA defect class DC1).
  const {
    deriveDeterministicRowId,
    stampDeterministicRowId,
    resolveStreamResetDiscardScope,
    applyStreamResetToTurnRows,
    buildRowIdentityKey,
    reconcileTurnRows,
  } = rowIdentityUtils || {};
  if (typeof reconcileTurnRows !== 'function'
    || typeof stampDeterministicRowId !== 'function'
    || typeof resolveStreamResetDiscardScope !== 'function'
    || typeof applyStreamResetToTurnRows !== 'function') {
    throw new Error('renderer-turn-reducer: row-identity-utils wire-up failed');
  }

  const {
    cloneSortKey,
    deepCloneJsonValue,
    normalizeGeneratedArtifact,
    normalizeId,
    normalizeToolLifecycleStatus,
    pushDistinct,
  } = turnNormalizationUtils;

  const {
    buildReasoningEntryMergeIndexes,
    isReasoningEntryEdit,
    mergeReasoningEntriesInto,
    resolveReasoningEntryEdits,
  } = reasoningEntryMergeUtils;

  const REASONING_CHUNK_SUM = typeof Symbol === 'function'
    ? Symbol('reasoningChunkSum')
    : '__reasoningChunkSum';
  const PHASE_SUMMARY_MAX_LENGTH = 240;
  const REASONING_ENTRY_MERGE_STATE = typeof Symbol === 'function'
    ? Symbol('reasoningEntryMergeState')
    : '__reasoningEntryMergeState';

  function createNullProtoMap() {
    return Object.create(null);
  }

  const normalizeToolStatus = normalizeToolLifecycleStatus;
  const resolveTerminalPresentation = terminalStateUtils.resolveTerminalPresentation;
  const resolveTerminalPresentationIfTerminal = terminalStateUtils.resolveTerminalPresentationIfTerminal;
  if (typeof resolveTerminalPresentation !== 'function' || typeof resolveTerminalPresentationIfTerminal !== 'function') {
    throw new Error('renderer-turn-reducer: terminal-state wire-up failed');
  }

  function normalizePhaseSummary(value) {
    const summary = String(value || '').replace(/\s+/g, ' ').trim();
    if (!summary) {
      return '';
    }
    if (summary.length <= PHASE_SUMMARY_MAX_LENGTH) {
      return summary;
    }
    return `${summary.slice(0, PHASE_SUMMARY_MAX_LENGTH - 3).trim()}...`;
  }

  function normalizePhaseMetadata(source = {}) {
    const candidate = source && typeof source === 'object' && !Array.isArray(source)
      ? source
      : {};
    const phase = candidate.phase && typeof candidate.phase === 'object' && !Array.isArray(candidate.phase)
      ? candidate.phase
      : candidate;
    const phaseId = normalizeId(phase.phase_id || phase.phaseId);
    const phaseKind = normalizeId(phase.phase_kind || phase.phaseKind);
    const thinkingId = normalizeId(phase.thinking_id || phase.thinkingId);
    const toolCallId = normalizeId(phase.tool_call_id || phase.toolCallId);
    const toolName = normalizeId(phase.tool_name || phase.toolName);
    const summary = normalizePhaseSummary(phase.summary);
    const iteration = Number(phase.iteration);
    if (
      !phaseId
      && !phaseKind
      && !thinkingId
      && !toolCallId
      && !toolName
      && !summary
      && !Number.isFinite(iteration)
    ) {
      return null;
    }
    return {
      ...(phaseId ? { phase_id: phaseId } : {}),
      ...(phaseKind ? { phase_kind: phaseKind } : {}),
      ...(Number.isFinite(iteration) ? { iteration: Math.trunc(iteration) } : {}),
      ...(thinkingId ? { thinking_id: thinkingId } : {}),
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      ...(toolName ? { tool_name: toolName } : {}),
      ...(summary ? { summary } : {}),
    };
  }

  function mergePhaseMetadata(primary, fallback) {
    const base = normalizePhaseMetadata(fallback) || {};
    const next = normalizePhaseMetadata(primary) || {};
    const merged = { ...base, ...next };
    return Object.keys(merged).length ? merged : null;
  }

  function appendSourceIds(row, event) {
    const sourceIds = Array.isArray(event && event.source_message_ids) ? event.source_message_ids : [];
    for (let index = 0; index < sourceIds.length; index += 1) {
      pushDistinct(row.source_message_ids, sourceIds[index]);
    }
    if (!row.primary_message_id) {
      row.primary_message_id = normalizeId(event && event.primary_message_id);
    }
    if (!row.source_message_ids.length && row.primary_message_id) {
      row.source_message_ids.push(row.primary_message_id);
    }
  }

  function buildBaseRow(kind, turnId, event) {
    const normalizedTurnId = normalizeId(turnId);
    const normalizedEventId = normalizeId(event && event.event_id);
    const row = {
      row_id: `row:${normalizedEventId}`,
      turn_id: normalizedTurnId,
      kind,
      primary_message_id: normalizeId(event && event.primary_message_id),
      source_message_ids: [],
      first_event_sort_key: cloneSortKey(event && event.sort_key),
      source_events: [],
      payload: {},
    };
    if (normalizedEventId) {
      row.source_events.push(normalizedEventId);
    }
    appendSourceIds(row, event);
    return row;
  }

  function cloneEntries(entries) {
    const list = Array.isArray(entries) ? entries : [];
    return list.map((entry) => ({ ...entry }));
  }

  // The pure stream-payload → turn-event translator lives in a sibling factory
  // so the reducer stays under the modularity cap. It threads the normalization
  // and phase helpers above through closure; behavior is byte-identical.
  const { buildTurnEventFromStreamPayload } = (streamEventUtilsFactory
    && typeof streamEventUtilsFactory.createTurnReducerStreamEventUtils === 'function'
    ? streamEventUtilsFactory.createTurnReducerStreamEventUtils({
        normalizeId,
        cloneSortKey,
        deepCloneJsonValue,
        normalizeGeneratedArtifact,
        normalizeToolStatus,
        mergePhaseMetadata,
        normalizePhaseSummary,
        cloneEntries,
      })
    : {});
  if (typeof buildTurnEventFromStreamPayload !== 'function') {
    throw new Error('renderer-turn-reducer: stream-event-utils factory wire-up failed');
  }

  // The standalone approval_gap row lifecycle (the live Allow/Deny block) lives in
  // a sibling factory so the reducer stays under the modularity cap. It threads the
  // row/normalization helpers above through closure and operates on the turn passed
  // in; see the file header for the shared invariant with the trace projector.
  const {
    removeApprovalGapRow,
    syncApprovalGapRow,
  } = (approvalGapUtilsFactory
    && typeof approvalGapUtilsFactory.createTurnReducerApprovalGapUtils === 'function'
    ? approvalGapUtilsFactory.createTurnReducerApprovalGapUtils({
        buildBaseRow,
        normalizeId,
        pushDistinct,
        ensureRowEvent,
        normalizeToolStatus,
        stampRowIdentity,
      })
    : {});
  if (typeof syncApprovalGapRow !== 'function' || typeof removeApprovalGapRow !== 'function') {
    throw new Error('renderer-turn-reducer: approval-gap factory wire-up failed');
  }

  function getReasoningEntryMergeState(payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    if (!Array.isArray(payload.entries)) {
      payload.entries = [];
    }
    const existingState = payload[REASONING_ENTRY_MERGE_STATE];
    if (existingState && existingState.entries === payload.entries) {
      return existingState;
    }
    const { indexById, contentKeyCounts } = buildReasoningEntryMergeIndexes(payload.entries, normalizeId);
    const state = {
      entries: payload.entries,
      indexById,
      contentKeyCounts,
    };
    Object.defineProperty(payload, REASONING_ENTRY_MERGE_STATE, {
      value: state,
      enumerable: false,
      configurable: true,
    });
    return state;
  }

  function mergeReasoningEntriesIntoPayload(payload, incomingEntries) {
    const state = getReasoningEntryMergeState(payload);
    if (!state) {
      return [];
    }
    if (!Array.isArray(incomingEntries) || !incomingEntries.length) {
      return state.entries;
    }
    return mergeReasoningEntriesInto(state, incomingEntries, normalizeId);
  }

  function reasoningPhaseIsCompleted(event) {
    const status = normalizeId(event && event.status).toLowerCase();
    return status === 'completed'
      || status === 'complete'
      || (event && event.payload && event.payload.completed === true);
  }

  function createTurnReducerState(options) {
    return {
      active_turn_id: '',
      turns_by_id: createNullProtoMap(),
      reconciled_rows_by_turn_id: createNullProtoMap(),
      pending_reconciliation_by_turn_id: createNullProtoMap(),
      // DC1 flicker cure (chat_timeline_deterministic_row_id): when opted in,
      // each row-builder stamps a deterministic identity-tuple row_id at its
      // tail (via deriveDeterministicRowId). Default false => row_id stays
      // `row:${event_id}` and every downstream projection is byte-identical.
      deterministic_row_id: Boolean(options && options.deterministicRowId === true),
    };
  }

  // Stamp the row's deterministic row_id when the turn's state opted in. The
  // stamp reads the tuple fields the builder just assigned; it is stable across
  // later mutations of the same row (the reducer looks rows up by phase_id /
  // tool_call_id / message id, never by row_id, so re-stamping is unnecessary).
  function stampRowIdentity(turn, row) {
    const enabled = turn && turn.deterministic_row_id === true;
    stampDeterministicRowId(row, enabled);
    if (!enabled) {
      return row;
    }
    const baseId = deriveDeterministicRowId(row, row && row.row_id);
    const counts = turn.deterministic_row_id_counts_by_base;
    const priorCount = Number(counts[baseId] || 0);
    row.row_id = priorCount === 0 ? baseId : `${baseId}#${priorCount}`;
    counts[baseId] = priorCount + 1;
    return row;
  }

  const {
    createToolCallRow,
    createToolResultRow,
    populateToolResultRow,
    updateToolRowState,
  } = toolRowBuildersFactory.createTurnToolRowBuilders({
    buildBaseRow,
    normalizeId,
    pushDistinct,
    stampRowIdentity,
    normalizeGeneratedArtifact,
    deepCloneJsonValue,
    normalizeToolStatus,
  });

  const {
    applyCanonicalRowEvent,
    sealTurnRows,
  } = canonicalRowBuildersFactory.createTurnCanonicalRowBuilders({
    buildBaseRow,
    ensureRowEvent,
    stampRowIdentity,
    normalizeId,
    pushDistinct,
    deepCloneJsonValue,
    normalizeToolStatus,
    resolveTerminalPresentation,
  });

  function ensureTurnState(state, turnId, event) {
    const normalizedTurnId = normalizeId(turnId || event && event.turn_id);
    if (!normalizedTurnId) {
      return null;
    }
    if (!state.turns_by_id[normalizedTurnId]) {
      state.turns_by_id[normalizedTurnId] = {
        turn_id: normalizedTurnId,
        // Carried from state so the row-builders (which receive `turn`, not
        // `state`) can stamp deterministic row_ids. See stampRowIdentity.
        deterministic_row_id: state.deterministic_row_id === true,
        deterministic_row_id_counts_by_base: createNullProtoMap(),
        /* Wall-clock anchor stamped ONCE at turn creation (this block runs only on first sight of
           the turn). The Active Turn V2 deck's elapsed timer reads it via resolveTurnStartedAt;
           without a start carried on the turn the deck had nothing to measure from once the
           send-time preflight was torn down on the first stream event. */
        started_at_ms: Date.now(),
        primary_user_message_id: normalizeId(event && event.primary_user_message_id),
        primary_assistant_message_id: normalizeId(event && event.primary_assistant_message_id),
        source_message_ids: [],
        rows: [],
        // Phase 2 follow-up: retain the raw event stream so live consumers
        // (for example Phase 3 lifecycle grammar derivation) can build a
        // canonical view-model before hydrated reconciliation lands. The
        // projector/reducer still own row production; events[] is additive.
        events: [],
        seen_event_ids: new Set(),
        reasoning_edit_mismatches: 0,
        ignored_terminal_event_count: 0,
        last_ignored_terminal_reason: '',
        next_sort_ordinal: 0,
        next_assistant_segment_index: 0,
        last_tool_position: 0,
        // Count of tool_call rows currently in the transient 'approved' state, so
        // abandonApprovedToolRows can early-return without an O(rows) scan on the
        // common path (every assistant_text_segment / reasoning delta). Finding #12.
        approved_tool_row_count: 0,
        active_assistant_message_id: normalizeId(event && event.primary_assistant_message_id),
        assistant_row_index_by_message_id: createNullProtoMap(),
        reasoning_row_index_by_phase_id: createNullProtoMap(),
        retained_reasoning_event_by_phase_id: createNullProtoMap(),
        tool_row_index_by_call_id: createNullProtoMap(),
        // Trace-mode parity (D1): the result emits its own tool_result row,
        // keyed by call id alongside the tool_call row above, so live
        // provisional rows reconcile against the hydrated trace projection
        // without leaving stale rows.
        tool_result_row_index_by_call_id: createNullProtoMap(),
        // Awaiting-approval parity: the streaming reducer emits a standalone
        // approval_gap row (the Allow/Deny block) keyed by call id, mirroring
        // the hydrated projector (renderer-turn-row-projector.js buildApprovalGapRow).
        // Without it the live timeline shows "Awaiting approval" status but no
        // approval buttons, soft-locking the turn.
        approval_gap_row_index_by_call_id: createNullProtoMap(),
      };
    }
    const turn = state.turns_by_id[normalizedTurnId];
    if (!turn.primary_user_message_id && event && event.primary_user_message_id) {
      turn.primary_user_message_id = normalizeId(event.primary_user_message_id);
    }
    if (!turn.primary_assistant_message_id && event && event.primary_assistant_message_id) {
      turn.primary_assistant_message_id = normalizeId(event.primary_assistant_message_id);
    }
    pushDistinct(turn.source_message_ids, turn.primary_user_message_id);
    pushDistinct(turn.source_message_ids, turn.primary_assistant_message_id);
    return turn;
  }

  // `attributeSourceIds: false` records that the row processed the event without
  // claiming the event's MESSAGES. Needed where one event legitimately touches two
  // rows: a tool_result settles the tool_call row's badge while its content and its
  // message id belong to the dedicated tool_result row.
  function ensureRowEvent(row, event, options) {
    const eventId = normalizeId(event && event.event_id);
    if ((!options || options.recordEventId !== false) && eventId && !row.source_events.includes(eventId)) {
      row.source_events.push(eventId);
    }
    if (!options || options.attributeSourceIds !== false) {
      appendSourceIds(row, event);
    }
  }

  function createAssistantTextRow(turn, event, assistantMessageId) {
    const row = buildBaseRow('assistant_text', turn.turn_id, event);
    row.primary_message_id = normalizeId(assistantMessageId || row.primary_message_id);
    row.assistant_phase = normalizeId(event && event.assistant_phase) || 'final_answer';
    // The segment group index IS this row's identity: deriveDeterministicRowId
    // mints row:assistant_text:<turn>:<index> from it, so two rows sharing an
    // index collide and get papered over with a `#1` suffix instead of being
    // distinct rows.
    //
    // next_assistant_segment_index alone is not enough. It is advanced by
    // maybeAdvanceAssistantSegment, which reads next_assistant_message_id -- a
    // LIVE-stream field that canonical turn events do not carry. Replaying a
    // canonical turn therefore left every assistant row at index 0. Counting the
    // turn's SURVIVING assistant rows covers that and cannot disturb the live
    // path, because it measures the very quantity applyStreamResetToTurnRows
    // restates the counter to, and the live counter advances once per new
    // assistant row -- so it is never below this count.
    //
    // `discarded` rows are excluded for that same reason: a reset tombstones the
    // pre-reset row IN PLACE rather than removing it, and the row replacing it
    // takes the index the tombstone gave up, which is what the hydrated projector
    // counts because the discarded segment was never persisted.
    let survivingTextRowCount = 0;
    for (let index = 0; index < turn.rows.length; index += 1) {
      const existing = turn.rows[index];
      if (existing && existing.kind === 'assistant_text' && existing.discarded !== true) {
        survivingTextRowCount += 1;
      }
    }
    row.segment_group_index = Math.max(Number(turn.next_assistant_segment_index) || 0, survivingTextRowCount);
    row.payload = {
      assistant_phase: row.assistant_phase,
      text: '',
      segments: [],
      segment_group_index: row.segment_group_index,
      truncated: false,
    };
    turn.assistant_row_index_by_message_id[row.primary_message_id] = turn.rows.length;
    turn.rows.push(row);
    if (!turn.primary_assistant_message_id) {
      turn.primary_assistant_message_id = row.primary_message_id;
    }
    turn.active_assistant_message_id = row.primary_message_id;
    pushDistinct(turn.source_message_ids, row.primary_message_id);
    return stampRowIdentity(turn, row);
  }

  // Reasoning timing (Ollama "Thought for Xs"): earliest start wins, latest
  // completion wins. Conditional so phases without timestamps keep today's
  // payload shape and live reducer tests stay unaffected.
  function applyReasoningTimingToPayload(payload, event) {
    if (!payload || !event) return;
    const startedAt = normalizeId(
      event.started_at || event.startedAt
      || (event.payload && (event.payload.started_at || event.payload.startedAt))
    );
    if (startedAt && !payload.started_at) {
      payload.started_at = startedAt;
    }
    const completedAt = normalizeId(
      event.completed_at || event.completedAt
      || (event.payload && (event.payload.completed_at || event.payload.completedAt))
    );
    if (completedAt) {
      payload.completed_at = completedAt;
    }
  }

  function createReasoningRow(turn, event, assistantMessageId) {
    const row = buildBaseRow('reasoning', turn.turn_id, event);
    row.primary_message_id = normalizeId(assistantMessageId || row.primary_message_id);
    row.phase_id = normalizeId(event && event.phase_id);
    const phase = mergePhaseMetadata(
      event && event.payload && event.payload.phase,
      {
        phase_id: row.phase_id,
        phase_kind: event && event.payload && event.payload.phase_kind,
        thinking_id: event && event.payload && event.payload.thinking_id,
        tool_call_id: event && event.tool_call_id || event && event.payload && event.payload.tool_call_id,
        tool_name: event && event.payload && event.payload.tool_name,
        summary: event && event.payload && event.payload.summary,
        iteration: event && event.payload && event.payload.iteration,
      }
    );
    row.payload = {
      phase_id: row.phase_id,
      thinking_id: normalizeId(event && event.payload && event.payload.thinking_id),
      tool_call_id: normalizeId(event && event.tool_call_id || event && event.payload && event.payload.tool_call_id),
      tool_name: normalizeId(event && event.payload && event.payload.tool_name),
      summary: normalizePhaseSummary(event && event.payload && event.payload.summary),
      render_collapsed: Boolean(event && event.payload && event.payload.render_collapsed),
      entries: [],
      truncated: false,
    };
    if (phase) {
      row.payload.phase = phase;
      row.payload.phase_id = row.payload.phase_id || phase.phase_id || '';
      row.payload.phase_kind = row.payload.phase_kind || phase.phase_kind || '';
      row.payload.thinking_id = row.payload.thinking_id || phase.thinking_id || '';
      row.payload.tool_call_id = row.payload.tool_call_id || phase.tool_call_id || '';
      row.payload.tool_name = row.payload.tool_name || phase.tool_name || '';
      row.payload.summary = row.payload.summary || phase.summary || '';
    }
    if (reasoningPhaseIsCompleted(event)) {
      row.payload.completed = true;
    }
    applyReasoningTimingToPayload(row.payload, event);
    turn.reasoning_row_index_by_phase_id[row.phase_id] = turn.rows.length;
    turn.rows.push(row);
    pushDistinct(turn.source_message_ids, row.primary_message_id);
    // thinking_id / phase_id are set above, so the deterministic reasoning
    // anchor (thinking_id || phase_id) is final at this point.
    return stampRowIdentity(turn, row);
  }

  function getAssistantTextRow(turn, event) {
    const messageId = normalizeId(event && event.primary_message_id) || turn.active_assistant_message_id;
    const rowIndex = turn.assistant_row_index_by_message_id[messageId];
    if (Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < turn.rows.length) {
      return turn.rows[rowIndex];
    }
    return createAssistantTextRow(turn, event, messageId);
  }

  function reasoningEventHasNoUnseenEntries(row, event) {
    const incomingEntries = event && event.payload && event.payload.entries;
    if (!Array.isArray(incomingEntries) || !incomingEntries.length) {
      // Unreachable from reasoning_phase today (the entryless case takes the
      // in-place update branch before getReasoningRow); kept because in-place
      // reuse is also the right answer if that early return ever moves.
      return true;
    }
    const seenIds = new Set(
      (Array.isArray(row && row.payload && row.payload.entries) ? row.payload.entries : [])
        .map((entry) => normalizeId(entry && entry.id))
        .filter(Boolean)
    );
    return incomingEntries.every((entry) => {
      const entryId = normalizeId(entry && entry.id);
      return Boolean(entryId) && seenIds.has(entryId);
    });
  }

  function getReasoningRow(turn, event) {
    const phaseId = normalizeId(event && event.phase_id);
    const rowIndex = phaseId ? turn.reasoning_row_index_by_phase_id[phaseId] : undefined;
    if (Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < turn.rows.length) {
      const row = turn.rows[rowIndex];
      // 2026-08-29: Non-tail fallthrough preserves projector parity when a
      // reused phase splits around another row. Real splits carry new entry
      // ids; same-id echoes instead update the existing row in place. That
      // discriminator leans on three backend producers staying as they are:
      // the collector's per-phase-identity dedupe (canonical-turn-event-
      // collector.js) keeps a pre-boundary echo out of the persisted log, its
      // retargetCapturedEvents generation bump is the only way a second
      // captured event opens for a phase id, and reasoningTailBreakPending
      // (chat-stream-managed-runtime-segments.js) forces a FRESH entry id at
      // that same segment boundary. If any of the three regresses, the
      // duplicate row returns on rehydration only.
      if (rowIndex === turn.rows.length - 1 || reasoningEventHasNoUnseenEntries(row, event)) {
        return row;
      }
    }
    return createReasoningRow(turn, event, normalizeId(event && event.primary_message_id) || turn.active_assistant_message_id);
  }

  function getToolCallRow(turn, event) {
    const toolCallId = normalizeId(event && event.tool_call_id);
    const rowIndex = toolCallId ? turn.tool_row_index_by_call_id[toolCallId] : undefined;
    if (Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < turn.rows.length) {
      return turn.rows[rowIndex];
    }
    return createToolCallRow(turn, event);
  }

  function getToolResultRow(turn, event) {
    const toolCallId = normalizeId(event && event.tool_call_id);
    const rowIndex = toolCallId ? turn.tool_result_row_index_by_call_id[toolCallId] : undefined;
    if (Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < turn.rows.length) {
      return turn.rows[rowIndex];
    }
    return createToolResultRow(turn, event);
  }

  function maybeAdvanceAssistantSegment(turn, event, options) {
    const nextAssistantId = normalizeId(event && event.next_assistant_message_id);
    if (!nextAssistantId) {
      return;
    }
    const currentAssistantId = normalizeId(turn.active_assistant_message_id);
    // On a stream_reset the reducer owns next_assistant_segment_index outright
    // (applyStreamResetToTurnRows restates it as the surviving-row count), so
    // the caller passes advanceSegmentIndex:false and this bump must not fight
    // it. Absent options => today's behaviour for every other event.
    if (
      (!options || options.advanceSegmentIndex !== false)
      && currentAssistantId
      && currentAssistantId !== nextAssistantId
    ) {
      turn.next_assistant_segment_index += 1;
    }
    turn.active_assistant_message_id = nextAssistantId;
    if (!turn.primary_assistant_message_id) {
      turn.primary_assistant_message_id = nextAssistantId;
    }
  }

  function markLatestAssistantRowsTruncated(turn) {
    for (let index = turn.rows.length - 1; index >= 0; index -= 1) {
      const row = turn.rows[index];
      if (!row || !row.payload || row.primary_message_id !== turn.active_assistant_message_id) {
        continue;
      }
      if (row.kind === 'assistant_text' || row.kind === 'reasoning') {
        row.payload.truncated = true;
      }
    }
  }

  function abandonApprovedToolRows(turn, activeToolCallId) {
    if (!turn || !Array.isArray(turn.rows)) {
      return;
    }
    // Early-out on the common path (no approved rows) so a streamed text /
    // reasoning chunk does not pay an O(rows) scan (finding #12). A non-numeric
    // count falls through to the scan so the optimization can never skip a real
    // approved row.
    if (turn.approved_tool_row_count === 0) {
      return;
    }
    const normalizedActiveToolCallId = normalizeId(activeToolCallId);
    for (let index = 0; index < turn.rows.length; index += 1) {
      const row = turn.rows[index];
      if (!row || row.kind !== 'tool_call' || !row.payload) {
        continue;
      }
      if (normalizeToolStatus(row.payload.state) !== 'approved') {
        continue;
      }
      if (normalizedActiveToolCallId && normalizeId(row.tool_call_id || row.payload.tool_call_id) === normalizedActiveToolCallId) {
        continue;
      }
      row.payload.state = 'abandoned';
      turn.approved_tool_row_count = Math.max(0, turn.approved_tool_row_count - 1);
    }
  }

  function applyTurnStreamEvent(state, event) {
    if (!state || !event || typeof event !== 'object') {
      return state;
    }
    if (Array.isArray(event)) {
      for (let index = 0; index < event.length; index += 1) {
        applyTurnStreamEvent(state, event[index]);
      }
      return state;
    }
    const turn = ensureTurnState(state, event.turn_id, event);
    if (!turn) {
      return state;
    }
    const eventId = normalizeId(event.event_id);
    const incomingTerminal = event.kind === 'complete' || event.kind === 'error';
    if (incomingTerminal && resolveTerminalPresentationIfTerminal(turn.status)) {
      turn.ignored_terminal_event_count += 1;
      turn.last_ignored_terminal_reason = eventId && turn.seen_event_ids.has(eventId) ? 'duplicate' : 'late';
      return state;
    }
    if (eventId && turn.seen_event_ids.has(eventId)) {
      return state;
    }
    if (eventId) {
      turn.seen_event_ids.add(eventId);
    }
    let reasoningEventCoalesced = false;
    let allEditsDropped = false;
    if (Array.isArray(turn.events)) {
      const body = event.payload && typeof event.payload === 'object' ? event.payload : {};
      let incomingEntries = Array.isArray(body.entries) ? body.entries : [];
      const phaseKey = normalizeId(event.phase_id || body.phase_id);
      const retained = turn.retained_reasoning_event_by_phase_id[phaseKey];
      if (event.kind === 'reasoning_phase' && incomingEntries.some(isReasoningEntryEdit)) {
        const rowIndex = turn.reasoning_row_index_by_phase_id[phaseKey];
        const row = Number.isInteger(rowIndex) ? turn.rows[rowIndex] : null;
        const baseEntries = retained
          ? retained.payload && retained.payload.entries
          : row && row.payload && row.payload.entries;
        const allEdits = incomingEntries.every(isReasoningEntryEdit);
        const resolved = resolveReasoningEntryEdits(incomingEntries, baseEntries, normalizeId);
        body.entries = resolved.entries;
        incomingEntries = resolved.entries;
        turn.reasoning_edit_mismatches += resolved.mismatches;
        // An all-dropped edit frame still carries phase metadata (summary,
        // tokens_per_second, timing): coalesce it like an entryless frame.
        allEditsDropped = allEdits && !incomingEntries.length;
      }
      // Live retention matches the persisted canonical shape: one reasoning_phase per
      // run holds the latest snapshot, preserving projectTurnRows parity without historical copies.
      if (
        event.kind === 'reasoning_phase'
        && (incomingEntries.length || allEditsDropped)
        && retained
        && retained.primary_message_id === normalizeId(event.primary_message_id)
        && retained === turn.events[turn.events.length - 1]
        && reasoningEventHasNoUnseenEntries(retained, event)
      ) {
        const incomingById = new Map(incomingEntries.map((entry) => [normalizeId(entry && entry.id), entry]));
        const retainedIds = new Set();
        retained.payload.entries = retained.payload.entries
          .filter((entry) => {
            const entryId = normalizeId(entry && entry.id);
            if (entryId && retainedIds.has(entryId)) return false;
            retainedIds.add(entryId);
            return true;
          })
          .map((entry) => incomingById.get(normalizeId(entry && entry.id)) || entry);
        const incomingChunkCount = Number(body.chunk_count);
        if (Number.isFinite(incomingChunkCount) && incomingChunkCount > 0) {
          retained.payload.chunk_count = (Number(retained.payload.chunk_count) || 0) + incomingChunkCount;
        }
        for (const key of ['summary', 'thinking_id']) {
          if (normalizeId(body[key])) retained.payload[key] = body[key];
        }
        // Fill-if-empty / sticky fields mirror buildReasoningRow so projecting the
        // retained event yields the row the per-frame events would have built.
        for (const key of ['tool_call_id', 'tool_name', 'started_at']) {
          if (!normalizeId(retained.payload[key]) && normalizeId(body[key])) retained.payload[key] = body[key];
        }
        if (!normalizeId(retained.started_at) && normalizeId(event.started_at)) retained.started_at = event.started_at;
        for (const id of Array.isArray(event.source_message_ids) ? event.source_message_ids : []) {
          if (normalizeId(id)) pushDistinct(retained.source_message_ids, id);
        }
        if (body.tokens_per_second != null && body.tokens_per_second !== '') retained.payload.tokens_per_second = body.tokens_per_second;
        if (body.phase && typeof body.phase === 'object' && Object.keys(body.phase).length) retained.payload.phase = body.phase;
        if (body.render_collapsed === true) retained.payload.render_collapsed = true;
        if (body.completed === true) retained.payload.completed = true;
        if (normalizeId(event.status) && !reasoningPhaseIsCompleted(retained)) retained.status = event.status;
        if (normalizeId(event.completed_at)) retained.completed_at = event.completed_at;
        reasoningEventCoalesced = true;
      } else {
        turn.events.push(event);
        if (event.kind === 'reasoning_phase' && incomingEntries.length) {
          turn.retained_reasoning_event_by_phase_id[phaseKey] = event;
        }
      }
    }
    state.active_turn_id = turn.turn_id;
    if (event.kind === 'stream_reset') {
      if (normalizeId(event.primary_message_id)) {
        turn.active_assistant_message_id = normalizeId(event.primary_message_id);
      }
      // tool_continuation resets preserve genuine pre-tool commentary — no
      // "restarted" stamp; every other/absent reason discards (EH-W5 marker).
      // The one addition: with response_loop_display_v2 OFF main discards the
      // commentary under that same reason (discard_scope 'all'), and text main
      // erased has to carry the marker.
      const resetDiscardScope = resolveStreamResetDiscardScope(event);
      if (normalizeId(event.reason) !== 'tool_continuation' || resetDiscardScope === 'all') {
        markLatestAssistantRowsTruncated(turn);
      }
      applyStreamResetToTurnRows(turn, {
        scope: resetDiscardScope,
        // The OUTGOING id: the reset event's primary_message_id (latched just
        // above) still names the slice the pre-reset deltas were keyed by.
        activeAssistantMessageId: turn.active_assistant_message_id,
        deterministicRowId: turn.deterministic_row_id === true,
      });
      maybeAdvanceAssistantSegment(turn, event, { advanceSegmentIndex: false });
      return state;
    }
    maybeAdvanceAssistantSegment(turn, event);
    if (
      (event.kind === 'assistant_text_segment' || event.kind === 'reasoning_phase')
      && normalizeId(event.primary_message_id)
    ) {
      turn.active_assistant_message_id = normalizeId(event.primary_message_id);
      if (!turn.primary_assistant_message_id) {
        turn.primary_assistant_message_id = turn.active_assistant_message_id;
      }
    }
    if (event.kind === 'started') {
      return state;
    }

    if (applyCanonicalRowEvent(turn, event)) {
      return state;
    }
    if (event.kind === 'complete' || event.kind === 'error') {
      // Record the canonical terminal status because the live reducer emits no terminal row; preserve cancelled separately from genuine errors.
      turn.status = resolveTerminalPresentation(event.terminal_status, { fallbackStatus: event.kind }).status;
      return state;
    }
    if (event.kind === 'assistant_text_segment') {
      abandonApprovedToolRows(turn);
      const row = getAssistantTextRow(turn, event);
      ensureRowEvent(row, event);
      row.assistant_phase = normalizeId(event.assistant_phase) || row.assistant_phase || 'final_answer';
      row.payload.assistant_phase = row.assistant_phase;
      const text = String(event.payload && event.payload.text || '');
      if (text) {
        row.payload.text += text;
      }
      const segmentPhase = normalizePhaseMetadata(event.payload && event.payload.phase);
      row.payload.segments.push({
        segment_id: normalizeId(event.payload && event.payload.segment_id),
        phase_id: normalizeId(event.payload && event.payload.phase_id),
        ...(segmentPhase ? { phase: segmentPhase } : {}),
        text,
        message_index: Number(event.payload && event.payload.message_index) || 0,
        segment_index: Number(event.payload && event.payload.segment_index) || 0,
      });
      pushDistinct(turn.source_message_ids, row.primary_message_id);
      return state;
    }
    if (event.kind === 'reasoning_phase') {
      const body = event.payload && typeof event.payload === 'object' ? event.payload : {};
      if (!Array.isArray(body.entries) || !body.entries.length) {
        const phaseSummary = normalizePhaseSummary(body.summary);
        const phaseId = normalizeId(event.phase_id || body.phase_id);
        const rowIndex = phaseId ? turn.reasoning_row_index_by_phase_id[phaseId] : undefined;
        if (Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < turn.rows.length) {
          const row = turn.rows[rowIndex];
          if (row && row.kind === 'reasoning' && row.payload) {
            ensureRowEvent(row, event, { recordEventId: !reasoningEventCoalesced });
            if (phaseSummary) {
              row.payload.summary = phaseSummary;
            }
            row.payload.render_collapsed = row.payload.render_collapsed || Boolean(body.render_collapsed);
            if (reasoningPhaseIsCompleted(event)) {
              row.payload.completed = true;
            }
            applyReasoningTimingToPayload(row.payload, event);
          }
        }
        return state;
      }
      abandonApprovedToolRows(turn);
      const row = getReasoningRow(turn, event);
      const reusingNonTailRow = row !== turn.rows[turn.rows.length - 1];
      ensureRowEvent(row, event, { recordEventId: !reasoningEventCoalesced });
      row.payload.phase_id = row.payload.phase_id || normalizeId(event.phase_id);
      row.payload.thinking_id = row.payload.thinking_id || normalizeId(body.thinking_id);
      row.payload.tool_call_id = row.payload.tool_call_id || normalizeId(body.tool_call_id);
      row.payload.tool_name = row.payload.tool_name || normalizeId(body.tool_name);
      const phase = mergePhaseMetadata(body.phase, {
        phase_id: event.phase_id || body.phase_id,
        phase_kind: body.phase_kind,
        thinking_id: body.thinking_id,
        tool_call_id: body.tool_call_id,
        tool_name: body.tool_name,
        summary: body.summary,
        iteration: body.iteration,
      });
      if (phase) {
        row.payload.phase = phase;
        row.payload.phase_id = row.payload.phase_id || phase.phase_id || '';
        row.payload.phase_kind = row.payload.phase_kind || phase.phase_kind || '';
        row.payload.thinking_id = row.payload.thinking_id || phase.thinking_id || '';
        row.payload.tool_call_id = row.payload.tool_call_id || phase.tool_call_id || '';
        row.payload.tool_name = row.payload.tool_name || phase.tool_name || '';
      }
      const phaseSummary = normalizePhaseSummary(body.summary);
      if (phaseSummary) {
        row.payload.summary = phaseSummary;
      }
      row.payload.render_collapsed = row.payload.render_collapsed || Boolean(body.render_collapsed);
      if (reasoningPhaseIsCompleted(event)) {
        row.payload.completed = true;
      }
      applyReasoningTimingToPayload(row.payload, event);
      mergeReasoningEntriesIntoPayload(row.payload, body.entries);
      // Renders as "Thinking... (N chunks)" when the thinking widget has nothing to
      // show (renderer-turn-row-render-utils.js). Only the hydrated projector was
      // producing it, so a delegated hydration would have silently dropped the
      // count. Reported chunk counts accumulate across the phase's events and fall
      // back to the entry count, matching buildReasoningRow; the running sum hangs
      // off a Symbol so it stays out of every payload comparison.
      const reportedChunks = Number(body.chunk_count);
      if (!reusingNonTailRow && Number.isFinite(reportedChunks) && reportedChunks > 0) {
        row.payload[REASONING_CHUNK_SUM] = (Number(row.payload[REASONING_CHUNK_SUM]) || 0) + reportedChunks;
      }
      row.payload.chunk_count = Number(row.payload[REASONING_CHUNK_SUM]) || row.payload.entries.length;
      pushDistinct(turn.source_message_ids, row.primary_message_id);
      return state;
    }
    if (
      event.kind === 'tool_use'
      || event.kind === 'approval_requested'
      || event.kind === 'user_questions_requested'
      || event.kind === 'approval_resolved'
      || event.kind === 'tool_executing'
      || event.kind === 'tool_result'
    ) {
      abandonApprovedToolRows(turn, event.tool_call_id);
      const toolRowCallId = normalizeId(event.tool_call_id);
      if (event.kind === 'tool_result') {
        // Trace parity (D1): the result is its own tool_result row. The
        // existing tool_call row (if any) reconciles to a terminal state so
        // its live badge flips to completed/errored, but the result CONTENT
        // lives on the dedicated tool_result row — mirroring the trace
        // projector's two-row split.
        const callRowIndex = toolRowCallId ? turn.tool_row_index_by_call_id[toolRowCallId] : undefined;
        if (Number.isInteger(callRowIndex) && callRowIndex >= 0 && callRowIndex < turn.rows.length) {
          const callRow = turn.rows[callRowIndex];
          // Badge only, no attribution. Merging the result's message id here put
          // BOTH ids on BOTH rows, which makes the
          // [data-source-message-ids~=<id>] row lookup in renderer-turn-shell.js
          // ambiguous while streaming and precise only after a reload -- the
          // divergence the Wave 2 render ledger found and resolved in the hydrated
          // projector's favour. The two-row split this branch already documents
          // only actually holds if the attribution splits too.
          ensureRowEvent(callRow, event, { attributeSourceIds: false });
          const wasApproved = normalizeToolStatus(callRow.payload && callRow.payload.state) === 'approved';
          updateToolRowState(callRow, event);
          const isApproved = normalizeToolStatus(callRow.payload && callRow.payload.state) === 'approved';
          if (wasApproved !== isApproved) {
            turn.approved_tool_row_count = Math.max(0, (turn.approved_tool_row_count || 0) + (isApproved ? 1 : -1));
          }
          turn.last_tool_position = callRowIndex;
        }
        const resultRow = getToolResultRow(turn, event);
        ensureRowEvent(resultRow, event);
        populateToolResultRow(resultRow, event);
        pushDistinct(turn.source_message_ids, resultRow.primary_message_id);
        // A result settles the call — the approval prompt (if any) is moot.
        removeApprovalGapRow(turn, toolRowCallId);
        return state;
      }
      const row = getToolCallRow(turn, event);
      ensureRowEvent(row, event);
      const wasApproved = normalizeToolStatus(row.payload && row.payload.state) === 'approved';
      updateToolRowState(row, event);
      if (event.kind === 'user_questions_requested') {
        const body = event.payload && typeof event.payload === 'object' ? event.payload : {};
        row.payload.state = 'pending_user_input';
        row.payload.question_ref = normalizeId(body.question_ref);
        row.payload.user_questions = Array.isArray(body.questions) ? deepCloneJsonValue(body.questions) : [];
        row.payload.tool_name = row.payload.tool_name || normalizeId(body.tool_name);
      }
      const isApproved = normalizeToolStatus(row.payload && row.payload.state) === 'approved';
      if (wasApproved !== isApproved) {
        turn.approved_tool_row_count = Math.max(0, (turn.approved_tool_row_count || 0) + (isApproved ? 1 : -1));
      }
      // Surface (or retract) the standalone Allow/Deny block as the call enters
      // and leaves awaiting_approval. Runs before last_tool_position so any
      // splice-driven index repair is already reflected below.
      syncApprovalGapRow(turn, event, row);
      // The tool row's index is already tracked; avoid the O(rows) indexOf scan
      // on every tool event (finding #12).
      const knownToolRowIndex = turn.tool_row_index_by_call_id[toolRowCallId];
      turn.last_tool_position = Number.isInteger(knownToolRowIndex)
        ? knownToolRowIndex
        : turn.rows.indexOf(row);
      pushDistinct(turn.source_message_ids, row.primary_message_id);
      return state;
    }
    return state;
  }

  return {
    buildTurnEventFromStreamPayload,
    createTurnReducerState,
    applyTurnStreamEvent,
    sealTurnRows,
    // Row identity + reconcile are re-exported from the shared
    // renderer-row-identity-utils module so existing importers
    // (reducer-wiring, the corpus/parity tests) keep one import point.
    reconcileTurnRows,
    buildRowIdentityKey,
    deriveDeterministicRowId,
  };
});
