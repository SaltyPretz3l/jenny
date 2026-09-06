const { projectTurnTree } = require('../../renderer/chat/renderer-turn-tree-projector');
const {
  TURN_EVENT_LOG_VERSION,
  persistDurableTurnEvents,
} = require('./session-turn-events');
const {
  createPromotedObservationQueue,
  mergePromotedObservationsIntoTurnEvents,
} = require('./tool-observation-promotion');
const { normalizeSourceCitations } = require('./tool-result-source-metadata');
const {
  cloneJsonValue,
  normalizeId,
  sanitizePathFieldsInPayload,
  normalizeStreamEnvelopeMetadata,
  attachStreamEnvelopeMetadata,
} = require('./canonical-turn-event-normalization');
const {
  TOOL_RELATED_KINDS,
  LIVE_CAPTURED_KINDS,
  buildMessageIndex,
  buildPersistedTurnEvent,
  buildCapturedTurnEventForStorage,
  settleCapturedReasoningFromProjection,
  reasoningPhaseIdentity,
  buildCaptureDedupeKey,
  mergeReasoningEntriesById,
  assistantTextPayloadHasUsableText,
  normalizeCanonicalTurnEventForCapture,
} = require('./canonical-turn-event-collector-normalize');

class CanonicalTurnEventCollector {
  constructor({
    store,
    logger = null,
    turnId = '',
    sessionId = '',
    journal = null,
    canonicalPrimary = false,
    featureFlags = null,
  } = {}) {
    this.store = store;
    this.logger = typeof logger === 'function' ? logger : null;
    this.turnId = normalizeId(turnId);
    this.sessionId = normalizeId(sessionId);
    this.journal = journal;
    this.canonicalPrimary = canonicalPrimary === true;
    // Snapshot of the service feature flags at construction (per-turn
    // collector lifetime). Only `source_citations` is consulted today.
    this.featureFlags = featureFlags && typeof featureFlags === 'object' ? featureFlags : null;
    this.capturedEvents = [];
    this.promotedObservationQueue = createPromotedObservationQueue({ turnId: this.turnId });
    this.eventOrdinalsByKind = Object.create(null);
    this.capturedByDedupeKey = new Map();
    this.captureOrdinal = 0;
    // Reasoning phase identities are only stable WITHIN one segment slice: the
    // sidecar restarts iteration numbering when a tool loop resumes after an
    // approval, so a later slice can legally REUSE an earlier slice's
    // phase_id/thinking_id (phase_reasoning_<req>_iter1_1 twice in one turn —
    // the 2026-07-06 reasoning mis-retargeting RCA). Once a slice's events are
    // retargeted onto their persisted segment they are sealed: a reused
    // identity coalesces into a NEW captured event (generation-suffixed dedupe
    // key) instead of merging into — and re-retargeting — the sealed one.
    this.sealedRetargetedEvents = new Set();
    this.reasoningPhaseGenerations = new Map();
    // Reasoning events buffer as captured-event REFERENCES and serialize at
    // flush time, so per-delta coalescing updates the queued event in place
    // instead of journaling one row per chunk.
    this.pendingJournalEvents = [];
    this.pendingJournalEventRefs = new Set();
  }

  flushJournalEvents() {
    if (
      !this.journal
      || !this.sessionId
      || typeof this.journal.append !== 'function'
      || !this.pendingJournalEvents.length
    ) {
      return 0;
    }
    const groups = new Map();
    for (const entry of this.pendingJournalEvents) {
      const turnId = normalizeId(entry.turnId);
      if (!turnId) {
        continue;
      }
      const bucket = groups.get(turnId) || [];
      bucket.push(buildCapturedTurnEventForStorage(entry.captured));
      groups.set(turnId, bucket);
    }
    this.pendingJournalEvents = [];
    this.pendingJournalEventRefs = new Set();
    let flushed = 0;
    for (const [turnId, events] of groups.entries()) {
      if (!events.length) {
        continue;
      }
      this.journal.append(this.sessionId, turnId, events);
      flushed += events.length;
    }
    return flushed;
  }

