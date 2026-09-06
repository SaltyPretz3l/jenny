(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamPatchTargetUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The live bubble is the ground truth for which article is streaming.
  const STREAMING_BUBBLE_SELECTOR = '[data-streaming-bubble="true"]';

  function createStreamPatchTargetUtils(deps) {
    const settings = deps || {};
    const getRuntime = typeof settings.getRuntime === 'function'
      ? settings.getRuntime
      : function noopGetRuntime() { return null; };
    const getChatTimeline = typeof settings.getChatTimeline === 'function'
      ? settings.getChatTimeline
      : function noopGetChatTimeline() { return null; };
    const escapeSelectorValue = typeof settings.escapeSelectorValue === 'function'
      ? settings.escapeSelectorValue
      : (value) => String(value || '');
    const resolveVisibleMessageDomTarget = typeof settings.resolveVisibleMessageDomTarget === 'function'
      ? settings.resolveVisibleMessageDomTarget
      : function fallbackResolveVisibleMessageDomTarget(container, messageId) {
        if (!container || typeof container.querySelector !== 'function') return null;
        return container.querySelector(`[data-message-id="${escapeSelectorValue(messageId)}"]`);
      };

    function resolveStreamingRowPatchTarget(runtimeState, container) {
      const nextRuntime = runtimeState || getRuntime();
      const targetContainer = container || getChatTimeline();
      const rowTarget = nextRuntime?.streamingRowTarget && typeof nextRuntime.streamingRowTarget === 'object'
        ? nextRuntime.streamingRowTarget
        : null;
      if (!rowTarget || !targetContainer || typeof targetContainer.querySelector !== 'function') {
        return null;
      }
      const turnId = String(rowTarget.turnId || '').trim();
      const rowKind = String(rowTarget.rowKind || '').trim();
      const toolCallId = String(rowTarget.toolCallId || '').trim();
      if (!turnId || !rowKind || !toolCallId) {
        return null;
      }
      return targetContainer.querySelector(
        `[data-row-id="${escapeSelectorValue(`${turnId}:${rowKind}:${toolCallId}`)}"]`
      );
    }

    // [data-message-id] also appears on nested controls (reasoning-row header
    // buttons carry their segment's message id for toggle wiring), so a raw
    // first-match lookup can hand the article patch a BUTTON — which then gets
    // its innerHTML replaced with article markup. Always lift a match to its
    // enclosing .chat-entry article; a node with no such ancestor passes
    // through unchanged (legacy/stub DOM shapes).
    function liftPatchTargetToArticle(node) {
      if (!node) {
        return null;
      }
      if (typeof node.matches === 'function' && node.matches('.chat-entry')) {
        return node;
      }
      const article = typeof node.closest === 'function' ? node.closest('.chat-entry') : null;
      return article || node;
    }

    // Structural resolve: finds the article by message identity alone, never
    // consulting the marker. resolveVisibleMessageDomTarget is already
    // segment-aware (it skips thread-compat anchors and lifts a row to its
    // owning article), so this is the authority the marker only caches.
    function resolveStreamingArticleByMessageId(runtimeState, container) {
      const nextRuntime = runtimeState || getRuntime();
      const targetContainer = container || getChatTimeline();
      if (!targetContainer || typeof targetContainer.querySelector !== 'function') {
        return null;
      }
      const streamingMessageId = String(nextRuntime?.streamingMessageId || '').trim();
      const streamingArticleMessageId = String(nextRuntime?.streamingArticleMessageId || '').trim();
      if (streamingArticleMessageId) {
        const byArticleMessageId = resolveVisibleMessageDomTarget(targetContainer, streamingArticleMessageId);
        if (byArticleMessageId) {
          return liftPatchTargetToArticle(byArticleMessageId);
        }
      }
      return streamingMessageId
        ? liftPatchTargetToArticle(resolveVisibleMessageDomTarget(targetContainer, streamingMessageId))
        : null;
    }

    // Marker-first resolve for the patch path. The marker is a cheap cache over
    // resolveStreamingArticleByMessageId; stampStreamingArticleMarker keeps it to
    // one node, and the multi-match branch self-heals a DOM that drifted anyway
    // (article markup bakes the attribute in, so a rebuild can reintroduce a
    // duplicate between stamps). Trusting a first match blindly is what anchored
    // the patch to an article holding no live bubble and full-rendered the whole
    // transcript on every delta after an approval.
    function resolveStreamingArticlePatchTarget(runtimeState, container) {
      const nextRuntime = runtimeState || getRuntime();
      const targetContainer = container || getChatTimeline();
      if (!targetContainer || typeof targetContainer.querySelectorAll !== 'function') {
        return null;
      }
      const streamingMessageId = String(nextRuntime?.streamingMessageId || '').trim();
      if (streamingMessageId) {
        const marked = targetContainer.querySelectorAll(
          `[data-streaming-message-id="${escapeSelectorValue(streamingMessageId)}"]`
        );
        if (marked.length > 1) {
          for (const candidate of marked) {
            if (candidate.querySelector && candidate.querySelector(STREAMING_BUBBLE_SELECTOR)) {
              return liftPatchTargetToArticle(candidate);
            }
          }
        }
        if (marked.length) {
          return liftPatchTargetToArticle(marked[0]);
        }
      }
      return resolveStreamingArticleByMessageId(nextRuntime, targetContainer);
    }

    function resolveStreamingPatchTarget(runtimeState, container) {
      return resolveStreamingRowPatchTarget(runtimeState, container)
        || resolveStreamingArticlePatchTarget(runtimeState, container);
    }

    function resolvePatchTargetArticle(patchTarget) {
      if (!patchTarget) {
        return null;
      }
      return patchTarget.matches?.('[data-message-id]')
        ? patchTarget
        : patchTarget.closest?.('[data-message-id]') || null;
    }

    function normalizeStreamingRowTarget(target) {
      return target && typeof target === 'object'
        ? {
          turnId: String(target.turnId || '').trim(),
          rowKind: String(target.rowKind || '').trim(),
          toolCallId: String(target.toolCallId || '').trim(),
        }
        : null;
    }

    // Re-anchors the marker onto the live article. Resolves STRUCTURALLY on
    // purpose: the marker-first resolver reads the very attribute the stamp is
    // about to sweep, so consulting it here could only re-confirm a stale
    // anchor. No streaming message means no marker may survive at all.
    function anchorStreamingArticleMarker(runtimeState, container) {
      const nextRuntime = runtimeState || getRuntime();
      const targetContainer = container || getChatTimeline();
      const streamingMessageId = String(nextRuntime?.streamingMessageId || '').trim();
      if (!streamingMessageId) {
        sweepStreamingArticleMarkers(targetContainer, null);
        return null;
      }
      return stampStreamingArticleMarker(
        resolveStreamingArticleByMessageId(nextRuntime, targetContainer),
        streamingMessageId,
        targetContainer
      );
    }

    // canPatchMessage answers yes/no; this names the FIRST comparand that
    // failed, so a full render is attributable instead of anonymous. The
    // caller supplies streamingMessage. Read-only: never mutates runtime.
    function describePatchBlock(options) {
      const nextOptions = options || {};
      const nextRuntime = getRuntime();
      const targetContainer = getChatTimeline();
      const streamingMessage = nextOptions.streamingMessage;
      const structureSignature = nextOptions.structureSignature != null ? nextOptions.structureSignature : 0;
      if (!streamingMessage) {
        return 'no_streaming_message';
      }
      if (!targetContainer) {
        return 'no_timeline';
      }
      if (nextRuntime?.sessionId !== String(nextOptions.currentSessionId || '')) {
        return 'session_mismatch';
      }
      if (nextRuntime?.structureSignature !== structureSignature) {
        return 'signature_mismatch';
      }
      if (nextRuntime?.streamingMessageId !== String(streamingMessage.id || '')) {
        return 'streaming_id_mismatch';
      }
      return '';
    }
    // The streaming marker is a SINGLETON: the patch path trusts it as its
    // anchor, so a second live marker lets the resolver hand back an article
    // that no longer holds the stream. Clears every marker except keepNode --
    // the node the caller is about to stamp.
    function sweepStreamingArticleMarkers(container, keepNode) {
      const targetContainer = container || getChatTimeline();
      if (!targetContainer || typeof targetContainer.querySelectorAll !== 'function') {
        return;
      }
      const marked = targetContainer.querySelectorAll('[data-streaming-message-id]');
      for (const node of marked) {
        if (node !== keepNode && node.dataset) {
          delete node.dataset.streamingMessageId;
        }
      }
    }

    // The ONE writer of the marker: sweeping is part of stamping, so the
    // singleton holds by construction. It cannot be a repair that only runs on
    // the full-render path -- the patch path re-stamps its own article on every
    // delta, so any duplicate a repair removed would be recreated by the very
    // next token.
    function stampStreamingArticleMarker(article, streamingMessageId, container) {
      const nextId = String(streamingMessageId || '').trim();
      sweepStreamingArticleMarkers(container, nextId ? article : null);
      if (!article?.dataset) {
        return null;
      }
      if (nextId) {
        article.dataset.streamingMessageId = nextId;
      } else {
        delete article.dataset.streamingMessageId;
      }
      return article;
    }

    function clearStreamingArticleMarker(articleOverride, runtimeState, container) {
      const patchTarget = articleOverride
        || resolveStreamingPatchTarget(runtimeState, container);
      const article = patchTarget?.matches?.('[data-message-id]')
        ? patchTarget
        : patchTarget?.closest?.('[data-message-id]');
      if (article?.dataset) {
        delete article.dataset.streamingMessageId;
      }
    }

    return {
      anchorStreamingArticleMarker,
      clearStreamingArticleMarker,
      describePatchBlock,
      sweepStreamingArticleMarkers,
      normalizeStreamingRowTarget,
      resolvePatchTargetArticle,
      resolveStreamingArticleByMessageId,
      resolveStreamingArticlePatchTarget,
      resolveStreamingPatchTarget,
      stampStreamingArticleMarker,
      resolveStreamingRowPatchTarget,
    };
  }

  return {
    createStreamPatchTargetUtils,
  };
});
