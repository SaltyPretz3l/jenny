/*
 * Per-session transcript view vocabulary: answers | thinking | everything.
 * A session's explicit choice (state.ui.transcriptViewBySession) wins; other
 * sessions follow the persisted global default (state.transcriptViewDefault).
 * Also owns the per-pane cluster control (icon button + radio menu) and the
 * Settings field builder (Transcript views plan, po-review A1/B1/C1).
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

  return {
    TRANSCRIPT_VIEWS,
    DEFAULT_TRANSCRIPT_VIEW,
    normalizeTranscriptView,
    resolveTranscriptView,
    cycleTranscriptView,
    transcriptViewLabel,
    transcriptViewDescription,
    mountTranscriptViewControl,
  };
});
