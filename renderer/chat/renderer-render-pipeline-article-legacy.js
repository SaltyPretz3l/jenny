/* renderer/chat/renderer-render-pipeline-article-legacy.js
 * The per-message ("legacy") article path of the article markup pipeline: the
 * message bubble markup, the inline user-message editor swap, the token meta
 * label, application-turn notes and the dispatcher fallback
 * (buildMessageArticleMarkupLegacy). Split out of
 * renderer-render-pipeline-article-markup.js, which composes it and keeps the
 * projected turn-article path.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineArticleLegacy = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  // source_citations: strip settled [web:N] markers like the row-model bubble.
  const resolveCitationChipsUtils = () => globalThis.rendererCitationChipsUtils
    || (typeof require === 'function' ? require('./renderer-citation-chips-utils') : null) || {};
  function createLegacyArticleMarkup(deps) {
    const {
      state = {},
      MESSAGE_STATUS = {},
      chatTimeline = null,
      callbacks = {},
      // Resolved by the article markup pipeline (shared with the turn-article path):
      escapeHtml,
      buildMessageShellArticle,
      renderMessageHoverRow,
      buildAssistantMetaLabel,
      buildMessageTokenMeta,
      formatMessageTokenMeta,
      combineMessageMetaLabels,
      formatMessageTerminalTimestamp,
      buildStreamingBubbleMarkup,
      recordTurnArticleRolloutSignal,
      getPaneSessionId,
      paneSessionIsPrimary,
      getPaneTranscriptView,
      resolveSelectionState,
      maybePredictArticleHeight,
      buildThreadCompatAnchor,
      isBlankAssistantSegmentMessage,
    } = deps;
    const {
      buildToolEntryInnerMarkup = () => '',
      resolveProjectedPrimaryRow = () => null,
      buildInteractiveRecapModel = () => null,
      buildMessageBodyShell = () => '',
      buildAssistantContentShell = () => '',
      buildTurnRowId = () => '',
      renderMarkdown = (value) => String(value || ''),
      renderAgentStatusWidget = () => '',
      renderContextCompactedNotice = () => '',
      renderThinkingWidget = () => '',
      renderAssistantFailureNotice = () => '',
      renderMessageAttachments = () => '',
      renderInteractiveRoundRecap = () => '',
      renderProactiveSuggestionBlock = () => '',
      renderSlashCommandOutput = () => '',
      // Addressed session messages (role:'context'): attributed cards that render before
      // the turn's user bubble as their own article (renderer-session-message-rows.js).
      renderSessionMessage = (message, extra) => {
        const rows = globalThis.rendererSessionMessageRows
          || (typeof require === 'function' ? (() => { try { return require('./renderer-session-message-rows'); } catch (_error) { return null; } })() : null);
        return rows ? rows.renderSessionMessage(message, { escapeHtml, getSessions: () => state?.sessions, ...extra }) : '';
      },
    } = callbacks;

    let cachedTokenFingerprint = '';
    let cachedTokenMetaById = null;
    function buildTokenMessagesFingerprint(messages) {
      const list = Array.isArray(messages) ? messages : [];
      return list.map(function mapTokenMessageFingerprint(message) {
        const visibleSegments = Array.isArray(message?.visible_segments) ? message.visible_segments : [];
        const segmentTextLength = visibleSegments.reduce(function sumSegmentTextLength(total, segment) {
          return total + String(segment?.text || '').length;
        }, 0);
        return [
          String(message?.id || ''),
          String(message?.role || ''),
          String(message?.kind || ''),
          String(message?.status || ''),
          String(message?.content || '').length,
          visibleSegments.length,
          segmentTextLength,
        ].join(':');
      }).join('|');
    }

    function resolveTokenMessagesFingerprint(messages, projectionContext) {
      const renderSignature = String(projectionContext?.messageTokenSignature || '').trim();
      return renderSignature || buildTokenMessagesFingerprint(messages);
    }

    function resolveMessageTokenMetaLabel(message, messages, projectionContext) {
      const messageId = String(message?.id || '').trim();
      if (!messageId || typeof buildMessageTokenMeta !== 'function') {
        return '';
      }
      const fingerprint = resolveTokenMessagesFingerprint(messages, projectionContext);
      // Gate the rebuild on the content fingerprint only (finding #37): the
      // messages array is rebuilt every render (immutable updates), so the old
      // array-identity check defeated the cache and ran buildMessageTokenMeta on
      // every render even when nothing changed.
      if (cachedTokenFingerprint !== fingerprint) {
        cachedTokenFingerprint = fingerprint;
        cachedTokenMetaById = buildMessageTokenMeta(messages);
      }
      if (!cachedTokenMetaById || typeof cachedTokenMetaById.get !== 'function') {
        return '';
      }
      return typeof formatMessageTokenMeta === 'function'
        ? formatMessageTokenMeta(cachedTokenMetaById.get(messageId))
        : '';
    }

    function buildMessageMetaLabel(baseLabel, message, messages, projectionContext) {
      const tokenLabel = resolveMessageTokenMetaLabel(message, messages, projectionContext);
      if (typeof combineMessageMetaLabels === 'function') {
        return combineMessageMetaLabels(baseLabel, tokenLabel);
      }
      return [baseLabel, tokenLabel].filter(Boolean).join(' · ');
    }

    // F2: inline edit affordance for the legacy article-markup path. Delegates
    // to the inventory primitive at renderer/inventory/inline-text-editor.js
    // so raw textarea + button markup stays inside renderer/inventory/.
    function buildLegacyEditingUserBubbleMarkup(messageId, draftText, options) {
      const opts = options || {};
      const inventory = typeof globalThis !== 'undefined'
        ? globalThis.inventoryInlineTextEditor
        : null;
      if (inventory && typeof inventory.buildInlineUserMessageEditorMarkup === 'function') {
        return inventory.buildInlineUserMessageEditorMarkup({
          messageId,
          draftText,
          committing: opts.committing === true,
          affectedCount: opts.affectedCount,
        });
      }
      // Fallback if inventory isn't loaded yet — keep the bubble usable.
      const id = String(messageId || '');
      const draft = String(draftText == null ? '' : draftText);
      return `<div class="chat-bubble chat-bubble-editing" dir="auto" data-message-id="${escapeHtml(id)}" data-pin-fade-trigger="user">${escapeHtml(draft)}</div>`;
    }

    function buildMessageInnerMarkup(
      message,
      messages,
      latestAssistantMessageId,
      latestReplyAssistantMessageId,
      followUpDisabledReason,
      regenerateRequest,
      projectionContext
    ) {
      const status = String(message.status || '');
      const metaLabel = buildMessageMetaLabel(
        buildAssistantMetaLabel(message, formatMessageTerminalTimestamp),
        message,
        messages,
        projectionContext
      );
      const agentStatusMarkup = message.role === 'assistant' ? renderAgentStatusWidget(message) : '';
      const contextCompactedMarkup = message.role === 'assistant' ? renderContextCompactedNotice(message) : '';
      const thinkingMarkup = message.role === 'assistant'
        ? renderThinkingWidget(message, latestAssistantMessageId, { transcriptView: getPaneTranscriptView() })
        : '';
      const failureMarkup = message.role === 'assistant' ? renderAssistantFailureNotice(message) : '';
      const editingMessageId = state.ui && typeof state.ui.editingMessageId === 'string'
        ? state.ui.editingMessageId
        : '';
      const actionOptions = {
        latestReplyAssistantMessageId,
        followUpActionsBusy: Boolean(followUpDisabledReason),
        followUpDisabledReason,
        regenerateRequest,
        editingMessageId,
        branchUnavailable: paneSessionIsPrimary(),
      };
      let bubbleInnerHtml = null;
      let streamUnits = null;
      let streamChangedStart = -1;
      let messageMarkup;
      const sessionMessageMarkup = String(message.role || '') === 'context'
        ? renderSessionMessage(message, { wokeTurn: wakeCardRole(message, messages) }) : '';
      if (sessionMessageMarkup) {
        messageMarkup = sessionMessageMarkup;
      } else if (message.kind === 'interactive_round_recap') {
        const recapModel = buildInteractiveRecapModel(message);
        messageMarkup = renderInteractiveRoundRecap(message, {
          recapModel,
          sessionId: getPaneSessionId(),
        });
      } else if (message.kind === 'proactive_suggestion') {
        messageMarkup = renderProactiveSuggestionBlock(message);
      } else if (message.kind === 'slash_command_output') {
        messageMarkup = renderSlashCommandOutput(message);
      } else if (message.kind === 'memory_note') {
        // The reflection receipt (row 58 W2): the run's memory chips with Undo, folded when several.
        messageMarkup = globalThis.rendererMemoryChatEntry?.buildMemoryNotesMarkup?.(message.memory_notes,
          { escapeHtml, sessionId: getPaneSessionId(), groupId: message.id }) || '';
      } else if (message.kind === 'tool_use') {
        messageMarkup = buildToolEntryInnerMarkup(message, messages, projectionContext);
      } else if (message.role === 'assistant' && status === MESSAGE_STATUS.STREAMING && message.id === latestAssistantMessageId) {
        if (String(message.content || '').trim()) {
          const revealModel = buildStreamingBubbleMarkup(message);
          bubbleInnerHtml = revealModel.bubbleInnerHtml;
          streamUnits = revealModel.streamUnits;
          streamChangedStart = revealModel.streamChangedStart;
          messageMarkup = `<div class="chat-bubble chat-bubble-markdown chat-bubble-streaming" dir="auto" data-streaming-bubble="true" role="status" aria-live="polite" aria-atomic="false" aria-label="${escapeHtml(jt('chat.article.streamingAssistantResponse', 'Assistant response (streaming)'))}">${revealModel.bubbleInnerHtml}</div>`;
        } else {
          messageMarkup = '';
        }
      } else if (message.role === 'assistant') {
        const imageReferences = globalThis.rendererArtifactImageReferences
          || (typeof require === 'function' ? require('./renderer-artifact-image-references') : null);
        const markdownHtml = renderMarkdown((resolveCitationChipsUtils().stripCitationMarkersForFlags || String)(message.content, state?.features?.featureFlags));
        const bodyHtml = imageReferences?.createRewriter(messages, message, getPaneSessionId(), chatTimeline?.ownerDocument || globalThis.document)(markdownHtml) ?? markdownHtml;
        messageMarkup = String(message.content || '').trim()
          ? `<div class="chat-bubble chat-bubble-markdown" dir="auto">${bodyHtml}</div>`
          : '';
      } else if (message.role === 'user') {
        // F2: when this user message is the active edit target, swap the
        // bubble for the inline editor. editingMessageId is hoisted above
        // so this branch + the actionOptions share one state.ui read.
        const messageIdForEdit = String(message.id || '').trim();
        if (editingMessageId && editingMessageId === messageIdForEdit) {
          const draftText = state.ui && typeof state.ui.editingDraftText === 'string'
            ? state.ui.editingDraftText
            : String(message.content || '');
          const committing = state.ui && state.ui.editCommitting === true;
          const affectedCount = Math.max(Number(state.ui?.editingAffectedCount) || 0, 0);
          messageMarkup = buildLegacyEditingUserBubbleMarkup(messageIdForEdit, draftText, { committing, affectedCount });
        } else {
          // EH-W6: failed-send chip from message.send_failure (mirrors the
          // V2 row builder in renderer-turn-row-render-utils.js).
          const sendFailure = message.send_failure;
          const sendFailureActive = sendFailure
            && sendFailure.state === 'failed'
            && sendFailure.dismissed !== true;
          const failureChip = sendFailureActive
          ? '<span class="chat-bubble-send-status" role="status">' + escapeHtml(jt('chat.article.failedToSend', 'Failed to send')) + '</span>'
            : '';
          const sendStateAttr = sendFailureActive ? ' data-send-state="failed"' : '';
          messageMarkup = `<div class="chat-bubble chat-bubble-markdown" dir="auto" data-pin-fade-trigger="user"${sendStateAttr}>${renderMarkdown(message.content, { breaks: true, literalBackslashes: true })}${failureChip}</div>`;
        }
      } else {
        messageMarkup = `<div class="chat-bubble" dir="auto">${escapeHtml(message.content)}</div>`;
      }
      const predictionHtml = `
            <div class="chat-role sr-only">${escapeHtml(message.role)}</div>
            ${contextCompactedMarkup}
            ${agentStatusMarkup}
            ${thinkingMarkup}
            ${messageMarkup}
            ${failureMarkup}
            ${renderMessageAttachments(message)}
          `;
      return {
        status,
        pending: status === MESSAGE_STATUS.STREAMING,
        finalizedAt: escapeHtml(message.finalizedAt || ''),
        thinkingMarkup,
        bubbleInnerHtml,
        streamUnits,
        streamChangedStart,
        predictionHtml: predictionHtml,
        innerHtml: `
            ${predictionHtml}
            ${message.kind === 'tool_use' || message.kind === 'memory_note' || sessionMessageMarkup ? '' : renderMessageHoverRow(message, actionOptions, metaLabel)}
          `,
      };
    }

    function buildMessageArticleInnerHtml(message, innerHtml, rowOptions) {
      if (String(message?.role || '') === 'assistant') {
        return buildAssistantContentShell(message?.id, innerHtml, rowOptions);
      }
      return buildMessageBodyShell(message?.id, innerHtml, rowOptions);
    }

    // App-started turns (chat-bubble-action-utils.js applicationTurnOf) are not the person's
    // messages. A New session preparation or wake turn draws no row: the proposal card or the mail
    // card above says why it ran. An auto-resume has no card, so it keeps one quiet line.
    const HIDDEN_APPLICATION_TURNS = new Set(['handoff_preparation', 'wake']);
    function applicationTurnOf(message) {
      const actions = globalThis.chatBubbleActionUtils
        || (typeof require === 'function' ? require('./chat-bubble-action-utils') : null);
      return actions?.applicationTurnOf ? actions.applicationTurnOf(message) : '';
    }

    // The first mail card of a wake turn (context rows sit right before the turn's user row) says
    // it woke the chat: 'jenny' in the primary chat, 'chat' elsewhere; '' for any other card.
    function wakeCardRole(message, messages) {
      const list = Array.isArray(messages) ? messages : [];
      const index = list.findIndex((entry) => entry && entry.id === message?.id);
      if (index < 0 || (index > 0 && String(list[index - 1]?.role || '') === 'context')) return '';
      let next = index + 1;
      while (next < list.length && String(list[next]?.role || '') === 'context') next += 1;
      if (applicationTurnOf(list[next]) !== 'wake') return '';
      return paneSessionIsPrimary() ? 'jenny' : 'chat';
    }

    function formatNoteTime(value) {
      const stamp = Date.parse(String(value || ''));
      if (!Number.isFinite(stamp)) return '';
      try {
        return new Date(stamp).toLocaleTimeString(globalThis.jennyI18n?.tag?.(), {
          hour: 'numeric', ...globalThis.jennyI18n?.timeOptions?.(), minute: '2-digit',
        });
      } catch (_error) {
        return '';
      }
    }

    function buildApplicationTurnNoteArticle(message) {
      const time = formatNoteTime(message.timestamp);
      const actions = globalThis.chatBubbleActionUtils
        || (typeof require === 'function' ? require('./chat-bubble-action-utils') : null);
      const text = actions?.applicationTurnNoteText
        ? actions.applicationTurnNoteText(message)
        : jt('chat.applicationTurn.autoResumed', 'Resumed automatically after a turn-budget stop');
      return buildMessageShellArticle({
        className: 'app-turn-note-entry',
        messageId: message.id,
        messageRole: 'system',
        messageStatus: MESSAGE_STATUS.COMPLETE || 'complete',
        innerHtml: `<p class="chat-app-turn-note" role="note"><span>${escapeHtml(text)}</span>`
          + (time ? `<span class="chat-app-turn-note-time">${escapeHtml(time)}</span>` : '') + '</p>',
      });
    }

    // @legacy-fallback (NOT dead code): the dispatcher lands here when
    // canRenderProjectedTurnArticle is false (turn not yet coalesced, or a row
    // kind outside COALESCED_TURN_ROW_KINDS). Removal is gated on the
    // `legacy_message_article_markup_render` signal staying at zero for a
    // sprint (docs/archive/RENDER_PIPELINE_SPLIT_PLAN.md §4).
    function buildMessageArticleMarkupLegacy(
      message,
      messages,
      latestAssistantMessageId,
      latestReplyAssistantMessageId,
      followUpDisabledReason,
      regenerateRequest,
      projectionContext
    ) {
      const messageRole = String(message?.role || '').trim();
      // A memory note always renders here by design (it belongs to no turn).
      if (messageRole === 'assistant' && message.kind !== 'memory_note' && !isBlankAssistantSegmentMessage(message)) {
        recordTurnArticleRolloutSignal('legacy_message_article_markup_render', {
          messageId: String(message?.id || '').trim(),
          messageKind: String(message?.kind || '').trim(),
          messageRole,
        });
      }
      // tool_result never renders a standalone article: its data lives on the
      // paired tool_use's ToolStepRow (renderer-turn-row-projector.js). Read it
      // via resolveProjectedPrimaryRow(...).tool_result_payload or the transcript
      // tool-call renderer; no [data-message-kind="tool_result"] article exists.
      if (message.kind === 'tool_result') {
        return '';
      }
      const applicationTurn = applicationTurnOf(message);
      if (HIDDEN_APPLICATION_TURNS.has(applicationTurn)) return buildThreadCompatAnchor(message, { envelopeSibling: true });
      if (applicationTurn) return buildApplicationTurnNoteArticle(message);
      const messageModel = buildMessageInnerMarkup(
        message,
        messages,
        latestAssistantMessageId,
        latestReplyAssistantMessageId,
        followUpDisabledReason,
        regenerateRequest,
        projectionContext
      );
      messageModel.predictedHeight = maybePredictArticleHeight(
        message,
        messageModel.predictionHtml,
        String(message.content || ''),
        projectionContext
      );
      const projectedRow = message.kind === 'tool_use'
        ? resolveProjectedPrimaryRow(message, projectionContext)
        : null;
      // F4/F5/F6: surface selection state on the article (data-selected + handle).
      const selectionStateLegacy = resolveSelectionState(message.id);
      return buildMessageShellArticle({
        className: message.kind === 'tool_use'
          ? 'assistant tool-entry'
          : `${String(message.role || '')}${messageModel.status === MESSAGE_STATUS.STREAMING ? ' pending' : ''}`,
        messageId: message.id,
        messageRole: message.role,
        messageStatus: message.kind === 'tool_use' ? String(message.status || '') : messageModel.status,
        finalizedAt: messageModel.finalizedAt,
        predictedHeight: messageModel.predictedHeight,
        selectionMode: selectionStateLegacy.selectionMode,
        selected: selectionStateLegacy.selected,
        // Ht-D: legacy per-message articles have no approval_gap row concept
        // (that's a projected-turn-article row kind) — pending/streaming is
        // the only exemption signal here.
        cvExempt: messageModel.status === MESSAGE_STATUS.STREAMING,
        innerHtml: buildMessageArticleInnerHtml(message, messageModel.innerHtml, projectedRow
          ? {
              rowId: buildTurnRowId(projectedRow),
              sourceMessageId: projectedRow.primary_message_id,
            }
          : undefined),
      });
    }

    return {
      buildMessageInnerMarkup,
      buildMessageArticleInnerHtml,
      buildMessageArticleMarkupLegacy,
    };
  }

  return { createLegacyArticleMarkup };
});
