(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineStreamRevealCallbacks = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createStreamRevealPatchCallbacks(context) {
    const {
      uiRuntime,
      chatTimeline,
      messages,
      threadTree,
      derived,
      projectionContext,
      streamingRowTarget,
      latestAssistantMessageId,
      latestReplyAssistantMessageId,
      followUpDisabledReason,
      latestRegenerateRequest,
      structureSignature,
      forcedOpenIds,
      timelineDividerByMessageId,
      messageFingerprints,
      messageRenderSignature,
      recapExpansionSignature,
      threadExpansionSignature,
      projectionRevisionKey,
      resolveFollowUpDisabledReason,
      resolveRegenerateRequest,
      buildMessageInnerMarkup,
      buildMessageArticleInnerHtml,
      buildProjectionStreamingRowMarkup,
      resolveVisibleTurnArticleTarget,
      resolveTurnArticleMessageId,
      buildMessageArticleMarkup,
      noteStreamRender,
      runPostTimelineRenderEffects,
      markCatchupPatched,
      recordTurnArticleRolloutSignal,
      markCatchupFullRenderFallback,
      resolveFullRenderReason,
      performFullMessageRender,
    } = context;

    // The turn's row list as { html, segments }: html is the list body the
    // keyed morph applies, segments the same markup split per top-level
    // child (renderer-turn-row-list-utils.js rowListSegmentSink).
    function buildTurnRowList() {
      // Resolve the anchor the SAME way patchVisibleStreamingArticle does:
      // read it off the live article first. Under turn_activity_envelope a
      // whole turn renders at one anchor message, and the dispatcher inside
      // buildMessageArticleMarkup decides that anchor with
      // deriveTurnArticleAnchorMessageId -- a different function from
      // resolveTurnArticleMessageId. When the two disagree the dispatcher
      // returns a thread-compat stub with no row list, the morph goes inert,
      // and the turn charges a full render per delta. The live article's
      // data-message-id IS the anchor the dispatcher already chose.
      const streamingMessageId = String(derived.streamingMessage?.id || '').trim();
      const streamingArticle = resolveVisibleTurnArticleTarget(streamingMessageId, projectionContext);
      const articleMessageId = String(
        streamingArticle?.getAttribute?.('data-message-id')
        || resolveTurnArticleMessageId(streamingMessageId, projectionContext)
        || streamingMessageId
      ).trim();
      const articleMessage = messages.find(
        (message) => String(message?.id || '').trim() === articleMessageId
      ) || derived.streamingMessage;
      const template = articleMessage
        ? chatTimeline?.ownerDocument?.createElement?.('template')
        : null;
      if (!template) {
        return { html: '', segments: [] };
      }
      // Only the row list survives this call, so the article's height
      // prediction (a second row-list build) is skipped; the live article
      // keeps the predicted height its full render stamped.
      const segments = [];
      template.innerHTML = String(buildMessageArticleMarkup(
        articleMessage,
        messages,
        latestAssistantMessageId,
        latestReplyAssistantMessageId,
        followUpDisabledReason,
        String(articleMessage.id || '') === latestReplyAssistantMessageId ? latestRegenerateRequest : null,
        projectionContext,
        { skipHeightPrediction: true, rowListSegmentSink: segments }
      ) || '').trim();
      const html = template.content.querySelector('[data-turn-row-list="true"]')?.innerHTML || '';
      return { html, segments: html ? segments : [] };
    }

    return {
      buildMessageNodeState: (message, nextMessages, nextLatestAssistantMessageId) => {
        const nextFollowUpDisabledReason = resolveFollowUpDisabledReason();
        const nextRegenerateRequest = String(message?.id || '') === latestReplyAssistantMessageId
          ? resolveRegenerateRequest(latestReplyAssistantMessageId, nextMessages, {
            latestReplyAssistantMessageId,
            followUpActionsBusy: Boolean(nextFollowUpDisabledReason),
          })
          : null;
        const nextMessageModel = buildMessageInnerMarkup(
          message,
          nextMessages,
          nextLatestAssistantMessageId,
          latestReplyAssistantMessageId,
          nextFollowUpDisabledReason,
          nextRegenerateRequest,
          projectionContext
        );
        return {
          ...nextMessageModel,
          innerHtml: buildMessageArticleInnerHtml(message, nextMessageModel.innerHtml),
        };
      },
      buildRowNodeMarkup: () => buildProjectionStreamingRowMarkup(
        streamingRowTarget,
        messages,
        projectionContext
      ),
      // The live segment's reasoning rows, rendered from their projected rows
      // exactly as the turn article renders them. The message-level widget
      // carries every phase of the stream (reasoning_phases is stream-scoped),
      // so its stack never lines up with a one-phase row: the reasoning patch
      // then rebuilt the whole turn row list on every delta (HB-010).
      buildLiveReasoningRowsMarkup: () => buildProjectionStreamingRowMarkup(
        { liveReasoningMessageId: String(derived.streamingMessage?.id || '') },
        messages,
        projectionContext
      ),
      // Keyed-morph fallback for a structural delta the surgical patch
      // cannot take: reconcile the turn's rows in place instead of
      // charging patch_fallback:row_model_not_surgical to a full render.
      //
      // The markup comes from buildMessageArticleMarkup -- the SAME builder
      // performFullMessageRender uses -- so the morph writes exactly the
      // rows a full render would, including the streaming reveal units and
      // the retry affordances a hand-assembled row list would have dropped.
      buildTurnRowListMarkup: () => buildTurnRowList().html,
      // Structured variant: the same markup as one { kind, id, markup } segment
      // per top-level list child, for the per-row reconcile in queuePatch.
      buildTurnRowListSegments: () => buildTurnRowList(),
      onAfterPatch: (patchedMessages, patchResult) => {
        // The live reasoning patch and the row-list morph write rows, never the
        // list itself: sync its live-turn marker (transcript view 'answers').
        const patchedArticle = resolveVisibleTurnArticleTarget(
          String(patchResult?.messageId || derived.streamingMessage?.id || ''),
          projectionContext
        );
        const patchedList = patchedArticle?.querySelector?.('[data-turn-row-list="true"]');
        if (patchedList) {
          const turnId = String(patchedArticle.getAttribute('data-turn-id') || '').trim();
          if (turnId && turnId === String(projectionContext?.liveTurnId || '').trim()) {
            patchedList.setAttribute('data-turn-live', 'true');
          } else {
            patchedList.removeAttribute('data-turn-live');
          }
        }
        uiRuntime.messageRenderSignature = messageRenderSignature;
        noteStreamRender('patch');
        runPostTimelineRenderEffects(patchedMessages, {
          decorateFollowUps: true,
          inlineMermaidStreaming: true,
          patchedMessageId: patchResult?.messageId,
          predictedHeight: patchResult?.predictedHeight,
          cleanupPredictedHeights: true,
          syncViewport: true,
        });
        markCatchupPatched('stream_reveal', {
          messageId: patchResult?.messageId || String(derived.streamingMessage?.id || ''),
        });
      },
      onFallback: (fallbackCause) => {
        if (derived.streamingMessage) {
          const streamingMessageId = String(derived.streamingMessage.id || '').trim();
          const streamingArticleMessageId = resolveTurnArticleMessageId(
            streamingMessageId,
            projectionContext
          );
          if (!resolveVisibleTurnArticleTarget(streamingMessageId, projectionContext)) {
            recordTurnArticleRolloutSignal('turn_article_stream_mismatch', {
              streamingMessageId,
              streamingArticleMessageId,
              phase: 'patch_fallback',
            });
          }
        }
        markCatchupFullRenderFallback('stream_reveal_fallback');
        noteStreamRender('full', resolveFullRenderReason(
          'patch_fallback' + (fallbackCause ? ':' + fallbackCause : '')
        ));
        performFullMessageRender(
          messages,
          threadTree,
          latestAssistantMessageId,
          latestReplyAssistantMessageId,
          followUpDisabledReason,
          latestRegenerateRequest,
          structureSignature,
          derived,
          forcedOpenIds,
          projectionContext,
          timelineDividerByMessageId,
          messageFingerprints
        );
        uiRuntime.messageRenderSignature = messageRenderSignature;
        uiRuntime.recapExpansionSignature = recapExpansionSignature;
        uiRuntime.threadBranchSignature = threadExpansionSignature;
        uiRuntime.projectionCommittedRevisionKey = projectionRevisionKey;
        runPostTimelineRenderEffects(messages, {
          decorateFollowUps: true,
          syncViewport: true,
        });
      },
    };
  }

  return {
    createStreamRevealPatchCallbacks,
  };
});
