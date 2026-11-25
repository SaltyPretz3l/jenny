/* renderer/chat/renderer-render-pipeline-article-markup.js
 * The factory owns article markup, receives upstream projection and thread
 * helpers, and retains a reachable per-message fallback when projected-turn
 * rendering is unavailable (that fallback is composed from
 * renderer-render-pipeline-article-legacy.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineArticleMarkupUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const resolveArticlePredictionUtils = () => globalThis.rendererRenderPipelineArticlePrediction
    || (typeof require === 'function' ? require('./renderer-render-pipeline-article-prediction') : null);
  const { isPrimarySessionId = () => false } = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)) || {};
  const resolveArticleLegacyUtils = () => globalThis.rendererRenderPipelineArticleLegacy
    || (typeof require === 'function' ? require('./renderer-render-pipeline-article-legacy') : null);
  const jt = globalThis.jennyI18n?.t || globalThis.jennyI18nFallback || ((k, d, p) => (p ? String(d).replace(/\{(\w+)\}/g, (m, n) => (n in p ? String(p[n]) : m)) : d));
  const jtn = globalThis.jennyI18n?.tn || ((k, count, p, one, other) => jt.call(null, k, count === 1 ? one : other, { count }));

  // Row 192 C8, the outcomes line. Files: this turn's change ledger (what the Changes tab lists), cached per
  // view model. Pictures: only what the lazily loaded pictures cache already holds; nothing is requested here.
  const fileCounts = new WeakMap();
  function countChangedFiles(viewModel) {
    if (!viewModel || typeof viewModel !== 'object') return 0;
    if (!fileCounts.has(viewModel)) {
      const ledger = globalThis.rendererJennyChangeLedger || (typeof require === 'function' ? require('./renderer-jenny-change-ledger') : null);
      fileCounts.set(viewModel, new Set((ledger?.buildJennyChangeLedgerFromTurnViewModels?.([viewModel]).changes || []).map((change) => change.fileKey)).size);
    }
    return fileCounts.get(viewModel);
  }
  const PICTURE_STATES = ['ready', 'same', 'after_failed', 'new', 'deleted'];
  function countChangePictures(sessionId, turnId) {
    try {
      const cache = globalThis.rendererChangePictures?.getShared?.().cache;
      return sessionId && cache && !cache.isDisabled() ? globalThis.rendererChangePicturesModel.pagesOf(cache.peek(sessionId, turnId, 'desktop').record)
        .filter((page) => PICTURE_STATES.includes(page.state)).length : 0;
    } catch (_error) { return 0; }
  }
  function buildTurnOutcomesMarkup(turnId, viewModel, sessionId, picturesOn, escapeHtml) {
    const files = turnId ? countChangedFiles(viewModel) : 0;
    if (!files) return '';
    const pictures = picturesOn ? countChangePictures(sessionId, turnId) : 0;
    const button = globalThis.inventoryActionButton || (typeof require === 'function' ? require('../inventory/action-button') : null);
    const link = (outcome, label, title) => button({ plain: true, className: 'turn-outcome-link', label, title, dataset: { 'turn-outcome': outcome, scope: 'turn', 'turn-id': turnId } });
    const links = [link('changes', jtn('chat.turnOutcomes.filesChanged', files, null, '{count} file changed', '{count} files changed'), jt('chat.turnOutcomes.filesChangedTitle', 'Open the Changes tab'))];
    if (pictures) links.push(link('pictures', jtn('chat.turnOutcomes.pictures', pictures, null, '{count} picture of the changed page', '{count} pictures of the changed page'), jt('chat.turnOutcomes.picturesTitle', 'Open the Changes tab at the pictures')));
    return `<div class="turn-outcomes" role="group" aria-label="${escapeHtml(jt('chat.turnOutcomes.groupLabel', 'What this turn left behind'))}">${links.join('<span class="turn-outcome-sep" aria-hidden="true">·</span>')}</div>`;
  }

  function createArticleMarkupPipeline(deps) {
    const {
      state = {},
      constants = {},
      dom = {},
      callbacks = {},
    } = deps || {};
    const { MESSAGE_STATUS = {} } = constants;
    const { chatTimeline = null, chatThreadColumn = null } = dom;
    // The pane's primary flag is resolved once per (sessions list, its length, pane session id), not scanned per bubble.
    let primaryFlagSessions = null;
    let primaryFlagLength = -1;
    let primaryFlagId = '';
    let primaryFlag = false;
    const {
      // Upstream pipeline methods (C1-C3, B1, B3); the legacy-only ones are read by the legacy module:
      resolveResumeTailAssistantMessageId = () => '',
      resolveArticlePredictionCacheKey = () => '',
      getMessageFromCollection = () => null,
      deriveActionTargetMessageId = () => '',
      resolveVisibleTurnArticleTarget = () => null,
      recordTurnArticleRolloutSignal = () => {},
      resolveProjectionStreamingRowId = () => '',
      // turn-shell + turn-row siblings:
      buildMessageShellArticle = () => '',
      buildTurnRowListMarkup = () => '',
      // streaming-reveal helper:
      buildStreamingBubbleMarkup = () => ({ bubbleInnerHtml: '', streamUnits: null, streamChangedStart: -1 }),
      // Injected renderer callbacks:
      escapeHtml = (value) => String(value || ''),
      buildAssistantMetaLabel = () => '',
      buildMessageTokenMeta = () => new Map(),
      formatMessageTokenMeta = () => '',
      combineMessageMetaLabels = (primary, secondary) => [primary, secondary].filter(Boolean).join(' · '),
      buildShortAssistantMetaLabel = (...args) => globalThis.chatMessageUtils?.buildShortAssistantMetaLabel?.(...args) || '',
      formatMessageTokenMetaShort = (meta) => globalThis.rendererContextUsageUtils?.formatMessageTokenMetaShort?.(meta) || '',
      renderMessageHoverRow = () => '',
      formatMessageTerminalTimestamp = () => '',
      formatMessageClockTime = formatMessageTerminalTimestamp,
      isArtifactReviewVisible = () => false,
      // This pane's follow state (one pane: state.ui.followLatest).
      isFollowingLatest = () => state?.ui?.followLatest === true,
      // Split view W1-4a: the session this pane shows (one pane: currentSessionId).
      getPaneSessionId = () => String(state.currentSessionId || '').trim(),
      // Row 69: the primary Jenny chat offers no Branch (its transcript spans every project).
      paneSessionIsPrimary = () => {
        const id = getPaneSessionId();
        const sessions = Array.isArray(state.sessions) ? state.sessions : null;
        if (sessions !== primaryFlagSessions || (sessions ? sessions.length : -1) !== primaryFlagLength || id !== primaryFlagId) {
          primaryFlagSessions = sessions;
          primaryFlagLength = sessions ? sessions.length : -1;
          primaryFlagId = id;
          primaryFlag = isPrimarySessionId(sessions, id);
        }
        return primaryFlag;
      },
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

    // Height prediction and the predicted-height cleanup live in
    // renderer-render-pipeline-article-prediction.js (split at the line cap).
    const {
      maybePredictArticleHeight,
      maybePredictTurnHeight,
      schedulePredictedHeightCleanup,
      syncPatchedArticlePrediction,
    } = resolveArticlePredictionUtils().createArticlePrediction({
      state, chatTimeline, chatThreadColumn, resolveArticlePredictionCacheKey, resolveVisibleTurnArticleTarget,
      buildTurnRowListMarkup, isFollowingLatest,
    });

    // The per-message path: message bubbles, application-turn notes and the
    // dispatcher fallback live in renderer-render-pipeline-article-legacy.js.
    const {
      buildMessageInnerMarkup,
      buildMessageArticleInnerHtml,
      buildMessageArticleMarkupLegacy,
    } = resolveArticleLegacyUtils().createLegacyArticleMarkup({
      state, MESSAGE_STATUS, chatTimeline, callbacks, escapeHtml, buildMessageShellArticle, renderMessageHoverRow,
      buildAssistantMetaLabel, buildMessageTokenMeta, formatMessageTokenMeta, combineMessageMetaLabels,
      buildShortAssistantMetaLabel, formatMessageTokenMetaShort, formatMessageTerminalTimestamp, formatMessageClockTime,
      buildStreamingBubbleMarkup, recordTurnArticleRolloutSignal, getPaneSessionId, paneSessionIsPrimary,
      getPaneTranscriptView, resolveSelectionState, maybePredictArticleHeight, buildThreadCompatAnchor,
      isBlankAssistantSegmentMessage,
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
      // B7a: batch/recap rows render inline through the Tier-1 registry, not the legacy per-message path;
      // plan proposal, object and document rows ride the same first-class row path.
      'batch',
      'recap',
      'plan_proposal',
      'plan_object',
      'plan_document',
    ]);

    // Turn-activity envelope (coalesced turn articles): the coalesce helpers
    // load as their own script; resolve lazily so script order stays free.
    function resolveTurnArticleCoalesceUtils() {
      const utils = globalThis.rendererTurnArticleCoalesceUtils;
      return typeof utils?.collectTurnRenderRows === 'function' && typeof utils.deriveTurnArticleAnchorMessageId === 'function' ? utils : null;
    }

    // A blank plain assistant segment (no kind, content, attachments or reasoning entries) carries nothing a
    // reader could lose, so the Ht-F rollout canaries skip it. Mirrors the claim predicate in
    // renderer-turn-tree-projector-persistence.js: keep the two in sync.
    function isBlankAssistantSegmentMessage(message) {
      return !String(message?.kind || '').trim() && !String(message?.content || '').trim()
        && !(Array.isArray(message?.attachments) && message.attachments.length > 0)
        && !(Array.isArray(message?.reasoning?.entries) && message.reasoning.entries.length > 0);
    }

    const isSteerBubbleRow = (row, messages, ctx) => String(row?.kind || '').trim() === 'user_bubble' // row 180: sent mid-turn
      && getMessageFromCollection(String(row.primary_message_id || '').trim(), messages, ctx)?.kind === 'steer';

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
      const sourceRows = (Array.isArray(rows) ? rows : []).filter((row) => row && (String(row.kind || '') !== 'user_bubble' || isSteerBubbleRow(row, messages, projectionContext)));
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
        branchUnavailable: paneSessionIsPrimary(),
      };
      // Footer label: a terminal assistant_error notice outranks the contentful action target (which stays the
      // copy/regenerate target), so a failed turn reads "Failed", never "Completed".
      const terminalErrorMessage = globalThis.rendererTurnRowErrorDedupeUtils?.findTerminalAssistantErrorMessage?.(
        sourceRows, (messageId) => getMessageFromCollection(messageId, messages, projectionContext)) || null;
      const turnMessageIds = [...new Set(Array.isArray(turn?.source_message_ids) ? turn.source_message_ids : [actionTargetMessageId])];
      const turnMessages = turnMessageIds.map((id) => getMessageFromCollection(id, messages, projectionContext)).filter((item) => item?.role === 'assistant');
      const tokenMeta = buildMessageTokenMeta(turnMessages, turnMessageIds).get(actionTargetMessageId);
      const footerMessage = terminalErrorMessage || actionTargetMessage;
      const metaLabel = combineMessageMetaLabels(
        buildAssistantMetaLabel(footerMessage, formatMessageTerminalTimestamp, turnMessages, turn),
        formatMessageTokenMeta(tokenMeta)
      );
      const shortMetaLabel = buildShortAssistantMetaLabel(footerMessage, formatMessageClockTime, turnMessages, turn,
        formatMessageTokenMetaShort(tokenMeta));
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
      const turnPhaseApi = globalThis.rendererTurnPhase;
      const turnViewModelForPhase = projectionContext?.viewModelByTurnId instanceof Map
        ? projectionContext.viewModelByTurnId.get(String(turn?.turn_id || '').trim()) || null
        : null;
      let turnPhaseForMarkup = typeof turnPhaseApi?.deriveTurnPhase === 'function' && turnViewModelForPhase
        ? turnPhaseApi.deriveTurnPhase(turnViewModelForPhase)
        : '';
      // review_artifact is consumer-supplied: with the split review panel visible, the latest settled turn
      // tracks the review context without a second lifecycle authority.
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
      const renderSteerHoverRow = (steerMessage) => renderMessageHoverRow(steerMessage, actionOptions, '', ''); // Copy-only
      const rowListHtml = buildTurnRowListMarkup(sourceRows, messages, {
        ...renderOptions, renderSteerHoverRow, transcriptView,
        isStreaming,
        projectionContext,
        messageById: projectionContext?.messageById,
        turnIdByMessageId: projectionContext?.turnIdByMessageId,
        // Resume revalidates sessionId on activation (empty = inert button); callers omit it: this pane's (W1-4a).
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
      // Row 192 C9: a failed or stopped turn's card is a system_notice row of subkind assistant_error, so a turn
      // that ended before any answer text gets its details line too. None while the turn runs, tool gaps included.
      const hasActionableAssistantRow = sourceRows.some(function hasAssistantRow(row) {
        const rowKind = String(row?.kind || '').trim();
        return rowKind === 'assistant_text' || rowKind === 'assistant_error'
          || (rowKind === 'system_notice' && row.payload?.subkind === 'assistant_error');
      });
      const turnSettled = !isStreaming && !turnLive;
      const hoverRowHtml = hasActionableAssistantRow && turnSettled
        ? renderMessageHoverRow(actionTargetMessage, actionOptions, metaLabel, shortMetaLabel)
        : '';
      const outcomesHtml = turnSettled
        ? buildTurnOutcomesMarkup(String(turn?.turn_id || '').trim(), turnViewModelForPhase, getPaneSessionId(),
          state.features?.featureFlags?.change_pictures !== false, escapeHtml)
        : '';
      const finalizedAt = String(actionTargetMessage?.finalizedAt || primaryMessage?.finalizedAt || '').trim();
      // skipHeightPrediction: the stream-reveal builder keeps only the row list (timeline-perf 2026-09-30).
      // A settled article predicts from rowListHtml (one build, one sink feed); a streaming one keeps its own
      // build (its row list carries streaming-bubble markup) that never feeds the caller's sink. No reservation
      // for the live turn under a following reader (row 131, D5: the overshoot is blank room the reply jumps back from).
      const predictedHeight = renderOptions.skipHeightPrediction === true || (turnLive && isFollowingLatest() === true)
        ? null
        : maybePredictTurnHeight(turn, sourceRows, messages, {
          ...renderOptions, renderSteerHoverRow, transcriptView, turnPhase: turnPhaseForMarkup, turnLive, rowListSegmentSink: null,
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
      // Ht-D: the active turn and any turn with an unresolved approval gate (an approval_gap row that is not a
      // `resolved` receipt, renderer-turn-reducer-approval-gap.js) are exempt from content-visibility paint-skip.
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
            ${outcomesHtml}
            ${hoverRowHtml}
          </div>
        `,
      });
    }

    // @legacy-fallback (compat scaffolding, NOT dead code; docs/archive/RENDER_PIPELINE_SPLIT_PLAN.md §4): a
    // non-primary sibling inside a coalesced turn article renders as an empty anchor row so message-id lookups
    // resolve. Envelope siblings carry data-thread-compat-enveloped so the thread DOM drops their collapse toggle.
    function buildThreadCompatAnchor(message, options) {
      const messageId = String(message?.id || '').trim();
      const envelopeSibling = !!(options && options.envelopeSibling);
      const anchorSpan = `<span class="thread-compat-anchor" data-message-id="${escapeHtml(messageId)}" data-thread-compat-anchor="true" aria-hidden="true"></span>`;
      const envelopeAttr = envelopeSibling ? ' data-thread-compat-enveloped="true"' : '';
      return `<div class="chat-row chat-row-thread-compat" data-row-kind="thread_compat"${envelopeAttr} data-source-message-id="${escapeHtml(messageId)}" data-source-message-ids="${escapeHtml(messageId)}">${anchorSpan}</div>`;
    }

    // True when this turn renders as ONE coalesced envelope article: sibling compat anchors then render dotless
    // (the article's rows carry the rail landmarks). Mirrors the assistant dispatch's anchor derivation.
    function isEnvelopeCoalescedTurn(turnId, rows, projectionContext) {
      return !!resolveTurnArticleCoalesceUtils()?.deriveTurnArticleAnchorMessageId(turnId, rows, projectionContext);
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
      if (turnId && message?.kind === 'steer' && canRenderProjectedTurnArticle(projectionContext?.turnById?.get?.(turnId), projectionContext?.rowsByTurnId?.get?.(turnId))
        && isEnvelopeCoalescedTurn(turnId, projectionContext?.rowsByTurnId?.get?.(turnId), projectionContext)) return buildThreadCompatAnchor(message, { envelopeSibling: true });
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
        // Resume tail: not latestAssistantMessageId (an appended recap, suggestion or question batch steals it), nor
        // latestReplyAssistantMessageId (complete-only: an older budget stop would outlive a newer error or stop).
        const resumeTailMessageId = resolveResumeTailAssistantMessageId(messages);
        if (!canRenderTurnArticle && turn && rows.length > 0 && !primaryAssistantMessageId) {
          recordTurnArticleRolloutSignal('turn_article_missing_primary', {
            turnId, messageId, rowCount: rows.length,
            sourceMessageCount: Array.isArray(turn?.source_message_ids) ? turn.source_message_ids.length : 0,
          });
        }
        if (canRenderTurnArticle) {
          const turnArticleOptions = () => ({
            projectionContext, skipHeightPrediction, rowListSegmentSink, renderMessageId: messageId,
            latestReplyAssistantMessageId, resumeTailMessageId, followUpDisabledReason, regenerateRequest,
            streamingRowId: isActiveTurn ? resolveProjectionStreamingRowId(projectionContext) : '',
            isStreaming: isActiveTurn,
            streamingMessageId: isActiveTurn ? String(latestAssistantMessageId || messageId || '').trim() : '',
            // Full-turn rows for cross-bucket decisions (the answer-vs-tool-card mermaid dedup).
            turnRows: rows,
            // The stream handler's live ids: activeStreamingMessageId stays empty on this path, so settle gating reads these.
            pendingStreamMessageIds: typeof state?.pendingStreams?.values === 'function' ? [...state.pendingStreams.values()].map(String) : [],
          });
          // Turn-activity envelope: the WHOLE turn renders at one deterministic anchor message (the others become
          // compat anchors), so a multi-iteration turn is one article and step grouping sees every iteration. The
          // anchor is a pure function of the projection context; no safe anchor falls through to per-bucket dispatch.
          const coalesceUtils = resolveTurnArticleCoalesceUtils();
          if (coalesceUtils) {
            const anchorMessageId = coalesceUtils.deriveTurnArticleAnchorMessageId(turnId, rows, projectionContext);
            if (anchorMessageId && anchorMessageId !== messageId) {
              return buildThreadCompatAnchor(message, { envelopeSibling: true });
            }
            if (anchorMessageId === messageId) {
              const coalescedRows = coalesceUtils.collectTurnRenderRows(turnId, rows, projectionContext);
              if (coalescedRows.length) {
                return buildTurnArticleMarkup(turn, coalescedRows, messages, turnArticleOptions());
              }
            }
          }
          if (!visibleRenderRows.length) {
            if (!isBlankAssistantSegmentMessage(message)) {
              recordTurnArticleRolloutSignal('turn_article_suppressed_sibling', { turnId, messageId, primaryAssistantMessageId, isActiveTurn });
            }
            return buildThreadCompatAnchor(message, {
              envelopeSibling: isEnvelopeCoalescedTurn(turnId, rows, projectionContext),
            });
          }
          return buildTurnArticleMarkup(turn, visibleRenderRows, messages, turnArticleOptions());
        }
      }
      return buildMessageArticleMarkupLegacy(message, messages, latestAssistantMessageId, latestReplyAssistantMessageId,
        followUpDisabledReason, regenerateRequest, projectionContext);
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
