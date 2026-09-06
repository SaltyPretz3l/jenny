(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnRowRenderUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Mid-turn phase → SR-only kicker label. Only commentary/intermediate get a
  // label; final_answer keeps full emphasis and no kicker.
  const ASSISTANT_PHASE_KICKER_LABELS = { commentary: 'Commentary', intermediate: 'Continued response' };

  const stringUtils = (function resolveStringUtils() {
    if (typeof globalThis !== 'undefined' && globalThis.stringUtils) {
      return globalThis.stringUtils;
    }
    if (typeof require === 'function') {
      try { return require('../shared/string-utils'); } catch (_error) { /* not available */ }
    }
    return null;
  })();
  const defaultEscapeHtml = stringUtils && typeof stringUtils.escapeHtml === 'function'
    ? stringUtils.escapeHtml
    : function fallbackEscapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    };
  function resolveTurnRowModule(globalName, modulePath) {
    if (typeof globalThis !== 'undefined' && globalThis[globalName]) return globalThis[globalName];
    if (typeof require === 'function') {
      try { return require(modulePath); } catch (_error) { /* not available */ }
    }
    return null;
  }
  const turnRowModelUtils = resolveTurnRowModule('rendererTurnRowModelUtils', './renderer-turn-row-model-utils');
  const turnRowToolRenderUtils = resolveTurnRowModule('rendererTurnRowToolRenderUtils', './renderer-turn-row-tool-render-utils');
  const turnRowListUtils = resolveTurnRowModule('rendererTurnRowListUtils', './renderer-turn-row-list-utils');
  const turnRowBubbleUtils = resolveTurnRowModule('rendererTurnRowBubbleUtils', './renderer-turn-row-bubble-utils');
  const resumeTurnAffordance = resolveTurnRowModule('rendererResumeTurnAffordance', './renderer-resume-turn-affordance');
  const toolCallUtils = resolveTurnRowModule('toolCallUtils', './tool-call-utils');
  const planDocumentUtils = resolveTurnRowModule('rendererPlanDocument', '../features/renderer-plan-document');

  // Class-E projected-row call-id resolver (2-key subset, payload-first), shared with
  // tool-call-utils.resolveProjectedRowCallId; falls back to the same String().trim()
  // behavior the inline normalizeId(payload.tool_call_id || row.tool_call_id) used.
  function resolveProjectedRowCallId(row) {
    if (toolCallUtils && typeof toolCallUtils.resolveProjectedRowCallId === 'function') {
      return toolCallUtils.resolveProjectedRowCallId(row);
    }
    const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
    return String(payload.tool_call_id || (row && row.tool_call_id) || '').trim();
  }

  function createTurnRowRenderUtils(deps) {
    const settings = deps || {};
    const MESSAGE_STATUS = settings.MESSAGE_STATUS || { STREAMING: 'streaming' };
    const escapeHtml = typeof settings.escapeHtml === 'function'
      ? settings.escapeHtml
      : defaultEscapeHtml;
    // WS3: renderer feature flags reach markup builders via this accessor;
    // absent (tests, timeline-replay corpus) -> {} -> flag-gated markup off.
    const getFeatureFlags = typeof settings.getFeatureFlags === 'function'
      ? settings.getFeatureFlags
      : function noopGetFeatureFlags() { return {}; };
    const renderMarkdown = typeof settings.renderMarkdown === 'function'
      ? settings.renderMarkdown
      : function fallbackRenderMarkdown(text) {
        return escapeHtml(String(text || ''));
      };
    const renderStreamingMarkdownUnits = typeof settings.renderStreamingMarkdownUnits === 'function'
      ? settings.renderStreamingMarkdownUnits
      : function fallbackStreamingMarkdown(text) {
        return {
          html: renderMarkdown(text),
          units: [],
          changedStartIndex: -1,
        };
      };
    const renderThinkingWidget = typeof settings.renderThinkingWidget === 'function'
      ? settings.renderThinkingWidget
      : function noopRenderThinkingWidget() { return ''; };
    const renderToolCallBlock = typeof settings.renderToolCallBlock === 'function'
      ? settings.renderToolCallBlock
      : function noopRenderToolCallBlock() { return ''; };
    const renderAgentStatusWidget = typeof settings.renderAgentStatusWidget === 'function'
      ? settings.renderAgentStatusWidget
      : function noopRenderAgentStatusWidget() { return ''; };
    const renderAgentProgressRow = typeof settings.renderAgentProgressRow === 'function'
      ? settings.renderAgentProgressRow
      : function noopRenderAgentProgressRow() { return ''; };
    const renderAssistantFailureNotice = typeof settings.renderAssistantFailureNotice === 'function'
      ? settings.renderAssistantFailureNotice
      : function noopRenderAssistantFailureNotice() { return ''; };
    const renderContextCompactedNotice = typeof settings.renderContextCompactedNotice === 'function'
      ? settings.renderContextCompactedNotice
      : function noopRenderContextCompactedNotice() { return ''; };
    const renderMessageAttachments = typeof settings.renderMessageAttachments === 'function'
      ? settings.renderMessageAttachments
      : function noopRenderMessageAttachments() { return ''; };
    const renderInteractiveRoundRecap = typeof settings.renderInteractiveRoundRecap === 'function'
      ? settings.renderInteractiveRoundRecap
      : function noopRenderInteractiveRoundRecap() { return ''; };
    const renderProactiveSuggestionBlock = typeof settings.renderProactiveSuggestionBlock === 'function'
      ? settings.renderProactiveSuggestionBlock
      : function noopRenderProactiveSuggestionBlock() { return ''; };
    const renderSlashCommandOutput = typeof settings.renderSlashCommandOutput === 'function'
      ? settings.renderSlashCommandOutput
      : function noopRenderSlashCommandOutput() { return ''; };
    // B7a: live/inert interactive batch row markup. Resolved at the render-pipeline
    // layer (it needs the session's pending batch + draft + question-state
    // helpers); absent in headless/unit contexts -> '' (inert, as before B7a).
    const buildInteractiveBatchRowMarkup = typeof settings.buildInteractiveBatchRowMarkup === 'function'
      ? settings.buildInteractiveBatchRowMarkup
      : function noopBuildInteractiveBatchRowMarkup() { return ''; };
    const isAgentProgressDurableEnabled = typeof settings.isAgentProgressDurableEnabled === 'function'
      ? settings.isAgentProgressDurableEnabled
      : function defaultIsAgentProgressDurableEnabled() { return false; };
    const artifactPresentationModule = (function resolveArtifactPresentation() {
      if (settings.artifactPresentation && typeof settings.artifactPresentation.buildArtifactPresentation === 'function') {
        return settings.artifactPresentation;
      }
      if (typeof globalThis !== 'undefined' && globalThis.rendererArtifactPresentation) {
        return globalThis.rendererArtifactPresentation;
      }
      if (typeof require === 'function') {
        try { return require('../features/renderer-artifact-presentation'); } catch (_error) { /* not available */ }
      }
      return null;
    })();
    const timelineV2PresentationModule = (function resolveTimelineV2Presentation() {
      if (settings.timelineV2Presentation && typeof settings.timelineV2Presentation.buildTimelineV2Presentation === 'function') {
        return settings.timelineV2Presentation;
      }
      if (typeof globalThis !== 'undefined' && globalThis.rendererTimelineV2Presentation) {
        return globalThis.rendererTimelineV2Presentation;
      }
      if (typeof require === 'function') {
        try { return require('./renderer-timeline-v2-presentation'); } catch (_error) { /* not available */ }
      }
      return null;
    })();
    const buildTimelineV2Presentation = timelineV2PresentationModule
      && typeof timelineV2PresentationModule.buildTimelineV2Presentation === 'function'
      ? timelineV2PresentationModule.buildTimelineV2Presentation
      : null;
    const renderArtifactTeaser = typeof settings.renderArtifactTeaser === 'function'
      ? settings.renderArtifactTeaser
      : function fallbackRenderArtifactTeaser(artifact) {
        const safeArtifact = artifact && typeof artifact === 'object' ? artifact : {};
        const artifactId = String(safeArtifact.artifact_id || '').trim();
        if (!artifactId) {
          return '';
        }
        const pres = artifactPresentationModule
          ? artifactPresentationModule.buildArtifactPresentation(safeArtifact, { mode: 'teaser' })
          : null;
        const kindAttr = pres ? pres.kind : 'tool';
        const title = pres ? pres.title : String(safeArtifact.title || 'Artifact');
        // W1-5: the title button routes straight to the review panel (studio
        // retired), so the extra ⤢ affordance is redundant here.
        return `
          <div class="inv-artifact-card" data-artifact-id="${escapeHtml(artifactId)}" data-artifact-kind="${escapeHtml(kindAttr)}">
            <button type="button" data-inv-artifact-action="panel" data-artifact-id="${escapeHtml(artifactId)}">${escapeHtml(title)}</button>
          </div>
        `;
      };
    const renderApprovalBlock = (function resolveApprovalBlockRenderer() {
      if (typeof settings.renderApprovalBlock === 'function') {
        return settings.renderApprovalBlock;
      }
      if (typeof globalThis !== 'undefined'
        && globalThis.rendererApprovalBlock
        && typeof globalThis.rendererApprovalBlock.renderApprovalBlock === 'function') {
        return globalThis.rendererApprovalBlock.renderApprovalBlock;
      }
      if (typeof require === 'function') {
        try {
          const mod = require('./renderer-approval-block');
          if (mod && typeof mod.renderApprovalBlock === 'function') {
            return mod.renderApprovalBlock;
          }
        } catch (_error) {
          /* module not available in this environment */
        }
      }
      return null;
    })();
    const renderUserQuestionsBlock = (function resolveUserQuestionsBlockRenderer() {
      if (typeof settings.renderUserQuestionsBlock === 'function') {
        return settings.renderUserQuestionsBlock;
      }
      if (typeof globalThis !== 'undefined'
        && globalThis.rendererUserQuestionsBlock
        && typeof globalThis.rendererUserQuestionsBlock.renderUserQuestionsBlock === 'function') {
        return globalThis.rendererUserQuestionsBlock.renderUserQuestionsBlock;
      }
      if (typeof require === 'function') {
        try {
          const mod = require('./renderer-user-questions-block');
          if (mod && typeof mod.renderUserQuestionsBlock === 'function') {
            return mod.renderUserQuestionsBlock;
          }
        } catch (_error) {
          /* module not available in this environment */
        }
      }
      return null;
    })();
    const renderUserQuestionsReceipt = (function resolveUserQuestionsReceiptRenderer() {
      if (typeof settings.renderUserQuestionsReceipt === 'function') {
        return settings.renderUserQuestionsReceipt;
      }
      if (typeof globalThis !== 'undefined'
        && globalThis.rendererUserQuestionsBlock
        && typeof globalThis.rendererUserQuestionsBlock.renderUserQuestionsReceipt === 'function') {
        return globalThis.rendererUserQuestionsBlock.renderUserQuestionsReceipt;
      }
      if (typeof require === 'function') {
        try {
          const mod = require('./renderer-user-questions-block');
          if (mod && typeof mod.renderUserQuestionsReceipt === 'function') {
            return mod.renderUserQuestionsReceipt;
          }
        } catch (_error) {
          /* module not available in this environment */
        }
      }
      return null;
    })();

    const toolMarkerUtils = (function resolveToolMarkerUtils() {
      if (settings.toolMarkerUtils && typeof settings.toolMarkerUtils === 'object') {
        return settings.toolMarkerUtils;
      }
      if (typeof globalThis !== 'undefined' && globalThis.rendererToolMarkerUtils) {
        return globalThis.rendererToolMarkerUtils;
      }
      if (typeof require === 'function') {
        try { return require('./renderer-tool-marker-utils'); } catch (_error) { /* not available */ }
      }
      return null;
    })();
    const buildToolMarkerBannerMarkup = toolMarkerUtils && typeof toolMarkerUtils.buildToolMarkerBannerMarkup === 'function'
      ? toolMarkerUtils.buildToolMarkerBannerMarkup
      : function noopBuildToolMarkerBannerMarkup() { return ''; };
    const buildOrphanCarryNoticeMarkup = toolMarkerUtils && typeof toolMarkerUtils.buildOrphanCarryNoticeMarkup === 'function'
      ? toolMarkerUtils.buildOrphanCarryNoticeMarkup
      : function noopBuildOrphanCarryNoticeMarkup() { return ''; };

    const errorRecoveryUtils = (function resolveErrorRecoveryUtils() {
      if (settings.errorRecoveryUtils && typeof settings.errorRecoveryUtils === 'object') {
        return settings.errorRecoveryUtils;
      }
      if (typeof globalThis !== 'undefined' && globalThis.rendererErrorRecoveryUtils) {
        return globalThis.rendererErrorRecoveryUtils;
      }
      if (typeof require === 'function') {
        try { return require('./renderer-error-recovery-utils'); } catch (_error) { /* not available */ }
      }
      return null;
    })();
    const renderTimelineErrorCardMarkup = errorRecoveryUtils && typeof errorRecoveryUtils.renderTimelineErrorCard === 'function'
      ? errorRecoveryUtils.renderTimelineErrorCard
      : function noopRenderTimelineErrorCard() { return ''; };
    /* Same tooltip copy the card chip uses; inlined constant so the legacy
     * bare-row fallback still reads correctly with the card module absent. */
    const LOGS_DEEP_LINK_TITLE = (errorRecoveryUtils && errorRecoveryUtils.LOGS_LINK_TITLE)
      || "View this error's diagnostic event in Activity";
    const turnRowErrorDedupeUtils = settings.turnRowErrorDedupeUtils || resolveTurnRowModule('rendererTurnRowErrorDedupeUtils', './renderer-turn-row-error-dedupe-utils');
    const resolveTurnErrorDedupe = turnRowErrorDedupeUtils?.resolveTurnErrorDedupe || function noop() { return { suppress: false, suppressedErrors: [] }; };
    const {
      copyAssistantErrorRecoveryFields,
      formatDurationMs,
      getMessageById,
      getReasoningPhaseField,
      hasAssistantErrorRecoveryMetadata,
      normalizeId,
      normalizeReasoningPhase,
    } = turnRowModelUtils;
    const {
      buildApprovalGapMarkup,
      buildToolCallRowMarkup: buildDefaultToolCallRowMarkup,
      buildToolResultRowMarkup,
    } = turnRowToolRenderUtils.createTurnRowToolRenderUtils({
      escapeHtml,
      normalizeId,
      formatDurationMs,
      renderArtifactTeaser,
      buildToolMarkerBannerMarkup,
      renderApprovalBlock,
      getFeatureFlags,
    });

    const {
      getSourceMessage,
      buildStreamUnitsMarkup,
      buildStreamingBubbleHtml,
      shouldRenderMessageAttachments,
      buildRowAttachmentsMarkup,
      buildSendFailureChipMarkup,
      buildUserBubbleRowMarkup,
      buildEditingUserBubbleMarkup,
      buildTruncationMarkerMarkup,
      stripCitationMarkersForDisplay,
    } = turnRowBubbleUtils.createTurnRowBubbleUtils({
      escapeHtml,
      normalizeId,
      getMessageById,
      getFeatureFlags,
      renderMarkdown,
      renderStreamingMarkdownUnits,
      renderMessageAttachments,
      resolveTurnRowModule,
    });

    function buildAssistantTextRowMarkup(row, messages, options) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const sourceMessage = getSourceMessage(row, messages, options);
      const text = String(payload.text || '');
      const renderOptions = options || {};
      const isStreaming = renderOptions.isStreaming === true;
      // Mid-turn phase kicker: when the response-loop display is active, a
      // preserved commentary/intermediate slice gets an SR-only label OUTSIDE
      // the markdown bubble (the visible de-emphasis is the dimmed
      // [data-assistant-phase] wrapper added in buildRowWrapperMarkup). The
      // terminal final_answer keeps full emphasis and gets no kicker.
      const kickerLabel = renderOptions.responseLoopDisplayV2 === true
        ? (ASSISTANT_PHASE_KICKER_LABELS[normalizeId(row && row.assistant_phase)] || '')
        : '';
      const kickerMarkup = kickerLabel
        ? `<span class="chat-commentary-kicker"><span class="sr-only">${escapeHtml(kickerLabel)}</span></span>`
        : '';
      const bubbleMarkup = text.trim()
        ? (() => {
            const bubbleClassName = `chat-bubble chat-bubble-markdown${isStreaming ? ' chat-bubble-streaming' : ''}`;
            const bubbleBodyHtml = isStreaming
              ? buildStreamingBubbleHtml(text, renderOptions)
              : renderMarkdown(stripCitationMarkersForDisplay(text));
            const streamingAttrs = isStreaming
              ? ' data-streaming-bubble="true" role="status" aria-live="polite" aria-atomic="false" aria-label="Assistant response (streaming)"'
              : '';
            return `<div class="${bubbleClassName}"${streamingAttrs}>${bubbleBodyHtml}</div>`;
          })()
        : '';
      const attachmentsMarkup = sourceMessage && shouldRenderMessageAttachments(row, renderOptions)
        ? buildRowAttachmentsMarkup(sourceMessage)
        : '';
      const resumeKind = sourceMessage && sourceMessage.resumable_stop;
      const resumeMarkup = resumeTurnAffordance
        && resumeTurnAffordance.RESUMABLE_STOP_KINDS.includes(resumeKind)
        && row.assistant_phase === 'final_answer'
        && normalizeId(sourceMessage.id) === normalizeId(renderOptions.resumeTailMessageId)
        && renderOptions.isStreaming !== true
        ? resumeTurnAffordance.buildResumeAffordanceMarkup({
            kind: resumeKind,
            messageId: normalizeId(sourceMessage.id),
            sessionId: renderOptions.sessionId,
            disabled: renderOptions.resumeSendBusy === true,
          })
        : '';
      return `${kickerMarkup}${bubbleMarkup}${attachmentsMarkup}${buildTruncationMarkerMarkup(payload)}${resumeMarkup}`;
    }

    function buildReasoningRenderMessage(row, messages, options) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const sourceMessage = getSourceMessage(row, messages, options);
      const phaseId = normalizeId(payload.phase_id || row && row.phase_id);
      const thinkingId = normalizeId(payload.thinking_id);
      const entries = Array.isArray(payload.entries) ? payload.entries.map((entry) => ({ ...entry })) : [];
      const sourcePhases = Array.isArray(sourceMessage && sourceMessage.reasoning_phases)
        ? sourceMessage.reasoning_phases
        : [];
      const reasoningPhases = sourcePhases.filter(function filterPhase(phase) {
        if (!phase || typeof phase !== 'object') {
          return false;
        }
        const matchesThinkingId = thinkingId && normalizeId(getReasoningPhaseField(phase, 'thinkingId')) === thinkingId;
        const matchesPhaseId = phaseId && normalizeId(getReasoningPhaseField(phase, 'phaseId')) === phaseId;
        return phaseId ? matchesPhaseId : matchesThinkingId;
      }).slice(0, 1);
      const sourceTranscriptPhases = Array.isArray(sourceMessage && sourceMessage.phases)
        ? sourceMessage.phases
        : [];
      const transcriptPhase = sourceTranscriptPhases.find(function findTranscriptPhase(phase) {
        if (!phase || typeof phase !== 'object') {
          return false;
        }
        const candidatePhaseId = normalizeId(phase.phase_id || phase.phaseId);
        const candidateThinkingId = normalizeId(phase.thinking_id || phase.thinkingId);
        return phaseId ? candidatePhaseId === phaseId : Boolean(thinkingId && candidateThinkingId === thinkingId);
      });
      const messageId = normalizeId(sourceMessage && sourceMessage.id)
        || normalizeId(row && row.primary_message_id)
        || `${normalizeId(row && row.turn_id)}:reasoning`;
      return {
        ...(sourceMessage && typeof sourceMessage === 'object' ? sourceMessage : {}),
        id: messageId,
        role: 'assistant',
        status: (options && options.isStreaming === true) ? MESSAGE_STATUS.STREAMING : String(sourceMessage && sourceMessage.status || 'complete'),
        reasoning: {
          source: 'provider',
          entries,
        },
        phases: [{
          ...(transcriptPhase || {}),
          phase_id: phaseId,
          phase_kind: 'reasoning',
          thinking_id: thinkingId,
          entries,
        }],
        reasoning_phases: reasoningPhases.length
          ? reasoningPhases.map((phase) => normalizeReasoningPhase(phase))
          : [{
              phaseKind: 'reasoning',
              phaseId,
              thinkingId,
              summary: String(payload.summary || ''),
              renderCollapsed: payload.render_collapsed === true,
              iteration: Number(payload.iteration) || 0,
              // Carry the projected timing so renderPhase can show "Thought for Xs".
               startedAt: String(payload.started_at || ''),
               completedAt: String(payload.completed_at || ''),
               completed: payload.completed === true || Boolean(payload.completed_at),
             }],
      };
    }

    function buildReasoningRowMarkup(row, messages, options) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      // A terminal turn can still carry stale streaming render options (a
      // streamingMessageId matching this row's shared primary_message_id);
      // reasoning must never render as streaming/auto-expanded once the
      // turn phase is settled.
      const turnPhase = normalizeId(options && options.turnPhase);
      const turnSettled = turnPhase === 'done' || turnPhase === 'review_artifact';
      const reasoningStreaming = !turnSettled && !!(options && options.isStreaming === true);
      const renderMessage = buildReasoningRenderMessage(
        row,
        messages,
        { ...(options || {}), isStreaming: reasoningStreaming }
      );
      const widgetHtml = renderThinkingWidget(
        renderMessage,
        reasoningStreaming ? renderMessage.id : ''
      );
      const truncationMarkup = buildTruncationMarkerMarkup(payload);
      if (String(widgetHtml || '').trim()) {
        return `${widgetHtml}${truncationMarkup}`;
      }
      const chunkCount = Number(payload.chunk_count) || 0;
      const label = chunkCount ? `Thinking\u2026 (${chunkCount} chunks)` : 'Thinking\u2026';
      return `<div class="thinking-placeholder" role="status" aria-live="polite">${escapeHtml(label)}</div>${truncationMarkup}`;
    }

    function buildToolCallMessage(row, messages, options) {
      const renderOptions = options || {};
      const sourceMessage = getSourceMessage(row, messages, renderOptions);
      if (sourceMessage) {
        return sourceMessage;
      }
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const fallbackMessageId = normalizeId(row && row.primary_message_id)
        || `${normalizeId(row && row.turn_id)}:tool_step:${resolveProjectedRowCallId(row)}`;
      return {
        id: fallbackMessageId,
        role: 'assistant',
        kind: 'tool_use',
        status: String(payload.state || 'requested'),
        tool_call: {
          call_id: resolveProjectedRowCallId(row),
          tool_name: String(payload.tool_name || ''),
          input: payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input)
            ? { ...payload.input }
            : {},
          input_json: String(payload.input_json || ''),
          summary: String(payload.summary || ''),
          status: String(payload.state || 'requested'),
          ...(Array.isArray(payload.user_questions) ? { user_questions: payload.user_questions } : {}),
          ...(normalizeId(payload.question_ref) ? { question_ref: normalizeId(payload.question_ref) } : {}),
        },
      };
    }

    function buildUserQuestionsMarkup(toolCallMessage, row) {
      const toolCall = toolCallMessage && toolCallMessage.tool_call && typeof toolCallMessage.tool_call === 'object'
        ? toolCallMessage.tool_call : {};
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const status = normalizeId(payload.state || toolCall.status);
      const toolName = normalizeId(payload.tool_name || toolCall.tool_name);
      const questions = Array.isArray(payload.user_questions) ? payload.user_questions : toolCall.user_questions;
      if (toolName !== 'ask_user') {
        return '';
      }
      // Stale demotion is client-side (dead waiter) — no tool_result event ever
      // lands, so the projector keeps deriving payload.state='pending_user_input'
      // from the unsettled event stream. The persisted stale mark must therefore
      // outrank the pending state, or a full row re-render (scroll recycle,
      // resize, later stream event) resurrects the interactive dead card.
      const staleKind = normalizeId(payload.user_questions_result_kind || toolCall.user_questions_result_kind);
      if (status === 'pending_user_input' && staleKind !== 'user_questions_stale') {
        return renderUserQuestionsBlock ? renderUserQuestionsBlock({
          toolCallId: normalizeId(payload.tool_call_id || toolCall.call_id),
          questionRef: normalizeId(payload.question_ref || toolCall.question_ref),
          questions: Array.isArray(questions) ? questions : [],
        }, { escapeHtml }) : '';
      }
      if (staleKind === 'user_questions_stale') {
        return renderUserQuestionsReceipt && Array.isArray(questions) ? renderUserQuestionsReceipt({
          toolCallId: normalizeId(payload.tool_call_id || toolCall.call_id),
          questions,
          stale: true,
        }, { escapeHtml }) : '';
      }
      const resultKind = normalizeId(payload.user_questions_result_kind);
      const answered = resultKind === 'user_questions_answered';
      if (!renderUserQuestionsReceipt
        || !Array.isArray(questions)
        || (answered && !Array.isArray(payload.user_questions_answers))
        || (!answered && resultKind !== 'user_questions_declined')) {
        return '';
      }
      return renderUserQuestionsReceipt({
        toolCallId: normalizeId(payload.tool_call_id || toolCall.call_id),
        questions,
        resultKind,
        answers: Array.isArray(payload.user_questions_answers) ? payload.user_questions_answers : [],
      }, { escapeHtml });
    }

    function buildToolCallRowMarkup(row, messages, options) {
      const questionMarkup = buildUserQuestionsMarkup(buildToolCallMessage(row, messages, options), row);
      return questionMarkup || buildDefaultToolCallRowMarkup(row, messages, options);
    }

    function buildToolStepRowMarkup(row, messages, options) {
      const renderOptions = options || {};
      const messageById = renderOptions.messageById;
      const toolCallMessage = buildToolCallMessage(row, messages, renderOptions);
      const questionMarkup = buildUserQuestionsMarkup(toolCallMessage, row);
      if (questionMarkup) {
        return questionMarkup;
      }
      const primaryMarkup = renderToolCallBlock(toolCallMessage, Array.isArray(messages) ? messages : [], {
        projectedToolRow: row,
        messageById,
        sessionId: renderOptions.sessionId,
        turnId: row && row.turn_id,
        rowId: row && row.row_id,
        turnIdByMessageId: renderOptions.turnIdByMessageId,
      });
      if (String(primaryMarkup || '').trim()) {
        return primaryMarkup;
      }
      return buildToolCallRowMarkup(row, messages, renderOptions);
    }

    function buildGenericSystemNoticeMarkup(row) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const text = String(
        payload.message
        || payload.content
        || payload.summary
        || payload.unknown_kind
        || payload.subkind
        || 'System notice'
      ).trim();
      if (!text) {
        return '';
      }
      return `<div class="chat-system-notice">${escapeHtml(text)}</div>`;
    }

    function buildSystemNoticeMessage(row, messages, options) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const sourceMessage = getSourceMessage(row, messages, options);
      const messageId = normalizeId(sourceMessage && sourceMessage.id)
        || normalizeId(row && row.primary_message_id)
        || `${normalizeId(row && row.turn_id)}:system_notice`;
      const base = {
        ...(sourceMessage && typeof sourceMessage === 'object' ? sourceMessage : {}),
        id: messageId,
        role: 'assistant',
        agent_status: payload.agent_status && typeof payload.agent_status === 'object'
          ? { ...payload.agent_status }
          : sourceMessage && sourceMessage.agent_status && typeof sourceMessage.agent_status === 'object'
            ? { ...sourceMessage.agent_status }
            : null,
        context_compacted: payload.context_compacted && typeof payload.context_compacted === 'object'
          ? { ...payload.context_compacted }
          : sourceMessage && sourceMessage.context_compacted && typeof sourceMessage.context_compacted === 'object'
            ? { ...sourceMessage.context_compacted }
            : null,
        context_compactions: Array.isArray(sourceMessage && sourceMessage.context_compactions)
          ? sourceMessage.context_compactions.map((entry) => ({ ...entry }))
          : [],
        stream_error: String(payload.stream_error || payload.message || sourceMessage && sourceMessage.stream_error || ''),
      };
      copyAssistantErrorRecoveryFields(base, payload, sourceMessage);
      if (isAgentProgressDurableEnabled() && Array.isArray(payload.agent_status_steps) && payload.agent_status_steps.length) {
        base.agent_status_steps = payload.agent_status_steps.map((step) => ({ ...step }));
      }
      return base;
    }

    function buildAgentProgressRowMarkup(row) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const steps = Array.isArray(payload.steps) ? payload.steps : [];
      if (!steps.length) {
        return '';
      }
      return renderAgentProgressRow({ steps, escapeHtml });
    }

    function buildPlanObjectRowMarkup(row) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      return planDocumentUtils?.legacyPlanObjectMarkup
        ? planDocumentUtils.legacyPlanObjectMarkup(payload, { escapeHtml, renderMarkdown })
        : '';
    }

    function buildPlanDocumentRowMarkup(row) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      return planDocumentUtils?.fullDocumentMarkup
        ? planDocumentUtils.fullDocumentMarkup(payload, { escapeHtml, renderMarkdown })
        : '';
    }

    function buildErrorCodeNoticeMarkup(row, renderMessage, suppressedErrors) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const errorCode = normalizeId(renderMessage && renderMessage.error_code) || normalizeId(payload.error_code);
      if (!errorCode && !hasAssistantErrorRecoveryMetadata(renderMessage)) {
        return '';
      }
      const folded = Array.isArray(suppressedErrors) ? suppressedErrors : [];
      /* Row-ID contract: turn_id IS the turn's parent_stream_id, so it is the
       * logs deep-link target for the card chip and the legacy row alike.
       * Stamped onto the notice message so the recovery path (which renders
       * the same card through the transcript adapter) links too when the
       * source message did not carry its own stream field. */
      const streamId = normalizeId(row && row.turn_id);
      const noticeMessage = {
        ...(renderMessage && typeof renderMessage === 'object' ? renderMessage : {}),
        ...(folded.length ? { suppressedErrors: folded } : {}),
      };
      if (streamId && !normalizeId(noticeMessage.stream_id)) {
        noticeMessage.stream_id = streamId;
      }
      const recoveryMarkup = renderAssistantFailureNotice(noticeMessage);
      if (recoveryMarkup) {
        const errorCodeAttr = errorCode ? ` data-error-code="${escapeHtml(errorCode)}"` : '';
        return `<div class="chat-error-row chat-error-row--recovery"${errorCodeAttr}>${recoveryMarkup}</div>`;
      }
      if (!errorCode) {
        return '';
      }
      const message = String(
        payload.stream_error
        || payload.message
        || payload.content
        || payload.summary
        || ''
      ).trim();
      const cardMarkup = renderTimelineErrorCardMarkup({
        error_code: errorCode,
        stream_error: message,
        id: renderMessage && renderMessage.id,
        session_id: renderMessage && (renderMessage.session_id || renderMessage.sessionId),
        status: renderMessage && renderMessage.status,
        suppressedErrors: folded,
      }, { streamId });
      if (cardMarkup) {
        return `<div class="chat-error-row chat-error-row--recovery" data-error-code="${escapeHtml(errorCode)}">${cardMarkup}</div>`;
      }
      /* @legacy-fallback — bare error row when the card module is unavailable.
       * The code still deep-links into the Activity tab (same
       * data-inv-error-action contract as the card chip) whenever the row
       * carries a turn id. */
      const messageHtml = message
        ? `<span class="chat-error-message">${escapeHtml(message)}</span>`
        : '';
      const codeLinkAttrs = streamId
        ? ` role="link" tabindex="0" data-inv-error-action="open_logs" data-stream-id="${escapeHtml(streamId)}"`
          + ` title="${escapeHtml(LOGS_DEEP_LINK_TITLE)}"`
        : '';
      return `<div class="chat-error-row" data-error-code="${escapeHtml(errorCode)}" role="alert"><span class="chat-error-code"${codeLinkAttrs}>${escapeHtml(errorCode)}</span>${messageHtml}</div>`;
    }

      function buildSystemNoticeRowMarkup(row, messages, options) {
        const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
        const subkind = normalizeId(payload.subkind).toLowerCase();
        if (subkind === 'orphan_carry') {
          return buildOrphanCarryNoticeMarkup(payload);
        }
        if (subkind === 'source_citations') {
        // Citations: persisted source_citations events render as a chip row
        // (renderer-citation-chips-utils). Flag-gated at render too so a
        // flag-off relaunch shows nothing even for events persisted while the
        // flag was on (the collector derive is the primary gate).
        if (getFeatureFlags()?.source_citations !== true) {
          return '';
        }
        const chipsModule = resolveTurnRowModule('rendererCitationChipsUtils', './renderer-citation-chips-utils');
        if (!chipsModule || typeof chipsModule.renderCitationChips !== 'function') {
          return '';
        }
        return chipsModule.renderCitationChips({ refs: payload.refs, escapeHtml });
      }
      const renderMessage = buildSystemNoticeMessage(row, messages, options);
      if (subkind === 'context_compacted') {
        return renderContextCompactedNotice(renderMessage) || buildGenericSystemNoticeMarkup(row);
      }
      if (subkind === 'agent_status') {
        return renderAgentStatusWidget(renderMessage) || buildGenericSystemNoticeMarkup(row);
      }
      if (subkind === 'assistant_error') {
        /* Same-turn dedupe (renderer-turn-row-error-dedupe-utils.js): one card per failed turn; a suppressed row returns '' HERE so it cannot leak back in via the fallback below. */
        const dedupe = resolveTurnErrorDedupe(row, options, normalizeId);
        if (dedupe.suppress) return '';
        const errorCodeMarkup = buildErrorCodeNoticeMarkup(row, renderMessage, dedupe.suppressedErrors);
        if (errorCodeMarkup) {
          return errorCodeMarkup;
        }
        return renderAssistantFailureNotice(renderMessage) || buildGenericSystemNoticeMarkup(row);
      }
      return buildGenericSystemNoticeMarkup(row);
    }

    function buildGenericRowMarkup(row) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const text = String(payload.content || payload.text || payload.summary || '').trim();
      if (!text) {
        return '';
      }
      return `<div class="chat-bubble">${escapeHtml(text)}</div>`;
    }

    function buildRowId(row) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const turnId = normalizeId(row && row.turn_id);
      const rowKind = normalizeId(row && row.kind);
      const fallbackId = normalizeId(row && row.row_id) || 'row';
      if (rowKind === 'reasoning') {
        const stableRowId = getFeatureFlags()?.chat_timeline_deterministic_row_id === true ? normalizeId(row && row.row_id) : '';
        return `${turnId}:reasoning:${stableRowId || normalizeId(payload.phase_id || row && row.phase_id || fallbackId)}`;
      }
      if (rowKind === 'assistant_text') {
        const groupIndex = payload.segment_group_index != null
          ? String(payload.segment_group_index)
          : String(row && row.segment_group_index != null ? row.segment_group_index : fallbackId);
        return `${turnId}:assistant_text:${groupIndex}`;
      }
      if (rowKind === 'tool_step') {
        return `${turnId}:tool_step:${normalizeId(payload.tool_call_id || row && row.tool_call_id || fallbackId)}`;
      }
      if (rowKind === 'tool_call') {
        return `${turnId}:tool_call:${normalizeId(payload.tool_call_id || row && row.tool_call_id || fallbackId)}`;
      }
      if (rowKind === 'tool_result') {
        return `${turnId}:tool_result:${normalizeId(payload.tool_call_id || row && row.tool_call_id || fallbackId)}`;
      }
      if (rowKind === 'approval_gap') {
        return `${turnId}:approval_gap:${normalizeId(payload.tool_call_id || row && row.tool_call_id || fallbackId)}`;
      }
      if (rowKind === 'system_notice') {
        return `${turnId}:system_notice:${normalizeId(payload.event_seq || fallbackId)}`;
      }
      if (rowKind === 'agent_progress') {
        return `${turnId}:agent_progress:${normalizeId(row && row.primary_message_id || fallbackId)}`;
      }
      if (rowKind === 'plan_object') {
        return `${turnId}:plan_object:${normalizeId(payload.plan_id || fallbackId)}`;
      }
      if (rowKind === 'plan_document') {
        return `${turnId}:plan_document:${normalizeId(payload.plan_id || fallbackId)}`;
      }
      return `${turnId}:${rowKind}:${fallbackId}`;
    }

    function isStreamingRow(row, options) {
      const renderOptions = options || {};
      if (typeof renderOptions.isStreamingRow === 'function') {
        return renderOptions.isStreamingRow(row) === true;
      }
      const rowId = buildRowId(row);
      if (normalizeId(renderOptions.streamingRowId) && normalizeId(renderOptions.streamingRowId) === rowId) {
        return true;
      }
      const primaryMessageId = normalizeId(row && row.primary_message_id);
      if (
        normalizeId(renderOptions.streamingMessageId)
        && normalizeId(renderOptions.streamingMessageId) === primaryMessageId
      ) {
        return true;
      }
      if (renderOptions.isStreaming !== true || String(row && row.kind || '') !== 'assistant_text') {
        return false;
      }
      // Fallback for a streaming turn whose ids never matched above: a
      // streaming-marked text row renders the live stream's reveal units
      // INSTEAD of its own payload text, so a row whose message carries an
      // explicit settled status is never the live one — claiming a settled
      // earlier segment blanks its text and mirrors the stream into it.
      // Unresolvable/status-less messages keep the legacy behavior.
      const message = renderOptions.messageById?.get?.(primaryMessageId) || null;
      const messageStatus = message && typeof message === 'object' ? normalizeId(message.status) : '';
      return !messageStatus || messageStatus === (MESSAGE_STATUS.STREAMING || 'streaming');
    }

    // These functions adapt projected row payloads to the message shapes consumed by transcript renderers.
    function buildRecapRowMarkup(row) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      return renderInteractiveRoundRecap({
        id: normalizeId(row && row.primary_message_id),
        content: String(payload.content || ''),
        interactive_round_recap: payload.interactive_round_recap || null,
      });
    }

    function buildSuggestionRowMarkup(row) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      return renderProactiveSuggestionBlock({
        id: normalizeId(row && row.primary_message_id),
        content: String(payload.content || ''),
        proactive_suggestion: payload.proactive_suggestion || null,
      });
    }

    function buildSlashOutputRowMarkup(row) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      // The projector carries only `content` in the slash_output row payload (no
      // slash_command), so renderSlashCommandOutput renders the '/command' default kicker.
      return renderSlashCommandOutput({
        id: normalizeId(row && row.primary_message_id),
        slash_command: String(payload.slash_command || ''),
        content: String(payload.content || ''),
      });
    }

    // B7a: a persisted question_batch projects to a `batch` row (now in
    // COALESCED_TURN_ROW_KINDS so it reaches the registry). Delegates to the
    // render-pipeline-supplied builder, which renders the LIVE editable
    // interactive panel inline when this batch is the session's active pending
    // batch, or a read-only summary otherwise. '' in headless contexts.
    function buildBatchRowMarkup(row) {
      return buildInteractiveBatchRowMarkup(row);
    }

    // Historical plan proposals share the collapsed receipt builder. The
    // legacy renderer module remains loaded for old transcript helpers only.
    function buildPlanProposalRowMarkup(row) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      return planDocumentUtils?.legacyPlanProposalMarkup
        ? planDocumentUtils.legacyPlanProposalMarkup(payload, { escapeHtml, renderMarkdown })
        : '';
    }

    // D3 (owner ruling): defensive-only. attachment_cluster is merged into user_bubble at
    // projection, so no standalone attachment row reaches here today; emitting chips would
    // be an unlabeled behavior change. Keep ''.
    function buildAttachmentRowMarkup() {
      return '';
    }

    // Single kind->builder registry collapsing the former Tier-1 if/else and the Tier-3
    // message.kind fallthrough into one dispatch. buildGenericRowMarkup stays the default
    // for genuinely-unknown future kinds. The tool_step entry is KEPT — the live reducer
    // still emits tool_step provisional rows (through B6); dropping it would strand live
    // tool rows into buildGenericRowMarkup (critic #1 / §7-D1).
    const ROW_BUILDERS = {
      user_bubble: buildUserBubbleRowMarkup,
      assistant_text: buildAssistantTextRowMarkup,
      reasoning: buildReasoningRowMarkup,
      tool_step: buildToolStepRowMarkup,
      tool_call: buildToolCallRowMarkup,
      tool_result: buildToolResultRowMarkup,
      approval_gap: buildApprovalGapMarkup,
      system_notice: buildSystemNoticeRowMarkup,
      agent_progress: buildAgentProgressRowMarkup,
      plan_object: buildPlanObjectRowMarkup,
      plan_document: buildPlanDocumentRowMarkup,
      recap: buildRecapRowMarkup,
      suggestion: buildSuggestionRowMarkup,
      slash_output: buildSlashOutputRowMarkup,
      batch: buildBatchRowMarkup,
      plan_proposal: buildPlanProposalRowMarkup,
      attachment: buildAttachmentRowMarkup,
    };

    function buildRowBodyMarkup(row, messages, options) {
      const builder = ROW_BUILDERS[normalizeId(row && row.kind)];
      return typeof builder === 'function'
        ? builder(row, messages, options)
        : buildGenericRowMarkup(row);
    }

    // Row-wrapper + turn-row-list assembly layer lives in the sibling
    // renderer-turn-row-list-utils.js; it consumes the body dispatch, identity,
    // and streaming detection built above as injected deps (keeps render-utils
    // under the file-size ceiling). buildTurnRowListMarkup is the only re-exposed
    // member — buildRowWrapperMarkup / buildTimelineV2SummaryAttributes stay
    // internal to the list builder, as they were before the extraction.
    const timelineOrientationUtils = resolveTurnRowModule(
      'rendererChatTimelineOrientationUtils',
      './renderer-chat-timeline-orientation-utils'
    );
    const { buildTurnRowListMarkup } = turnRowListUtils.createTurnRowListUtils({
      escapeHtml,
      normalizeId,
      buildTimelineV2Presentation,
      buildRowId,
      isStreamingRow,
      buildRowBodyMarkup,
      buildTimeDividerMarkup: typeof settings.buildTimeDividerMarkup === 'function'
        ? settings.buildTimeDividerMarkup
        : timelineOrientationUtils?.buildTimeDividerMarkup,
    });

    return {
      buildAssistantTextRowMarkup,
      buildReasoningRowMarkup,
      buildToolStepRowMarkup,
      buildToolCallRowMarkup,
      buildToolResultRowMarkup,
      buildApprovalGapMarkup,
      buildSystemNoticeRowMarkup,
      buildRecapRowMarkup,
      buildSuggestionRowMarkup,
      buildSlashOutputRowMarkup,
      buildBatchRowMarkup,
      buildAttachmentRowMarkup,
      buildRowBodyMarkup,
      ROW_BUILDERS,
      buildRowId,
      buildTurnRowListMarkup,
      formatDurationMs,
      getMessageById,
    };
  }

  return {
    createTurnRowRenderUtils,
  };
});
