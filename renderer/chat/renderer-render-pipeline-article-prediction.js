/* renderer/chat/renderer-render-pipeline-article-prediction.js
 * Pretext height prediction for transcript articles and turn row lists, and
 * the predicted-height min-height cleanup, for the article-markup pipeline
 * (renderer-render-pipeline-article-markup.js). Split out of that module at
 * its 1015-line cap; behaviour unchanged.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineArticlePrediction = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // `deps`: the article-markup pipeline's state bag, its timeline/thread
  // column elements, and the upstream resolvers it was given:
  // resolveArticlePredictionCacheKey(message, projectionContext),
  // resolveVisibleTurnArticleTarget(messageId) and
  // buildTurnRowListMarkup(rows, messages, options).
  function createArticlePrediction(deps) {
    const {
      state = {},
      chatTimeline = null,
      chatThreadColumn = null,
      resolveArticlePredictionCacheKey = () => '',
      resolveVisibleTurnArticleTarget = () => null,
      buildTurnRowListMarkup = () => '',
    } = deps || {};

    function getPretextUtils() {
      const pretextUtils = typeof rendererPretextUtils !== 'undefined' ? rendererPretextUtils : null;
      return pretextUtils && pretextUtils.isEnabled(state) ? pretextUtils : null;
    }

    function resolveTranscriptPredictionFont(pretextUtils) {
      return pretextUtils ? pretextUtils.resolveDefaultFontString('.chat-bubble') : null;
    }

    function resolveUserPredictionWidth(pretextUtils) {
      if (!pretextUtils) {
        return 0;
      }
      const bubble = chatTimeline ? chatTimeline.querySelector('.chat-entry.user .chat-bubble') : null;
      const entry = chatTimeline ? chatTimeline.querySelector('.chat-entry.user') : null;
      return pretextUtils.resolveElementWidth(bubble)
        || pretextUtils.resolveElementWidth(entry)
        || 560;
    }

    function resolveAssistantPredictionWidth(pretextUtils) {
      if (!pretextUtils) {
        return 0;
      }
      const content = chatTimeline ? chatTimeline.querySelector('.chat-entry.assistant .chat-message-content') : null;
      return pretextUtils.resolveElementWidth(content)
        || pretextUtils.resolveElementWidth(chatThreadColumn)
        || 760;
    }
    const COLLAPSED_BODY_EXCLUDE_SELECTOR = '.tool-call-row[data-expanded="false"] .tool-call-row-body, .reasoning-row-panel:not(.expanded) .reasoning-row-panel-body';
    const COLLAPSED_BODY_PREDICTION_OPTIONS = Object.freeze({
      excludeSelector: COLLAPSED_BODY_EXCLUDE_SELECTOR,
    });
    // Transcript view 'answers': the stylesheet hides settled reasoning rows
    // and the members of a collapsed tool run (styles/chat-thread-rail.css),
    // so the prediction drops them too.
    const ANSWERS_VIEW_PREDICTION_OPTIONS = Object.freeze({
      excludeSelector: `${COLLAPSED_BODY_EXCLUDE_SELECTOR}, .turn-row-list:not([data-turn-live="true"]) .chat-row[data-row-kind="reasoning"], .chat-row[data-run-member]:not([data-run-expanded="true"])`,
    });
    function resolveHtmlPredictionOptions(htmlString, transcriptView) {
      const markup = String(htmlString || '');
      if (transcriptView === 'answers'
        && (markup.includes('data-row-kind="reasoning"') || markup.includes('data-run-member'))) {
        return ANSWERS_VIEW_PREDICTION_OPTIONS;
      }
      return markup.includes('tool-call-row-body') || markup.includes('reasoning-row-panel-body')
        ? COLLAPSED_BODY_PREDICTION_OPTIONS
        : undefined;
    }
    function maybePredictArticleHeight(message, htmlString, textContent, projectionContext) {
      const pretextUtils = getPretextUtils();
      if (!pretextUtils || !message) {
        return null;
      }
      const cacheKey = resolveArticlePredictionCacheKey(message, projectionContext);
      if (!cacheKey || cacheKey === 'article:') {
        return null;
      }
      const font = resolveTranscriptPredictionFont(pretextUtils);
      if (!font) {
        return null;
      }
      const isUserMessage = String(message.role || '').trim() === 'user';
      const maxWidth = isUserMessage
        ? resolveUserPredictionWidth(pretextUtils)
        : resolveAssistantPredictionWidth(pretextUtils);
      if (!maxWidth) {
        return null;
      }
      const prediction = isUserMessage
        ? pretextUtils.predictTextHeight(cacheKey, textContent, font, maxWidth, 15 * 1.6)
        : pretextUtils.predictHtmlContentHeight(
            cacheKey, htmlString, font, maxWidth, 15 * 1.6, resolveHtmlPredictionOptions(htmlString)
          );
      return prediction && prediction.height > 0
        ? Math.ceil(prediction.height)
        : null;
    }

    function maybePredictTurnHeight(turn, rows, messages, options, prebuiltRowListHtml) {
      const pretextUtils = getPretextUtils();
      if (!pretextUtils || !turn || !Array.isArray(rows) || rows.length < 1) {
        return null;
      }
      const font = resolveTranscriptPredictionFont(pretextUtils);
      const maxWidth = resolveAssistantPredictionWidth(pretextUtils);
      if (!font || !maxWidth) {
        return null;
      }
      const sourceRows = rows.filter(function includeRow(row) {
        return row && String(row.kind || '') !== 'user_bubble';
      });
      if (!sourceRows.length) {
        return null;
      }
      // Predict the exact assembled row list so tool-call/result pairing and
      // collapsed-body visibility match the DOM rather than measuring each
      // projected row as if it rendered independently. An article passes the
      // row list it already built (same non-user rows); a standalone call builds.
      const turnMarkup = typeof prebuiltRowListHtml === 'string'
        ? prebuiltRowListHtml
        : buildTurnRowListMarkup(sourceRows, messages, options || {});
      const prediction = pretextUtils.predictHtmlContentHeight(
        `turn:${String(turn.turn_id || '').trim()}`,
        turnMarkup,
        font,
        maxWidth,
        15 * 1.6,
        resolveHtmlPredictionOptions(turnMarkup, options && options.transcriptView)
      );
      return prediction && prediction.height > 0 ? Math.ceil(prediction.height) : null;
    }

    let predictedHeightCleanupFrame = 0;
    let predictedHeightCleanupTimer = 0;

    function clearPredictedHeightStyles() {
      if (!chatTimeline) {
        return;
      }
      chatTimeline.querySelectorAll('[data-predicted-height]').forEach(function clearMinHeight(node) {
        if (!node || !node.style) return;
        // DOM-window placeholders use the same inline property to preserve
        // scroll geometry while their article body is detached. Clearing it
        // here collapses the placeholder and lets the virtualizer restore the
        // old prediction on remount. The entry store discards prediction-owned
        // values from its restore snapshot, so mounted entries remain safe to
        // clear while virtualized entries retain their measured placeholder.
        if (node.getAttribute?.('data-virtualized') === 'true') return;
        node.style.minHeight = '';
      });
    }

    function schedulePredictedHeightCleanup() {
      if (!chatTimeline) {
        return;
      }
      const windowRef = typeof window !== 'undefined' ? window : null;
      if (!windowRef) {
        clearPredictedHeightStyles();
        return;
      }
      if (predictedHeightCleanupFrame && typeof windowRef.cancelAnimationFrame === 'function') {
        windowRef.cancelAnimationFrame(predictedHeightCleanupFrame);
      }
      const runCleanup = function runCleanup() {
        predictedHeightCleanupFrame = 0;
        if (predictedHeightCleanupTimer && typeof windowRef.clearTimeout === 'function') {
          windowRef.clearTimeout(predictedHeightCleanupTimer);
        }
        predictedHeightCleanupTimer = 0;
        clearPredictedHeightStyles();
      };
      if (typeof windowRef.requestAnimationFrame === 'function') {
        predictedHeightCleanupFrame = windowRef.requestAnimationFrame(runCleanup);
      } else {
        runCleanup();
        return;
      }
      if (!predictedHeightCleanupTimer && typeof windowRef.setTimeout === 'function') {
        predictedHeightCleanupTimer = windowRef.setTimeout(function forcePredictedHeightCleanup() {
          if (predictedHeightCleanupFrame && typeof windowRef.cancelAnimationFrame === 'function') {
            windowRef.cancelAnimationFrame(predictedHeightCleanupFrame);
          }
          runCleanup();
        }, 48);
      }
    }

    function syncPatchedArticlePrediction(messageId, predictedHeight) {
      if (!chatTimeline) {
        return;
      }
      const normalizedMessageId = String(messageId || '').trim();
      if (!normalizedMessageId) {
        return;
      }
      const article = resolveVisibleTurnArticleTarget(normalizedMessageId);
      if (!article) {
        return;
      }
      const nextHeight = Number(predictedHeight) || 0;
      if (nextHeight > 0) {
        article.dataset.predictedHeight = String(nextHeight);
        article.style.minHeight = `${nextHeight}px`;
        return;
      }
      article.style.minHeight = '';
      article.removeAttribute('data-predicted-height');
    }

    return {
      maybePredictArticleHeight,
      maybePredictTurnHeight,
      schedulePredictedHeightCleanup,
      syncPatchedArticlePrediction,
    };
  }

  return { createArticlePrediction };
});
