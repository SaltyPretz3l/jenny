// Canonical turn view-model builder. Pure function: no globals, no DOM, no
// persistence. Consumes the same `turn` shape that renderer/chat/renderer-turn-tree-projector.js
// emits (turn_id, events, source_message_ids, primary_user_message_id,
// primary_assistant_message_id) plus the projection-context side tables
// (messageById, toolMessageIdsByCallId) that render-pipeline-utils maintains.
//
// This module is deliberately scoped to semantic derivation. Row ordering stays
// owned by the reducer / row projector; this builder re-exposes the same
// semantics in a turn-shaped view-model so that projection-context, classic
// shell adapters, and lifecycle phase grammar can converge on one authority.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-turn-view-model-sections'));
    return;
  }
  root.rendererTurnViewModel = factory(root.rendererTurnViewModelSections || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (sectionHelpers) {
  'use strict';

  const {
    buildToolCallSections,
    buildNoticeSections,
    buildAttachmentSection,
    buildInteractiveSection,
    buildSuggestionSection,
    buildSlashOutputSection,
    buildCarrySummary,
  } = sectionHelpers || {};

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function pushDistinct(list, value) {
    const normalized = normalizeId(value);
    if (!normalized || list.includes(normalized)) return;
    list.push(normalized);
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

  function collectAttachmentEvents(events, userPrimaryMessageId) {
    const primaryId = normalizeId(userPrimaryMessageId);
    if (!primaryId) return [];
    return events.filter((event) =>
      event
      && event.kind === 'attachment_cluster'
      && normalizeId(event.primary_message_id) === primaryId
    );
  }

  function buildUserSection(events, turn) {
    const userEvents = events.filter((event) => event && event.kind === 'user_prompt');
    if (!userEvents.length) {
      return null;
    }
    const userEvent = userEvents[0];
    const userPrimaryMessageId = normalizeId(
      userEvent.primary_message_id || (turn && turn.primary_user_message_id)
    );
    const attachmentEvents = collectAttachmentEvents(events, userPrimaryMessageId);
    const attachments = [];
    for (const attEvent of attachmentEvents) {
      const items = Array.isArray(attEvent.payload && attEvent.payload.attachments)
        ? attEvent.payload.attachments
        : [];
      for (const item of items) {
        if (item) attachments.push(item);
      }
    }
    return {
      messageId: userPrimaryMessageId,
      content: String(userEvent.payload && userEvent.payload.content || ''),
      attachments,
      sourceMessageIds: [userPrimaryMessageId].filter(Boolean),
    };
  }

  function buildAssistantSection(events, turn) {
    const segmentEvents = events.filter((event) => event && event.kind === 'assistant_text_segment');
    if (!segmentEvents.length) {
      return null;
    }
    const assistantMessageId = normalizeId(turn && turn.primary_assistant_message_id);
    const segments = [];
    let currentGroup = null;
    let groupIndex = 0;
    let finalAnswerSortKey = null;
    let latestSortKey = null;
    for (const segment of segmentEvents) {
      const payload = segment.payload && typeof segment.payload === 'object' ? segment.payload : {};
      const segmentPrimaryId = normalizeId(segment.primary_message_id);
      const segmentPhase = normalizeId(segment.assistant_phase);
      // Empty carry segments are not activity: they must not outrank a tool outcome.
      if (Array.isArray(segment.sort_key) && String(payload.text || '').trim()) latestSortKey = segment.sort_key.slice();
      if (segmentPhase === 'final_answer' && Array.isArray(segment.sort_key) && String(payload.text || '').trim()) {
        finalAnswerSortKey = segment.sort_key.slice();
      }
      if (
        !currentGroup
        || currentGroup._primaryMessageId !== segmentPrimaryId
        || currentGroup._assistantPhase !== segmentPhase
      ) {
        currentGroup = {
          groupIndex,
          primaryMessageId: segmentPrimaryId,
          assistantPhase: segmentPhase,
          phaseId: normalizeId(payload.phase_id),
          text: '',
          sourceMessageIds: [],
          segmentIds: [],
          _primaryMessageId: segmentPrimaryId,
          _assistantPhase: segmentPhase,
        };
        segments.push(currentGroup);
        groupIndex += 1;
      }
      currentGroup.text += String(payload.text || '');
      pushDistinct(currentGroup.sourceMessageIds, segmentPrimaryId);
      const segmentId = normalizeId(payload.segment_id);
      if (segmentId) currentGroup.segmentIds.push(segmentId);
    }
    for (const group of segments) {
      delete group._primaryMessageId;
      delete group._assistantPhase;
    }
    const totalText = segments.reduce((acc, group) => acc + group.text, '');
    const finalSegment = segments.slice().reverse().find((group) => group.assistantPhase === 'final_answer') || null;
    return {
      messageId: assistantMessageId,
      segments,
      totalText,
      finalAnswerText: finalSegment ? finalSegment.text : '',
      hasFinalAnswer: Boolean(finalSegment),
      finalAnswerSortKey,
      latestSortKey,
    };
  }

  function buildReasoningSection(events) {
    const groups = [];
    let currentGroup = null;
    for (const event of events) {
      if (!event || event.kind !== 'reasoning_phase') continue;
      const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
      const phaseId = normalizeId(event.phase_id || payload.phase_id);
      if (!currentGroup || currentGroup.phaseId !== phaseId) {
        currentGroup = {
          primaryMessageId: normalizeId(event.primary_message_id),
          phaseId,
          thinkingId: normalizeId(payload.thinking_id),
          toolCallId: normalizeId(event.tool_call_id || payload.tool_call_id),
          toolName: normalizeId(payload.tool_name),
          renderCollapsed: Boolean(payload.render_collapsed),
          entries: [],
          sourceMessageIds: [],
          sortKey: Array.isArray(event.sort_key) ? event.sort_key.slice() : [0, 0, 0],
          lastSortKey: null,
        };
        groups.push(currentGroup);
      }
      const entries = Array.isArray(payload.entries) ? payload.entries : [];
      for (const entry of entries) {
        if (entry) currentGroup.entries.push({ ...entry });
      }
      // Latest contentful event of the group (a reused phase id resumes the
      // group); the opening sortKey stays the ordering key.
      if (entries.some((entry) => entry && String(entry.text || '').trim()) && Array.isArray(event.sort_key)) {
        currentGroup.lastSortKey = event.sort_key.slice();
      }
      currentGroup.renderCollapsed = currentGroup.renderCollapsed || Boolean(payload.render_collapsed);
      if (!currentGroup.toolCallId) {
        currentGroup.toolCallId = normalizeId(event.tool_call_id || payload.tool_call_id);
      }
      if (!currentGroup.toolName) {
        currentGroup.toolName = normalizeId(payload.tool_name);
      }
      if (!currentGroup.thinkingId) {
        currentGroup.thinkingId = normalizeId(payload.thinking_id);
      }
      pushDistinct(currentGroup.sourceMessageIds, event.primary_message_id);
    }
    return groups.filter((group) => group.entries.length > 0);
  }

  function deriveArtifacts(toolCalls) {
    const artifacts = [];
    const seen = new Set();
    for (const toolCall of toolCalls) {
      const list = Array.isArray(toolCall && toolCall.generatedArtifacts) ? toolCall.generatedArtifacts : [];
      for (const artifact of list) {
        const id = normalizeId(artifact && artifact.artifact_id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        artifacts.push({
          ...artifact,
          tool_call_id: normalizeId(toolCall.toolCallId),
          tool_name: normalizeId(toolCall.toolName),
        });
      }
    }
    return artifacts;
  }

  function derivePhaseHint(viewModel) {
    // Conservative summary of current-turn tool and assistant state; downstream
    // lifecycle derivation consumes phaseHint without re-walking events.
    const toolCalls = Array.isArray(viewModel.toolCalls) ? viewModel.toolCalls : [];
    const assistant = viewModel.assistant;
    const reasoning = Array.isArray(viewModel.reasoning) ? viewModel.reasoning : [];
    const notices = Array.isArray(viewModel.notices) ? viewModel.notices : [];
    const assistantErrors = notices.filter((notice) => notice && notice.eventKind === 'assistant_error');
    let latestActivitySortKey = assistant && assistant.latestSortKey;
    for (const activity of reasoning.concat(toolCalls, assistantErrors)) {
      const sortKey = activity && (activity.lastEventSortKey || activity.lastSortKey || activity.sortKey);
      if (sortKey && (!latestActivitySortKey || sortKeyCompare(sortKey, latestActivitySortKey) > 0)) {
        latestActivitySortKey = sortKey;
      }
    }
    // A turn-level assistant failure after the last activity is terminal even
    // when an earlier tool outcome is not the latest event.
    if (assistantErrors.some((notice) => sortKeyCompare(notice.sortKey, latestActivitySortKey) >= 0)) return 'errored';
    let hasErrored = false;
    let hasRunning = false;
    let hasAwaitingApproval = false;
    let hasDenied = false;
    let hasCancelledOrTimedOut = false;
    let hasCompletedTool = false;
    let hasAbandoned = false;
    for (const toolCall of toolCalls) {
      const state = toolCall && toolCall.state;
      const isLatestActivity = toolCall && sortKeyCompare(toolCall.lastEventSortKey, latestActivitySortKey) >= 0;
      if (state === 'errored' && isLatestActivity) hasErrored = true;
      else if (state === 'running' || state === 'interrupted') hasRunning = true;
      else if (state === 'awaiting_approval') hasAwaitingApproval = true;
      else if (state === 'denied' && isLatestActivity) hasDenied = true;
      else if ((state === 'cancelled' || state === 'timed_out') && isLatestActivity) hasCancelledOrTimedOut = true;
      else if (state === 'completed' && isLatestActivity) hasCompletedTool = true;
      else if (state === 'abandoned' && isLatestActivity) hasAbandoned = true;
    }
    if (hasErrored) return 'errored';
    if (hasAwaitingApproval) return 'awaiting_approval';
    if (hasRunning) return 'tool_running';
    if (hasDenied) return 'denied';
    if (hasCancelledOrTimedOut) return 'cancelled';
    if (assistant && assistant.hasFinalAnswer) {
      // Live segments default to final_answer, so an agent loop's preamble
      // before each tool call reads as the answer. Reasoning that opened after
      // the latest answer text is the live step: calling the turn 'final_answer'
      // (phase done) there renders that step as a settled "Thought" row.
      // Compare the group's latest contentful event (a resumed phase id keeps
      // its opening sortKey); an answer with only empty carries has no sort key.
      const latestReasoning = reasoning[reasoning.length - 1];
      if (latestReasoning && (!assistant.finalAnswerSortKey
        || sortKeyCompare(latestReasoning.lastSortKey || latestReasoning.sortKey, assistant.finalAnswerSortKey) > 0)) {
        return 'reasoning';
      }
      return 'final_answer';
    }
    if (assistant && assistant.segments && assistant.segments.length > 0) return 'streaming_assistant';
    if (reasoning.length > 0) return 'reasoning';
    if (hasCompletedTool || hasAbandoned) return 'tool_settled';
    if (viewModel.user) return 'awaiting_assistant';
    return 'idle';
  }

  function buildTurnViewModel(turn, context) {
    const events = Array.isArray(turn && turn.events) ? turn.events.slice() : [];
    // Stable iteration order for everything downstream: defer to reducer-assigned
    // sort_key. The builder never re-keys events.
    events.sort((left, right) => sortKeyCompare(left && left.sort_key, right && right.sort_key));
    const { messageById = null, toolMessageIdsByCallId = null } = context || {};
    const turnId = normalizeId(turn && turn.turn_id);
    const user = buildUserSection(events, turn);
    const assistant = buildAssistantSection(events, turn);
    const reasoning = buildReasoningSection(events);
    const toolCalls = buildToolCallSections(events, { messageById, toolMessageIdsByCallId });
    const anchoredToolCallIds = new Set(
      toolCalls.map((toolCall) => normalizeId(toolCall.toolCallId)).filter(Boolean)
    );
    const notices = buildNoticeSections(events, anchoredToolCallIds);
    // A4 F7: a turn failure recorded after a call's last event means nothing
    // waits on that call's approval any more, as the sealed fold also says.
    const failureSortKeys = notices.filter((notice) => notice && notice.eventKind === 'assistant_error')
      .map((notice) => notice.sortKey);
    for (const toolCall of toolCalls) {
      if (toolCall.state === 'awaiting_approval'
        && failureSortKeys.some((sortKey) => sortKeyCompare(sortKey, toolCall.lastEventSortKey) > 0)) {
        toolCall.state = 'interrupted';
      }
    }
    const attachments = buildAttachmentSection(events);
    const interactive = buildInteractiveSection(events);
    const suggestions = buildSuggestionSection(events);
    const slashOutput = buildSlashOutputSection(events);
    const artifacts = deriveArtifacts(toolCalls);
    const carrySummary = buildCarrySummary(events, {
      user,
      assistant,
      toolCalls,
      reasoning,
      notices,
      interactive,
      suggestions,
      slashOutput,
    });
    if (carrySummary.needsOrphanCarry) {
      notices.push({
        kind: 'system_notice',
        subkind: 'orphan_carry',
        primaryMessageId: '',
        sourceMessageIds: [],
        payload: { subkind: 'orphan_carry' },
        origin: 'carry',
        sortKey: [0, 0, 0],
      });
    }
    const viewModel = {
      turnId,
      rootMessageIds: {
        user: user ? user.messageId : normalizeId(turn && turn.primary_user_message_id),
        assistant: assistant ? assistant.messageId : normalizeId(turn && turn.primary_assistant_message_id),
      },
      user,
      assistant,
      toolCalls,
      reasoning,
      notices,
      attachments,
      interactive,
      suggestions,
      slashOutput,
      artifacts,
      carry: carrySummary.carry,
      phaseHint: 'idle',
    };
    viewModel.phaseHint = derivePhaseHint(viewModel);
    return viewModel;
  }

  return {
    buildTurnViewModel,
  };
});