  noteEvent(event, options = {}) {
    const rawSource = event && typeof event === 'object' && !Array.isArray(event) ? event : {};
    const prevalidated = options && typeof options === 'object' ? options.validation : null;
    const canonicalSource = Object.prototype.hasOwnProperty.call(rawSource, 'v')
      || Object.prototype.hasOwnProperty.call(rawSource, 'type')
      ? normalizeCanonicalTurnEventForCapture(rawSource, this.logger, prevalidated)
      : null;
    if ((Object.prototype.hasOwnProperty.call(rawSource, 'v')
      || Object.prototype.hasOwnProperty.call(rawSource, 'type')) && canonicalSource == null) {
      return null;
    }
    const source = canonicalSource || rawSource;
    const turnId = normalizeId(source.turn_id || source.turnId || this.turnId);
    const kind = normalizeId(source.kind);
    if (!turnId || !kind) {
      return null;
    }
    const toolCallId = normalizeId(source.tool_call_id || source.toolCallId);
    let dedupeKey = buildCaptureDedupeKey(source, kind, turnId, toolCallId);
    if (kind === 'reasoning_phase') {
      const phaseIdentity = reasoningPhaseIdentity(source, kind);
      const generation = phaseIdentity
        ? Number(this.reasoningPhaseGenerations.get(`${turnId}:${phaseIdentity}`) || 0)
        : 0;
      if (generation > 0) {
        dedupeKey = `${dedupeKey}:gen${generation}`;
      }
    }
    if (this.capturedByDedupeKey.has(dedupeKey)) {
      const existing = this.capturedByDedupeKey.get(dedupeKey);
      if (kind === 'reasoning_phase' && existing) {
        this._coalesceReasoningEvent(existing, source);
      }
      return existing;
    }
    const ordinal = Number(this.eventOrdinalsByKind[kind] || 0);
    this.eventOrdinalsByKind[kind] = ordinal + 1;
    const payload = sanitizePathFieldsInPayload(cloneJsonValue(
      source.payload && typeof source.payload === 'object' && !Array.isArray(source.payload)
        ? source.payload
        : {}
    ));
    if (kind === 'tool_result' && Array.isArray(payload.generated_artifacts)) {
      payload.generated_artifacts = payload.generated_artifacts.map((artifact) => ({
        ...artifact,
        tool_call_id: normalizeId(artifact?.tool_call_id || artifact?.toolCallId || toolCallId),
      }));
    }
    attachStreamEnvelopeMetadata(payload, source.stream_envelope);
    const capturedEvent = {
      event_id: normalizeId(source.event_id || source.eventId) || `${turnId}:${kind}:${ordinal}`,
      turn_id: turnId,
      kind,
      status: normalizeId(source.status),
      primary_message_id: normalizeId(source.primary_message_id || source.primaryMessageId),
      source_message_ids: Array.isArray(source.source_message_ids || source.sourceMessageIds)
        ? (source.source_message_ids || source.sourceMessageIds).map((value) => normalizeId(value)).filter(Boolean)
        : [],
      target_message_id: normalizeId(source.target_message_id || source.targetMessageId),
      tool_call_id: toolCallId,
      segment_group_index: source.segment_group_index ?? null,
      phase_id: normalizeId(source.phase_id || source.phaseId),
      started_at: normalizeId(source.started_at || source.startedAt),
      completed_at: normalizeId(source.completed_at || source.completedAt),
      payload,
      _capture_order: this.captureOrdinal,
    };
    this.captureOrdinal += 1;
    this.capturedEvents.push(capturedEvent);
    this.capturedByDedupeKey.set(dedupeKey, capturedEvent);
    if (this.journal && this.sessionId && typeof this.journal.append === 'function') {
      if (kind === 'reasoning_phase') {
        this.pendingJournalEvents.push({ turnId, captured: capturedEvent });
        this.pendingJournalEventRefs.add(capturedEvent);
      } else {
        this.flushJournalEvents();
        this.journal.append(this.sessionId, turnId, [
          buildCapturedTurnEventForStorage(capturedEvent),
        ]);
      }
    }
    this._maybeDeriveSourceCitations(capturedEvent);
    return capturedEvent;
  }

