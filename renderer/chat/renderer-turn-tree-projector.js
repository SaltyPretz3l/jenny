(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-thread-tree-utils'),
      require('./renderer-turn-normalization-utils'),
      require('./renderer-turn-tree-projector-persistence'),
      require('./renderer-turn-tree-projector-message-utils')
    );
    return;
  }
  root.rendererTurnTreeProjector = factory(
    root.rendererThreadTreeUtils || {},
    root.rendererTurnNormalizationUtils || {},
    root.rendererTurnTreeProjectorPersistence,
    root.rendererTurnTreeProjectorMessageUtils || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (threadTreeUtils, turnNormalizationUtils, persistenceFactory, projectorMessageUtils) {
  'use strict';
  const buildTranscriptThreadTree = typeof threadTreeUtils.buildTranscriptThreadTree === 'function'
    ? threadTreeUtils.buildTranscriptThreadTree
    : null;
  const {
    deepCloneJsonValue,
    normalizeGeneratedArtifact,
    normalizeId,
    normalizeToolLifecycleStatus,
    sortKeyCompare,
  } = turnNormalizationUtils;
  const STANDALONE_TURN_KINDS = new Set([
    'proactive_suggestion',
    'slash_command_output',
  ]);

  const EVENT_KIND_PRIORITY = Object.freeze({
    user_prompt: 10,
    attachment_cluster: 15,
    reasoning_phase: 20,
    agent_progress: 25,
    plan_object: 28,
    plan_document: 29,
    assistant_text_segment: 30,
    tool_use: 40,
    approval_requested: 45,
    approval_resolved: 46,
    tool_executing: 47,
    tool_result: 50,
    // source_citations (collector-derived from a web_search tool_result;
    // flag `source_citations`) sorts directly below its producing tool_result.
    source_citations: 52,
    assistant_error: 60,
    interactive_batch: 70,
    plan_proposal: 75,
    interactive_recap: 80,
    proactive_suggestion: 90,
    slash_output: 100,
    system_notice: 110,
  });
  // v1: original additive vocabulary (Phase 2B).
  // v2: Phase 11C adds the durable `plan_object` kind. Older v1 logs remain
  //     valid (they simply don't carry plan_object events).
  // v3: composer-rethink Wave F adds the terminal `plan_proposal` kind (the
  //     "Jenny proposes" card). The backend keeps stamping v2 until F3
  //     persists proposal events; this is acceptance-widening only.
  const SUPPORTED_TURN_EVENT_LOG_VERSION = 4; // v4: append-only Plan Mode documents.

  function normalizeKind(message) {
    return normalizeId(message && message.kind).toLowerCase();
  }

  function normalizeRole(message) {
    return normalizeId(message && message.role).toLowerCase();
  }

  // Pure message/phase field normalizers live in the message-utils sibling
  // (extracted for the modularity cap); same UMD load order as the other
  // projector siblings — see index.html + harness SCRIPT_ORDER.
  const {
    cloneNoticePayload,
    clonePlainObject,
    cloneSubagentReportMetadata,
    contextCompactedPayloadsMatch,
    normalizeRecoveryActions,
    buildInteractiveRecapViewModel,
    groupLegacyReasoningEntries,
    getPhaseField,
  } = projectorMessageUtils;

  // Row-ID stability contract: turn_id is derived from the persisted
  // parent_stream_id field (set by the backend on every assistant/tool
  // message at stream time). event_id and row_id are then composed
  // deterministically from turn_id + kind + ordinal. These identities
  // survive app restart because parent_stream_id survives app restart.
  // Do NOT change the derivation algorithm without a migration that
  // re-stamps all existing messages in the session store.
  function extractMessageStreamId(message) {
    const directId = normalizeId(
      message && (
        message.streamId
        || message.stream_id
        || message.request_id
        || message.requestId
        || message.parent_stream_id
        || message.parentStreamId
      )
    );
    if (directId) {
      return directId;
    }
    const toolParent = normalizeId(
      message
      && message.tool_call
      && message.tool_call.parent_stream_id
    );
    if (toolParent) {
      return toolParent;
    }
    const toolResultParent = normalizeId(
      message
      && message.tool_result
      && message.tool_result.parent_stream_id
    );
    if (toolResultParent) {
      return toolResultParent;
    }
    const planDocumentParent = projectorMessageUtils.planDocumentParentStreamId(message);
    if (planDocumentParent) return planDocumentParent;
    const messageId = normalizeId(message && message.id);
    if (!messageId) {
      return '';
    }
    const prefixedPatterns = [
      /^assistant_(.+?)(?:_seg\d+)?$/i,
      /^question_batch_(.+)$/i,
      /^plan_proposal_(.+)$/i,
      /^interactive_round_recap_(.+)$/i,
      /^user_(.+)$/i,
    ];
    for (const pattern of prefixedPatterns) {
      const match = messageId.match(pattern);
      if (match && normalizeId(match[1])) {
        return normalizeId(match[1]);
      }
    }
    return '';
  }

  function createTurn(turnId, firstMessageIndex) {
    return {
      turn_id: turnId,
      branch_id: '',
      events: [],
      primary_user_message_id: '',
      primary_assistant_message_id: '',
      source_message_ids: [],
      _sourceMessageIdSet: new Set(),
      _kindOrdinalByName: Object.create(null),
      _lastContextCompactedPayload: null,
      _firstMessageIndex: firstMessageIndex,
      _hasAssistantLikeMessage: false,
    };
  }

  function pushDistinct(list, set, value) {
    const normalized = normalizeId(value);
    if (!normalized || set.has(normalized)) {
      return;
    }
    set.add(normalized);
    list.push(normalized);
  }

  function pushEvent(turn, kind, options) {
    const settings = options || {};
    const ordinal = Number(turn._kindOrdinalByName[kind] || 0);
    turn._kindOrdinalByName[kind] = ordinal + 1;
    const event = {
      event_id: `${turn.turn_id}:${kind}:${ordinal}`,
      turn_id: turn.turn_id,
      kind,
      primary_message_id: normalizeId(settings.primary_message_id),
      source_message_ids: Array.from(new Set(
        (Array.isArray(settings.source_message_ids) ? settings.source_message_ids : [settings.primary_message_id])
          .map((value) => normalizeId(value))
          .filter(Boolean)
      )),
      sort_key: [
        // Use the backend-assigned event_seq when available (set per-message by
        // projectTurnTree on turn._currentEventSeq). Falls back to message_index
        // for legacy messages that predate event_seq persistence.
        Number.isInteger(turn._currentEventSeq) && turn._currentEventSeq >= 0
          ? turn._currentEventSeq
          : Number(settings.message_index) || 0,
        Number(settings.intra_message_order) || 0,
        Number(EVENT_KIND_PRIORITY[kind]) || 0,
      ],
      payload: settings.payload && typeof settings.payload === 'object' && !Array.isArray(settings.payload)
        ? settings.payload
        : {},
    };
    if (settings.phase_id) {
      event.phase_id = normalizeId(settings.phase_id);
    }
    if (settings.tool_call_id) {
      event.tool_call_id = normalizeId(settings.tool_call_id);
    }
    if (settings.status) {
      event.status = normalizeId(settings.status);
    }
    turn.events.push(event);
    return event;
  }

  function emitAssistantEvents(turn, message, messageIndex) {
    const kind = normalizeKind(message);
    let intra = 0;
    const messageId = normalizeId(message && message.id);
    const phases = Array.isArray(message && message.phases) ? message.phases : [];
    const visibleSegments = Array.isArray(message && message.visible_segments) ? message.visible_segments : [];
    const visibleSegmentsByPhaseId = new Map();
    const unmatchedSegments = [];

    for (let index = 0; index < visibleSegments.length; index += 1) {
      const segment = visibleSegments[index];
      const phaseId = normalizeId(segment && (segment.phase_id || segment.phaseId));
      const bucket = phaseId
        ? (visibleSegmentsByPhaseId.get(phaseId) || [])
        : unmatchedSegments;
      bucket.push({
        segment_id: normalizeId(segment && (segment.segment_id || segment.segmentId)) || `segment_${index}`,
        phase_id: phaseId,
        text: String(segment && segment.text || ''),
        segment_index: index,
      });
      if (phaseId && !visibleSegmentsByPhaseId.has(phaseId)) {
        visibleSegmentsByPhaseId.set(phaseId, bucket);
      }
    }

    function emitSegmentEvents(segments) {
      const list = Array.isArray(segments) ? segments : [];
      for (const segment of list) {
        pushEvent(turn, 'assistant_text_segment', {
          message_index: messageIndex,
          intra_message_order: intra,
          primary_message_id: messageId,
          source_message_ids: [messageId],
          phase_id: segment.phase_id,
          payload: {
            segment_id: segment.segment_id,
            phase_id: segment.phase_id,
            text: String(segment.text || ''),
            message_index: messageIndex,
            segment_index: segment.segment_index,
          },
        });
        intra += 1;
      }
    }

    if (kind === 'question_batch') {
      pushEvent(turn, 'interactive_batch', {
        message_index: messageIndex,
        intra_message_order: intra,
        primary_message_id: messageId,
        source_message_ids: [messageId],
        status: normalizeId(message && message.status),
        payload: {
          content: String(message && message.content || ''),
          question_batch: message && (message.question_batch || message.interactive_batch) || null,
        },
      });
      return;
    }

    if (kind === 'plan_proposal') {
      pushEvent(turn, 'plan_proposal', {
        message_index: messageIndex,
        intra_message_order: intra,
        primary_message_id: messageId,
        source_message_ids: [messageId],
        status: normalizeId(message && message.status),
        payload: {
          content: String(message && message.content || ''),
          plan_proposal: message && message.plan_proposal || null,
        },
      });
      return;
    }

    if (kind === 'plan_document') { pushEvent(turn, 'plan_document', projectorMessageUtils.buildPlanDocumentEvent(message, messageIndex, intra, messageId)); return; }

    if (kind === 'interactive_round_recap') {
      pushEvent(turn, 'interactive_recap', {
        message_index: messageIndex,
        intra_message_order: intra,
        primary_message_id: messageId,
        source_message_ids: [messageId],
        payload: {
          content: String(message && message.content || ''),
          interactive_round_recap: message && message.interactive_round_recap || null,
        },
      });
      return;
    }

    if (kind === 'proactive_suggestion') {
      pushEvent(turn, 'proactive_suggestion', {
        message_index: messageIndex,
        intra_message_order: intra,
        primary_message_id: messageId,
        source_message_ids: [messageId],
        payload: {
          content: String(message && message.content || ''),
          proactive_suggestion: message && message.proactive_suggestion || null,
        },
      });
      return;
    }

    if (kind === 'slash_command_output') {
      pushEvent(turn, 'slash_output', {
        message_index: messageIndex,
        intra_message_order: intra,
        primary_message_id: messageId,
        source_message_ids: [messageId],
        payload: {
          content: String(message && message.content || ''),
        },
      });
      return;
    }

    if (kind === 'tool_use') {
      const toolCall = message && message.tool_call && typeof message.tool_call === 'object'
        ? message.tool_call
        : {};
      const toolCallId = normalizeId(toolCall.call_id);
      const approvalState = normalizeToolLifecycleStatus(toolCall.approval_state || '');
      const toolStatus = normalizeToolLifecycleStatus(toolCall.status || message && message.status || '');
      pushEvent(turn, 'tool_use', {
        message_index: messageIndex,
        intra_message_order: intra,
        primary_message_id: messageId,
        source_message_ids: [messageId],
        tool_call_id: toolCallId,
        status: toolStatus || 'requested',
        payload: {
          tool_name: normalizeId(toolCall.tool_name),
          input: toolCall.input && typeof toolCall.input === 'object' && !Array.isArray(toolCall.input)
            ? clonePlainObject(toolCall.input)
            : {},
          input_json: String(toolCall.input_json || ''),
          approval_state: approvalState,
          summary: String(toolCall.summary || ''),
          ...(String(toolCall.reason || '').trim() ? { reason: String(toolCall.reason).trim() } : {}),
          parent_stream_id: normalizeId(toolCall.parent_stream_id),
        },
      });
      intra += 1;
      if (approvalState === 'pending' || toolStatus === 'pending_approval') {
        pushEvent(turn, 'approval_requested', {
          message_index: messageIndex,
          intra_message_order: intra,
          primary_message_id: messageId,
          source_message_ids: [messageId],
          tool_call_id: toolCallId,
          status: 'pending_approval',
          payload: {
            approval_state: approvalState || 'pending',
            ...(String(toolCall.policy_scope || '').trim() ? { policy_scope: String(toolCall.policy_scope).trim() } : {}),
            ...(String(toolCall.policy_consequence || '').trim() ? { policy_consequence: String(toolCall.policy_consequence).trim() } : {}),
            ...(String(toolCall.reason || '').trim() ? { reason: String(toolCall.reason).trim() } : {}),
          },
        });
        intra += 1;
      } else if (approvalState === 'approved' || toolStatus === 'approved') {
        pushEvent(turn, 'approval_resolved', {
          message_index: messageIndex,
          intra_message_order: intra,
          primary_message_id: messageId,
          source_message_ids: [messageId],
          tool_call_id: toolCallId,
          status: 'approved',
          payload: {
            approval_state: 'approved',
          },
        });
        intra += 1;
      } else if (approvalState === 'denied' || toolStatus === 'denied') {
        pushEvent(turn, 'approval_resolved', {
          message_index: messageIndex,
          intra_message_order: intra,
          primary_message_id: messageId,
          source_message_ids: [messageId],
          tool_call_id: toolCallId,
          status: 'denied',
          payload: {
            approval_state: 'denied',
          },
        });
        intra += 1;
      } else if (approvalState === 'timed_out' || toolStatus === 'timed_out') {
        pushEvent(turn, 'approval_resolved', {
          message_index: messageIndex,
          intra_message_order: intra,
          primary_message_id: messageId,
          source_message_ids: [messageId],
          tool_call_id: toolCallId,
          status: 'timed_out',
          payload: {
            approval_state: 'timed_out',
          },
        });
        intra += 1;
      } else if (approvalState === 'cancelled' || toolStatus === 'cancelled') {
        pushEvent(turn, 'approval_resolved', {
          message_index: messageIndex,
          intra_message_order: intra,
          primary_message_id: messageId,
          source_message_ids: [messageId],
          tool_call_id: toolCallId,
          status: toolStatus || approvalState,
          payload: {
            approval_state: approvalState || toolStatus,
          },
        });
        intra += 1;
      }
      if (toolStatus === 'running') {
        pushEvent(turn, 'tool_executing', {
          message_index: messageIndex,
          intra_message_order: intra,
          primary_message_id: messageId,
          source_message_ids: [messageId],
          tool_call_id: toolCallId,
          status: 'running',
          payload: {
            tool_name: normalizeId(toolCall.tool_name),
          },
        });
      }
      return;
    }

    if (kind === 'tool_result') {
      const toolResult = message && message.tool_result && typeof message.tool_result === 'object'
        ? message.tool_result
        : {};
      const approvalState = normalizeToolLifecycleStatus(toolResult.approval_state || toolResult.approvalState || '');
      const resultStatus = approvalState === 'denied' || approvalState === 'timed_out' || approvalState === 'cancelled'
        ? approvalState
        : (toolResult.is_error ? 'errored' : 'completed');
      pushEvent(turn, 'tool_result', {
        message_index: messageIndex,
        intra_message_order: intra,
        primary_message_id: messageId,
        source_message_ids: [messageId],
        tool_call_id: normalizeId(toolResult.call_id),
        status: resultStatus,
        payload: {
          tool_name: normalizeId(toolResult.tool_name),
          output_text: String(toolResult.output_text || ''),
          summary: String(toolResult.summary || ''),
          is_error: toolResult.is_error === true,
          error_code: normalizeId(toolResult.error_code),
          parent_stream_id: normalizeId(toolResult.parent_stream_id),
          ...(() => {
            const metadata = cloneSubagentReportMetadata(toolResult.metadata);
            return metadata ? { metadata } : {};
          })(),
          ...(approvalState ? { approval_state: approvalState } : {}),
          ...(() => {
            const generatedArtifacts = Array.isArray(toolResult.generated_artifacts)
              ? toolResult.generated_artifacts.map(normalizeGeneratedArtifact).filter(Boolean)
              : [];
            return generatedArtifacts.length ? { generated_artifacts: generatedArtifacts } : {};
          })(),
        },
      });
      return;
    }

    const isKnownAssistantKind = !kind || kind === 'assistant' || kind === 'text';
    if (!isKnownAssistantKind) {
      pushEvent(turn, 'system_notice', {
        message_index: messageIndex,
        intra_message_order: intra,
        primary_message_id: messageId,
        source_message_ids: [messageId],
        payload: {
          subkind: 'unknown_kind',
          unknown_kind: kind,
          content: String(message && message.content || ''),
        },
      });
      return;
    }

    const contextCompacted = cloneNoticePayload(message && message.context_compacted);
    if (contextCompacted && !contextCompactedPayloadsMatch(turn._lastContextCompactedPayload, contextCompacted)) {
      turn._lastContextCompactedPayload = contextCompacted;
      pushEvent(turn, 'system_notice', {
        message_index: messageIndex,
        intra_message_order: intra,
        primary_message_id: messageId,
        source_message_ids: [messageId],
        payload: {
          subkind: 'context_compacted',
          context_compacted: contextCompacted,
        },
      });
      intra += 1;
    }

    const agentStatus = cloneNoticePayload(message && message.agent_status);
    const agentStatusSteps = Array.isArray(message && message.agent_status_steps) && message.agent_status_steps.length
      ? message.agent_status_steps
      : null;
    if (agentStatus || agentStatusSteps) {
      const agentStatusPayload = { subkind: 'agent_status' };
      if (agentStatus) {
        agentStatusPayload.agent_status = agentStatus;
      }
      if (agentStatusSteps) {
        agentStatusPayload.agent_status_steps = agentStatusSteps;
      }
      pushEvent(turn, 'system_notice', {
        message_index: messageIndex,
        intra_message_order: intra,
        primary_message_id: messageId,
        source_message_ids: [messageId],
        payload: agentStatusPayload,
      });
      intra += 1;
    }

    const agentProgressSnapshot = Array.isArray(message && message.agent_progress_snapshot) && message.agent_progress_snapshot.length
      ? message.agent_progress_snapshot
      : null;
    if (agentProgressSnapshot) {
      pushEvent(turn, 'agent_progress', {
        message_index: messageIndex,
        intra_message_order: intra,
        primary_message_id: messageId,
        source_message_ids: [messageId],
        payload: { steps: agentProgressSnapshot },
      });
      intra += 1;
    }

    let hasReasoningOutput = false;
    for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex += 1) {
      const phase = phases[phaseIndex];
      const phaseId = getPhaseField(phase, 'phase_id');
      const phaseKind = getPhaseField(phase, 'phase_kind');
      if (phaseKind === 'reasoning') {
        const phaseEntries = Array.isArray(phase && phase.entries)
          ? phase.entries.map((entry) => ({ ...entry }))
          : [];
        pushEvent(turn, 'reasoning_phase', {
          message_index: messageIndex,
          intra_message_order: intra,
          primary_message_id: messageId,
          source_message_ids: [messageId],
          phase_id: phaseId,
          status: normalizeId(phase && phase.completed_at ? 'completed' : 'open'),
          payload: {
            phase_id: phaseId,
            phase_kind: phaseKind,
            iteration: Number(phase && phase.iteration) || 0,
            thinking_id: getPhaseField(phase, 'thinking_id'),
            tool_call_id: getPhaseField(phase, 'tool_call_id'),
            tool_name: getPhaseField(phase, 'tool_name'),
            render_collapsed: phase && (phase.render_collapsed === true || phase.renderCollapsed === true),
            started_at: getPhaseField(phase, 'started_at'),
            completed_at: getPhaseField(phase, 'completed_at'),
            entries: phaseEntries,
          },
        });
        intra += 1;
        if (phaseEntries.length > 0) {
          hasReasoningOutput = true;
        }
        continue;
      }
      if (phaseKind === 'text') {
        emitSegmentEvents(visibleSegmentsByPhaseId.get(phaseId) || []);
      }
    }

    if (!hasReasoningOutput) {
      const legacyReasoningGroups = groupLegacyReasoningEntries(
        message && message.reasoning && message.reasoning.entries
      );
      for (let index = 0; index < legacyReasoningGroups.length; index += 1) {
        const group = legacyReasoningGroups[index];
        const phaseId = group.thinkingId ? `legacy_phase_${group.thinkingId}` : `legacy_phase_${index}`;
        pushEvent(turn, 'reasoning_phase', {
          message_index: messageIndex,
          intra_message_order: intra,
          primary_message_id: messageId,
          source_message_ids: [messageId],
          phase_id: phaseId,
          status: normalizeId(message && message.status) || 'completed',
          payload: {
            phase_id: phaseId,
            phase_kind: 'reasoning',
            iteration: index,
            thinking_id: group.thinkingId,
            tool_call_id: '',
            tool_name: '',
            render_collapsed: false,
            started_at: '',
            completed_at: '',
            entries: group.entries.map((entry) => ({ ...entry })),
            legacy: true,
          },
        });
        intra += 1;
      }
    }

    emitSegmentEvents(unmatchedSegments);

    if (!visibleSegments.length && !phases.length && String(message && message.content || '')) {
      pushEvent(turn, 'assistant_text_segment', {
        message_index: messageIndex,
        intra_message_order: intra,
        primary_message_id: messageId,
        source_message_ids: [messageId],
        payload: {
          segment_id: `content_${messageIndex}`,
          phase_id: '',
          text: String(message && message.content || ''),
          message_index: messageIndex,
          segment_index: 0,
          legacy: true,
        },
      });
      intra += 1;
    }

    if (
      normalizeId(message && message.status).toLowerCase() === 'error'
      || normalizeId(message && message.stream_error)
    ) {
      pushEvent(turn, 'assistant_error', {
        message_index: messageIndex,
        intra_message_order: intra,
        primary_message_id: messageId,
        source_message_ids: [messageId],
        status: normalizeId(message && message.status) || 'error',
        payload: {
          stream_error: String(message && message.stream_error || ''),
          terminal_status: normalizeId(message && message.terminal_status),
          terminal_subcode: normalizeId(message && message.terminal_subcode),
          content: String(message && message.content || ''),
          error_code: normalizeId(message && message.error_code),
          retryable: message && typeof message.retryable === 'boolean' ? message.retryable : null,
          category: normalizeId(message && message.category),
          recovery_class: normalizeId(message && message.recovery_class),
          next_action: normalizeId(message && message.next_action),
          recovery_title: normalizeId(message && message.recovery_title),
          recovery_hint: normalizeId(message && message.recovery_hint),
          next_action_label: normalizeId(message && message.next_action_label),
          recovery_actions: normalizeRecoveryActions(message && message.recovery_actions),
        },
      });
    }
  }

  function assignAssistantPhases(turn) {
    // H-R2a: honor an explicit backend-stamped phase when present. The canonical
    // capture path stamps `payload.assistant_phase` on preserved mid-turn
    // commentary/intermediate segments (a tool_continuation reset), and the
    // persistence projector hydrates it onto `event.assistant_phase` before this
    // runs. Without this guard, the positional inference below would re-tag a
    // genuine 'commentary' segment as a second 'final_answer' bubble when its
    // following tool did not survive into the projected turn (the
    // orphaned-commentary regression). Positional inference stays the fallback
    // for legacy/unlabeled events (no explicit phase set).
    const KNOWN_ASSISTANT_PHASES = ['commentary', 'intermediate', 'final_answer'];
    const hasExplicitPhase = (event) =>
      KNOWN_ASSISTANT_PHASES.includes(normalizeId(event && event.assistant_phase));
    const textEvents = [];
    const toolIndices = [];
    for (let index = 0; index < turn.events.length; index += 1) {
      const event = turn.events[index];
      if (event.kind === 'assistant_text_segment') {
        textEvents.push({ event, index });
      }
      if (event.kind === 'tool_use') {
        toolIndices.push(index);
      }
    }
    if (!textEvents.length) {
      return;
    }
    if (!toolIndices.length) {
      for (const entry of textEvents) {
        if (hasExplicitPhase(entry.event)) {
          continue;
        }
        entry.event.assistant_phase = 'final_answer';
      }
      return;
    }
    // textEvents and toolIndices are both in ascending event-index order, and a
    // single event is never both text and tool, so a monotonic two-pointer scan
    // replaces the per-text-event filter/some — O(textEvents + toolEvents) rather
    // than O(textEvents x toolEvents) (finding #34). The toolPointer advance must
    // run for every text event (even ones we skip) so the scan stays monotonic.
    let toolPointer = 0;
    for (const entry of textEvents) {
      while (toolPointer < toolIndices.length && toolIndices[toolPointer] < entry.index) {
        toolPointer += 1;
      }
      if (hasExplicitPhase(entry.event)) {
        continue;
      }
      const priorToolCount = toolPointer;
      const futureToolExists = toolPointer < toolIndices.length;
      if (priorToolCount === 0) {
        entry.event.assistant_phase = 'commentary';
      } else if (futureToolExists) {
        entry.event.assistant_phase = 'intermediate';
      } else {
        entry.event.assistant_phase = 'final_answer';
      }
    }
  }

  function resolveBranchId(threadTree, messageIds) {
    if (!threadTree || !threadTree.nodeById || typeof threadTree.nodeById.get !== 'function') {
      return '';
    }
    const candidates = Array.isArray(messageIds) ? messageIds : [];
    for (const messageId of candidates) {
      let currentId = normalizeId(messageId);
      if (!currentId || !threadTree.nodeById.get(currentId)) {
        continue;
      }
      let previousId = '';
      while (currentId && currentId !== previousId) {
        const node = threadTree.nodeById.get(currentId);
        const parentId = normalizeId(node && node.parentId);
        if (!parentId || !threadTree.nodeById.get(parentId)) {
          return currentId;
        }
        previousId = currentId;
        currentId = parentId;
      }
      return currentId;
    }
    return '';
  }

  const persistence = (persistenceFactory && typeof persistenceFactory.createTurnTreePersistence === 'function')
    ? persistenceFactory.createTurnTreePersistence({
        normalizeId,
        deepCloneJsonValue,
        sortKeyCompare,
        EVENT_KIND_PRIORITY,
        SUPPORTED_TURN_EVENT_LOG_VERSION,
        createTurn,
        pushDistinct,
        assignAssistantPhases,
        normalizeRole,
        normalizeKind,
        resolveBranchId,
        // Hybrid claim pass (Ht-F canary fix): function declarations hoist,
        // so these late-bound references are valid at factory-creation time.
        extractMessageStreamId,
        buildTurnTreeFromMessages,
      })
    : null;
  if (!persistence) {
    throw new Error('renderer-turn-tree-projector: persistence factory wire-up failed');
  }
  const { isTurnEventLogSupported, buildTurnTreeFromPersistedEvents } = persistence;


  function projectTurnTree(session) {
    const payload = Array.isArray(session) ? { messages: session } : (session || {});
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const threadTree = payload.threadTree || (
      typeof buildTranscriptThreadTree === 'function'
        ? buildTranscriptThreadTree(messages, { buildInteractiveRecapViewModel })
        : null
    );
    if (
      isTurnEventLogSupported(payload.turn_event_log_version || payload.turnEventLogVersion)
      && Array.isArray(payload.turn_events || payload.turnEvents)
      && (payload.turn_events || payload.turnEvents).length > 0
    ) {
      return buildTurnTreeFromPersistedEvents(payload, threadTree);
    }
    return buildTurnTreeFromMessages(messages, threadTree);
  }

  // First stream id carried by the assistant-like messages that answer the
  // user message at startIndex. Only the next user message bounds the scan;
  // standalone messages (suggestions, slash output) never answer a prompt, so
  // they are skipped like any other non-answering message — treating them as
  // a boundary would leave a retried anchor keyed by its stale stream (the
  // twin-turn row-loss shape) if one ever interleaves before the answer.
  // Empty when the turn has no answer yet (a mid-send user-only tail keeps
  // its own key). Errored answers count: an attempt persisted with
  // status:'error' still carries the stream the live reducer and terminal
  // reconcile key by, and skipping it would reopen the reconcile miss.
  function resolveAnsweringStreamId(messages, startIndex) {
    for (let index = startIndex + 1; index < messages.length; index += 1) {
      const message = messages[index] && typeof messages[index] === 'object'
        ? messages[index]
        : {};
      const role = normalizeRole(message);
      if (role === 'user') {
        return '';
      }
      const kind = normalizeKind(message);
      if (STANDALONE_TURN_KINDS.has(kind)) {
        continue;
      }
      if (role === 'assistant' || kind === 'tool_result') {
        const streamId = extractMessageStreamId(message);
        if (streamId) {
          return streamId;
        }
      }
    }
    return '';
  }

  // Message-derived turn grouping. Runs standalone for sessions with no
  // persisted turn events, and as the hybrid fallback (via the persistence
  // sibling) for messages the event log does not cover — e.g. a live turn
  // whose events have not persisted yet.
  function buildTurnTreeFromMessages(messages, threadTree) {
    const turns = [];
    const byTurnId = Object.create(null);
    const byMessageId = Object.create(null);
    const turnByKey = new Map();
    let latestTurnId = '';
    let latestUserTurnId = '';
    let pendingUserTurnId = '';

    function ensureTurnForKey(turnKey, messageIndex) {
      const normalizedTurnKey = normalizeId(turnKey) || `turn_${messageIndex}`;
      let turn = turnByKey.get(normalizedTurnKey);
      if (!turn) {
        turn = createTurn(normalizedTurnKey, messageIndex);
        turnByKey.set(normalizedTurnKey, turn);
        turns.push(turn);
      }
      return turn;
    }

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index] && typeof messages[index] === 'object'
        ? messages[index]
        : {};
      const messageId = normalizeId(message.id) || `message_${index}`;
      const role = normalizeRole(message);
      const kind = normalizeKind(message);
      const streamId = extractMessageStreamId(message);

      let turn;
      if (role === 'user') {
        // Authoritative-stream adoption: a retried / edit-regenerated turn
        // keeps its original user message (id embeds the OLD stream) while
        // the assistant/tool messages answering it carry the CURRENT stream.
        // Key the turn by the answering stream so this projection, the
        // persisted turn-event projection, the live reducer, and backend
        // diagnostics converge on one turn id — keying by the stale user id
        // splits the turn into hydrated/live twins whose duplicated rows
        // orphan each other in the render-bucket dedup (streamed text and
        // the approval block vanish at the first tool event). Adoption only
        // applies when the user key would CREATE a turn; a user message that
        // joins an existing turn keeps today's grouping.
        const answeringStreamId = streamId && turnByKey.has(streamId)
          ? ''
          : resolveAnsweringStreamId(messages, index);
        turn = ensureTurnForKey(answeringStreamId || streamId || `turn_${index}`, index);
        if (streamId && answeringStreamId && streamId !== answeringStreamId && !turnByKey.has(streamId)) {
          // Alias the user-derived key so a straggler message still carrying
          // the old stream id groups here instead of forming a floater turn.
          turnByKey.set(streamId, turn);
        }
        latestUserTurnId = turn.turn_id;
        pendingUserTurnId = turn.turn_id;
      } else if (STANDALONE_TURN_KINDS.has(kind)) {
        turn = ensureTurnForKey(`turn_${messageId}`, index);
        pendingUserTurnId = '';
      } else if (streamId && turnByKey.has(streamId)) {
        turn = ensureTurnForKey(streamId, index);
        pendingUserTurnId = '';
      } else if (streamId && pendingUserTurnId && byTurnId[pendingUserTurnId] && !byTurnId[pendingUserTurnId]._hasAssistantLikeMessage) {
        turn = byTurnId[pendingUserTurnId];
        turnByKey.set(streamId, turn);
        pendingUserTurnId = '';
      } else if (streamId) {
        turn = ensureTurnForKey(streamId, index);
        pendingUserTurnId = '';
      } else if (latestUserTurnId && byTurnId[latestUserTurnId]) {
        turn = byTurnId[latestUserTurnId];
        pendingUserTurnId = '';
      } else if (latestTurnId && byTurnId[latestTurnId] && !STANDALONE_TURN_KINDS.has(kind)) {
        turn = byTurnId[latestTurnId];
        pendingUserTurnId = '';
      } else {
        turn = ensureTurnForKey(`turn_${index}`, index);
        pendingUserTurnId = '';
      }

      byTurnId[turn.turn_id] = turn;
      latestTurnId = turn.turn_id;
      byMessageId[messageId] = turn.turn_id;
      pushDistinct(turn.source_message_ids, turn._sourceMessageIdSet, messageId);

      if (role === 'user' && !turn.primary_user_message_id) {
        turn.primary_user_message_id = messageId;
      } else if (
        role === 'assistant'
        && !turn.primary_assistant_message_id
        && kind !== 'interactive_round_recap'
        && kind !== 'slash_command_output'
      ) {
        turn.primary_assistant_message_id = messageId;
      }

      if (role === 'assistant' && !STANDALONE_TURN_KINDS.has(kind)) {
        turn._hasAssistantLikeMessage = true;
      }

      // Expose the persisted event_seq for this message so pushEvent can use it
      // as the primary sort dimension without requiring changes to every call site.
      turn._currentEventSeq = Number.isInteger(message.event_seq) && message.event_seq >= 0
        ? message.event_seq : null;

      if (role === 'user') {
        pushEvent(turn, 'user_prompt', {
          message_index: index,
          intra_message_order: 0,
          primary_message_id: messageId,
          source_message_ids: [messageId],
          payload: {
            content: String(message.content || ''),
            attachments: Array.isArray(message.attachments) ? message.attachments.map((attachment) => ({ ...attachment })) : [],
          },
        });
        if (Array.isArray(message.attachments) && message.attachments.length) {
          pushEvent(turn, 'attachment_cluster', {
            message_index: index,
            intra_message_order: 1,
            primary_message_id: messageId,
            source_message_ids: [messageId],
            payload: {
              attachments: message.attachments.map((attachment) => ({ ...attachment })),
            },
          });
        }
      } else if (role === 'assistant' || kind === 'tool_result') {
        emitAssistantEvents(turn, message, index);
      } else {
        pushEvent(turn, 'system_notice', {
          message_index: index,
          intra_message_order: 0,
          primary_message_id: messageId,
          source_message_ids: [messageId],
          payload: {
            subkind: 'unknown_role',
            role,
            kind,
          },
        });
      }

      // _currentEventSeq is a transient per-message context used by pushEvent.
      // Remove it so it does not appear in the returned turn objects.
      delete turn._currentEventSeq;
    }

    for (const turn of turns) {
      turn.events.sort((left, right) => sortKeyCompare(left.sort_key, right.sort_key));
      assignAssistantPhases(turn);
      turn.branch_id = resolveBranchId(
        threadTree,
        [
          turn.primary_assistant_message_id,
          turn.primary_user_message_id,
          ...turn.source_message_ids,
        ]
      );
      delete turn._sourceMessageIdSet;
      delete turn._kindOrdinalByName;
      delete turn._lastContextCompactedPayload;
      delete turn._firstMessageIndex;
      delete turn._hasAssistantLikeMessage;
    }

    return {
      turns,
      byTurnId,
      byMessageId,
    };
  }

  return {
    projectTurnTree,
    EVENT_KIND_PRIORITY,
  };
});
