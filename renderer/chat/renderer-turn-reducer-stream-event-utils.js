/* renderer/chat/renderer-turn-reducer-stream-event-utils.js
 * Sibling factory for renderer-turn-reducer.js: owns the pure
 * `buildTurnEventFromStreamPayload` translator that maps a live stream
 * payload (started / phase_* / delta / tool_use / tool_approval_needed /
 * tool_result / stream_reset / complete / error) to the reducer's normalized
 * turn-event shape(s). It receives normalization and phase helpers through
 * `deps`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-stream-terminal-state'),
      require('./tool-call-utils')
    );
    return;
  }
  root.rendererTurnReducerStreamEventUtils = factory(
    root.rendererStreamTerminalState || {},
    root.toolCallUtils || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (terminalStateUtils, toolCallUtils) {
  'use strict';

  const resolveTerminalPresentation = terminalStateUtils.resolveTerminalPresentation;
  if (typeof resolveTerminalPresentation !== 'function') {
    throw new Error('renderer-stream-terminal-state must load before renderer-turn-reducer-stream-event-utils');
  }

  // Tri-state: main's effective `preservePriorSegments` decision (flag
  // included) when it published one, otherwise null so the reducer can tell
  // "older main, no opinion" from an explicit false.
  function resolveResetPreserveFlag(payload) {
    const raw = payload && (
      payload.preserve_prior_segments != null
        ? payload.preserve_prior_segments
        : payload.preservePriorSegments
    );
    return typeof raw === 'boolean' ? raw : null;
  }

  function createTurnReducerStreamEventUtils(deps) {
    const {
      normalizeId,
      cloneSortKey,
      deepCloneJsonValue,
      normalizeGeneratedArtifact,
      normalizeToolStatus,
      mergePhaseMetadata,
      normalizePhaseSummary,
      cloneEntries,
    } = deps || {};

    if (typeof normalizeId !== 'function' || typeof mergePhaseMetadata !== 'function') {
      throw new Error('renderer-turn-reducer-stream-event-utils: required deps missing');
    }

    function buildTurnEventFromStreamPayload(payload, context) {
      const settings = context && typeof context === 'object' ? context : {};
      const turnId = normalizeId(settings.turn_id || payload && payload.streamId || payload && payload.requestId || payload && payload.request_id);
      const primaryUserMessageId = normalizeId(settings.primary_user_message_id);
      const assistantMessageId = normalizeId(settings.primary_assistant_message_id);
      const toolUseMessageId = normalizeId(settings.primary_tool_message_id);
      const eventId = normalizeId(settings.event_id || `${turnId}:${normalizeId(payload && payload.type)}:${Number(settings.ordinal) || 0}`);
      const sortKey = cloneSortKey(settings.sort_key || [Number(settings.message_index) || 0, Number(settings.intra_message_order) || 0, Number(settings.kind_priority) || 0]);
      const type = normalizeId(payload && payload.type);
      const payloadPhase = mergePhaseMetadata(payload && payload.phase, {
        phase_id: payload && (payload.phaseId || payload.phase_id),
        phase_kind: payload && (payload.phaseKind || payload.phase_kind),
        thinking_id: payload && (payload.thinkingId || payload.thinking_id),
        tool_call_id: payload && (payload.toolCallId || payload.tool_call_id),
        tool_name: payload && (payload.toolName || payload.tool_name),
        summary: payload && payload.summary,
        iteration: payload && payload.iteration,
      });

      if (type === 'started') {
        return {
          event_id: eventId,
          turn_id: turnId,
          kind: 'started',
          primary_user_message_id: primaryUserMessageId,
          primary_assistant_message_id: assistantMessageId,
          source_message_ids: [primaryUserMessageId].filter(Boolean),
          sort_key: sortKey,
        };
      }
      if (type === 'phase_started' || type === 'phase_completed') {
        const phaseId = normalizeId(payloadPhase && payloadPhase.phase_id || payload && payload.phaseId);
        return {
          event_id: eventId,
          turn_id: turnId,
          kind: 'reasoning_phase',
          primary_message_id: assistantMessageId,
          primary_assistant_message_id: assistantMessageId,
          source_message_ids: [assistantMessageId].filter(Boolean),
          phase_id: phaseId,
          status: type === 'phase_completed' ? 'completed' : 'open',
          sort_key: sortKey,
          payload: {
            phase_id: phaseId,
            phase_kind: normalizeId(payloadPhase && payloadPhase.phase_kind || payload && payload.phaseKind),
            thinking_id: normalizeId(payloadPhase && payloadPhase.thinking_id || payload && payload.thinkingId),
            tool_call_id: normalizeId(payloadPhase && payloadPhase.tool_call_id || payload && payload.toolCallId),
            tool_name: normalizeId(payloadPhase && payloadPhase.tool_name || payload && payload.toolName),
            summary: normalizePhaseSummary(payloadPhase && payloadPhase.summary || payload && payload.summary),
            render_collapsed: Boolean(payload && payload.renderCollapsed),
            ...(payloadPhase ? { phase: payloadPhase } : {}),
            entries: [],
          },
        };
      }
      if (type === 'delta') {
        const events = [];
        const reasoning = payload && payload.reasoning && typeof payload.reasoning === 'object' ? payload.reasoning : null;
        if (reasoning && Array.isArray(reasoning.entriesDelta) && reasoning.entriesDelta.length) {
          // The synthetic fallback phase id must be PER SEGMENT (the assistant
          // shell message id advances at every tool-continuation stream_reset),
          // not per stream: a stream-global id merges every segment's
          // reasoning into the turn's FIRST reasoning row, so mid-stream the
          // live thinking + answer render at the top of the turn and the
          // settled interleave only pops into place at terminal reconcile.
          const liveFallbackPhaseId = `live_phase_${assistantMessageId || turnId}`;
          const reasoningPhase = mergePhaseMetadata(payloadPhase, {
            phase_id: settings.phase_id || payload && payload.phaseId || payload && payload.thinkingId || liveFallbackPhaseId,
            phase_kind: payload && payload.phaseKind || 'reasoning',
            thinking_id: payload && payload.thinkingId,
            tool_call_id: payload && payload.toolCallId,
            tool_name: payload && payload.toolName,
            summary: payload && payload.summary,
          });
          const reasoningPhaseId = normalizeId(reasoningPhase && reasoningPhase.phase_id || settings.phase_id || payload && payload.phaseId || payload && payload.thinkingId || liveFallbackPhaseId);
          events.push({
            event_id: `${eventId}:reasoning`,
            turn_id: turnId,
            kind: 'reasoning_phase',
            primary_message_id: assistantMessageId,
            primary_assistant_message_id: assistantMessageId,
            source_message_ids: [assistantMessageId].filter(Boolean),
            phase_id: reasoningPhaseId,
            status: 'open',
            sort_key: sortKey,
            payload: {
              phase_id: reasoningPhaseId,
              phase_kind: normalizeId(reasoningPhase && reasoningPhase.phase_kind) || 'reasoning',
              thinking_id: normalizeId(reasoningPhase && reasoningPhase.thinking_id || payload && payload.thinkingId),
              tool_call_id: normalizeId(reasoningPhase && reasoningPhase.tool_call_id || payload && payload.toolCallId),
              tool_name: normalizeId(reasoningPhase && reasoningPhase.tool_name || payload && payload.toolName),
              summary: normalizePhaseSummary(reasoningPhase && reasoningPhase.summary || payload && payload.summary),
              render_collapsed: false,
              ...(reasoningPhase ? { phase: reasoningPhase } : {}),
              entries: cloneEntries(reasoning.entriesDelta),
            },
          });
        }
        const segmentText = String(settings.segment_text != null ? settings.segment_text : payload && payload.content || '');
        if (segmentText) {
          events.push({
            event_id: `${eventId}:text`,
            turn_id: turnId,
            kind: 'assistant_text_segment',
            primary_message_id: assistantMessageId,
            primary_assistant_message_id: assistantMessageId,
            next_assistant_message_id: assistantMessageId,
            source_message_ids: [assistantMessageId].filter(Boolean),
            assistant_phase: normalizeId(settings.assistant_phase) || 'final_answer',
            sort_key: sortKey,
            payload: {
              segment_id: normalizeId(settings.segment_id) || `${assistantMessageId || turnId}_seg_${Number(settings.segment_index) || 0}`,
              phase_id: normalizeId(settings.phase_id || payloadPhase && payloadPhase.phase_id || payload && payload.phaseId),
              ...(payloadPhase ? { phase: payloadPhase } : {}),
              text: segmentText,
              message_index: Number(settings.message_index) || 0,
              segment_index: Number(settings.segment_index) || 0,
            },
          });
        }
        return events;
      }
      if (type === 'tool_use') {
        const status = normalizeToolStatus(payload && payload.status || 'requested') || 'requested';
        const approvalId = normalizeId(payload && (payload.approvalId || payload.approval_id));
        const events = [{
          event_id: eventId,
          turn_id: turnId,
          kind: 'tool_use',
          primary_message_id: toolUseMessageId,
          source_message_ids: [toolUseMessageId].filter(Boolean),
          tool_call_id: normalizeId(payload && payload.callId),
          status,
          sort_key: sortKey,
          payload: {
            ...(approvalId ? { approval_id: approvalId } : {}),
            tool_name: normalizeId(payload && payload.toolName),
            ...(String(payload && (payload.policyScope || payload.policy_scope) || '').trim()
              ? { policy_scope: String(payload.policyScope || payload.policy_scope).trim() }
              : {}),
            ...(String(payload && (payload.policyConsequence || payload.policy_consequence) || '').trim()
              ? { policy_consequence: String(payload.policyConsequence || payload.policy_consequence).trim() }
              : {}),
            ...(String(payload && payload.reason || '').trim() ? { reason: String(payload.reason).trim() } : {}),
            input: payload && payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input) ? deepCloneJsonValue(payload.input) : {},
            input_json: JSON.stringify(payload && payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input) ? payload.input : {}),
            summary: String(payload && payload.summary || ''),
            approval_state: normalizeToolStatus(payload && payload.approvalState),
          },
        }];
        if (status === 'pending_approval') {
          events.push({
            event_id: `${eventId}:approval_requested`,
            turn_id: turnId,
            kind: 'approval_requested',
            primary_message_id: toolUseMessageId,
            source_message_ids: [toolUseMessageId].filter(Boolean),
            tool_call_id: normalizeId(payload && payload.callId),
            status: 'pending_approval',
            sort_key: cloneSortKey([sortKey[0], sortKey[1], sortKey[2] + 1]),
            payload: {
              ...(approvalId ? { approval_id: approvalId } : {}),
              approval_state: normalizeToolStatus(payload && payload.approvalState) || 'pending',
              ...(String(payload && (payload.policyScope || payload.policy_scope) || '').trim()
                ? { policy_scope: String(payload.policyScope || payload.policy_scope).trim() }
                : {}),
              ...(String(payload && (payload.policyConsequence || payload.policy_consequence) || '').trim()
                ? { policy_consequence: String(payload.policyConsequence || payload.policy_consequence).trim() }
                : {}),
              ...(String(payload && payload.reason || '').trim() ? { reason: String(payload.reason).trim() } : {}),
            },
          });
        } else if (status === 'pending_user_input') {
          events.push({
            event_id: `${eventId}:user_questions_requested`,
            turn_id: turnId,
            kind: 'user_questions_requested',
            primary_message_id: toolUseMessageId,
            source_message_ids: [toolUseMessageId].filter(Boolean),
            tool_call_id: normalizeId(payload && payload.callId),
            status: 'pending_user_input',
            sort_key: cloneSortKey([sortKey[0], sortKey[1], sortKey[2] + 1]),
            payload: {
              tool_name: normalizeId(payload && payload.toolName),
              question_ref: normalizeId(payload && (payload.questionRef || payload.question_ref)),
              questions: Array.isArray(payload && payload.questions) ? deepCloneJsonValue(payload.questions) : [],
            },
          });
        } else if (status === 'approved' || status === 'denied' || status === 'timed_out' || status === 'cancelled') {
          events.push({
            event_id: `${eventId}:approval_resolved`,
            turn_id: turnId,
            kind: 'approval_resolved',
            primary_message_id: toolUseMessageId,
            source_message_ids: [toolUseMessageId].filter(Boolean),
            tool_call_id: normalizeId(payload && payload.callId),
            status,
            sort_key: cloneSortKey([sortKey[0], sortKey[1], sortKey[2] + 1]),
            payload: {
              ...(approvalId ? { approval_id: approvalId } : {}),
              approval_state: normalizeToolStatus(payload && payload.approvalState) || status,
            },
          });
        } else if (status === 'running') {
          events.push({
            event_id: `${eventId}:tool_executing`,
            turn_id: turnId,
            kind: 'tool_executing',
            primary_message_id: toolUseMessageId,
            source_message_ids: [toolUseMessageId].filter(Boolean),
            tool_call_id: normalizeId(payload && payload.callId),
            status: 'running',
            sort_key: cloneSortKey([sortKey[0], sortKey[1], sortKey[2] + 1]),
            payload: {
              tool_name: normalizeId(payload && payload.toolName),
            },
          });
        }
        return events;
      }
      if (type === 'tool_approval_needed') {
        const approvalId = normalizeId(payload && (payload.approvalId || payload.approval_id));
        const approvalRequestedEvent = {
          event_id: eventId,
          turn_id: turnId,
          kind: 'approval_requested',
          primary_message_id: toolUseMessageId,
          source_message_ids: [toolUseMessageId].filter(Boolean),
          tool_call_id: normalizeId(payload && payload.callId),
          status: 'pending_approval',
          sort_key: sortKey,
          payload: {
            ...(approvalId ? { approval_id: approvalId } : {}),
            approval_state: 'pending',
            // Shared derivation with renderer-turn-row-projector (single
            // source in tool-call-utils): a pending plan document makes the
            // live gap row buttonless too.
            ...(typeof toolCallUtils.deriveApprovalVariant === 'function'
              && toolCallUtils.deriveApprovalVariant(
                payload && payload.toolName,
                Boolean(payload && payload.planDocument)
              ) === 'plan'
              ? { approval_variant: 'plan' }
              : {}),
            ...(String(payload && (payload.policyScope || payload.policy_scope) || '').trim()
              ? { policy_scope: String(payload.policyScope || payload.policy_scope).trim() }
              : {}),
            ...(String(payload && (payload.policyConsequence || payload.policy_consequence) || '').trim()
              ? { policy_consequence: String(payload.policyConsequence || payload.policy_consequence).trim() }
              : {}),
            ...(String(payload && payload.reason || '').trim() ? { reason: String(payload.reason).trim() } : {}),
            // The approval can beat its tool_use event to the reducer; carrying
            // the tool name, summary and input here lets the gap row name the
            // tool and quote the command in that race instead of rendering
            // "this tool" with a generic key/value dump.
            ...(normalizeId(payload && payload.toolName) ? { tool_name: normalizeId(payload.toolName) } : {}),
            ...(String(payload && payload.summary || '').trim() ? { summary: String(payload.summary).trim() } : {}),
            ...(payload && payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input)
              ? { input: deepCloneJsonValue(payload.input), input_json: JSON.stringify(payload.input) }
              : {}),
          },
        };
        const planDocument = payload && payload.planDocument;
        if (!planDocument || typeof planDocument !== 'object' || Array.isArray(planDocument)) {
          return approvalRequestedEvent;
        }
        const callId = normalizeId(payload && payload.callId);
        const planId = normalizeId(planDocument.plan_id) || callId;
        const planMessageId = `plan_document_${planId}`;
        const planSortKey = cloneSortKey(sortKey);
        planSortKey[planSortKey.length - 1] += 1;
        return [approvalRequestedEvent, {
          event_id: `${eventId}:plan_document`, turn_id: turnId, kind: 'plan_document',
          primary_message_id: planMessageId, source_message_ids: [planMessageId],
          tool_call_id: callId, status: 'pending', sort_key: planSortKey,
          payload: { ...deepCloneJsonValue(planDocument), transition: 'pending' },
        }];
      }
      if (type === 'user_questions_requested') {
        return {
          event_id: eventId,
          turn_id: turnId,
          kind: 'user_questions_requested',
          primary_message_id: toolUseMessageId,
          source_message_ids: [toolUseMessageId].filter(Boolean),
          tool_call_id: normalizeId(payload && payload.callId),
          status: 'pending_user_input',
          sort_key: sortKey,
          payload: {
            tool_name: normalizeId(payload && payload.toolName),
            question_ref: normalizeId(payload && (payload.questionRef || payload.question_ref)),
            questions: Array.isArray(payload && payload.questions) ? deepCloneJsonValue(payload.questions) : [],
          },
        };
      }
      if (type === 'tool_result') {
        const approvalState = normalizeToolStatus(payload && payload.approvalState);
        const resultStatus = approvalState === 'denied' || approvalState === 'timed_out' || approvalState === 'cancelled'
          ? approvalState
          : (payload && payload.isError ? 'errored' : 'completed');
        const toolResultEvent = {
          event_id: eventId,
          turn_id: turnId,
          kind: 'tool_result',
          primary_message_id: toolUseMessageId,
          tool_result_message_id: normalizeId(settings.tool_result_message_id),
          source_message_ids: [toolUseMessageId, normalizeId(settings.tool_result_message_id)].filter(Boolean),
          tool_call_id: normalizeId(payload && payload.callId),
          status: resultStatus,
          sort_key: sortKey,
          payload: {
            tool_name: normalizeId(payload && payload.toolName),
            output_text: String(payload && payload.content || ''),
            summary: String(payload && payload.summary || ''),
            is_error: Boolean(payload && payload.isError),
            error_code: normalizeId(payload && payload.errorCode),
            approval_state: approvalState,
            generated_artifacts: Array.isArray(payload && payload.generatedArtifacts)
              ? payload.generatedArtifacts.map(normalizeGeneratedArtifact).filter(Boolean)
              : [],
            ...(payload && payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
              ? { metadata: deepCloneJsonValue(payload.metadata) }
              : {}),
          },
        };
        const metadata = payload && payload.metadata;
        if (!metadata || metadata.result_kind !== 'plan_mode_transition') {
          return toolResultEvent;
        }
        const callId = normalizeId(payload && payload.callId);
        const transition = normalizeId(metadata.plan_decision) || 'abandoned';
        const planMessageId = `plan_document_${callId}`;
        const planSortKey = cloneSortKey(sortKey);
        planSortKey[planSortKey.length - 1] += 1;
        return [toolResultEvent, {
          event_id: `${eventId}:plan_document`, turn_id: turnId, kind: 'plan_document',
          primary_message_id: planMessageId, source_message_ids: [planMessageId],
          tool_call_id: callId, status: transition, sort_key: planSortKey,
          payload: {
            tool_call_id: callId, transition, state: transition,
            feedback: metadata.plan_feedback, plan_edited: metadata.plan_edited === true,
            ...(metadata.plan && typeof metadata.plan === 'object' ? deepCloneJsonValue(metadata.plan) : {}),
          },
        }];
      }
      if (type === 'stream_reset') {
        const preservePriorSegments = resolveResetPreserveFlag(payload);
        return {
          event_id: eventId,
          turn_id: turnId,
          kind: 'stream_reset',
          // Sidecar reset reason: 'tool_continuation' marks a preserved
          // genuine-commentary reset (no truncation stamp downstream); every
          // other/absent reason is a discarding reset.
          reason: normalizeId(payload && payload.reason),
          // Main names what it erased instead of leaving the renderer to
          // re-derive it from `reason` (it cannot: the tool_continuation
          // preserve is flag-gated and model_winddown erases only the live
          // slice). 'all' | 'live_slice' | 'none'; absent => older main, and
          // the reducer falls back to the legacy reason set.
          discard_scope: normalizeId(payload && (payload.discard_scope || payload.discardScope)),
          ...(typeof preservePriorSegments === 'boolean' ? { preserve_prior_segments: preservePriorSegments } : {}),
          primary_message_id: assistantMessageId,
          primary_assistant_message_id: assistantMessageId,
          source_message_ids: [assistantMessageId].filter(Boolean),
          next_assistant_message_id: normalizeId(settings.next_assistant_message_id),
          sort_key: sortKey,
        };
      }
      if (type === 'complete' || type === 'error') {
        /* Carry the service's terminal classification (buildTerminalErrorPayload
           emits it as `status`; explicit terminal_status spellings win) so the
           reducer can tell a user stop from a genuine failure. Dropping it here
           made every cancellation settle the deck as "Needs Recovery". */
        const rawTerminalStatus = payload && (payload.terminal_status || payload.terminalStatus || payload.status);
        const terminalPresentation = resolveTerminalPresentation(rawTerminalStatus, { fallbackStatus: type });
        return {
          event_id: eventId,
          turn_id: turnId,
          kind: type,
          terminal_status: terminalPresentation.status,
          primary_message_id: assistantMessageId,
          primary_assistant_message_id: assistantMessageId,
          source_message_ids: [assistantMessageId].filter(Boolean),
          sort_key: sortKey,
        };
      }
      return null;
    }

    return { buildTurnEventFromStreamPayload };
  }

  return { createTurnReducerStreamEventUtils };
});