  // Citations: derive the persisted `source_citations` kind from a tool_result
  // payload that carries `citations`/`sources` (web_search today; the future
  // knowledge_* tools return the same shape). Flag-gated (`source_citations`,
  // default-off) so flag-off turn_events[] stay byte-identical. The derived
  // event re-enters noteEvent with a deterministic event_id, so repeats
  // dedupe and journaling/capture-order placement (right after the producing
  // tool_result) come for free. Normalization is the bounded untrusted-input
  // chokepoint in tool-result-source-metadata.js.
  _maybeDeriveSourceCitations(capturedEvent) {
    if (this.featureFlags?.source_citations !== true) {
      return;
    }
    if (!capturedEvent || normalizeId(capturedEvent.kind) !== 'tool_result') {
      return;
    }
    const normalized = normalizeSourceCitations(capturedEvent.payload);
    if (!normalized || !Array.isArray(normalized.refs) || !normalized.refs.length) {
      return;
    }
    const turnId = normalizeId(capturedEvent.turn_id);
    const toolCallId = normalizeId(capturedEvent.tool_call_id);
    this.noteEvent({
      event_id: `${turnId}:source_citations:${toolCallId || 'orphan'}`,
      turn_id: turnId,
      kind: 'source_citations',
      tool_call_id: toolCallId,
      primary_message_id: normalizeId(capturedEvent.primary_message_id),
      source_message_ids: Array.isArray(capturedEvent.source_message_ids)
        ? capturedEvent.source_message_ids
        : [],
      payload: {
        refs: normalized.refs,
        truncated: normalized.truncated === true,
        ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      },
    });
  }

  // Per-phase coalescing for streamed reasoning: each delta arrives as a
  // snapshot event for the same phase, so the captured event is updated in
  // place — entries merged by id (latest snapshot wins, matching the renderer
  // projector), chunk counts accumulated, scalar metadata latest-wins.
  _coalesceReasoningEvent(existing, source) {
    const incoming = sanitizePathFieldsInPayload(cloneJsonValue(
      source.payload && typeof source.payload === 'object' && !Array.isArray(source.payload)
        ? source.payload
        : {}
    ));
    const payload = existing.payload && typeof existing.payload === 'object' && !Array.isArray(existing.payload)
      ? existing.payload
      : (existing.payload = {});
    if (Array.isArray(incoming.entries) && incoming.entries.length) {
      payload.entries = mergeReasoningEntriesById(payload.entries, incoming.entries);
    }
    const incomingChunkCount = Number(incoming.chunk_count);
    if (Number.isFinite(incomingChunkCount) && incomingChunkCount > 0) {
      payload.chunk_count = (Number(payload.chunk_count) || 0) + incomingChunkCount;
    }
    for (const key of ['phase_id', 'phase_kind', 'thinking_id', 'summary', 'text']) {
      if (typeof incoming[key] === 'string' && incoming[key]) {
        payload[key] = incoming[key];
      }
    }
    if (incoming.tokens_per_second != null) {
      payload.tokens_per_second = incoming.tokens_per_second;
    }
    if (incoming.render_collapsed === true) {
      payload.render_collapsed = true;
    }
    if (incoming.completed === true) {
      payload.completed = true;
    }
    const streamEnvelope = normalizeStreamEnvelopeMetadata(source.stream_envelope);
    if (streamEnvelope) {
      payload.stream_envelope = streamEnvelope;
    }
    const status = normalizeId(source.status);
    if (status) {
      existing.status = status;
    }
    const completedAt = normalizeId(source.completed_at || source.completedAt);
    if (completedAt) {
      existing.completed_at = completedAt;
    }
    if (!existing.started_at) {
      existing.started_at = normalizeId(source.started_at || source.startedAt);
    }
    if (!existing.phase_id) {
      existing.phase_id = normalizeId(source.phase_id || source.phaseId || incoming.phase_id);
    }
    if (!existing.primary_message_id) {
      existing.primary_message_id = normalizeId(source.primary_message_id || source.primaryMessageId);
    }
    if (!existing.source_message_ids.length) {
      existing.source_message_ids = Array.isArray(source.source_message_ids || source.sourceMessageIds)
        ? (source.source_message_ids || source.sourceMessageIds).map((value) => normalizeId(value)).filter(Boolean)
        : [];
    }
    if (
      this.journal
      && this.sessionId
      && typeof this.journal.append === 'function'
      && !this.pendingJournalEventRefs.has(existing)
    ) {
      this.pendingJournalEvents.push({ turnId: existing.turn_id, captured: existing });
      this.pendingJournalEventRefs.add(existing);
    }
    return existing;
  }

