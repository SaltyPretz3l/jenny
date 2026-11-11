/* renderer/chat/renderer-chat-tool-row-toggles.js owns the transcript's
 * tool-row disclosure motion: the legacy .tool-call-header details toggle
 * (with its pretext height prediction and motion timing, wired per pane by
 * renderer-chat-event-utils.js) and the minimal tool row / Answers tool-run
 * toggles with lazy detail materialization (wired by
 * renderer-chat-event-transcript-bindings.js). Loaded before both. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatToolRowToggles = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const motionHeightUtils = (typeof globalThis !== 'undefined' && globalThis.rendererMotionHeightUtils)
    || (typeof require === 'function' ? require('../shared/motion-height-utils') : null) || {};

  // A user toggle tells the search overlay to drop its transient record.
  function dispatchToolRowUserExpansion(chatTimeline, ownerDocument, rowKey, expanded) {
    const CustomEventCtor = ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
    if (rowKey && typeof CustomEventCtor === 'function') {
      chatTimeline?.dispatchEvent?.(new CustomEventCtor('tool-row-user-expansion', { detail: { rowKey, expanded } }));
    }
  }

  function createToolDetailsToggle(deps) {
    const {
      state,
      chatTimeline,
      renderAll,
      setToolCallExpansion = function noopSetToolCallExpansion() {},
    } = deps || {};

    function readCssDurationMs(variableName, fallbackMs) {
      if (typeof document === 'undefined' || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
        return fallbackMs;
      }
      const rawValue = window.getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
      if (!rawValue) {
        return fallbackMs;
      }
      if (rawValue.endsWith('ms')) {
        const parsedMs = Number.parseFloat(rawValue);
        return Number.isFinite(parsedMs) ? parsedMs : fallbackMs;
      }
      if (rawValue.endsWith('s')) {
        const parsedSeconds = Number.parseFloat(rawValue);
        return Number.isFinite(parsedSeconds) ? parsedSeconds * 1000 : fallbackMs;
      }
      return fallbackMs;
    }

    function prefersReducedMotion() {
      return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function getToolDetailsTransitionMs() {
      return prefersReducedMotion()
        ? 0
        : readCssDurationMs('--motion-duration-regular', 220);
    }

    const toolDetailsTimers = new WeakMap();

    function clearToolDetailsTimer(detailsEl) {
      if (!detailsEl) {
        return;
      }
      const timerId = toolDetailsTimers.get(detailsEl);
      if (!timerId) {
        return;
      }
      window.clearTimeout(timerId);
      toolDetailsTimers.delete(detailsEl);
    }

    function resolvePredictionLineHeight(element) {
      if (!element || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
        return 15 * 1.6;
      }
      const parsedLineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
      return Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
        ? parsedLineHeight
        : 15 * 1.6;
    }

    function toggleToolDetails(toolHeader, nextExpanded) {
      if (!toolHeader) {
        return;
      }
      const expanded = Boolean(nextExpanded);
      const wasCollapsing = toolHeader.getAttribute('aria-expanded') !== 'true';
      toolHeader.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      const restoreFocus = document?.activeElement === toolHeader;
      const rowKey = String(toolHeader.dataset?.toolRowKey || '').trim();
      if (rowKey) setToolCallExpansion(rowKey, expanded);
      dispatchToolRowUserExpansion(chatTimeline, document, rowKey, expanded);
      const ownerBlock = toolHeader.closest?.('.tool-call-block') || null;
      if (expanded && ownerBlock?.dataset?.toolDetailsMaterialized === 'false') {
        renderAll({ forceFullRender: true });
        const materializedHeader = Array.from(chatTimeline.querySelectorAll('.tool-call-header'))
          .find((node) => node.dataset?.toolRowKey === rowKey);
        const materialized = materializedHeader
          ?.closest?.('.tool-call-block')?.dataset?.toolDetailsMaterialized === 'true';
        if (materialized) {
          toggleToolDetails(materializedHeader, true);
        }
        if (restoreFocus) materializedHeader?.focus?.({ preventScroll: true });
        return;
      }
      const detailsId = toolHeader.getAttribute('aria-controls');
      const detailsEl = ownerBlock?.querySelector?.('.tool-call-details') || (detailsId ? document.getElementById(detailsId) : null);
      if (!detailsEl) {
        return;
      }
      const transitioning = toolDetailsTimers.has(detailsEl);
      clearToolDetailsTimer(detailsEl);
      const transitionMs = getToolDetailsTransitionMs();
      if (transitionMs === 0) {
        detailsEl.hidden = !expanded;
        detailsEl.classList.toggle('expanded', expanded);
        detailsEl.style.maxHeight = expanded ? 'none' : '';
        return;
      }
      let measuredHeight = Math.max(detailsEl.scrollHeight || 0, detailsEl.offsetHeight || 0);
      const _pretextUtils = typeof rendererPretextUtils !== 'undefined' ? rendererPretextUtils : null;
      if (measuredHeight === 0 && expanded && _pretextUtils && _pretextUtils.isEnabled(state)) {
        const textContent = String(detailsEl.textContent || '').trim();
        if (textContent) {
          const font = _pretextUtils.resolveFontString(detailsEl)
            || _pretextUtils.resolveDefaultFontString('.chat-bubble');
          const maxWidth = _pretextUtils.resolveElementWidth(detailsEl.parentElement) || 560;
          const lineHeight = resolvePredictionLineHeight(detailsEl);
          const cacheKey = 'tooldetail:' + (String(toolHeader.dataset.messageId || '').trim() || detailsId);
          const prediction = _pretextUtils.predictTextHeight(
            cacheKey,
            textContent,
            font,
            maxWidth,
            lineHeight
          );
          if (prediction && prediction.height > 0) {
            measuredHeight = Math.ceil(prediction.height);
          }
        }
      }

      if (expanded) {
        detailsEl.hidden = false;
        motionHeightUtils.pinHeightForTransition(detailsEl, transitioning && wasCollapsing
          ? motionHeightUtils.readCurrentMaxHeightPx(detailsEl, window) : 0);
        detailsEl.classList.add('expanded');
        requestAnimationFrame(() => {
          if (toolHeader.getAttribute('aria-expanded') !== 'true') return;
          detailsEl.style.maxHeight = `${Math.max(detailsEl.scrollHeight || measuredHeight || 0, 0)}px`;
        });
        const timerId = window.setTimeout(() => {
          if (toolHeader.getAttribute('aria-expanded') === 'true') {
            detailsEl.style.maxHeight = 'none';
          }
          toolDetailsTimers.delete(detailsEl);
        }, transitionMs);
        toolDetailsTimers.set(detailsEl, timerId);
        return;
      }

      motionHeightUtils.pinHeightForTransition(detailsEl, transitioning
        ? motionHeightUtils.readCurrentMaxHeightPx(detailsEl, window)
        : Math.max(motionHeightUtils.resolveCollapseStartPx(detailsEl), measuredHeight));
      requestAnimationFrame(() => {
        if (toolHeader.getAttribute('aria-expanded') !== 'false') return;
        detailsEl.classList.remove('expanded');
        detailsEl.style.maxHeight = '0px';
      });
      const timerId = window.setTimeout(() => {
        if (toolHeader.getAttribute('aria-expanded') !== 'true') {
          detailsEl.hidden = true;
          detailsEl.style.maxHeight = '';
        }
        toolDetailsTimers.delete(detailsEl);
      }, transitionMs);
      toolDetailsTimers.set(detailsEl, timerId);
    }

    return { toggleToolDetails, getToolDetailsTransitionMs };
  }

  function createMinimalToolRowToggles(deps) {
    const {
      chatTimeline,
      doc,
      appendClientLog,
      renderAll = function noopRenderAll() {},
      getToolDetailsTransitionMs,
    } = deps || {};

    const revealTimers = new WeakMap();
    function animateRevealHeight(el, expanded) {
      if (!el) {
        return;
      }
      const win = (el.ownerDocument && el.ownerDocument.defaultView) || null;
      const raf = win && win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : null;
      const setT = win && win.setTimeout ? win.setTimeout.bind(win) : null;
      const clearT = win && win.clearTimeout ? win.clearTimeout.bind(win) : null;
      const pending = revealTimers.get(el);
      if (pending?.timerId && clearT) {
        clearT(pending.timerId);
      }
      const intent = { expanded, timerId: 0 };
      revealTimers.set(el, intent);
      const transitionMs = typeof getToolDetailsTransitionMs === 'function'
        ? (Number(getToolDetailsTransitionMs()) || 0)
        : 0;
      const settle = () => {
        if (revealTimers.get(el) !== intent) return;
        el.style.maxHeight = expanded ? 'none' : ''; intent.timerId = 0;
      };
      if (transitionMs === 0 || !raf || !setT) {
        settle();
        return;
      }
      if (expanded) {
        motionHeightUtils.pinHeightForTransition(el, pending?.timerId && !pending.expanded
          ? motionHeightUtils.readCurrentMaxHeightPx(el, win) : 0);
        raf(() => { if (revealTimers.get(el) === intent) el.style.maxHeight = `${Math.max(el.scrollHeight || 0, 0)}px`; });
      } else {
        motionHeightUtils.pinHeightForTransition(el, pending?.timerId
          ? motionHeightUtils.readCurrentMaxHeightPx(el, win) : motionHeightUtils.resolveCollapseStartPx(el));
        raf(() => { if (revealTimers.get(el) === intent) el.style.maxHeight = '0px'; });
      }
      intent.timerId = setT(settle, transitionMs);
    }
    function toggleMinimalToolRow(toggleNode, forceExpanded) {
      const rowNode = toggleNode && typeof toggleNode.closest === 'function'
        ? toggleNode.closest('.tool-call-row--minimal')
        : null;
      if (!rowNode) {
        return;
      }
      const rowKey = toggleNode.dataset?.toolRowKey || rowNode.dataset?.toolRowKey || '';
      const nextExpanded = typeof forceExpanded === 'boolean'
        ? forceExpanded : rowNode.getAttribute('data-expanded') !== 'true';
      const restoreFocus = doc?.activeElement === toggleNode;
      const toolRowUtils = typeof globalThis !== 'undefined' ? globalThis.rendererTurnRowToolRenderUtils : null;
      if (rowKey && toolRowUtils && typeof toolRowUtils.setToolRowExpansion === 'function') {
        toolRowUtils.setToolRowExpansion(rowKey, nextExpanded);
      }
      dispatchToolRowUserExpansion(chatTimeline, doc, rowKey, nextExpanded);
      if (nextExpanded && rowNode.dataset?.toolDetailsMaterialized === 'false') {
        const bodyNode = rowNode.querySelector('.tool-call-row-body');
        const materialized = !bodyNode
          ? { ok: false, reason: 'missing_body', markup: '' }
          : (toolRowUtils && typeof toolRowUtils.materializeToolRowDetails === 'function'
            ? toolRowUtils.materializeToolRowDetails(rowKey)
            : { ok: false, reason: 'materializer_unavailable', markup: '' });
        if (materialized.ok && bodyNode) {
          bodyNode.innerHTML = materialized.markup;
          globalThis.rendererCodeHighlight?.decorateCodeBlocks?.(bodyNode);
          rowNode.dataset.toolDetailsMaterialized = 'true';
        } else {
          appendClientLog?.('WARN', 'tool.details_materialization_fallback', {
            rowKey: String(rowKey || '').slice(0, 240),
            reason: String(materialized.reason || 'unknown').slice(0, 80),
          });
          renderAll({ forceFullRender: true });
          const materializedToggle = Array.from(chatTimeline.querySelectorAll('[data-tool-row-toggle]'))
            .find((node) => node.dataset?.toolRowKey === rowKey);
          const didMaterialize = materializedToggle
            ?.closest?.('.tool-call-row--minimal')?.dataset?.toolDetailsMaterialized === 'true';
          if (didMaterialize) toggleMinimalToolRow(materializedToggle, true);
          if (restoreFocus) materializedToggle?.focus?.({ preventScroll: true });
          return;
        }
      }
      rowNode.setAttribute('data-expanded', nextExpanded ? 'true' : 'false');
      toggleNode.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
      const bodyNode = rowNode.querySelector('.tool-call-row-body');
      if (bodyNode) {
        // Visibility is owned by the inert attribute + CSS (resting state keyed
        // on data-expanded); animateRevealHeight handles the smooth max-height.
        if (nextExpanded) {
          bodyNode.removeAttribute('inert');
        } else {
          bodyNode.setAttribute('inert', '');
        }
        if (typeof animateRevealHeight === 'function') {
          animateRevealHeight(bodyNode, nextExpanded);
        }
      }
    }

    // Answers tool run (renderer-turn-row-list-utils): the summary row and its
    // flat member rows share data-run-id; the override is keyed like a tool row
    // so a view switch resets it with the session's other tool overrides.
    function toggleToolRun(toggleNode, forceExpanded) {
      const summaryRow = toggleNode?.closest?.('.chat-row[data-row-kind="tool_run"]');
      const list = summaryRow?.closest?.('.turn-row-list');
      if (!summaryRow || !list) return;
      const next = typeof forceExpanded === 'boolean' ? forceExpanded : summaryRow.getAttribute('data-run-expanded') !== 'true';
      globalThis.toolCallUtils?.getToolRunRows?.(list, summaryRow.getAttribute('data-run-id'))
        ?.forEach((node) => node.setAttribute('data-run-expanded', next ? 'true' : 'false'));
      toggleNode.setAttribute('aria-expanded', next ? 'true' : 'false');
      const runKey = toggleNode.getAttribute('data-tool-run-key') || '';
      globalThis.rendererTurnRowToolRenderUtils?.setToolRowExpansion?.(runKey, next);
      dispatchToolRowUserExpansion(chatTimeline, doc, runKey, next);
    }

    return { toggleMinimalToolRow, toggleToolRun };
  }

  return { createToolDetailsToggle, createMinimalToolRowToggles };
});
