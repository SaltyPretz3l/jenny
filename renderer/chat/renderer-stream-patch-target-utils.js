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

  // The key a reasoning block aligns on: its phase key, else its thinking id,
  // else its ordinal. Shared by the stack patch and the block resolver.
  function getReasoningBlockKey(block, index) {
    const key = String(
      block?.getAttribute?.('data-phase-key')
      || block?.getAttribute?.('data-thinking-id')
      || ''
    ).trim();
    return key || `index:${index}`;
  }

  // `diagnostics` (optional): a plain object; every null return names why in
  // diagnostics.reason. The fallback it triggers rebuilds the whole turn row
  // list, and an anonymous null hid that rebuild behind "patch applied" for
  // months (timeline-perf 2026-09-30). Keys stay short and fixed: they ship
  // in client_timing.row_list_morph_reasons.
  function resolveReasoningPatchBlocks(existingBlocks, nextStack, scope, rowModelList, getBlockKey, diagnostics) {
    const reject = (reason) => {
      if (diagnostics && typeof diagnostics === 'object') diagnostics.reason = reason;
      return null;
    };
    const nextBlocks = Array.from(nextStack.querySelectorAll('.reasoning-row-block'));
    if (!rowModelList || !scope?.matches?.('.chat-row[data-row-kind="reasoning"]')) {
      return nextBlocks;
    }

    // A checkpoint row owns only its phase; the incoming stack owns the message.
    // Align local blocks by key, and leave already-rendered sibling phases alone.
    const nextByKey = new Map(nextBlocks.map((block, index) => [getBlockKey(block, index), block]));
    const localKeys = new Set(existingBlocks.map(getBlockKey));
    if (nextByKey.size !== nextBlocks.length || localKeys.size !== existingBlocks.length) {
      return reject('duplicate_block_key');
    }
    const alignedBlocks = existingBlocks.map((block, index) => nextByKey.get(getBlockKey(block, index)));
    if (alignedBlocks.some((block) => !block)) {
      return reject('block_unaligned');
    }
    const otherBlocks = Array.from(rowModelList.querySelectorAll('.reasoning-row-block'))
      .filter((block) => !scope.contains(block));
    const otherByKey = new Map(otherBlocks.map((block, index) => [getBlockKey(block, index), block]));
    if (otherByKey.size !== otherBlocks.length) {
      return reject('sibling_duplicate_key');
    }
    // A sibling phase is left alone only while its rendered status and settled
    // fingerprint (summary, labels, body) still match the incoming stack.
    const sameAttribute = (left, right, name) => left.getAttribute(name) === right.getAttribute(name);
    for (const [key, nextBlock] of nextByKey) {
      if (localKeys.has(key)) continue;
      const renderedBlock = otherByKey.get(key);
      if (!renderedBlock) return reject('sibling_missing');
      if (!sameAttribute(renderedBlock, nextBlock, 'data-reasoning-status')) return reject('sibling_status_mismatch');
      if (!sameAttribute(renderedBlock, nextBlock, 'data-reasoning-fp')) return reject('sibling_fp_mismatch');
    }
    return alignedBlocks;
  }

  // The reasoning row the LIVE segment streams into. A row-model turn article
  // interleaves every segment's reasoning, so an article-wide first match would
  // mirror the stream into segment 0. A row keeps its first segment as
  // data-source-message-id when the reducer reuses it for a later segment (a
  // phase/thinking id repeated across a tool boundary); the later segment is
  // then named only in the space-separated data-source-message-ids (HB-005).
  // Missing that row fell back to the LAST stack -- another segment's row --
  // so every reasoning delta failed its block-key check and rebuilt the whole
  // turn's row list, large diff rows included. Last resort stays the last stack.
  function resolveLiveReasoningScope(rowModelList, messageId, escapeSelectorValue) {
    const escape = typeof escapeSelectorValue === 'function' ? escapeSelectorValue : (value) => String(value || '');
    const normalizedId = String(messageId || '').trim();
    if (normalizedId) {
      const reasoningRow = '.chat-row[data-row-kind="reasoning"]';
      for (const attribute of ['data-source-message-id=', 'data-source-message-ids~=']) {
        const rows = rowModelList.querySelectorAll(`${reasoningRow}[${attribute}"${escape(normalizedId)}"]`);
        if (rows.length) return rows[rows.length - 1];
      }
    }
    const stacks = rowModelList.querySelectorAll('.reasoning-row-stack');
    if (stacks.length) {
      return stacks[stacks.length - 1].closest('.chat-row') || rowModelList;
    }
    return rowModelList;
  }

  function rowNamesMessage(row, messageId) {
    return row?.getAttribute?.('data-source-message-id') === messageId
      || String(row?.getAttribute?.('data-source-message-ids') || '').split(/\s+/).includes(messageId);
  }

  function sameReasoningState(left, right) {
    const leftBlocks = Array.from(left.querySelectorAll('.reasoning-row-block'));
    const rightBlocks = Array.from(right.querySelectorAll('.reasoning-row-block'));
    return leftBlocks.length === rightBlocks.length && leftBlocks.every((block, index) => (
      ['data-phase-key', 'data-reasoning-status', 'data-reasoning-fp']
        .every((name) => block.getAttribute(name) === rightBlocks[index].getAttribute(name))
    ));
  }

  // HB-010: the incoming reasoning stack for a row-model patch. The
  // message-level widget renders every phase of the stream (reasoning_phases
  // is stream-scoped, and entries without a known thinking id group apart), so
  // it never lines up with a one-phase row and every delta rebuilt the whole
  // turn row list. Take the live row's own render instead: the live segment's
  // reasoning rows rendered the way the turn article renders them. Only when
  // the scope row names the live segment (the last-stack fallback belongs to
  // another segment) and every other row the segment owns is already on screen
  // with the same phase state -- a checkpoint continuation opening phase 2, or
  // phase 1 settling, is structural and keeps the row-list morph. null means
  // "use the message-level stack" (and its fallback).
  // `options.diagnostics` (optional) receives the null reason, same contract
  // as resolveReasoningPatchBlocks.
  function buildLiveReasoningRowStackMarkup(options) {
    const { scope, rowModelList, messageId, buildLiveReasoningRowsMarkup, doc, diagnostics } = options || {};
    const reject = (reason) => {
      if (diagnostics && typeof diagnostics === 'object') diagnostics.reason = reason;
      return null;
    };
    const normalizedId = String(messageId || '').trim();
    const rowId = String(scope?.getAttribute?.('data-row-id') || '').trim();
    if (!normalizedId || !rowId || typeof buildLiveReasoningRowsMarkup !== 'function'
      || typeof doc?.createElement !== 'function' || !rowModelList?.querySelectorAll) {
      return reject('helper_unavailable');
    }
    if (!scope.matches?.('.chat-row[data-row-kind="reasoning"]')) return reject('scope_not_reasoning_row');
    if (!rowNamesMessage(scope, normalizedId)) return reject('scope_names_other_segment');
    const template = doc.createElement('template');
    template.innerHTML = String(buildLiveReasoningRowsMarkup() || '').trim();
    const renderedById = new Map(Array.from(rowModelList.querySelectorAll('.chat-row[data-row-kind="reasoning"]'))
      .map((row) => [row.getAttribute('data-row-id'), row]));
    let scopeStack = null;
    for (const freshRow of template.content.querySelectorAll('.chat-row[data-row-kind="reasoning"]')) {
      const freshId = freshRow.getAttribute('data-row-id');
      if (freshId === rowId) {
        scopeStack = freshRow.querySelector('.reasoning-row-stack');
      } else if (!renderedById.has(freshId)) {
        return reject('segment_row_not_rendered');
      } else if (!sameReasoningState(renderedById.get(freshId), freshRow)) {
        return reject('segment_row_state_mismatch');
      }
    }
    return scopeStack ? scopeStack.outerHTML : reject('scope_stack_missing');
  }

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
    getReasoningBlockKey,
    buildLiveReasoningRowStackMarkup,
    createStreamPatchTargetUtils,
    resolveLiveReasoningScope,
    resolveReasoningPatchBlocks,
  };
});