  // Recording-layer retarget: reasoning streams before the segment message it
  // will land in exists, so live capture initially points at the synthetic
  // base assistant id. At segment-persist time the runtime calls this with the
  // slice's reasoning phase ids so the captured events reference the REAL
  // persisted message and the timeline projection can claim it.
  retargetCapturedEvents(turnId, { phaseIds = [], messageId = '' } = {}) {
    const normalizedTurnId = normalizeId(turnId);
    const targetId = normalizeId(messageId);
    const phaseIdSet = new Set(
      (Array.isArray(phaseIds) ? phaseIds : []).map((value) => normalizeId(value)).filter(Boolean)
    );
    if (!normalizedTurnId || !targetId || !phaseIdSet.size) {
      return 0;
    }
    let retargeted = 0;
    for (const event of this.capturedEvents) {
      if (normalizeId(event?.turn_id) !== normalizedTurnId) continue;
      if (normalizeId(event?.kind) !== 'reasoning_phase') continue;
      if (!phaseIdSet.has(normalizeId(event?.phase_id))) continue;
      // Sealed = already retargeted onto an earlier persisted segment. A later
      // slice reusing the same phase id must not steal it.
      if (this.sealedRetargetedEvents.has(event)) continue;
      this.sealedRetargetedEvents.add(event);
      if (normalizeId(event?.primary_message_id) === targetId) continue;
      event.primary_message_id = targetId;
      event.source_message_ids = [targetId];
      retargeted += 1;
    }
    // The slice's phase identities are consumed with the persisted segment:
    // bump their generation so a reused id opens a fresh captured event
    // instead of coalescing into the sealed one.
    for (const phaseId of phaseIdSet) {
      const generationKey = `${normalizedTurnId}:${phaseId}`;
      this.reasoningPhaseGenerations.set(
        generationKey,
        Number(this.reasoningPhaseGenerations.get(generationKey) || 0) + 1
      );
    }
    return retargeted;
  }

  // Destructive stream resets discard captured text/reasoning events. Terminal
  // replacement resets can scope that deletion to the active base-message
  // slice so earlier durable segment events survive. Tool events are untouched.
  discardCapturedEvents(turnId, kinds, { primaryMessageId = '' } = {}) {
    const normalizedTurnId = normalizeId(turnId);
    const normalizedPrimaryMessageId = normalizeId(primaryMessageId);
    const kindSet = new Set(
      (Array.isArray(kinds) ? kinds : []).map((value) => normalizeId(value)).filter(Boolean)
    );
    if (!normalizedTurnId || !kindSet.size) {
      return 0;
    }
    const shouldDiscard = (event) =>
      normalizeId(event?.turn_id) === normalizedTurnId
      && kindSet.has(normalizeId(event?.kind))
      && (
        !normalizedPrimaryMessageId
        || normalizeId(event?.primary_message_id) === normalizedPrimaryMessageId
      );
    const discarded = this.capturedEvents.filter(shouldDiscard);
    if (!discarded.length) {
      return 0;
    }
    const discardedSet = new Set(discarded);
    this.capturedEvents = this.capturedEvents.filter((event) => !discardedSet.has(event));
    for (const [key, event] of [...this.capturedByDedupeKey.entries()]) {
      if (discardedSet.has(event)) {
        this.capturedByDedupeKey.delete(key);
      }
    }
    this.pendingJournalEvents = this.pendingJournalEvents.filter(
      (entry) => !discardedSet.has(entry.captured)
    );
    for (const event of discarded) {
      this.pendingJournalEventRefs.delete(event);
      this.sealedRetargetedEvents.delete(event);
    }
    return discarded.length;
  }

