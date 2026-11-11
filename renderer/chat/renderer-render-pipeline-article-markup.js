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
    // The pane's primary flag is resolved once per (sessions list, its length, pane session id), not scanned per bubble.
    let primaryFlagSessions = null;
    let primaryFlagLength = -1;
    let primaryFlagId = '';
    let primaryFlag = false;
    const {
      // Upstream pipeline methods (projection-cache C1, hydration C2,
      // projection-context C3, thread-state B1, thinking B3); the legacy-only ones
      // (tool entry, recap model, row shells) are read by the legacy module:
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
      buildStreamingBubbleMarkup = (message) => ({
        bubbleInnerHtml: '',
        streamUnits: null,
        streamChangedStart: -1,
      }),
      // Injected renderer callbacks:
      escapeHtml = (value) => String(value || ''),
      buildAssistantMetaLabel = () => '',
      buildMessageTokenMeta = () => new Map(),
      formatMessageTokenMeta = () => '',
      combineMessageMetaLabels = (primary, secondary) => [primary, secondary].filter(Boolean).join(' · '),
      renderMessageHoverRow = () => '',
      formatMessageTerminalTimestamp = () => '',
      isArtifactReviewVisible = () => false,
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
      state,
      chatTimeline,
      chatThreadColumn,
      resolveArticlePredictionCacheKey,
      resolveVisibleTurnArticleTarget,
      buildTurnRowListMarkup,
    });

    // The per-message path: message bubbles, application-turn notes and the
    // dispatcher fallback live in renderer-render-pipeline-article-legacy.js.
    const {
      buildMessageInnerMarkup,
      buildMessageArticleInnerHtml,
      buildMessageArticleMarkupLegacy,
    } = resolveArticleLegacyUtils().createLegacyArticleMarkup({
      state,
      MESSAGE_STATUS,
      chatTimeline,
      callbacks,
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
        branchUnavailable: paneSessionIsPrimary(),
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
      // No reservation for the live turn under a reader following it (row 131, D5: an overshoot is
      // blank room the follow scrolls into, and the reply jumps back when the room goes).
      const predictedHeight = renderOptions.skipHeightPrediction === true || (turnLive && state?.ui?.followLatest === true)
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
