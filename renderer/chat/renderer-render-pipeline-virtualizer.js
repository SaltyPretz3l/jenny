/* renderer/chat/renderer-render-pipeline-virtualizer.js
 * The B5 long-conversation timeline virtualizer wiring of the render pipeline
 * (the virtualizer plus the facade render-effects drives it through) and the
 * weight its rebuild is sized by. Split out of
 * renderer-render-pipeline-utils.js, which composes it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineVirtualizer = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function getTimelineEntryWeight(messages) {
    let total = 0;
    for (const message of Array.isArray(messages) ? messages : []) {
      if (!message || typeof message !== 'object') continue;
      const seen = new Set();
      const entryGroups = [message.reasoning?.entries]
        .concat((Array.isArray(message.reasoning_phases) ? message.reasoning_phases : []).map((phase) => phase?.entries));
      total = Math.min(Number.MAX_SAFE_INTEGER, total + (typeof message.content === 'string' ? message.content.length : 0));
      for (const entries of entryGroups) {
        for (const entry of Array.isArray(entries) ? entries : []) {
          if (!entry || typeof entry !== 'object' || seen.has(entry)) continue;
          seen.add(entry);
          total = Math.min(Number.MAX_SAFE_INTEGER, total + (typeof entry.text === 'string' ? entry.text.length : 0));
        }
      }
    }
    return total;
  }

  function createPipelineVirtualizer(deps) {
    const {
      state,
      timelineVirtualizerUtils,
      chatTimeline,
      chatThreadScroll,
      uiRuntime,
      scrollCoordinator,
      appendClientLog,
      renderMessages,
      getVisibleSessionMessages,
      getPaneSessionId,
      // Late-bound: render-effects is created after the virtualizer and calls back into it.
      getRenderEffectsPipeline,
    } = deps;

    // B5 — long-conversation timeline virtualization. The active-turn-root
    // pin probe reads through this ref; render-effects writes it before
    // each render via virtualizerFacade.setActiveTurnRoot.
    const virtualizerActiveRootRef = { id: '' };
    const virtualizer = timelineVirtualizerUtils
      ? timelineVirtualizerUtils.createTimelineVirtualizer({
        chatTimeline,
        chatThreadScroll,
        document: typeof document !== 'undefined' ? document : null,
        window: typeof window !== 'undefined' ? window : null,
        boundsEnabled: state.features?.featureFlags?.chat_long_thread_bounds !== false,
        contentVisibilityEnabled: state.features?.featureFlags?.chat_render_content_visibility === true,
        getActiveTurnRootMessageId: function readActiveTurnRoot() {
          return virtualizerActiveRootRef.id || '';
        },
        onAfterMount: function onVirtualizedEntryMount(entryEl, containerEl) {
          // Lazy-decoration re-trigger (mermaid re-observe, math re-typeset,
          // follow-up buttons) lives on the render-effects sibling — this
          // controller is at the file-size cap.
          getRenderEffectsPipeline()?.redecorateVirtualizedEntry?.(containerEl);
        },
        requestEntryMarkup: function requestVirtualizedEntryMarkup(entryEl) {
          return getRenderEffectsPipeline()?.buildVirtualizedEntryInnerHtml?.(entryEl) || '';
        },
        requestCanonicalRerender: function requestVirtualizerRecoveryRender() {
          renderMessages({ forceFullRender: true, reason: 'virtualizer_recovery' });
        },
        captureReaderAnchor: function captureVirtualizerReaderAnchor() {
          return scrollCoordinator?.captureReaderAnchor?.();
        },
        noteProgrammaticWrite: function noteVirtualizerProgrammaticWrite(reason) {
          scrollCoordinator?.noteProgrammaticWrite?.(reason);
        },
        restoreReaderAnchor: function restoreVirtualizerReaderAnchor() {
          return scrollCoordinator?.restoreReaderAnchor?.();
        },
        appendClientLog,
        onStatsChange: function updateVirtualizerStats(nextStats) {
          const longThreadBudgetStats = {
            ...(state.ui?.longThreadBudgetStats || {}),
            ...(uiRuntime.longThreadBudgetStats || {}),
            ...(nextStats || {}),
          };
          uiRuntime.longThreadBudgetStats = longThreadBudgetStats;
          if (state.ui && typeof state.ui === 'object') {
            state.ui.longThreadBudgetStats = longThreadBudgetStats;
          }
        },
      })
      : null;

    // Facade exposed to render-effects so it doesn't need to know
    // whether the virtualizer module loaded. All three operations are
    // safe no-ops when `virtualizer` is null.
    const virtualizerFacade = {
      setActiveTurnRoot(messageId) {
        virtualizerActiveRootRef.id = String(messageId || '').trim();
      },
      rebuild() {
        if (!virtualizer) return;
        virtualizer.rebuild(getTimelineEntryWeight(getVisibleSessionMessages(getPaneSessionId())));
        const longThreadBudgetStats = {
          ...(state.ui?.longThreadBudgetStats || {}),
          ...(uiRuntime.longThreadBudgetStats || {}),
          ...(virtualizer._internals?.getBudgetStats?.() || {}),
        };
        uiRuntime.longThreadBudgetStats = longThreadBudgetStats;
        if (state.ui && typeof state.ui === 'object') {
          state.ui.longThreadBudgetStats = longThreadBudgetStats;
        }
      },
      prepareForStructuralMorph() { virtualizer && virtualizer.prepareForStructuralMorph(); },
      refreshScope(rootEl) { virtualizer && virtualizer.refreshScope(rootEl); },
      getBudgetStats() { return virtualizer?._internals?.getBudgetStats?.() || null; },
    };

    return { virtualizer, virtualizerFacade };
  }

  return { createPipelineVirtualizer, getTimelineEntryWeight };
});
