/* renderer/shell/renderer-viewport-thinking-panel-utils.js – thinking-panel
   measure/settle/sync cluster extracted from renderer-viewport-utils.js (UMD).
   Owns the per-panel settle-cleanup map and generation-gate WeakMap; receives
   the transient schedulers from the viewport scheduling sibling. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererViewportThinkingPanelUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const thinkingPanelSettleUtils = (typeof globalThis !== 'undefined' && globalThis.rendererThinkingPanelSettleUtils)
    || (typeof require === 'function' ? require('./renderer-thinking-panel-settle-utils') : null) || {};
  const asyncFenceUtils = (typeof globalThis !== 'undefined' && globalThis.rendererAsyncFence)
    || (typeof require === 'function' ? require('../shared/async-fence') : null) || {};
  const motionHeightUtils = (typeof globalThis !== 'undefined' && globalThis.rendererMotionHeightUtils)
    || (typeof require === 'function' ? require('../shared/motion-height-utils') : null) || {};
  const autocollapseUtils = (typeof globalThis !== 'undefined' && globalThis.rendererReasoningAutocollapseUtils)
    || (typeof require === 'function' ? require('../chat/renderer-reasoning-autocollapse-utils') : null) || {};

  function createViewportThinkingPanelUtils(deps) {
    const { state } = deps;
    const { chatTimeline } = deps.dom || {};
    const {
      thinkingController,
      reducedMotionQuery,
    } = deps.controllers || {};
    const {
      escapeSelectorValue,
      appendClientLog = () => {},
      getScrollCoordinator = () => null,
      isDisposed = () => false,
    } = deps.callbacks || {};
    const {
      scheduleTransientViewportFrame,
      scheduleTransientViewportTimer,
      schedulePostLayoutViewportSync,
    } = deps.scheduling || {};

    const thinkingPanelCleanupByPanel = new Map();
    // 2026-08-29 review fix: every sync re-arms the settle, and re-arming
    // cancels the previous arm's transition listener — so a zero-growth sync
    // landing mid-transition used to drop the pending "panel grew" flag and
    // strand the follow re-drive. Growth stays pending until a settle
    // actually consumes it.
    const thinkingPanelGrowthPending = new WeakMap();
    const thinkingPanelGenerationByPanel = new WeakMap();
    const thinkingPanelLastHeight = new WeakMap();
    const { settleThinkingPanelNow, SETTLED_CLASS = 'reasoning-row-panel--settled' } = thinkingPanelSettleUtils;

    function getThinkingPanelGenerationGate(panel) {
      let gate = thinkingPanelGenerationByPanel.get(panel);
      if (!gate) {
        gate = asyncFenceUtils.createGenerationGate();
        thinkingPanelGenerationByPanel.set(panel, gate);
      }
      return gate;
    }

    // Wrap a deferred (rAF / setTimeout) body so it no-ops if the controller was
    // disposed before the frame fired -- one named disposal guard in place of the
    // repeated post-dispose check at every transient thinking-panel callsite (AGENTS.md §5).
    function ifViewportLive(fn) {
      return function () {
        if (!isDisposed()) { fn(); }
      };
    }

    function resolveThinkingPanelExpandedHeight(panel) {
      if (!panel) {
        return 0;
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
      const body = panel.querySelector('.reasoning-row-panel-body');
      const measured = Math.max(
        Number(panel.scrollHeight) || 0,
        Number(panel.offsetHeight) || 0,
        Number(body?.scrollHeight) || 0,
        Number(body?.offsetHeight) || 0
      );
      if (measured > 0) {
        return measured;
      }
      const _pretextUtils = typeof rendererPretextUtils !== 'undefined' ? rendererPretextUtils : null;
      if (_pretextUtils && _pretextUtils.isEnabled(state)) {
        const textContent = String(body?.textContent || '').trim();
        if (textContent) {
          const font = _pretextUtils.resolveFontString(body || panel)
            || _pretextUtils.resolveDefaultFontString('.chat-bubble');
          const maxWidth = _pretextUtils.resolveElementWidth(body || panel) || 560;
          const thinkingId = String(panel.dataset?.thinkingId || panel.id || '').trim() || 'panel';
          const lineHeight = resolvePredictionLineHeight(body || panel);
          const prediction = _pretextUtils.predictTextHeight(
            `thinking:${thinkingId}`,
            textContent,
            font,
            maxWidth,
            lineHeight
          );
          if (prediction && prediction.height > 0) {
            return Math.ceil(prediction.height);
          }
        }
      }
      return String(body?.textContent || '').trim() ? 24 : 0;
    }

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

    function getThinkingPanelTransitionMs(extraMs) {
      if (reducedMotionQuery.matches) {
        return 0;
      }
      return readCssDurationMs('--motion-duration-regular', 220) + Math.max(Number(extraMs) || 0, 0);
    }

    function clearThinkingPanelSettle(panel) {
      const pendingCleanup = thinkingPanelCleanupByPanel.get(panel);
      if (pendingCleanup) pendingCleanup();
      thinkingPanelCleanupByPanel.delete(panel);
      thinkingPanelSettleUtils.clearThinkingPanelSettle(panel);
    }
    function armThinkingPanelSettle(panel, maxHeightChanged) {
      clearThinkingPanelSettle(panel);
      if (maxHeightChanged === true) thinkingPanelGrowthPending.set(panel, true);
      let cleanup = null;
      cleanup = thinkingPanelSettleUtils.armThinkingPanelSettle(panel, {
        skip: reducedMotionQuery.matches,
        ifLive: ifViewportLive,
        transitionMs: getThinkingPanelTransitionMs(80),
        onCleanup: () => {
          if (thinkingPanelCleanupByPanel.get(panel) === cleanup) thinkingPanelCleanupByPanel.delete(panel);
        },
        onSettled: () => {
          const growthPending = thinkingPanelGrowthPending.get(panel) === true;
          thinkingPanelGrowthPending.delete(panel);
          if (
            !growthPending
            || isDisposed()
            || state?.ui?.followLatest === false
            || typeof thinkingController?.shouldAutoScroll !== 'function'
            || !thinkingController.shouldAutoScroll()
          ) {
            return;
          }
          schedulePostLayoutViewportSync({
            syncOptions: {
              preserveFollowLatest: true,
            },
          });
        },
      });
      if (typeof cleanup === 'function') thinkingPanelCleanupByPanel.set(panel, cleanup);
    }
    function syncRenderedThinkingPanels(rootNode = chatTimeline) {
      if (isDisposed() || !rootNode) {
        return;
      }
      const panels = Array.from(rootNode.querySelectorAll?.('.reasoning-row-panel') || []);
      if (rootNode.matches?.('.reasoning-row-panel')) panels.unshift(rootNode);
      panels.forEach((panel) => {
        if (panel.dataset?.collapsing === 'true') return;
        const isExpanded = panel.classList.contains('expanded');
        if (isExpanded) {
          panel.hidden = false;
          if (panel.closest?.('.reasoning-row-block')?.getAttribute?.('data-reasoning-status') === 'streaming') {
            if (panel.style.maxHeight !== 'none') panel.style.maxHeight = 'none';
            return;
          }
          const expandedHeight = resolveThinkingPanelExpandedHeight(panel);
          const newMaxHeight = reducedMotionQuery.matches
            ? 'none'
            : `${expandedHeight}px`;
          const currentMaxHeight = panel.style.maxHeight;
          // Growth is judged on the measured height, not the inline string: a
          // settled panel carries an empty inline (CSS max-height:none rules),
          // so `'' !== px` would read as growth on every sync and the settle's
          // follow re-drive would schedule the next sync forever.
          const heightChanged = thinkingPanelLastHeight.get(panel) !== expandedHeight;
          thinkingPanelLastHeight.set(panel, expandedHeight);

          if ((!currentMaxHeight || currentMaxHeight === '0px') && !panel.classList.contains(SETTLED_CLASS)) {
            // Panel just created via full innerHTML — skip transition to
            // avoid a collapse-then-expand flash.
            panel.style.transition = 'none';
            panel.style.maxHeight = newMaxHeight;
            void panel.offsetHeight;
            panel.style.transition = '';
            settleThinkingPanelNow(panel, reducedMotionQuery.matches);
          } else if (panel.classList.contains(SETTLED_CLASS) && !heightChanged) {
            // Settled at rest: leave the CSS max-height:none rule in charge.
          } else {
            // Panel survived a targeted patch — smoothly grow to new height.
            panel.style.maxHeight = newMaxHeight;
            armThinkingPanelSettle(panel, heightChanged);
          }
          return;
        }
        panel.hidden = true;
        panel.style.maxHeight = '';
        thinkingPanelLastHeight.delete(panel);
        thinkingPanelGrowthPending.delete(panel);
        clearThinkingPanelSettle(panel);
      });
    }

    function syncThinkingBlockNode(messageId, thinkingId) {
      if (isDisposed() || !chatTimeline) {
        return;
      }

      getScrollCoordinator()?.captureReaderAnchor?.();
      let toggle = null;
      let block = null;
      let expanded = false;
      let phaseKey = '';
      let defaultExpanded = false;

      if (thinkingId !== undefined) {
        toggle = chatTimeline.querySelector(
          `[data-reasoning-toggle][data-message-id="${escapeSelectorValue(messageId)}"][data-phase-key="${escapeSelectorValue(String(thinkingId || ''))}"]`
        );
        if (!toggle) {
          toggle = chatTimeline.querySelector(
            `[data-reasoning-toggle][data-message-id="${escapeSelectorValue(messageId)}"][data-thinking-id="${escapeSelectorValue(String(thinkingId || ''))}"]`
          );
        }
        if (toggle) {
          block = toggle.closest('.reasoning-row-block');
          phaseKey = String(toggle.dataset.phaseKey || thinkingId || '');
          defaultExpanded = toggle.dataset.defaultExpanded === 'true';
          expanded = thinkingController.isPhaseExpanded
            ? thinkingController.isPhaseExpanded(messageId, phaseKey, defaultExpanded)
            : thinkingController.isExpanded(messageId);
        }
      }

      if (!toggle) {
        return;
      }

      const panelId = toggle.getAttribute('aria-controls');
      const panel = panelId ? document.getElementById(panelId) : null;
      const panelEmpty = panel?.classList.contains('empty') === true;
      toggle.classList.toggle('expanded', expanded);
      toggle.setAttribute('aria-expanded', expanded && !panelEmpty ? 'true' : 'false');
      block?.classList.toggle('expanded', expanded);

      if (!panel) {
        return;
      }
      const panelGenerationGate = getThinkingPanelGenerationGate(panel);
      panelGenerationGate.bump();
      // The reader's toggle wins over an in-flight auto-collapse: abandon it
      // here so its deferred frame/finish cannot hide the panel underneath us,
      // and forget the panel so a later rebuild cannot replay the collapse.
      autocollapseUtils.noteReasoningPanelReaderToggle?.(panel);

      if (panelEmpty) {
        panel.classList.remove('expanded'); clearThinkingPanelSettle(panel);
        panel.hidden = true;
        panel.style.maxHeight = '';
      } else if (expanded) {
        panel.hidden = false;
        panel.classList.add('expanded');
        if (reducedMotionQuery.matches) {
          panel.style.maxHeight = 'none';
        } else {
          motionHeightUtils.pinHeightForTransition(panel, 0);
          scheduleTransientViewportFrame(() => {
            try {
              const newMaxHeight = `${resolveThinkingPanelExpandedHeight(panel)}px`;
              const maxHeightChanged = panel.style.maxHeight !== newMaxHeight;
              panel.style.maxHeight = newMaxHeight;
              armThinkingPanelSettle(panel, maxHeightChanged);
            } catch (error) {
              appendClientLog('ERROR', 'viewport.thinking_expand_error', { message: String(error?.message || '') });
            }
          });
        }
      } else if (reducedMotionQuery.matches) {
        panel.classList.remove('expanded'); clearThinkingPanelSettle(panel);
        panel.hidden = true;
        panel.style.maxHeight = '';
      } else {
        motionHeightUtils.pinHeightForTransition(panel, resolveThinkingPanelExpandedHeight(panel)); clearThinkingPanelSettle(panel);
        const collapseToken = panelGenerationGate.capture();
        scheduleTransientViewportFrame(() => {
          try {
            panel.classList.remove('expanded');
            panel.style.maxHeight = '0px';
          } catch (error) {
            appendClientLog('ERROR', 'viewport.thinking_collapse_error', { message: String(error?.message || '') });
          }
        });
        scheduleTransientViewportTimer(() => {
          try {
            if (!panelGenerationGate.isCurrent(collapseToken)) return;
            const phaseExpanded = thinkingController.isPhaseExpanded
              ? thinkingController.isPhaseExpanded(messageId, phaseKey, defaultExpanded)
              : thinkingController.isExpanded(messageId);
            if (!phaseExpanded) {
              panel.hidden = true;
            }
          } catch (_) { /* best-effort cleanup */ }
        }, getThinkingPanelTransitionMs(0));
      }

      scheduleTransientViewportFrame(() => {
        schedulePostLayoutViewportSync({
          syncOptions: {
            preserveFollowLatest: true,
          },
        });
      });

      // Reposition the sprite after the thinking panel layout change.
      // Delay until after the CSS transition completes (240ms max-height ease)
      // so getBoundingClientRect() reads the final layout position.
      const transitionDelay = getThinkingPanelTransitionMs(40);
      schedulePostLayoutViewportSync({
        delayMs: transitionDelay,
        syncOptions: {
          preserveFollowLatest: true,
        },
      });
    }

    function disposeThinkingPanelWork() {
      for (const cleanup of thinkingPanelCleanupByPanel.values()) {
        try { cleanup(); } catch (_error) { /* best-effort */ }
      }
      thinkingPanelCleanupByPanel.clear();
    }

    return {
      syncRenderedThinkingPanels,
      syncThinkingBlockNode,
      disposeThinkingPanelWork,
    };
  }

  return { createViewportThinkingPanelUtils };
});
