/*
 * Per-session transcript view vocabulary: answers | thinking | everything.
 * A session's explicit choice (state.ui.transcriptViewBySession) wins; other
 * sessions follow the persisted global default (state.transcriptViewDefault).
 * Also owns the per-pane More (three dots) button and its menu (Back to prompt, the
 * three views, Wide transcript, Activity, and Tasks and Notes while the bar is short of room),
 * the Settings field builder (Transcript views plan, po-review A1/B1/C1), and the
 * shell's Wide toggle (row 92: Chat width `full` on and off). Row 115 slice 2a.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTranscriptViewUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const moduleJt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const TRANSCRIPT_VIEWS = Object.freeze(['answers', 'thinking', 'everything']);
  const DEFAULT_TRANSCRIPT_VIEW = 'thinking';
  // Row 115: one More button in every pane; its menu carries the views.
  const MORE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.25h.01M8 8h.01M8 12.75h.01"></path></svg>';
  // The bar is "compact" below this width: Tasks and Notes leave it and appear in More.
  const COMPACT_MAX_WIDTH = 560;
  const WIDE_SHORTCUT_HINT = 'Ctrl+Alt+W';

  // Row 92: Wide is the Chat width preset `full`; off returns to the width chosen before it.
  const WIDE_CHAT_WIDTH = 'full';
  const FALLBACK_CHAT_WIDTH = 'standard';
  const CHAT_WIDTH_TOGGLE_EVENT = 'jenny:chat-width-toggle';

  function normalizeTranscriptView(value, fallback = DEFAULT_TRANSCRIPT_VIEW) {
    const token = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return TRANSCRIPT_VIEWS.includes(token) ? token : fallback;
  }

  function resolveTranscriptView(state, sessionId) {
    const explicit = state?.ui?.transcriptViewBySession?.get?.(String(sessionId));
    return normalizeTranscriptView(explicit, '') || normalizeTranscriptView(state?.transcriptViewDefault);
  }

  function cycleTranscriptView(view) {
    const index = TRANSCRIPT_VIEWS.indexOf(normalizeTranscriptView(view));
    return TRANSCRIPT_VIEWS[(index + 1) % TRANSCRIPT_VIEWS.length];
  }

  function transcriptViewLabel(view, jt = moduleJt) {
    return {
      answers: jt('settings.transcriptView.answers', 'Answers'),
      thinking: jt('settings.transcriptView.thinking', 'Thinking'),
      everything: jt('settings.transcriptView.everything', 'Everything'),
    }[normalizeTranscriptView(view)];
  }

  function transcriptViewDescription(view, jt = moduleJt) {
    return {
      answers: jt('chat.transcriptView.answersDescription', 'Replies only. Thinking and tool details stay tucked away.'),
      thinking: jt('chat.transcriptView.thinkingDescription', 'Thinking opens while it streams, folds when done.'),
      everything: jt('chat.transcriptView.everythingDescription', 'Thinking and tool details open by default.'),
    }[normalizeTranscriptView(view)];
  }

  const overflowObservers = new WeakMap(); // cluster -> dispose, so a rebind retires the previous observer

  function hostedElsewhere(pane) {
    return Boolean(pane) && (pane.classList.contains('ide-chat-dock-body') || pane.hasAttribute('data-pane-hosted'));
  }

  /**
   * Keep data-session-bar-compact on the cluster in step with its room. One
   * pane: the cluster spans the whole chat view, so it is the measure. Split
   * view: the cluster is shrink-to-fit, so the pane is. Returns { measure,
   * dispose }; the dock and a hosted pane never go compact.
   */
  function observeBarRoom(cluster, signal) {
    overflowObservers.get(cluster)?.();
    const pane = cluster.closest('.chat-pane');
    if (!pane || hostedElsewhere(pane)) return { measure() {}, dispose() {} };
    function measure() {
      const width = pane.getBoundingClientRect().width || cluster.getBoundingClientRect().width;
      if (!width) return; // not laid out (a hidden view): keep the last answer
      const compact = width < COMPACT_MAX_WIDTH;
      if (cluster.hasAttribute('data-session-bar-compact') === compact) return;
      if (compact) cluster.setAttribute('data-session-bar-compact', 'true');
      else cluster.removeAttribute('data-session-bar-compact');
    }
    const Observer = cluster.ownerDocument.defaultView?.ResizeObserver;
    const observer = typeof Observer === 'function' ? new Observer(measure) : null;
    if (observer) { observer.observe(pane); observer.observe(cluster); }
    let disposed = false;
    function dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      if (overflowObservers.get(cluster) === dispose) overflowObservers.delete(cluster);
      signal?.removeEventListener?.('abort', dispose);
    }
    overflowObservers.set(cluster, dispose);
    signal?.addEventListener?.('abort', dispose, { once: true });
    measure();
    return { measure, dispose };
  }

  /**
   * Mount this pane's More (three dots) button into its session bar: one
   * inventory icon button that opens the inventory context menu. Menu, top to
   * bottom: Back to prompt (`promptJump`; disabled with no prompt yet), Tasks and
   * Notes (only while the bar is compact and the real button is shown), a
   * separator, the three transcript views as radios, a separator,
   * Wide transcript (the shell's single toggle owns the width; this dispatches
   * its event) and Activity (when its button is shown in this pane). Idempotent
   * per cluster: a rebind reuses the button and only re-registers its listener.
   * `signal` disposes the width observer with the bind.
   */
  function mountTranscriptViewControl({ cluster, getSessionId, registerListener, listenerOptions, signal, promptJump = null, jt = moduleJt } = {}) {
    const build = globalThis.inventoryActionButton;
    const menu = globalThis.inventoryContextMenu;
    if (!cluster || typeof build !== 'function' || typeof getSessionId !== 'function' || typeof registerListener !== 'function') return null;
    let button = cluster.querySelector('[data-transcript-view-toggle]');
    if (!button) {
      const label = jt('chat.utilities.more', 'More');
      const html = build({
        plain: true, className: 'chat-timeline-utility-button chat-timeline-more-button',
        ariaLabel: label, title: label, ariaHaspopup: 'menu', ariaExpanded: false,
        dataset: { 'transcript-view-toggle': 'true' }, trustedHtml: MORE_ICON,
      });
      const splitToggle = cluster.querySelector('[data-chat-node="artifactSplitViewToggle"]');
      if (splitToggle) splitToggle.insertAdjacentHTML('afterend', html);
      else cluster.insertAdjacentHTML('afterbegin', html);
      button = cluster.querySelector('[data-transcript-view-toggle]');
    }
    if (!button) return null;
    const room = observeBarRoom(cluster, signal);
    const controller = () => globalThis.rendererTranscriptViewController || null;
    const currentView = () => normalizeTranscriptView(controller()?.getView?.(getSessionId()));
    const shown = (selector) => {
      const node = cluster.querySelector(selector);
      return node && !node.hidden ? node : null;
    };

    function menuItems() {
      room.measure();
      const view = currentView();
      const items = [];
      if (promptJump) {
        const promptId = promptJump.targetId();
        items.push({ label: jt('chat.wayfinder.backToPrompt', 'Back to prompt'), disabled: !promptId, action: () => promptJump.jump(promptId) });
      }
      if (cluster.hasAttribute('data-session-bar-compact')) {
        for (const [selector, label] of [['#chatTimelineTasksToggle', jt('artifactPanelV2Render.tasks', 'Tasks')], ['#chatTimelineNotesToggle', jt('projectNotes.toggle', 'Notes')]]) {
          const real = shown(selector);
          if (real) items.push({ label, action: () => real.click() });
        }
      }
      if (items.length) items.push({ separator: true });
      TRANSCRIPT_VIEWS.forEach((candidate, index) => items.push({
        label: transcriptViewLabel(candidate, jt),
        description: transcriptViewDescription(candidate, jt),
        checked: candidate === view,
        accessKey: String(index + 1),
        action: () => { controller()?.setView?.(getSessionId(), candidate, { source: 'control' }); },
      }));
      const tail = [];
      // The dock sets its own widths, so Chat width does not apply there.
      if (!hostedElsewhere(cluster.closest('.chat-pane'))) {
        const doc = button.ownerDocument;
        tail.push({
          label: jt('chat.chatWidthToggle.label', 'Wide transcript'), toggle: true,
          checked: String(doc.documentElement?.dataset?.chatWidth || '') === WIDE_CHAT_WIDTH,
          shortcutHint: WIDE_SHORTCUT_HINT,
          action: () => { button.dispatchEvent(new (doc.defaultView.CustomEvent)(CHAT_WIDTH_TOGGLE_EVENT, { bubbles: true, detail: { source: 'button' } })); },
        });
      }
      const activity = shown('[data-activity-open]');
      if (activity) tail.push({ label: jt('activity.title', 'Activity'), action: () => activity.click() });
      if (tail.length) items.push({ separator: true }, ...tail);
      return items;
    }

    registerListener(button, 'click', (event) => {
      event.preventDefault();
      if (typeof menu?.show !== 'function') return;
      // A pointer click on the open trigger closes its menu (the primitive
      // leaves the anchor's mousedown alone); keyboard activation (re)opens.
      if (event.detail > 0 && button.getAttribute('aria-expanded') === 'true') { menu.hide?.(); return; }
      menu.show({
        anchorEl: button, rootEl: button, restoreFocusTo: button,
        onHide: () => button.setAttribute('aria-expanded', 'false'),
        items: menuItems(),
      });
      // After show(): its hide() of a previous menu runs that menu's onHide.
      button.setAttribute('aria-expanded', 'true');
    }, listenerOptions);
    return { button, measure: room.measure, dispose: room.dispose };
  }

  /* The width to apply on a toggle: Wide from anything else (remembering that
     width), and back to the remembered width, or Standard, from Wide. */
  function nextChatWidth(current, previous) {
    if (current !== WIDE_CHAT_WIDTH) return { next: WIDE_CHAT_WIDTH, previous: current || FALLBACK_CHAT_WIDTH };
    const back = previous && previous !== WIDE_CHAT_WIDTH ? previous : FALLBACK_CHAT_WIDTH;
    return { next: back, previous: back };
  }

  /**
   * The one Wide toggle the shell owns (More menu events and Ctrl+Alt+W). It
   * applies through the same applyAppearance path as Settings and the Jenny
   * settings relay, then calls onApplied (Settings repaints its row). The width
   * to return to is the last non-Wide width seen this session, whichever path
   * set it. Returns { toggle, dispose }.
   */
  function createChatWidthToggle({ documentRef, getAppearance, applyAppearance, onApplied, appendClientLog } = {}) {
    if (!documentRef || typeof getAppearance !== 'function' || typeof applyAppearance !== 'function') return null;
    const currentWidth = () => String(documentRef.documentElement?.dataset?.chatWidth || '');
    let previous = currentWidth() === WIDE_CHAT_WIDTH ? '' : currentWidth();
    function toggle(source = 'shortcut') {
      const current = String(getAppearance()?.chatWidthId || '');
      const step = nextChatWidth(current, previous);
      const applied = applyAppearance({ ...getAppearance(), chatWidthId: step.next });
      const now = String(applied?.chatWidthId || current);
      if (now === step.next) previous = step.previous;
      onApplied?.();
      appendClientLog?.('INFO', 'chat.chat_width_toggle', { source, chatWidthId: now });
      return now;
    }
    const onEvent = (event) => toggle(event?.detail?.source || 'button');
    documentRef.addEventListener(CHAT_WIDTH_TOGGLE_EVENT, onEvent);
    // Settings and the relay change the width too: remember a non-Wide choice as the width to return to.
    const Observer = documentRef.defaultView?.MutationObserver;
    const observer = typeof Observer === 'function' ? new Observer(() => {
      const width = currentWidth();
      if (width && width !== WIDE_CHAT_WIDTH) previous = width;
    }) : null;
    observer?.observe(documentRef.documentElement, { attributes: true, attributeFilter: ['data-chat-width'] });
    return {
      toggle,
      dispose() {
        documentRef.removeEventListener(CHAT_WIDTH_TOGGLE_EVENT, onEvent);
        observer?.disconnect();
      },
    };
  }

  return {
    TRANSCRIPT_VIEWS,
    DEFAULT_TRANSCRIPT_VIEW,
    WIDE_CHAT_WIDTH,
    CHAT_WIDTH_TOGGLE_EVENT,
    COMPACT_MAX_WIDTH,
    nextChatWidth,
    createChatWidthToggle,
    normalizeTranscriptView,
    resolveTranscriptView,
    cycleTranscriptView,
    transcriptViewLabel,
    transcriptViewDescription,
    mountTranscriptViewControl,
  };
});