  notePromotedObservation(promotion) {
    return this.promotedObservationQueue.note(promotion);
  }

  mergePromotedObservations(turnId, events) {
    const normalizedTurnId = normalizeId(turnId);
    const sourceEvents = Array.isArray(events) ? events : [];
    const promotions = this.promotedObservationQueue.forTurn(normalizedTurnId);
    if (!promotions.length) {
      return sourceEvents;
    }
    try {
      return mergePromotedObservationsIntoTurnEvents(sourceEvents, promotions, {
        logger: this.logger,
      });
    } catch (error) {
      if (this.logger) {
        this.logger('WARN', 'chat.turn_event_promotion_failed', {
          sessionId: this.sessionId,
          turnId: normalizedTurnId,
          message: String(error?.message || error),
        });
      }
      return sourceEvents;
    }
  }

  buildFinalizedTurnEvents(turnId, messages) {
    const normalizedTurnId = normalizeId(turnId);
    const sourceMessages = Array.isArray(messages) ? messages : [];
    const projection = projectTurnTree({ messages: sourceMessages });
    const turn = Array.isArray(projection?.turns)
      ? projection.turns.find((entry) => normalizeId(entry?.turn_id) === normalizedTurnId)
      : null;
    if (!turn && !this.canonicalPrimary) {
      return [];
    }
    const messageById = buildMessageIndex(sourceMessages);
    const projectedEvents = Array.isArray(turn?.events) ? turn.events : [];
    const rawCapturedLiveEvents = this.capturedEvents.filter((event) =>
      normalizeId(event?.turn_id) === normalizedTurnId && LIVE_CAPTURED_KINDS.has(normalizeId(event?.kind))
    );
    settleCapturedReasoningFromProjection(rawCapturedLiveEvents, projectedEvents);
    const capturedLiveEvents = rawCapturedLiveEvents.filter((event) => {
      if (assistantTextPayloadHasUsableText(event)) {
        return true;
      }
      if (this.logger) {
        this.logger('WARN', 'canonical_turn_event.assistant_text_fallback_to_projection', {
          sessionId: this.sessionId,
          turnId: normalizedTurnId,
          eventId: normalizeId(event?.event_id),
          reason: 'empty_or_truncated_payload_text',
        });
      }
      return false;
    }).sort((left, right) =>
      (Number(left?._capture_order) || 0) - (Number(right?._capture_order) || 0)
    );
    const capturedReplacementKeys = new Set();
    for (const event of capturedLiveEvents) {
      const kind = normalizeId(event?.kind);
      const callId = normalizeId(event?.tool_call_id);
      if (TOOL_RELATED_KINDS.has(kind) && callId) {
        capturedReplacementKeys.add(`${kind}:${callId}`);
      } else if (kind) {
        capturedReplacementKeys.add(kind);
      }
    }
    function capturedReplacesProjectedEvent(event) {
      const kind = normalizeId(event?.kind);
      if (!LIVE_CAPTURED_KINDS.has(kind)) {
        return false;
      }
      const callId = normalizeId(event?.tool_call_id);
      if (TOOL_RELATED_KINDS.has(kind) && callId) {
        return capturedReplacementKeys.has(`${kind}:${callId}`);
      }
      return capturedReplacementKeys.has(kind);
    }
    if (this.canonicalPrimary && capturedLiveEvents.length) {
      const prefixKinds = new Set(['user_prompt', 'attachment_cluster', 'system_notice']);
      const prefixEvents = [];
      const suffixEvents = [];
      for (const event of projectedEvents) {
        const kind = normalizeId(event?.kind);
        if (capturedReplacesProjectedEvent(event)) {
          continue;
        }
        const persisted = buildPersistedTurnEvent(event, messageById);
        if (prefixKinds.has(kind)) {
          prefixEvents.push(persisted);
        } else {
          suffixEvents.push(persisted);
        }
      }
      return this.mergePromotedObservations(normalizedTurnId, [
        ...prefixEvents,
        ...capturedLiveEvents.map((event) => buildPersistedTurnEvent(event, messageById)),
        ...suffixEvents,
      ]);
    }
    // source_citations rides inside its producing tool's span (it carries the
    // same tool_call_id), so both merge paths below emit it directly after
    // the tool_result instead of stranding it (non-tool captured kinds are
    // otherwise only drained on the reasoning path).
    const isToolSpanKind = (kind) => TOOL_RELATED_KINDS.has(kind) || kind === 'source_citations';
    const capturedToolEvents = capturedLiveEvents.filter((event) =>
      isToolSpanKind(normalizeId(event?.kind))
    );
    const hasCapturedReasoning = capturedLiveEvents.some((event) =>
      normalizeId(event?.kind) === 'reasoning_phase'
    );
    // Live-captured text segments supersede their projected counterparts so a
    // segment never persists twice (once from capture, once from projection).
    const capturedTextEventByKey = new Map();
    for (const event of capturedLiveEvents) {
      if (normalizeId(event?.kind) !== 'assistant_text_segment') {
        continue;
      }
      const primaryId = normalizeId(event?.primary_message_id);
      if (primaryId) {
        capturedTextEventByKey.set(`pm:${primaryId}`, event);
      }
      const segmentId = normalizeId(event?.payload?.segment_id);
      if (segmentId) {
        capturedTextEventByKey.set(`seg:${segmentId}`, event);
      }
    }
    function capturedTextCounterpart(event) {
      if (normalizeId(event?.kind) !== 'assistant_text_segment') {
        return null;
      }
      return capturedTextEventByKey.get(`pm:${normalizeId(event?.primary_message_id)}`)
        || capturedTextEventByKey.get(`seg:${normalizeId(event?.payload?.segment_id)}`)
        || null;
    }
    const groupedCapturedToolEvents = new Map();
    for (const event of capturedToolEvents) {
      const callId = normalizeId(event.tool_call_id);
      if (!callId) {
        continue;
      }
      const bucket = groupedCapturedToolEvents.get(callId) || [];
      bucket.push(event);
      groupedCapturedToolEvents.set(callId, bucket);
    }
    if (hasCapturedReasoning) {
      const mergedEvents = [];
      const insertedCallIds = new Set();
      let capturedIndex = 0;
      function pushCapturedEvent(event) {
        mergedEvents.push(buildPersistedTurnEvent(event, messageById));
      }
      function drainCapturedReasoning() {
        while (capturedIndex < capturedLiveEvents.length) {
          const event = capturedLiveEvents[capturedIndex];
          if (TOOL_RELATED_KINDS.has(normalizeId(event?.kind))) {
            break;
          }
          pushCapturedEvent(event);
          capturedIndex += 1;
        }
      }
      function drainCapturedToolSpan(callId) {
        let sawCall = false;
        while (capturedIndex < capturedLiveEvents.length) {
          const event = capturedLiveEvents[capturedIndex];
          const kind = normalizeId(event?.kind);
          const eventCallId = normalizeId(event?.tool_call_id);
          const isMatchingTool = isToolSpanKind(kind) && eventCallId === callId;
          if (sawCall && !isMatchingTool) {
            break;
          }
          pushCapturedEvent(event);
          capturedIndex += 1;
          if (isMatchingTool) {
            sawCall = true;
          }
        }
      }
      function drainRemainingCaptured() {
        while (capturedIndex < capturedLiveEvents.length) {
          pushCapturedEvent(capturedLiveEvents[capturedIndex]);
          capturedIndex += 1;
        }
      }
      for (const event of projectedEvents) {
        const kind = normalizeId(event?.kind);
        const callId = normalizeId(event?.tool_call_id);
        if (kind === 'reasoning_phase' && hasCapturedReasoning) {
          drainCapturedReasoning();
          continue;
        }
        if (TOOL_RELATED_KINDS.has(kind) && callId && groupedCapturedToolEvents.has(callId)) {
          if (!insertedCallIds.has(callId)) {
            insertedCallIds.add(callId);
            drainCapturedToolSpan(callId);
          }
          continue;
        }
        if (kind === 'assistant_text_segment' || kind === 'assistant_error') {
          drainRemainingCaptured();
          // The captured copy of this segment (if any) just drained above in
          // capture order — drop the projected duplicate.
          if (capturedTextCounterpart(event)) {
            continue;
          }
        }
        mergedEvents.push(buildPersistedTurnEvent(event, messageById));
      }
      drainRemainingCaptured();
      return this.mergePromotedObservations(normalizedTurnId, mergedEvents);
    }
    const insertedCallIds = new Set();
    const consumedCapturedTextEvents = new Set();
    const mergedEvents = [];
    for (const event of projectedEvents) {
      const kind = normalizeId(event?.kind);
      const callId = normalizeId(event?.tool_call_id);
      if (TOOL_RELATED_KINDS.has(kind) && callId && groupedCapturedToolEvents.has(callId)) {
        if (!insertedCallIds.has(callId)) {
          insertedCallIds.add(callId);
          mergedEvents.push(
            ...groupedCapturedToolEvents
              .get(callId)
              .map((capturedEvent) => buildPersistedTurnEvent(capturedEvent, messageById))
          );
        }
        continue;
      }
      const capturedText = capturedTextCounterpart(event);
      if (capturedText) {
        if (!consumedCapturedTextEvents.has(capturedText)) {
          consumedCapturedTextEvents.add(capturedText);
          mergedEvents.push(buildPersistedTurnEvent(capturedText, messageById));
        }
        continue;
      }
      mergedEvents.push(buildPersistedTurnEvent(event, messageById));
    }
    for (const [callId, events] of groupedCapturedToolEvents.entries()) {
      if (!insertedCallIds.has(callId)) {
        mergedEvents.push(
          ...events.map((capturedEvent) => buildPersistedTurnEvent(capturedEvent, messageById))
        );
      }
    }
    return this.mergePromotedObservations(normalizedTurnId, mergedEvents);
  }

