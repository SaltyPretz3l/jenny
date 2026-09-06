// Pure section builders consume sorted turn events and caller-supplied helpers
// without touching globals, DOM, or persistence.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnViewModelSections = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RAW_TERMINAL_SUBSTATUSES = Object.freeze({
    completed: 'completed',
    cancelled: 'cancelled',
    preempted: 'preempted',
    timeout: 'timeout',
    timed_out: 'timeout',
    interrupted: 'interrupted',
    denied: 'denied',
    errored: 'errored',
    error: 'errored',
  });

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function normalizeSubstatus(value) {
    return normalizeId(value).toLowerCase();
  }

  function normalizeVisibleLifecycleStatus(value) {
    const status = normalizeSubstatus(value);
    if (status === 'timeout') return 'timed_out';
    if (status === 'preempted') return 'cancelled';
    return status;
  }

  function normalizeRawSubstatus(value) {
    const status = normalizeSubstatus(value);
    if (!status) return '';
    return RAW_TERMINAL_SUBSTATUSES[status] || status;
  }

  function deepCloneValue(value, seen) {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    const _seen = seen || new WeakSet();
    if (_seen.has(value)) {
      return Array.isArray(value) ? [] : {};
    }
    _seen.add(value);
    if (Array.isArray(value)) {
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        result.push(deepCloneValue(value[index], _seen));
      }
      return result;
    }
    const cloned = {};
    const keys = Object.keys(value);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      cloned[key] = deepCloneValue(value[key], _seen);
    }
    return cloned;
  }

  function clonePlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return deepCloneValue(value);
  }

  function pushDistinct(list, value) {
    const normalized = normalizeId(value);
    if (!normalized || list.includes(normalized)) return;
    list.push(normalized);
  }

  function resolveMessageById(messageById, messageId) {
    const normalizedId = normalizeId(messageId);
    if (!normalizedId) return null;
    if (messageById && typeof messageById.get === 'function') {
      return messageById.get(normalizedId) || null;
    }
    return null;
  }

  function normalizeGeneratedArtifact(artifact) {
    const source = artifact && typeof artifact === 'object' && !Array.isArray(artifact) ? artifact : {};
    const artifactId = normalizeId(source.artifact_id || source.artifactId);
    if (!artifactId) return null;
    return {
      artifact_id: artifactId,
      session_id: normalizeId(source.session_id || source.sessionId),
      artifact_kind: normalizeId(source.artifact_kind || source.artifactKind).toLowerCase() || 'document',
      title: String(source.title || source.file_name || source.fileName || 'Generated artifact').trim() || 'Generated artifact',
      file_name: String(source.file_name || source.fileName || '').trim(),
      display_path: String(source.display_path || source.displayPath || '').trim(),
      absolute_path: String(source.absolute_path || source.absolutePath || '').trim(),
      language: String(source.language || '').trim(),
      mime_type: String(source.mime_type || source.mimeType || '').trim().toLowerCase(),
      width: Math.max(Number(source.width || 0), 0),
      height: Math.max(Number(source.height || 0), 0),
      editable: source.editable !== false,
      status: String(source.status || 'available').trim().toLowerCase() || 'available',
    };
  }

  function sortKeyCompare(left, right) {
    const a = Array.isArray(left) ? left : [];
    const b = Array.isArray(right) ? right : [];
    for (let index = 0; index < 3; index += 1) {
      const delta = (Number(a[index]) || 0) - (Number(b[index]) || 0);
      if (delta !== 0) return delta;
    }
    return 0;
  }

  function cloneSortKey(sortKey) {
    return Array.isArray(sortKey) ? sortKey.slice() : [0, 0, 0];
  }

  function plainPayload(event) {
    return event && event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? event.payload
      : {};
  }

  function buildToolCallSections(events, { messageById, toolMessageIdsByCallId } = {}) {
    const eventsByCallId = new Map();
    for (const event of events) {
      if (!event) continue;
      if (
        event.kind !== 'tool_use'
        && event.kind !== 'tool_executing'
        && event.kind !== 'tool_result'
        && event.kind !== 'approval_requested'
        && event.kind !== 'approval_resolved'
      ) continue;
      const callId = normalizeId(event.tool_call_id);
      if (!callId) continue;
      const bucket = eventsByCallId.get(callId) || [];
      bucket.push(event);
      eventsByCallId.set(callId, bucket);
    }
    const toolCalls = [];
    for (const [callId, bucket] of eventsByCallId) {
      bucket.sort((a, b) => sortKeyCompare(a && a.sort_key, b && b.sort_key));
      const toolUseEvent = bucket.find((event) => event && event.kind === 'tool_use') || null;
      // No tool_use anchor: orphan tool lifecycle events surface as notices.
      if (!toolUseEvent) continue;
      const toolUsePayload = plainPayload(toolUseEvent);
      const approvalRequests = [];
      const approvalResolutions = [];
      let resultEvent = null;
      let hasExecuting = false;
      let duplicateToolUseCount = 0;
      let sawToolUse = false;
      for (const event of bucket) {
        if (event.kind === 'tool_use') {
          if (sawToolUse) duplicateToolUseCount += 1;
          sawToolUse = true;
        } else if (event.kind === 'tool_executing') {
          hasExecuting = true;
        } else if (event.kind === 'approval_requested') {
          approvalRequests.push({
            rawStatus: normalizeSubstatus(event.status),
            visibleStatus: normalizeVisibleLifecycleStatus(event.status),
            approvalState: normalizeVisibleLifecycleStatus(event.payload && event.payload.approval_state),
            rawApprovalState: normalizeSubstatus(event.payload && event.payload.approval_state),
            prompt: String(event.payload && (event.payload.prompt || event.payload.message || event.payload.summary) || ''),
          });
        } else if (event.kind === 'approval_resolved') {
          approvalResolutions.push({
            rawStatus: normalizeSubstatus(event.status),
            visibleStatus: normalizeVisibleLifecycleStatus(event.status),
            approvalState: normalizeVisibleLifecycleStatus(event.payload && event.payload.approval_state),
            rawApprovalState: normalizeSubstatus(event.payload && event.payload.approval_state),
          });
        } else if (event.kind === 'tool_result') {
          resultEvent = event;
        }
      }
      const resultPayload = resultEvent && resultEvent.payload && typeof resultEvent.payload === 'object' ? resultEvent.payload : null;
      const resultIsError = Boolean(resultPayload && resultPayload.is_error === true);
      const resultMetadata = resultPayload && resultPayload.metadata && typeof resultPayload.metadata === 'object' && !Array.isArray(resultPayload.metadata)
        ? clonePlainObject(resultPayload.metadata)
        : {};
      const generatedArtifacts = Array.isArray(resultPayload && resultPayload.generated_artifacts)
        ? resultPayload.generated_artifacts.map(normalizeGeneratedArtifact).filter(Boolean)
        : [];
      const toolUseRawStatus = normalizeSubstatus(toolUseEvent.status);
      const toolUseVisibleStatus = normalizeVisibleLifecycleStatus(toolUseEvent.status);
      // The event-level `status` field is polluted with message-level status
      // (e.g. 'complete' when the owning message finalized), so the
      // authoritative approval outcome lives in payload.approval_state.
      const finalResolution = approvalResolutions.length ? approvalResolutions[approvalResolutions.length - 1] : null;
      const finalVisibleApproval = finalResolution ? (finalResolution.approvalState || finalResolution.visibleStatus) : '';
      const finalRawApproval = finalResolution ? (finalResolution.rawApprovalState || finalResolution.rawStatus) : '';
      const resultVisibleApproval = normalizeVisibleLifecycleStatus(resultPayload && resultPayload.approval_state);
      const resultRawApproval = normalizeSubstatus(resultPayload && resultPayload.approval_state);
      let effectiveVisibleApproval = finalVisibleApproval;
      let effectiveRawApproval = finalRawApproval;
      if (resultVisibleApproval === 'denied' || resultVisibleApproval === 'timed_out' || resultVisibleApproval === 'cancelled') {
        effectiveVisibleApproval = resultVisibleApproval;
        effectiveRawApproval = resultRawApproval;
      }
      let state = 'requested';
      let rawTerminal = '';
      if (effectiveVisibleApproval === 'denied' || toolUseVisibleStatus === 'denied') {
        state = 'denied';
        rawTerminal = effectiveRawApproval === 'denied' ? 'denied' : normalizeRawSubstatus(effectiveRawApproval || toolUseRawStatus);
      } else if (effectiveVisibleApproval === 'timed_out' || toolUseVisibleStatus === 'timed_out') {
        state = 'timed_out'; rawTerminal = 'timeout';
      } else if (effectiveVisibleApproval === 'cancelled' || toolUseVisibleStatus === 'cancelled') {
        state = 'cancelled';
        rawTerminal = (effectiveRawApproval === 'preempted' || toolUseRawStatus === 'preempted') ? 'preempted' : 'cancelled';
      } else if (resultIsError) {
        state = 'errored'; rawTerminal = 'errored';
      } else if (resultEvent) {
        state = 'completed'; rawTerminal = 'completed';
      } else if (toolUseRawStatus === 'running' || hasExecuting) {
        state = 'interrupted'; rawTerminal = 'interrupted';
      } else if (effectiveVisibleApproval === 'approved') {
        state = 'approved';
      } else if (approvalRequests.length || toolUseRawStatus === 'pending_approval') {
        state = 'awaiting_approval';
      } else if (toolUseVisibleStatus === 'approved') {
        state = 'approved';
      } else if (sawToolUse) {
        state = 'abandoned';
      }
      const sourceMessageIds = [];
      pushDistinct(sourceMessageIds, toolUseEvent.primary_message_id);
      if (toolMessageIdsByCallId && typeof toolMessageIdsByCallId.get === 'function') {
        const linkedIds = toolMessageIdsByCallId.get(callId);
        if (Array.isArray(linkedIds)) for (const id of linkedIds) pushDistinct(sourceMessageIds, id);
      }
      for (const event of bucket) {
        const ids = Array.isArray(event.source_message_ids) ? event.source_message_ids : [];
        for (const id of ids) pushDistinct(sourceMessageIds, id);
      }
      // The tree projector normalizes raw subtypes (preempted→cancelled,
      // timeout→timed_out) before events reach the builder. Restore the raw
      // substatus from the original tool_use message so canonical data keeps
      // preempted and timeout representable per the Phase 2 lock.
      const toolMessage = resolveMessageById(messageById, toolUseEvent.primary_message_id);
      const rawToolCall = toolMessage && toolMessage.tool_call && typeof toolMessage.tool_call === 'object' ? toolMessage.tool_call : null;
      const rawApprovalState = normalizeSubstatus(rawToolCall && rawToolCall.approval_state);
      const rawToolStatus = normalizeSubstatus(rawToolCall && rawToolCall.status);
      if (state === 'cancelled' && (rawApprovalState === 'preempted' || rawToolStatus === 'preempted')) {
        rawTerminal = 'preempted';
      } else if (state === 'timed_out' && (rawApprovalState === 'timeout' || rawToolStatus === 'timeout')) {
        rawTerminal = 'timeout';
      }
      const resolvedDisplayName = normalizeId(
        toolUsePayload.tool_display_name
        || (toolMessage && toolMessage.tool_call && toolMessage.tool_call.tool_display_name)
      );
      toolCalls.push({
        toolCallId: callId,
        toolName: normalizeId(toolUsePayload.tool_name),
        toolDisplayName: resolvedDisplayName,
        primaryMessageId: normalizeId(toolUseEvent.primary_message_id),
        sourceMessageIds,
        input: Object.prototype.hasOwnProperty.call(toolUsePayload, 'input') && typeof toolUsePayload.input === 'object' && !Array.isArray(toolUsePayload.input)
          ? clonePlainObject(toolUsePayload.input) : {},
        inputJson: String(toolUsePayload.input_json || ''),
        inputSummary: String(toolUsePayload.input_summary || toolUsePayload.summary || ''),
        summary: String(toolUsePayload.summary || ''),
        state,
        rawTerminal,
        outputText: String(resultPayload && resultPayload.output_text || ''),
        resultSummary: String(resultPayload && resultPayload.summary || ''),
        resultIsError,
        resultMetadata,
        errorCode: normalizeId(resultPayload && resultPayload.error_code),
        approvalRequests,
        approvalResolutions,
        generatedArtifacts,
        durationMs: Number(resultPayload && (resultPayload.duration_ms ?? resultPayload.durationMs)) || 0,
        hasResult: Boolean(resultEvent),
        isExecuting: hasExecuting,
        duplicateToolUseCount,
        firstEventSortKey: cloneSortKey(toolUseEvent.sort_key),
      });
    }
    toolCalls.sort((a, b) => sortKeyCompare(a.firstEventSortKey, b.firstEventSortKey));
    return toolCalls;
  }

  function buildNoticeSections(events, anchoredToolCallIds) {
    const notices = [];
    const anchored = anchoredToolCallIds instanceof Set ? anchoredToolCallIds : new Set();
    for (const event of events) {
      if (!event || !event.kind) continue;
      const kind = event.kind;
      const payload = plainPayload(event);
      const base = {
        kind: 'system_notice',
        primaryMessageId: normalizeId(event.primary_message_id),
        sourceMessageIds: Array.isArray(event.source_message_ids) ? event.source_message_ids.slice() : [],
        sortKey: cloneSortKey(event.sort_key),
      };
      if (kind === 'system_notice' || kind === 'assistant_error') {
        notices.push({ ...base, subkind: normalizeId(payload.subkind || kind), payload: { ...payload }, origin: 'event' });
        continue;
      }
      if (kind === 'tool_use' && !normalizeId(event.tool_call_id)) {
        notices.push({ ...base, subkind: 'invalid_tool_use', payload: { ...payload }, origin: 'orphan_tool_use' });
        continue;
      }
      if (
        (kind === 'tool_result' || kind === 'approval_requested' || kind === 'approval_resolved' || kind === 'tool_executing')
        && !anchored.has(normalizeId(event.tool_call_id))
      ) {
        notices.push({
          ...base,
          subkind: `orphan_${kind}`,
          payload: { ...payload, tool_call_id: normalizeId(event.tool_call_id) },
          origin: 'orphan_tool_event',
        });
      }
    }
    notices.sort((a, b) => sortKeyCompare(a.sortKey, b.sortKey));
    return notices;
  }

  function buildAttachmentSection(events) {
    const attachments = [];
    for (const event of events) {
      if (!event || event.kind !== 'attachment_cluster') continue;
      const payload = plainPayload(event);
      const items = Array.isArray(payload.attachments) ? payload.attachments : [];
      for (const item of items) {
        if (item) attachments.push({ ...item, primaryMessageId: normalizeId(event.primary_message_id) });
      }
    }
    return attachments;
  }

  function buildInteractiveSection(events) {
    const batches = [];
    const recaps = [];
    for (const event of events) {
      if (!event || !event.kind) continue;
      const payload = plainPayload(event);
      const primaryMessageId = normalizeId(event.primary_message_id);
      const sortKey = cloneSortKey(event.sort_key);
      if (event.kind === 'interactive_batch') {
        batches.push({ primaryMessageId, questionBatch: payload.question_batch || payload.interactive_batch || null, payload: { ...payload }, sortKey });
      } else if (event.kind === 'interactive_recap') {
        recaps.push({ primaryMessageId, payload: { ...payload }, sortKey });
      }
    }
    batches.sort((a, b) => sortKeyCompare(a.sortKey, b.sortKey));
    recaps.sort((a, b) => sortKeyCompare(a.sortKey, b.sortKey));
    return { batches, recaps };
  }

  function buildSuggestionSection(events) {
    const items = [];
    for (const event of events) {
      if (!event || event.kind !== 'proactive_suggestion') continue;
      const payload = plainPayload(event);
      items.push({
        primaryMessageId: normalizeId(event.primary_message_id),
        suggestion: payload.proactive_suggestion || null,
        payload: { ...payload },
        sortKey: cloneSortKey(event.sort_key),
      });
    }
    items.sort((a, b) => sortKeyCompare(a.sortKey, b.sortKey));
    return items;
  }

  function buildSlashOutputSection(events) {
    const items = [];
    for (const event of events) {
      if (!event || event.kind !== 'slash_output') continue;
      items.push({
        primaryMessageId: normalizeId(event.primary_message_id),
        payload: { ...plainPayload(event) },
        sortKey: cloneSortKey(event.sort_key),
      });
    }
    items.sort((a, b) => sortKeyCompare(a.sortKey, b.sortKey));
    return items;
  }

  function buildCarrySummary(events, sections) {
    // Carry events contribute nothing to a canonical row (empty-entries
    // reasoning, empty-text assistant_text_segment). The projector attaches
    // them to the previous row or emits `orphan_carry`; the builder mirrors
    // that decision so consumers do not re-derive it.
    const carry = [];
    for (const event of events) {
      if (!event || !event.kind) continue;
      const payload = plainPayload(event);
      if (event.kind === 'reasoning_phase') {
        if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
          carry.push({ kind: 'reasoning_phase', eventId: normalizeId(event.event_id), primaryMessageId: normalizeId(event.primary_message_id) });
        }
        continue;
      }
      if (event.kind === 'assistant_text_segment' && !String(payload.text || '')) {
        carry.push({ kind: 'assistant_text_segment', eventId: normalizeId(event.event_id), primaryMessageId: normalizeId(event.primary_message_id) });
      }
    }
    const hasAnchor = Boolean(
      sections.user
      || sections.assistant
      || (sections.toolCalls && sections.toolCalls.length)
      || (sections.reasoning && sections.reasoning.length)
      || (sections.notices && sections.notices.length)
      || (sections.interactive && (sections.interactive.batches.length || sections.interactive.recaps.length))
      || (sections.suggestions && sections.suggestions.length)
      || (sections.slashOutput && sections.slashOutput.length)
    );
    return { carry, needsOrphanCarry: !hasAnchor && events.length > 0 && carry.length > 0 };
  }

  return {
    buildToolCallSections,
    buildNoticeSections,
    buildAttachmentSection,
    buildInteractiveSection,
    buildSuggestionSection,
    buildSlashOutputSection,
    buildCarrySummary,
  };
});
