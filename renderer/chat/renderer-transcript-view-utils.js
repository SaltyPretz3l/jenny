/*
 * Per-session transcript view vocabulary: answers | thinking | everything.
 * A session's explicit choice (state.ui.transcriptViewBySession) wins; other
 * sessions follow the persisted global default (state.transcriptViewDefault).
 * Also owns the per-pane cluster control (icon button + radio menu) and the
 * Settings field builder (Transcript views plan, po-review A1/B1/C1), and the
 * Wide transcript toggle beside it (row 92: Chat width `full` on and off).
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
  // One icon per view, all in the button; the stylesheet shows the one whose
  // data-view matches the button's data-transcript-view.
  const TRANSCRIPT_VIEW_ICONS = '<svg viewBox="0 0 16 16" aria-hidden="true" data-view="answers"><path d="M2.5 5.5h11M2.5 10.5h7"></path></svg>'
    + '<svg viewBox="0 0 16 16" aria-hidden="true" data-view="thinking"><path d="M2.5 4h11M2.5 8h7M2.5 12h11"></path></svg>'
    + '<svg viewBox="0 0 16 16" aria-hidden="true" data-view="everything"><path d="M2.5 3h11M2.5 6.5h7M2.5 10h11M2.5 13.5h7"></path></svg>';

  // Row 92: Wide is the Chat width preset `full`; off returns to the width chosen before it.
  const WIDE_CHAT_WIDTH = 'full';
  const FALLBACK_CHAT_WIDTH = 'standard';
  const CHAT_WIDTH_TOGGLE_EVENT = 'jenny:chat-width-toggle';
  const CHAT_WIDTH_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h12"></path><path d="m4.5 5.5-2.5 2.5 2.5 2.5"></path><path d="m11.5 5.5 2.5 2.5-2.5 2.5"></path></svg>';

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

  /**
   * Mount this pane's transcript view control into its timeline utility
   * cluster: one inventory icon button that opens a three-item radio menu
   * (inventory context menu). Idempotent per cluster: a rebind reuses the
   * button and only re-registers its listeners. The pane's timeline dispatches
   * `transcript-view-rendered` whenever its view attribute changes (a switch
   * or a pane session change), which is the only sync signal the control needs.
   */
  function mountTranscriptViewControl({ cluster, chatTimeline, getSessionId, registerListener, listenerOptions, jt = moduleJt } = {}) {
    const build = globalThis.inventoryActionButton;
    const menu = globalThis.inventoryContextMenu;
    if (!cluster || typeof build !== 'function' || typeof getSessionId !== 'function' || typeof registerListener !== 'function') return null;
    let button = cluster.querySelector('[data-transcript-view-toggle]');
    if (!button) {
      const html = build({
        plain: true, className: 'chat-timeline-utility-button chat-timeline-view-toggle',
        ariaHaspopup: 'menu', ariaExpanded: false, dataset: { 'transcript-view-toggle': 'true' },
        trustedHtml: TRANSCRIPT_VIEW_ICONS,
      });
      const splitToggle = cluster.querySelector('[data-chat-node="artifactSplitViewToggle"]');
      if (splitToggle) splitToggle.insertAdjacentHTML('afterend', html);
      else cluster.insertAdjacentHTML('afterbegin', html);
      button = cluster.querySelector('[data-transcript-view-toggle]');
    }
    if (!button) return null;
    const controller = () => globalThis.rendererTranscriptViewController || null;
    const currentView = () => normalizeTranscriptView(controller()?.getView?.(getSessionId()));
    function sync() {
      const view = currentView();
      const label = jt('chat.transcriptView.current', 'Transcript view: {view}', { view: transcriptViewLabel(view, jt) });
      if (button.dataset.transcriptView !== view) button.dataset.transcriptView = view;
      button.setAttribute('aria-label', label);
      button.title = label;
      if (button.hasAttribute('data-tooltip')) button.setAttribute('data-tooltip', label);
      globalThis.inventoryTooltip?.refresh?.(button);
    }
    registerListener(button, 'click', (event) => {
      event.preventDefault();
      if (typeof menu?.show !== 'function') return;
      // A pointer click on the open trigger closes its menu (the primitive
      // leaves the anchor's mousedown alone); keyboard activation (re)opens.
      if (event.detail > 0 && button.getAttribute('aria-expanded') === 'true') { menu.hide?.(); return; }
      const view = currentView();
      menu.show({
        anchorEl: button, rootEl: button, restoreFocusTo: button,
        onHide: () => button.setAttribute('aria-expanded', 'false'),
        items: TRANSCRIPT_VIEWS.map((candidate, index) => ({
          label: transcriptViewLabel(candidate, jt),
          description: transcriptViewDescription(candidate, jt),
          checked: candidate === view,
          accessKey: String(index + 1),
          action: () => { controller()?.setView?.(getSessionId(), candidate, { source: 'control' }); },
        })),
      });
      // After show(): its hide() of a previous menu runs that menu's onHide.
      button.setAttribute('aria-expanded', 'true');
    }, listenerOptions);
    if (chatTimeline) registerListener(chatTimeline, 'transcript-view-rendered', sync, listenerOptions);
    sync();
    return { button, sync };
  }

  /* The width to apply on a toggle: Wide from anything else (remembering that
     width), and back to the remembered width, or Standard, from Wide. */
  function nextChatWidth(current, previous) {
    if (current !== WIDE_CHAT_WIDTH) return { next: WIDE_CHAT_WIDTH, previous: current || FALLBACK_CHAT_WIDTH };
    const back = previous && previous !== WIDE_CHAT_WIDTH ? previous : FALLBACK_CHAT_WIDTH;
    return { next: back, previous: back };
  }

  function syncChatWidthToggles(documentRef) {
    const wide = String(documentRef?.documentElement?.dataset?.chatWidth || '') === WIDE_CHAT_WIDTH;
    for (const button of documentRef?.querySelectorAll?.('[data-chat-width-toggle]') || []) {
      button.setAttribute('aria-pressed', String(wide));
    }
  }

  /**
   * Mount the Wide transcript button into one pane's utility cluster, right
   * after the transcript view control. Idempotent per cluster. A click asks the
   * shell's toggle controller (createChatWidthToggle) through a bubbling event,
   * so the button holds no appearance state; aria-pressed follows
   * <html data-chat-width> through syncChatWidthToggles.
   */
  function mountChatWidthToggle({ cluster, registerListener, listenerOptions, jt = moduleJt } = {}) {
    const build = globalThis.inventoryActionButton;
    if (!cluster || typeof build !== 'function' || typeof registerListener !== 'function') return null;
    let button = cluster.querySelector('[data-chat-width-toggle]');
    if (!button) {
      const label = jt('chat.chatWidthToggle.label', 'Wide transcript');
      const title = jt('chat.chatWidthToggle.title', 'Wide transcript (Ctrl+Alt+W)');
      const html = build({
        plain: true, className: 'chat-timeline-utility-button chat-width-toggle', ariaPressed: false,
        ariaLabel: label, title, dataset: { 'chat-width-toggle': 'true' }, trustedHtml: CHAT_WIDTH_ICON,
      });
      const viewToggle = cluster.querySelector('[data-transcript-view-toggle]');
      if (viewToggle) viewToggle.insertAdjacentHTML('afterend', html);
      else cluster.insertAdjacentHTML('afterbegin', html);
      button = cluster.querySelector('[data-chat-width-toggle]');
    }
    if (!button) return null;
    registerListener(button, 'click', (event) => {
      event.preventDefault();
      button.dispatchEvent(new (button.ownerDocument.defaultView.CustomEvent)(CHAT_WIDTH_TOGGLE_EVENT, { bubbles: true, detail: { source: 'button' } }));
    }, listenerOptions);
    syncChatWidthToggles(button.ownerDocument);
    return { button };
  }

  /**
   * The one Wide toggle the shell owns (button events and Ctrl+Alt+W). It
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
      syncChatWidthToggles(documentRef);
      onApplied?.();
      appendClientLog?.('INFO', 'chat.chat_width_toggle', { source, chatWidthId: now });
      return now;
    }
    const onEvent = (event) => toggle(event?.detail?.source || 'button');
    documentRef.addEventListener(CHAT_WIDTH_TOGGLE_EVENT, onEvent);
    // Settings and the relay change the width too: keep every pane's button honest and
    // remember a non-Wide choice as the width to return to.
    const Observer = documentRef.defaultView?.MutationObserver;
    const observer = typeof Observer === 'function' ? new Observer(() => {
      const width = currentWidth();
      if (width && width !== WIDE_CHAT_WIDTH) previous = width;
      syncChatWidthToggles(documentRef);
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
    nextChatWidth,
    syncChatWidthToggles,
    mountChatWidthToggle,
    createChatWidthToggle,
    normalizeTranscriptView,
    resolveTranscriptView,
    cycleTranscriptView,
    transcriptViewLabel,
    transcriptViewDescription,
    mountTranscriptViewControl,
  };
});