  persistFinalizedTurn(sessionId, turnId, messages) {
    this.flushJournalEvents();
    const normalizedSessionId = normalizeId(sessionId);
    const normalizedTurnId = normalizeId(turnId);
    if (!normalizedSessionId || !normalizedTurnId || !this.store) {
      return { appended: 0, skipped: true, reason: 'invalid_input' };
    }
    const session = typeof this.store.getSession === 'function'
      ? this.store.getSession(normalizedSessionId)
      : null;
    if (Number(session?.turn_event_log_version || 0) > TURN_EVENT_LOG_VERSION) {
      return { appended: 0, skipped: true, reason: 'future_log_version' };
    }
    const sourceMessages = Array.isArray(messages)
      ? messages
      : (typeof this.store.getSessionMessages === 'function'
        ? this.store.getSessionMessages(normalizedSessionId)
        : []);
    const persistedEvents = this.buildFinalizedTurnEvents(normalizedTurnId, sourceMessages);
    if (!persistedEvents.length || typeof this.store.appendTurnEvents !== 'function') {
      return { appended: 0, skipped: true, reason: 'no_events' };
    }
    // Append durably and reconcile the journal in one place: the events are
    // forced to disk before the journal is cleared, and a write-blocked/refused
    // append RETAINS the journal (with a bounded WARN) for the next recovery
    // pass. See persistDurableTurnEvents in ./session-turn-events.
    const { ok, appended, reason } = persistDurableTurnEvents({
      store: this.store,
      journal: this.journal,
      logger: this.logger,
      sessionId: normalizedSessionId,
      turnId: normalizedTurnId,
      events: persistedEvents,
      session,
    });
    // `ok` distinguishes a refused append (journal retained) from a benign
    // zero-appended dedupe, so terminal seams can acknowledge the failure.
    return {
      appended,
      skipped: false,
      ok: ok !== false,
      ...(ok === false ? { reason: reason || 'append_refused' } : {}),
    };
  }
}

module.exports = {
  CanonicalTurnEventCollector,
  buildPersistedTurnEvent,
};
