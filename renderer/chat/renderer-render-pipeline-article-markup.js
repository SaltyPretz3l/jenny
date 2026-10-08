/* renderer/chat/renderer-render-pipeline-article-markup.js
 * The factory owns article markup, receives upstream projection and thread
 * helpers, and retains a reachable per-message fallback when projected-turn
 * rendering is unavailable.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineArticleMarkupUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  // source_citations: strip settled [web:N] markers like the row-model bubble.
  const resolveCitationChipsUtils = () => globalThis.rendererCitationChipsUtils
    || (typeof require === 'function' ? require('./renderer-citation-chips-utils') : null) || {};
  const resolveArticlePredictionUtils = () => globalThis.rendererRenderPipelineArticlePrediction
    || (typeof require === 'function' ? require('./renderer-render-pipeline-article-prediction') : null);
  function createArticleMarkupPipeline(deps) {
    const {
      state = {},
      constants = {},
      dom = {},
      controllers = {},
      callbacks = {},
    } = deps || {};
    const { MESSAGE_STATUS = {} } = constants;
    const { chatTimeline = null, chatThreadColumn = null } = dom;
    const {
      // Upstream pipeline methods (projection-cache C1, hydration C2,
      // projection-context C3, thread-state B1, thinking B3):
      buildToolEntryInnerMarkup = () => '',
      resolveProjectedPrimaryRow = () => null,
      resolveResumeTailAssistantMessageId = () => '',
      resolveArticlePredictionCacheKey = () => '',
      getMessageFromCollection = () => null,
      deriveActionTargetMessageId = () => '',
      resolveVisibleTurnArticleTarget = () => null,
      recordTurnArticleRolloutSignal = () => {},
      resolveProjectionStreamingRowId = () => '',
      buildInteractiveRecapModel = () => null,
      // turn-shell + turn-row siblings:
      buildMessageShellArticle = () => '',
      buildMessageBodyShell = () => '',
      buildAssistantContentShell = () => '',
      buildTurnRowListMarkup = () => '',
      buildTurnRowId = () => '',
      // streaming-reveal helper:
      buildStreamingBubbleMarkup = (message) => ({
        bubbleInnerHtml: '',
        streamUnits: null,
        streamChangedStart: -1,
      }),
      // Injected renderer callbacks:
      escapeHtml = (value) => String(value || ''),
      renderMarkdown = (value) => String(value || ''),
      buildAssistantMetaLabel = () => '',
      buildMessageTokenMeta = () => new Map(),
      formatMessageTokenMeta = () => '',
      combineMessageMetaLabels = (primary, secondary) => [primary, secondary].filter(Boolean).join(' · '),
      renderAgentStatusWidget = () => '',
      renderContextCompactedNotice = () => '',
      renderThinkingWidget = () => '',
      renderAssistantFailureNotice = () => '',
      renderMessageAttachments = () => '',
      renderMessageHoverRow = () => '',
      renderInteractiveRoundRecap = () => '',
      renderProactiveSuggestionBlock = () => '',
      renderSlashCommandOutput = () => '',
      formatMessageTerminalTimestamp = () => '',
      isArtifactReviewVisible = () => false,
      // Split view W1-4a: the session this pane shows (one pane: currentSessionId).
      getPaneSessionId = () => String(state.currentSessionId || '').trim(),
      // Transcript view of the session this pane shows (renderer-render-pipeline-utils.js).
      getPaneTranscriptView = () => 'thinking',
      // Split view W3-1: does THIS pane own selection mode (a bag without one is pane 0)?
      isPaneSelecting = () => state?.ui?.selectionModePaneId === 0,
    } = callbacks;

    // F4/F5/F6: per-render selection-state probes. Hot path (selectionMode
    // off) returns a single frozen object so we don't allocate per row.
    const SELECTION_STATE_OFF = Object.freeze({ selectionMode: false, selected: false });
    const SELECTION_STATE_ON_UNSELECTED = Object.freeze({ selectionMode: true, selected: false });
    let cachedSelectionSet = null;
    let cachedSelectionSetSessionId = '';
    function resolveSelectionState(messageId) {
      if (!state || !state.ui || isPaneSelecting() !== true) {
        cachedSelectionSet = null;
        cachedSelectionSetSessionId = '';
        return SELECTION_STATE_OFF;
      }
      const sessionId = getPaneSessionId();
      const idsBySession = state.ui.selectedMessageIdsBySession;
      if (!sessionId || !(idsBySession instanceof Map)) {
        return SELECTION_STATE_ON_UNSELECTED;
      }
      const currentSelectionSet = idsBySession.get(sessionId) || null;
      if (cachedSelectionSetSessionId !== sessionId || cachedSelectionSet !== currentSelectionSet) {
        cachedSelectionSetSessionId = sessionId;
        cachedSelectionSet = currentSelectionSet;
      }
      if (!(cachedSelectionSet instanceof Set)) return SELECTION_STATE_ON_UNSELECTED;
      return cachedSelectionSet.has(String(messageId || '').trim())
        ? { selectionMode: true, selected: true }
        : SELECTION_STATE_ON_UNSELECTED;
    }

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
      };
      let bubbleInnerHtml = null;
      let streamUnits = null;
      let streamChangedStart = -1;
      let messageMarkup;
      if (message.kind === 'interactive_round_recap') {
        const recapModel = buildInteractiveRecapModel(message);
        messageMarkup = renderInteractiveRoundRecap(message, {
          recapModel,
          sessionId: getPaneSessionId(),
        });
      } else if (message.kind === 'proactive_suggestion') {
        messageMarkup = renderProactiveSuggestionBlock(message);
      } else if (message.kind === 'slash_command_output') {
        messageMarkup = renderSlashCommandOutput(message);
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
        messageMarkup = String(message.content || '').trim()
          ? `<div class="chat-bubble chat-bubble-markdown" dir="auto">${renderMarkdown((resolveCitationChipsUtils().stripCitationMarkersForFlags || String)(message.content, state?.features?.featureFlags))}</div>`
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
            ${message.kind === 'tool_use' ? '' : renderMessageHoverRow(message, actionOptions, metaLabel)}
          `,
      };
    }

    function buildMessageArticleInnerHtml(message, innerHtml, rowOptions) {
      if (String(message?.role || '') === 'assistant') {
        return buildAssistantContentShell(message?.id, innerHtml, rowOptions);
      }
      return buildMessageBodyShell(message?.id, innerHtml, rowOptions);
    }

    // Height prediction and the predicted-height cleanup live in
    // renderer-render-pipeline-article-prediction.js (split at the line cap).
    const {
      maybePredictArticleHeight,
      maybePredictTurnHeight,
      schedulePredictedHeightCleanup,
      syncPatchedArticlePrediction,
    } = resolveArticlePredictionUtils().createArticlePrediction({
      state,
      chatTimeline,
      chatThreadColumn,
      resolveArticlePredictionCacheKey,
      resolveVisibleTurnArticleTarget,
      buildTurnRowListMarkup,
    });

    const COALESCED_TURN_ROW_KINDS = new Set([
      'assistant_text',
      'reasoning',
      'tool_step',
      'tool_call',
      'tool_result',
      'approval_gap',
      'system_notice',
      'agent_progress',
      // B7a: interactive batch/recap rows are now first-class. Routing them
      // through the Tier-1 registry (buildBatchRowMarkup / buildRecapRowMarkup)
      // renders the interactive panel inline instead of the legacy per-message
      // Tier-3 path (a plain bubble for batch).
      'batch',
      'recap',
      // Historical plan-proposal summaries ride the same first-class row path.
      'plan_proposal',
      // Plan proposal, plan object, and plan document rows use the first-class coalesced-turn row path.
      'plan_object',
      'plan_document',
    ]);

    // Turn-activity envelope (coalesced turn articles): the coalesce helpers
    // load as their own script; resolve lazily so script order stays free.
    function resolveTurnArticleCoalesceUtils() {
      const utils = typeof globalThis !== 'undefined'
        ? globalThis.rendererTurnArticleCoalesceUtils
        : null;
      return utils
        && typeof utils.collectTurnRenderRows === 'function'
        && typeof utils.deriveTurnArticleAnchorMessageId === 'function'
        ? utils
        : null;
    }

    // A blank plain assistant segment carries nothing a reader could lose —
    // no kind, no content, no attachments, no reasoning entries. Rollout
    // signals skip these so the Ht-F canaries only fire for shapes where
    // content could actually be missing. (Mirrors the claim predicate in
    // renderer-turn-tree-projector-persistence.js — keep the two in sync.)
    function isBlankAssistantSegmentMessage(message) {
      if (String(message?.kind || '').trim()) {
        return false;
      }
      if (String(message?.content || '').trim()) {
        return false;
      }
      if (Array.isArray(message?.attachments) && message.attachments.length > 0) {
        return false;
      }
      const reasoningEntries = message?.reasoning?.entries;
      return !(Array.isArray(reasoningEntries) && reasoningEntries.length > 0);
    }

    function canRenderProjectedTurnArticle(turn, rows) {
      const primaryAssistantMessageId = String(turn?.primary_assistant_message_id || '').trim();
      if (!primaryAssistantMessageId) {
        return false;
      }
      const visibleRows = (Array.isArray(rows) ? rows : []).filter(function filterVisibleRows(row) {
        return row && String(row.kind || '').trim() !== 'user_bubble';
      });
      return visibleRows.length > 0 && visibleRows.every(function hasSupportedKind(row) {
        return COALESCED_TURN_ROW_KINDS.has(String(row?.kind || '').trim());
      });
    }

    function buildTurnArticleMarkup(turn, rows, messages, options) {
      const renderOptions = options || {};
      const projectionContext = renderOptions.projectionContext || null;
      const sourceRows = (Array.isArray(rows) ? rows : []).filter(function excludeUserBubble(row) {
        return row && String(row.kind || '') !== 'user_bubble';
      });
      const renderMessageId = String(renderOptions.renderMessageId || '').trim();
      const primaryMessageId = renderMessageId
        || String(turn && turn.primary_assistant_message_id || '').trim()
        || String(sourceRows[0] && sourceRows[0].primary_message_id || '').trim();
      const articleMessageId = primaryMessageId;
      if (!primaryMessageId) {
        return '';
      }
      const actionTargetMessageId = deriveActionTargetMessageId(turn, sourceRows) || primaryMessageId;
      const primaryMessage = getMessageFromCollection(primaryMessageId, messages, projectionContext)
        || { id: primaryMessageId, role: 'assistant', status: 'complete' };
      const actionTargetMessage = getMessageFromCollection(actionTargetMessageId, messages, projectionContext)
        || primaryMessage;
      const latestReplyAssistantMessageId = renderOptions.latestReplyAssistantMessageId != null
        ? renderOptions.latestReplyAssistantMessageId
        : articleMessageId;
      const actionOptions = {
        latestReplyAssistantMessageId,
        followUpActionsBusy: Boolean(renderOptions.followUpDisabledReason),
        followUpDisabledReason: renderOptions.followUpDisabledReason,
        regenerateRequest: renderOptions.regenerateRequest,
        editingMessageId: state.ui && typeof state.ui.editingMessageId === 'string'
          ? state.ui.editingMessageId
          : '',
      };
      // Footer label: a terminal assistant_error notice on the turn outranks
      // the contentful action target (which stays the copy/regenerate target),
      // so a failed turn reads "Failed", never "Completed".
      const errorDedupeApi = (typeof globalThis !== 'undefined' && globalThis.rendererTurnRowErrorDedupeUtils) || null;
      const terminalErrorMessage = errorDedupeApi && typeof errorDedupeApi.findTerminalAssistantErrorMessage === 'function'
        ? errorDedupeApi.findTerminalAssistantErrorMessage(
            sourceRows,
            (messageId) => getMessageFromCollection(messageId, messages, projectionContext)
          )
        : null;
      const turnMessageIds = [...new Set(Array.isArray(turn?.source_message_ids) ? turn.source_message_ids : [actionTargetMessageId])];
      const turnMessages = turnMessageIds.map((id) => getMessageFromCollection(id, messages, projectionContext)).filter((item) => item?.role === 'assistant');
      const tokenMeta = buildMessageTokenMeta(turnMessages, turnMessageIds).get(actionTargetMessageId);
      const metaLabel = combineMessageMetaLabels(
        buildAssistantMetaLabel(terminalErrorMessage || actionTargetMessage, formatMessageTerminalTimestamp, turnMessages, turn),
        formatMessageTokenMeta(tokenMeta)
      );
      const hasActiveStreamingMessage = String(projectionContext?.activeStreamingMessageId || '').trim() !== '';
      const isStreaming = hasActiveStreamingMessage && (
        renderOptions.isStreaming === true || turnMessageIds.some(function hasStreamingMessage(messageId) {
          return String(getMessageFromCollection(messageId, messages, projectionContext)?.status || '') === MESSAGE_STATUS.STREAMING;
        })
      );
      const streamingMessageId = isStreaming
        ? String(renderOptions.streamingMessageId || '').trim()
        : '';
      const streamingMessage = streamingMessageId
        ? getMessageFromCollection(streamingMessageId, messages, projectionContext)
        : null;
      const streamingRevealModel = streamingMessage && String(streamingMessage.content || '').trim()
        ? buildStreamingBubbleMarkup(streamingMessage)
        : null;
      const turnPhaseApi = (typeof globalThis !== 'undefined' && globalThis.rendererTurnPhase) || null;
      const turnViewModelForPhase = projectionContext?.viewModelByTurnId instanceof Map
        ? projectionContext.viewModelByTurnId.get(String(turn?.turn_id || '').trim()) || null
        : null;
      let turnPhaseForMarkup = turnPhaseApi && typeof turnPhaseApi.deriveTurnPhase === 'function' && turnViewModelForPhase
        ? turnPhaseApi.deriveTurnPhase(turnViewModelForPhase)
        : '';
      // review_artifact is consumer-supplied: when the split review panel is
      // visible, surface it on the latest settled turn so the turn row tracks
      // the review context without a second lifecycle authority.
      const latestAssistantMessageId = renderOptions.latestReplyAssistantMessageId != null
        ? String(renderOptions.latestReplyAssistantMessageId || '').trim()
        : '';
      const isLatestTurn = !latestAssistantMessageId
        || latestAssistantMessageId === articleMessageId;
      if (
        turnPhaseForMarkup === 'done'
        && isLatestTurn
        && typeof isArtifactReviewVisible === 'function'
        && isArtifactReviewVisible() === true
      ) {
        turnPhaseForMarkup = 'review_artifact';
      }
      // The transcript view rides the row-list options (expansion defaults are
      // baked into row markup); the prediction below must see the same value.
      const transcriptView = renderOptions.transcriptView || getPaneTranscriptView();
      // Answers live-turn marker: the whole in-flight turn, tool gaps included
      // (isStreaming and activeTurnId both drop there); shared with the prediction.
      const liveTurnId = String(projectionContext?.liveTurnId || '').trim();
      const turnLive = liveTurnId !== '' && liveTurnId === String(turn?.turn_id || '').trim();
      const rowListHtml = buildTurnRowListMarkup(sourceRows, messages, {
        ...renderOptions,
        transcriptView,
        isStreaming,
         projectionContext,
         messageById: projectionContext?.messageById,
         turnIdByMessageId: projectionContext?.turnIdByMessageId,
         // Resume stamps sessionId for its activation-time revalidation (empty
         // = inert button); callers omit it, so read this pane's session (W1-4a).
         sessionId: renderOptions.sessionId || getPaneSessionId(),
         retryMessageId: isLatestTurn ? latestAssistantMessageId : '',
         resumeTailMessageId: renderOptions.resumeTailMessageId || '',
         resumeSendBusy: Boolean(renderOptions.followUpDisabledReason),
        timelineDividerByMessageId: projectionContext?.timelineDividerByMessageId || null,
        dividerHostMessageId: articleMessageId,
        streamingRowId: renderOptions.streamingRowId || '',
        streamingMessageId,
        streamUnits: streamingRevealModel?.streamUnits || null,
        turnPhase: turnPhaseForMarkup,
        turnLive,
        // Response-loop grouped steps: the expand-state Map is keyed by
        // turn id (the single-row patch path falls back to the row's own turn_id).
        turnId: String(turn?.turn_id || ''),
      });
      const hasActionableAssistantRow = sourceRows.some(function hasAssistantRow(row) {
        const rowKind = String(row?.kind || '').trim();
        return rowKind === 'assistant_text' || rowKind === 'assistant_error';
      });
      const hoverRowHtml = hasActionableAssistantRow
        ? renderMessageHoverRow(actionTargetMessage, actionOptions, metaLabel)
        : '';
      const finalizedAt = String(actionTargetMessage?.finalizedAt || primaryMessage?.finalizedAt || '').trim();
      // skipHeightPrediction: the stream-reveal row-list builder keeps only the
      // row list, so a prediction is waste there (timeline-perf 2026-09-30).
      // A settled article predicts from the rowListHtml above (one build, one
      // sink feed); a streaming one keeps a separate build because its row
      // list carries streaming-bubble markup the prediction never measured, and
      // that build must not feed the caller's segment sink a second time.
      const predictedHeight = renderOptions.skipHeightPrediction === true
        ? null
        : maybePredictTurnHeight(turn, sourceRows, messages, {
          ...renderOptions, transcriptView, turnPhase: turnPhaseForMarkup, turnLive, rowListSegmentSink: null,
          sessionId: renderOptions.sessionId || getPaneSessionId(),
        }, isStreaming ? null : rowListHtml);
      const extraAttributes = [
        `data-turn-id="${escapeHtml(String(turn?.turn_id || ''))}"`,
      ];
      if (streamingMessageId) {
        extraAttributes.push(`data-streaming-message-id="${escapeHtml(streamingMessageId)}"`);
      }
      // F4/F5/F6: surface selection state on the article (data-selected + handle).
      const selectionStateProjected = resolveSelectionState(articleMessageId);
      // Ht-D: exempt the active/pending turn and any turn holding an
      // unresolved approval gate from content-visibility paint-skip. An
      // approval_gap row that is not a `resolved` receipt is the
      // unresolved-gate signal (renderer-turn-reducer-approval-gap.js).
      const hasUnresolvedApprovalGap = sourceRows.some(function hasApprovalGapRow(row) {
        return String(row?.kind || '').trim() === 'approval_gap' && row?.payload?.state !== 'resolved';
      });
      return buildMessageShellArticle({
        className: `assistant${isStreaming ? ' pending' : ''}`,
        messageId: articleMessageId,
        messageRole: 'assistant',
        messageStatus: isStreaming ? MESSAGE_STATUS.STREAMING : String(primaryMessage?.status || 'complete'),
        finalizedAt,
        predictedHeight,
        extraAttributes: extraAttributes.join(' '),
        selectionMode: selectionStateProjected.selectionMode,
        selected: selectionStateProjected.selected,
        cvExempt: isStreaming || hasUnresolvedApprovalGap,
        innerHtml: `
          <div class="chat-message-content">
            ${rowListHtml}
            ${hoverRowHtml}
          </div>
        `,
      });
    }

    // @legacy-fallback (compat scaffolding, NOT dead code; see
    // docs/archive/RENDER_PIPELINE_SPLIT_PLAN.md §4): the projected dispatch
    // renders a non-primary sibling inside a coalesced turn-article here, so
    // updateThreadRailExtents() finds a per-row node-dot for nested compat
    // nodes. The orphan-dot guard (isBodyMarkupVisuallyEmpty) does NOT apply:
    // the always-empty anchor's dot IS the rail landmark. Envelope siblings
    // (options.envelopeSibling) render dotless, since their article's rows
    // paint the dots, and carry data-thread-compat-enveloped so the thread-DOM
    // layer can drop the matching collapse toggle for compat-only subtrees.
    function buildThreadCompatAnchor(message, options) {
      const messageId = String(message?.id || '').trim();
      const envelopeSibling = !!(options && options.envelopeSibling);
      const anchorSpan = `<span class="thread-compat-anchor" data-message-id="${escapeHtml(messageId)}" data-thread-compat-anchor="true" aria-hidden="true"></span>`;
      // Wrap in a chat-row so updateThreadRailExtents() can pick up a per-row
      // node dot for nested compat anchors. Without this, tool-parent compat
      // nodes (which never carry a thread-toggle when they have a single
      // child) leave a gap in the vertical rail.
      const dotSpan = envelopeSibling ? '' : '<span class="chat-row-node-dot" aria-hidden="true"></span>';
      const envelopeAttr = envelopeSibling ? ' data-thread-compat-enveloped="true"' : '';
      return `<div class="chat-row chat-row-thread-compat" data-row-kind="thread_compat"${envelopeAttr} data-source-message-id="${escapeHtml(messageId)}" data-source-message-ids="${escapeHtml(messageId)}">${dotSpan}${anchorSpan}</div>`;
    }

    // True when this turn renders as ONE coalesced envelope article (the
    // turn-activity envelope path will derive an anchor): sibling compat
    // anchors must then render dotless — the article's own rows carry the
    // rail landmarks. Mirrors the anchor derivation the assistant dispatch
    // performs so tool_result anchors agree with their turn's shape.
    function isEnvelopeCoalescedTurn(turnId, rows, projectionContext) {
      const coalesceUtils = resolveTurnArticleCoalesceUtils();
      if (!coalesceUtils) {
        return false;
      }
      return !!coalesceUtils.deriveTurnArticleAnchorMessageId(turnId, rows, projectionContext);
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
      if (messageRole === 'assistant' && !isBlankAssistantSegmentMessage(message)) {
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

    // `renderOptions` (optional, eighth): { skipHeightPrediction,
    // rowListSegmentSink } for callers that keep only the row list of the
    // returned markup (renderer-turn-row-list-utils.js documents the sink).
    function buildMessageArticleMarkup(
      message,
      messages,
      latestAssistantMessageId,
      latestReplyAssistantMessageId,
      followUpDisabledReason,
      regenerateRequest,
      projectionContext,
      renderOptions
    ) {
      const skipHeightPrediction = renderOptions?.skipHeightPrediction === true;
      const rowListSegmentSink = Array.isArray(renderOptions?.rowListSegmentSink) ? renderOptions.rowListSegmentSink : null;
      const messageId = String(message?.id || '').trim();
      const turnId = String(projectionContext?.turnIdByMessageId?.get?.(messageId) || '').trim();
      if (message.kind === 'tool_result') {
        const turn = turnId ? projectionContext?.turnById?.get?.(turnId) || null : null;
        const rows = turnId ? projectionContext?.rowsByTurnId?.get?.(turnId) || [] : [];
        return canRenderProjectedTurnArticle(turn, rows)
          ? buildThreadCompatAnchor(message, {
              envelopeSibling: isEnvelopeCoalescedTurn(turnId, rows, projectionContext),
            })
          : '';
      }
      if (turnId && String(message?.role || '').trim() === 'assistant') {
        const turn = projectionContext?.turnById?.get?.(turnId) || null;
        const rows = projectionContext?.rowsByTurnId?.get?.(turnId) || [];
        const renderRows = projectionContext?.rowsByRenderMessageId?.get?.(messageId) || [];
        const visibleRenderRows = renderRows.filter(function filterVisibleRenderRows(row) {
          return row && String(row.kind || '').trim() !== 'user_bubble';
        });
        const activeTurnId = String(projectionContext?.activeTurnId || '').trim();
        const primaryAssistantMessageId = String(turn?.primary_assistant_message_id || '').trim();
        const isActiveTurn = activeTurnId && activeTurnId === turnId;
        const canRenderTurnArticle = canRenderProjectedTurnArticle(turn, rows);
        // Resume tail: NOT latestAssistantMessageId, which an appended recap /
        // proactive suggestion / question batch would steal, and NOT
        // latestReplyAssistantMessageId, which is complete-only and would let an
        // older budget stop outlive a newer error or cancelled terminal.
        const resumeTailMessageId = resolveResumeTailAssistantMessageId(messages);
        if (!canRenderTurnArticle && turn && rows.length > 0 && !primaryAssistantMessageId) {
          recordTurnArticleRolloutSignal('turn_article_missing_primary', {
            turnId,
            messageId,
            rowCount: rows.length,
            sourceMessageCount: Array.isArray(turn?.source_message_ids) ? turn.source_message_ids.length : 0,
          });
        }
        if (canRenderTurnArticle) {
          // Turn-activity envelope: render the WHOLE turn at one deterministic
          // anchor message (all other turn messages become compat anchors), so
          // a multi-iteration turn is one article/avatar and the step grouping
          // sees the full iteration run. Anchor derivation is a pure function
          // of the projection context, so full renders and single-message
          // re-renders agree. No safe anchor -> fall through to the
          // per-bucket dispatch unchanged.
          const coalesceUtils = resolveTurnArticleCoalesceUtils();
          if (coalesceUtils) {
            const anchorMessageId = coalesceUtils.deriveTurnArticleAnchorMessageId(
              turnId,
              rows,
              projectionContext
            );
            if (anchorMessageId && anchorMessageId !== messageId) {
              return buildThreadCompatAnchor(message, { envelopeSibling: true });
            }
            if (anchorMessageId === messageId) {
              const coalescedRows = coalesceUtils.collectTurnRenderRows(turnId, rows, projectionContext);
              if (coalescedRows.length) {
                return buildTurnArticleMarkup(turn, coalescedRows, messages, {
                  projectionContext,
                  skipHeightPrediction,
                  rowListSegmentSink,
                  renderMessageId: messageId,
                  latestReplyAssistantMessageId,
                  resumeTailMessageId,
                  followUpDisabledReason,
                  regenerateRequest,
                  streamingRowId: isActiveTurn ? resolveProjectionStreamingRowId(projectionContext) : '',
                  isStreaming: isActiveTurn,
                  streamingMessageId: isActiveTurn
                    ? String(latestAssistantMessageId || messageId || '').trim()
                    : '',
                  turnRows: rows,
                  pendingStreamMessageIds: state && state.pendingStreams && typeof state.pendingStreams.values === 'function'
                    ? [...state.pendingStreams.values()].map(String)
                    : [],
                });
              }
            }
          }
          if (!visibleRenderRows.length) {
            if (!isBlankAssistantSegmentMessage(message)) {
              recordTurnArticleRolloutSignal('turn_article_suppressed_sibling', {
                turnId,
                messageId,
                primaryAssistantMessageId,
                isActiveTurn,
              });
            }
            return buildThreadCompatAnchor(message, {
              envelopeSibling: isEnvelopeCoalescedTurn(turnId, rows, projectionContext),
            });
          }
          return buildTurnArticleMarkup(turn, visibleRenderRows, messages, {
            projectionContext,
            skipHeightPrediction,
            rowListSegmentSink,
            renderMessageId: messageId,
            latestReplyAssistantMessageId,
            resumeTailMessageId,
            followUpDisabledReason,
            regenerateRequest,
            streamingRowId: isActiveTurn ? resolveProjectionStreamingRowId(projectionContext) : '',
            isStreaming: isActiveTurn,
            streamingMessageId: isActiveTurn
              ? String(latestAssistantMessageId || messageId || '').trim()
              : '',
            // Full-turn rows for cross-bucket render decisions (the
            // answer-vs-tool-card mermaid dedup): this article's
            // visibleRenderRows hold only ONE render message's rows.
            turnRows: rows,
            // Live-stream message ids from the stream handler's pending map —
            // the projection's activeStreamingMessageId stays empty on this
            // path, so settle gating needs the stream-handler signal.
            pendingStreamMessageIds: state && state.pendingStreams && typeof state.pendingStreams.values === 'function'
              ? [...state.pendingStreams.values()].map(String)
              : [],
          });
        }
      }
      return buildMessageArticleMarkupLegacy(
        message,
        messages,
        latestAssistantMessageId,
        latestReplyAssistantMessageId,
        followUpDisabledReason,
        regenerateRequest,
        projectionContext
      );
    }

    return {
      buildMessageInnerMarkup,
      buildMessageArticleInnerHtml,
      buildMessageArticleMarkup,
      buildTurnArticleMarkup,
      maybePredictTurnHeight,
      schedulePredictedHeightCleanup,
      syncPatchedArticlePrediction,
    };
  }

  return { createArticleMarkupPipeline };
});
