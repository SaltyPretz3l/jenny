/* renderer/chat/renderer-stream-reasoning-patch-utils.js
 * The surgical reasoning-stack patch of the stream-reveal controller
 * (renderer-stream-reveal-utils.js): aligns the live reasoning blocks with the
 * freshly built stack and patches header, panel and body in place, or names
 * why the delta needs the row-list fallback. Split out of the controller at
 * its 1015-line cap; behaviour unchanged.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamReasoningPatchUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function resolveSibling(globalName, modulePath) {
    if (typeof globalThis !== 'undefined' && globalThis[globalName]) return globalThis[globalName];
    if (typeof require === 'function') {
      try { return require(modulePath); } catch (_error) { /* not available */ }
    }
    return {};
  }
  const streamDomPatchUtils = resolveSibling('rendererStreamDomPatchUtils', './renderer-stream-dom-patch-utils');
  const streamPatchTargetUtils = resolveSibling('rendererStreamPatchTargetUtils', './renderer-stream-patch-target-utils');
  const thinkingPanelSettleUtils = resolveSibling('rendererThinkingPanelSettleUtils', '../shell/renderer-thinking-panel-settle-utils');
  const autocollapseUtils = resolveSibling('rendererReasoningAutocollapseUtils', './renderer-reasoning-autocollapse-utils');
  const { morphElementChildren, reconcileStreamUnits, setInnerHtmlPreservingCodeScroll } = streamDomPatchUtils;
  // Every write below lands inside a reasoning row the reconcile may have
  // stamped: flag it so its live-descendant check runs (see dom-patch utils).
  const noteRowSubtreeWrite = typeof streamDomPatchUtils.noteRowSubtreeWrite === 'function'
    ? streamDomPatchUtils.noteRowSubtreeWrite
    : () => {};

  // `deps`: the controller-scoped pieces -- getRuntime (the controller's
  // runtime record: lastThinkingMarkup/-Key, streamingArticleMessageId,
  // streamingMessageId), isStreamPaintV2Enabled, noteHeaderPatch(kind) and
  // buildAutoCollapseOptions(doc).
  function createReasoningStackPatcher(deps) {
    const settings = deps || {};
    const getRuntime = typeof settings.getRuntime === 'function' ? settings.getRuntime : () => ({});
    const isStreamPaintV2Enabled = typeof settings.isStreamPaintV2Enabled === 'function'
      ? settings.isStreamPaintV2Enabled
      : () => false;
    const noteHeaderPatch = typeof settings.noteHeaderPatch === 'function' ? settings.noteHeaderPatch : () => {};
    const buildAutoCollapseOptions = typeof settings.buildAutoCollapseOptions === 'function'
      ? settings.buildAutoCollapseOptions
      : () => ({});

    function parseReasoningStack(markup, doc) {
      const source = String(markup || '').trim();
      if (!source || !doc || typeof doc.createElement !== 'function') {
        return null;
      }
      const template = doc.createElement('template');
      template.innerHTML = source;
      return template.content.querySelector('.reasoning-row-stack');
    }

    function copyElementAttributes(target, source, options = {}) {
      if (!target || !source) {
        return;
      }
      const preserveStyle = options.preserveStyle === true;
      Array.from(target.attributes || []).forEach((attribute) => {
        if (preserveStyle && attribute.name === 'style') {
          return;
        }
        if (!source.hasAttribute(attribute.name)) {
          target.removeAttribute(attribute.name);
        }
      });
      Array.from(source.attributes || []).forEach((attribute) => {
        if (preserveStyle && attribute.name === 'style') {
          return;
        }
        target.setAttribute(attribute.name, attribute.value);
      });
    }

    const getReasoningBlockKey = streamPatchTargetUtils.getReasoningBlockKey;

    function patchReasoningBlock(existingBlock, nextBlock) {
      const existingHeader = existingBlock?.querySelector?.('.reasoning-row-header');
      const nextHeader = nextBlock?.querySelector?.('.reasoning-row-header');
      const existingPanel = existingBlock?.querySelector?.('.reasoning-row-panel');
      const nextPanel = nextBlock?.querySelector?.('.reasoning-row-panel');
      if (!existingHeader || !nextHeader || !existingPanel || !nextPanel) {
        return false;
      }

      copyElementAttributes(existingBlock, nextBlock);
      copyElementAttributes(existingHeader, nextHeader);
      if (existingHeader.innerHTML !== nextHeader.innerHTML) {
        const morphed = isStreamPaintV2Enabled()
          && typeof morphElementChildren === 'function'
          && morphElementChildren(existingHeader, nextHeader);
        if (morphed) {
          noteHeaderPatch('reasoning_header_morph');
        } else {
          existingHeader.innerHTML = nextHeader.innerHTML;
          noteHeaderPatch('reasoning_header_rewrite');
        }
      }

      // A panel mid auto-collapse keeps its animation state; a second settled
      // patch would otherwise strip data-collapsing and re-hide it instantly.
      const collapsing = autocollapseUtils.isReasoningPanelCollapsing?.(existingPanel) === true;
      const settledClass = thinkingPanelSettleUtils.SETTLED_CLASS || 'reasoning-row-panel--settled';
      const wasSettled = existingPanel.classList.contains(settledClass);
      const wasOpen = !collapsing && existingPanel.classList.contains('expanded') && !existingPanel.hidden;
      if (!collapsing) {
        copyElementAttributes(existingPanel, nextPanel, { preserveStyle: true });
        existingPanel.hidden = nextPanel.hidden;
        if (wasSettled && existingPanel.classList.contains('expanded') && !existingPanel.hidden) existingPanel.classList.add(settledClass);
      }
      const shouldAnimateCollapse = wasOpen && existingPanel.hidden
        && typeof autocollapseUtils.runReasoningPanelAutoCollapse === 'function';

      const existingBody = existingPanel.querySelector('.reasoning-row-panel-body');
      const nextBody = nextPanel.querySelector('.reasoning-row-panel-body');
      if (existingBody && nextBody) {
        copyElementAttributes(existingBody, nextBody);
        // Per-unit soft-landing reveal: update changed units in place and reveal
        // only the trailing <=2 newly appended ones. Settled/flat bodies (no
        // .reasoning-stream-unit children) fall through to a bulk replace inside
        // the helper. Guarded so a stubbed dom-patch module still patches.
        if (typeof reconcileStreamUnits === 'function') {
          reconcileStreamUnits(existingBody, nextBody, existingBlock.ownerDocument, {
            unitClassName: 'reasoning-stream-unit',
            revealCap: 2,
            staggerMs: 90,
          });
        } else if (existingBody.innerHTML !== nextBody.innerHTML) {
          setInnerHtmlPreservingCodeScroll(existingBody, nextBody.innerHTML);
        }
      } else if (!existingBody && nextBody) {
        existingPanel.appendChild(nextBody.cloneNode(true));
      } else if (existingBody && !nextBody) {
        existingBody.remove();
      }
      // Runs AFTER the body swap so the collapse starts from the settled
      // body's height, not the taller live one (no mid-collapse jump).
      if (shouldAnimateCollapse) {
        autocollapseUtils.runReasoningPanelAutoCollapse(existingPanel, buildAutoCollapseOptions(existingBlock.ownerDocument));
      }
      return true;
    }

    // Every result carries `reason` (fixed vocabulary): a requiresFullFallback
    // result sends the delta to the row-list morph, which ships that reason.
    function patchReasoningStack(article, patchModel, doc, rowModelList) {
      const runtime = getRuntime();
      const hasThinkingMarkup = Object.prototype.hasOwnProperty.call(patchModel || {}, 'thinkingMarkup');
      if (!hasThinkingMarkup) {
        return { patched: false, requiresFullFallback: false, hasThinkingMarkup: false, reason: 'no_thinking_markup' };
      }
      const fallback = (reason) => ({ patched: false, requiresFullFallback: true, hasThinkingMarkup: true, reason });

      const incomingMarkup = String(patchModel?.thinkingMarkup || '');
      const cacheKey = runtime.streamingArticleMessageId || runtime.streamingMessageId || '';
      if (
        cacheKey
        && cacheKey === runtime.lastThinkingMarkupKey
        && incomingMarkup === runtime.lastThinkingMarkup
        && article?.querySelector?.('.reasoning-row-stack')
      ) {
        return { patched: true, requiresFullFallback: false, hasThinkingMarkup: true, reason: 'stack_unchanged' };
      }

      const nextStack = parseReasoningStack(patchModel?.thinkingMarkup, doc);
      const existingStack = article?.querySelector?.('.reasoning-row-stack');
      if (!nextStack && !existingStack) {
        runtime.lastThinkingMarkup = incomingMarkup;
        runtime.lastThinkingMarkupKey = cacheKey;
        return { patched: false, requiresFullFallback: false, hasThinkingMarkup: true, reason: 'no_stack' };
      }
      if (nextStack && !existingStack) {
        const bubble = article?.querySelector?.('[data-streaming-bubble="true"]');
        if (bubble) {
          noteRowSubtreeWrite(bubble);
          bubble.before(nextStack);
          return { patched: true, requiresFullFallback: false, hasThinkingMarkup: true, reason: 'stack_inserted' };
        }
        return fallback('stack_new_no_bubble');
      }
      if (!nextStack || !existingStack) {
        return fallback('stack_removed');
      }

      const existingBlocks = Array.from(existingStack.querySelectorAll('.reasoning-row-block'));
      const blockDiagnostics = { reason: 'blocks_unresolved' };
      const nextBlocks = streamPatchTargetUtils.resolveReasoningPatchBlocks(
        existingBlocks, nextStack, article, rowModelList, getReasoningBlockKey, blockDiagnostics
      );
      if (!nextBlocks) {
        return fallback(blockDiagnostics.reason);
      }
      if (existingBlocks.length !== nextBlocks.length) {
        return fallback('block_count_mismatch');
      }
      for (let index = 0; index < existingBlocks.length; index += 1) {
        if (getReasoningBlockKey(existingBlocks[index], index) !== getReasoningBlockKey(nextBlocks[index], index)) {
          return fallback('block_key_mismatch');
        }
      }

      noteRowSubtreeWrite(existingStack);
      copyElementAttributes(existingStack, nextStack);
      for (let index = 0; index < existingBlocks.length; index += 1) {
        if (!patchReasoningBlock(existingBlocks[index], nextBlocks[index])) {
          return fallback('block_shape_mismatch');
        }
      }
      runtime.lastThinkingMarkup = incomingMarkup;
      runtime.lastThinkingMarkupKey = cacheKey;
      return { patched: true, requiresFullFallback: false, hasThinkingMarkup: true, reason: 'patched' };
    }

    return { patchReasoningStack };
  }

  return { createReasoningStackPatcher };
});
