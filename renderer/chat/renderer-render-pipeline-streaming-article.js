/* renderer/chat/renderer-render-pipeline-streaming-article.js
 * Rewrites the visible streaming article in place (morph or innerHTML) from a
 * fresh article build, and tells a rowless delegate shell from a real segment
 * birth. Split out of renderer-render-pipeline-message-renderer.js, which
 * hands in each render's inputs as `ctx`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineStreamingArticle = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Ht-D: syncChatEntryCvExemptAttribute keeps the paint-skip exemption
  // attribute in lockstep with the 'pending' class on the narrow patch path
  // below (which bypasses a full markup rebuild).
  const turnShellUtils = (typeof globalThis !== 'undefined' && globalThis.rendererTurnShell)
    || (typeof require === 'function' ? require('./renderer-turn-shell') : null)
    || {};
  const streamDomPatchUtils = (typeof globalThis !== 'undefined' && globalThis.rendererStreamDomPatchUtils)
    || (typeof require === 'function' ? require('./renderer-stream-dom-patch-utils') : null)
    || {};

  function createStreamingArticlePatcher(deps) {
    const {
      state,
      chatTimeline,
      uiRuntime,
      streamClientMetrics,
      getPaneSessionId,
      noteStreamRender,
      resolveVisibleTurnArticleTarget,
      resolveTurnArticleMessageId,
      buildMessageArticleMarkup,
      buildMessageInnerMarkup,
      buildMessageArticleInnerHtml,
      replayStreamRevealHandoff,
      stampStreamingArticleMarkerNode,
      runPostTimelineRenderEffects,
    } = deps;

    // A running delegate's agent_status frames land on the next segment's
    // empty shell, which then becomes derived.streamingMessage but projects no
    // row: there is no article to birth, so the signature-hold full render
    // repainted the whole timeline once per frame (80 full renders over one
    // 49 s delegate turn, 2026-10-19). While the turn's article is on screen such a frame
    // is a tool-gap write and belongs to the active_turn_root lane, whose
    // post-render effects clean up predicted heights. A shell that does project
    // a row is a real segment birth and keeps its one full render.
    function isRowlessShellOfVisibleTurn(streamingMessageId, projectionContext) {
      const turnId = projectionContext?.turnIdByMessageId?.get?.(streamingMessageId);
      const rows = turnId ? projectionContext.rowsByTurnId?.get?.(turnId) : null;
      if (!Array.isArray(rows) || !rows.length || rows.some((row) => (
        row?.render_message_id === streamingMessageId
        || row?.primary_message_id === streamingMessageId
        || (Array.isArray(row?.source_message_ids) && row.source_message_ids.includes(streamingMessageId))
      ))) {
        return false;
      }
      // Every row of a turn resolves to the same article, so one lookup (DOM
      // queries inside) decides; an off-screen turn keeps the old path.
      const anchor = rows.find((row) => row?.primary_message_id);
      return Boolean(anchor && resolveVisibleTurnArticleTarget(anchor.primary_message_id, projectionContext));
    }

    // ctx: this render's messages, ids, follow-up gate, projection context and
    // render signatures, plus its noteStructuralRewrite and recordStreamingArticleRebuild.
    function patchStreamingArticle(ctx, streamingMessage, articleOverride) {
      const {
        messages,
        latestAssistantMessageId,
        latestReplyAssistantMessageId,
        followUpDisabledReason,
        latestRegenerateRequest,
        projectionContext,
        messageRenderSignature,
        recapExpansionSignature,
        threadExpansionSignature,
        noteStructuralRewrite,
        recordStreamingArticleRebuild,
      } = ctx;
      const streamingMessageId = String(streamingMessage?.id || '').trim();
      let article = articleOverride || resolveVisibleTurnArticleTarget(streamingMessageId, projectionContext);
      if (!streamingMessageId || !article) {
        return false;
      }
      const articleMessageId = String(
        article.getAttribute?.('data-message-id')
        || resolveTurnArticleMessageId(streamingMessageId, projectionContext)
      ).trim();
      const articleMessageMatch = messages.find(
        (message) => String(message?.id || '').trim() === articleMessageId
      );
      const articleMessage = articleMessageMatch || streamingMessage;
      // timeline-perf 2026-09-30: the row segments let the morph below
      // reconcile the turn row list per row (settled rows keep their
      // reconcile stamps) instead of morphing every row of the turn.
      const rowListSegments = [];
      const nextArticleMarkup = buildMessageArticleMarkup(
        articleMessage,
        messages,
        latestAssistantMessageId,
        latestReplyAssistantMessageId,
        followUpDisabledReason,
        String(articleMessage.id || '') === latestReplyAssistantMessageId ? latestRegenerateRequest : null,
        projectionContext,
        { rowListSegmentSink: rowListSegments }
      );
      const template = article.ownerDocument?.createElement?.('template') || null;
      let nextArticle = null;
      if (template) {
        template.innerHTML = String(nextArticleMarkup || '').trim();
        nextArticle = template.content.querySelector('.chat-entry[data-message-id]');
      }
      // HB-006: under the turn-activity envelope the live article hosts the WHOLE
      // turn's row list. When the dispatcher answers with a compat stub (the
      // anchor moved, or the article's message fell out of `messages` and the
      // streaming segment stood in), the legacy branch below wrote only that
      // segment's reasoning into the host and wiped every other row until a
      // later full render. Refuse, and let the caller render the timeline.
      const hostsRowList = Boolean(article.querySelector?.('[data-turn-row-list]'));
      const refusal = nextArticle
        ? (hostsRowList && !nextArticle.querySelector('[data-turn-row-list]') ? 'refused_row_list_collapse' : '')
        : (hostsRowList ? 'refused_row_list_collapse' : (articleMessageMatch ? '' : 'refused_article_fallback'));
      if (refusal) {
        recordStreamingArticleRebuild({ turnId: articleMessageId, streamingMessageId, outcome: refusal });
        return false;
      }
      noteStructuralRewrite();
      let rebuildOutcome = 'raw_innerhtml';
      let rebuildStats;
      if (nextArticle) {
        const streamingArticleMorphEnabled =
          state?.features?.featureFlags?.chat_timeline_streaming_article_morph === true;
        if (
          streamingArticleMorphEnabled
          && typeof streamDomPatchUtils.setOuterHtmlPreservingCodeScroll === 'function'
        ) {
          const result = streamDomPatchUtils.setOuterHtmlPreservingCodeScroll(
            article,
            nextArticleMarkup,
            {
              collectStats: true,
              rowListSegments: hostsRowList && rowListSegments.length ? rowListSegments : null,
            }
          );
          rebuildOutcome = String(result?.outcome || 'morph_unavailable');
          rebuildStats = result?.stats;
          if (result?.rowList) {
            const rowStats = result.rowList.stats || {};
            rebuildStats = { ...(rebuildStats || {}), row_list: result.rowList.outcome, kept: rowStats.kept, morphed: rowStats.morphed, added: rowStats.added };
            streamClientMetrics?.noteRowListMorph?.(getPaneSessionId(), {
              reason: 'article_rewrite',
              rowsReused: Number(rowStats.kept) || 0,
              rowsRebuilt: (Number(rowStats.morphed) || 0) + (Number(rowStats.added) || 0),
            });
          }
          if (rebuildOutcome !== 'morph_applied') {
            article = resolveVisibleTurnArticleTarget(streamingMessageId, projectionContext) || article;
          }
        } else {
          // The rollback path (chat_timeline_streaming_article_morph off)
          // shares morphNode's attribute diff (syncElementAttributes) rather
          // than a second hand-rolled copy that fixes would skip. Optional-
          // called: without the module setOuterHtmlPreservingCodeScroll is
          // gone too, and an unsynced attribute is not worth throwing over.
          article.innerHTML = nextArticle.innerHTML;
          streamDomPatchUtils.syncElementAttributes?.(article, nextArticle);
        }
        recordStreamingArticleRebuild({
          turnId: articleMessageId,
          streamingMessageId,
          outcome: rebuildOutcome,
          stats: rebuildStats,
        });
      } else {
        const nextMessageModel = buildMessageInnerMarkup(
          streamingMessage,
          messages,
          latestAssistantMessageId,
          latestReplyAssistantMessageId,
          followUpDisabledReason,
          latestRegenerateRequest,
          projectionContext
        );
        const nextInnerHtml = buildMessageArticleInnerHtml(streamingMessage, nextMessageModel.innerHtml);
        // The helper always returns an { outcome } record, so a nullish result
        // means only that the module did not resolve -- the last-resort write.
        if (!streamDomPatchUtils.setInnerHtmlPreservingCodeScroll?.(article, nextInnerHtml)) {
          article.innerHTML = nextInnerHtml;
        }
        article.classList.toggle('pending', nextMessageModel.pending);
        turnShellUtils.syncChatEntryCvExemptAttribute?.(article, { pending: nextMessageModel.pending });
        article.dataset.messageStatus = nextMessageModel.status;
        article.dataset.finalizedAt = nextMessageModel.finalizedAt;
        recordStreamingArticleRebuild({
          turnId: articleMessageId,
          streamingMessageId,
          outcome: 'legacy_article_innerhtml',
        });
      }
      // The rebuild replaced the live reasoning panel with a settled, hidden
      // one; replay the eased hand-off before this task paints.
      replayStreamRevealHandoff();
      // Through the single writer, so rebuilding one article cannot leave the
      // previous streaming article still marked.
      stampStreamingArticleMarkerNode(article, streamingMessageId, chatTimeline);
      uiRuntime.messageRenderSignature = messageRenderSignature;
      uiRuntime.recapExpansionSignature = recapExpansionSignature;
      uiRuntime.threadBranchSignature = threadExpansionSignature;
      runPostTimelineRenderEffects(messages, {
        decorateFollowUps: true,
        inlineMermaidStreaming: true,
        syncViewport: true,
        syncChrome: true,
      });
      noteStreamRender('patch');
      return true;
    }

    return { patchStreamingArticle, isRowlessShellOfVisibleTurn };
  }

  return { createStreamingArticlePatcher };
});
