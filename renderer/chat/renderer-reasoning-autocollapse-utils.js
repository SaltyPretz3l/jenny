/*
 * renderer/chat/renderer-reasoning-autocollapse-utils.js
 *
 * Animates a preserved reasoning panel from its current height to closed.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererReasoningAutocollapseUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const motionHeightUtils = (typeof globalThis !== 'undefined' && globalThis.rendererMotionHeightUtils)
    || (typeof require === 'function' ? require('../shared/motion-height-utils') : null) || {};
  const thinkingPanelSettleUtils = (typeof globalThis !== 'undefined' && globalThis.rendererThinkingPanelSettleUtils)
    || (typeof require === 'function' ? require('../shell/renderer-thinking-panel-settle-utils') : null) || {};
  const asyncFenceUtils = (typeof globalThis !== 'undefined' && globalThis.rendererAsyncFence)
    || (typeof require === 'function' ? require('../shared/async-fence') : null) || {};
  const generationGateByPanel = new WeakMap();

  function getGenerationGate(panel) {
    let gate = generationGateByPanel.get(panel);
    if (!gate) {
      gate = asyncFenceUtils.createGenerationGate();
      generationGateByPanel.set(panel, gate);
    }
    return gate;
  }

  function isReasoningPanelCollapsing(panel) {
    return panel?.dataset?.collapsing === 'true';
  }

  // Abandon an in-flight collapse so another owner (the reader's toggle, a
  // reduced-motion flip) can take the panel over. The stale frame/finish
  // callbacks see a bumped gate and become no-ops.
  function cancelReasoningPanelAutoCollapse(panel) {
    if (!isReasoningPanelCollapsing(panel)) return false;
    getGenerationGate(panel).bump();
    delete panel.dataset.collapsing;
    return true;
  }

  // Mid-flight the inline max-height is already '0px' (the rAF target), so
  // the true current height is the computed value while it interpolates.
  // Must run with the panel visible: a hidden panel measures 0.
  function readCollapseStartPx(panel, win, wasCollapsing) {
    if (wasCollapsing && typeof win?.getComputedStyle === 'function') {
      const computed = String(win.getComputedStyle(panel)?.maxHeight || '');
      if (/^\d+(\.\d+)?px$/.test(computed)) return Number(computed.slice(0, -2));
    }
    return motionHeightUtils.measureCollapseStartPx(panel);
  }

  function runReasoningPanelAutoCollapse(panel, options) {
    if (!panel || !panel.style) {
      return false;
    }
    const opts = options || {};
    const gate = getGenerationGate(panel);
    const win = opts.windowRef || panel.ownerDocument?.defaultView;
    if (opts.reducedMotion === true) {
      // Instant path; also lands a collapse that was mid-animation when the
      // preference flipped, so no panel is stranded open with the flag set.
      gate.bump();
      panel.classList.remove('expanded');
      panel.hidden = true;
      panel.style.maxHeight = '';
      delete panel.dataset.collapsing;
      return true;
    }
    if (!win) {
      return false;
    }

    const wasCollapsing = isReasoningPanelCollapsing(panel);
    thinkingPanelSettleUtils.clearThinkingPanelSettle(panel);
    // .expanded stays on for the whole animation (padding + opacity keep
    // their open values) so only max-height moves; finish removes it once
    // the panel is hidden, where the class change cannot be seen.
    panel.hidden = false;
    panel.classList.add('expanded');
    panel.dataset.collapsing = 'true';
    motionHeightUtils.pinHeightForTransition(panel, readCollapseStartPx(panel, win, wasCollapsing));

    gate.bump();
    const token = gate.capture();
    const requestFrame = typeof opts.requestFrame === 'function'
      ? opts.requestFrame
      : win.requestAnimationFrame.bind(win);
    requestFrame(() => {
      if (!gate.isCurrent(token)) return;
      panel.style.maxHeight = '0px';
    });

    let finished = false;
    let timeoutHandle = 0;
    const cleanup = () => {
      panel.removeEventListener('transitionend', onEnd);
      if (timeoutHandle) win.clearTimeout(timeoutHandle);
      timeoutHandle = 0;
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      if (gate.isCurrent(token)) {
        panel.classList.remove('expanded');
        panel.hidden = true;
        panel.style.maxHeight = '';
        delete panel.dataset.collapsing;
      }
      cleanup();
    };
    const onEnd = (event) => {
      if (event.target !== panel || event.propertyName !== 'max-height') return;
      finish();
    };
    panel.addEventListener('transitionend', onEnd);
    timeoutHandle = win.setTimeout(finish, Math.max(Number(opts.transitionMs) || 0, 0));
    return true;
  }

  const handoffTrackers = new Set();

  function readPanelIdentity(panel) {
    return {
      thinkingId: String(panel?.dataset?.thinkingId || ''),
      phaseKey: String(panel?.dataset?.phaseKey || ''),
    };
  }

  function sameIdentity(a, b) {
    return a.thinkingId === b.thinkingId && a.phaseKey === b.phaseKey;
  }

  // Identity of the panels a reader can currently see open (not mid-collapse).
  // Phase keys repeat across messages AND across the segments of one turn
  // article (`phase_${n}` fallbacks), so the thinking id rides along.
  function collectOpenReasoningPhaseKeys(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    return Array.from(root.querySelectorAll('.reasoning-row-panel.expanded[data-phase-key]:not([hidden])'))
      .filter((panel) => !isReasoningPanelCollapsing(panel))
      .map(readPanelIdentity)
      .filter((entry) => entry.phaseKey);
  }

  function escapeSelector(options, value) {
    return typeof options?.escapeSelectorValue === 'function'
      ? options.escapeSelectorValue(value)
      : String(value).replace(/["\\]/g, '\\$&');
  }

  // A rebuild (full render, keyed morph) replaces the live panel node with a
  // settled one that is already hidden. Re-run the eased collapse on each
  // panel that was open a moment ago, in the same task as the rebuild so
  // nothing paints between the swap and the re-open. Returns the count.
  function replayReasoningHandoff(root, entries, options) {
    if (!root || typeof root.querySelectorAll !== 'function' || !Array.isArray(entries)) return 0;
    let replayed = 0;
    for (const entry of entries) {
      const phaseKey = String(entry?.phaseKey || '');
      if (!phaseKey) continue;
      const selector = `.reasoning-row-panel[data-thinking-id="${escapeSelector(options, String(entry.thinkingId || ''))}"]`
        + `[data-phase-key="${escapeSelector(options, phaseKey)}"]`;
      for (const panel of Array.from(root.querySelectorAll(selector))) {
        if (!panel.hidden || panel.classList.contains('expanded') || isReasoningPanelCollapsing(panel)) continue;
        if (runReasoningPanelAutoCollapse(panel, options)) replayed += 1;
      }
    }
    return replayed;
  }

  // The reader's toggle owns the panel from here: abandon any in-flight
  // auto-collapse and forget the panel in every hand-off tracker, so a later
  // rebuild cannot re-animate a collapse the reader made on purpose.
  function noteReasoningPanelReaderToggle(panel) {
    cancelReasoningPanelAutoCollapse(panel);
    const identity = readPanelIdentity(panel);
    if (!identity.phaseKey) return;
    for (const tracker of handoffTrackers) tracker.forget(identity);
  }

  // Remembers which panels of the streaming article a reader can see open,
  // so a rebuild path can replay the hand-off on the replacement nodes.
  // Scoped to the article's own message id. A replay that collapsed
  // something forgets the entries, so a later unrelated render cannot
  // re-run the collapse.
  function createReasoningHandoffTracker(deps) {
    const { chatTimeline, escapeSelectorValue, buildOptions } = deps || {};
    let remembered = null;
    const findArticle = (id) => (id && chatTimeline && typeof chatTimeline.querySelector === 'function'
      ? chatTimeline.querySelector(`[data-message-id="${escapeSelector({ escapeSelectorValue }, id)}"]`)
      : null);
    const tracker = {
      remember(article) {
        const entries = collectOpenReasoningPhaseKeys(article);
        const articleId = String(article?.getAttribute?.('data-message-id') || '');
        remembered = entries.length && articleId ? { articleId, entries } : null;
      },
      rememberById(articleId) {
        tracker.remember(findArticle(articleId));
      },
      forget(identity) {
        if (!remembered) return;
        remembered.entries = remembered.entries.filter((entry) => !sameIdentity(entry, identity));
        if (!remembered.entries.length) remembered = null;
      },
      clear() {
        remembered = null;
      },
      replay() {
        const article = remembered ? findArticle(remembered.articleId) : null;
        const replayed = article
          ? replayReasoningHandoff(article, remembered.entries, { ...buildOptions(article.ownerDocument), escapeSelectorValue })
          : 0;
        if (replayed) remembered = null;
        return replayed;
      },
    };
    handoffTrackers.add(tracker);
    return tracker;
  }

  return {
    runReasoningPanelAutoCollapse,
    cancelReasoningPanelAutoCollapse,
    isReasoningPanelCollapsing,
    collectOpenReasoningPhaseKeys,
    replayReasoningHandoff,
    noteReasoningPanelReaderToggle,
    createReasoningHandoffTracker,
  };
});
