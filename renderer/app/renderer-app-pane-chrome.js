/* renderer/app/renderer-app-pane-chrome.js -- the second chat pane's composer, attachments, notices and drafts (UMD) */
/**
 * Extracted from renderer-app-pane-composition.js (which creates it once and
 * calls through), so the composition stays under its line cap. Everything
 * here is per-pane chrome keyed by a pane's session; the lifecycle (mount /
 * unmount order, layout, focus, render routing) stays in the composition.
 *
 *   createPaneChrome(deps) returns
 *     syncPaneComposer(pane), syncPaneAttachments(pane), createPaneAttachments(pane)
 *     buildComposerNodes(pane, paneDom)  the toolbar buttons, queued-count span,
 *         notice hosts and the pane's `dom` bag; returns the right toolbar
 *     resolvePaneNotices(rootEl), mountPaneNotices(pane, getSessionId)
 *     composerDrafts(), handOffDrafts(prev, next, reason), showPaneDraft(pane, sessionId, reason)
 *     autosizeInput(input), insertButton(host, buttonOptions), buildPaneDom(rootEl, paneDom, pane)
 *
 * deps: state, layoutController, options (the composition's injected options,
 * read late: attachment utils/callbacks, composerV2Render, getComposerSessionState,
 * TOAST_SOURCE), root, doc, jt, actionButton, call, paneDrafts, panes (the
 * composition's Map), paneSessionId, pane0Root.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAppPaneChrome = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ICON_STOP = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1" /></svg>';
  var ICON_ATTACH = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14 8.5l-5.5 5.5a3.5 3.5 0 01-5-5L9 3.5a2.5 2.5 0 013.5 3.5L7 12.5a1.5 1.5 0 01-2-2L10.5 5"/></svg>';
  var BACKEND_PREPARING = ['sidecar_spawned', 'model_acquiring', 'model_loading', 'starting', 'retrying'];
  var normalizeId = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).normalizeId;

  function noop() {}
  // An unchanged render writes nothing (a same-value attribute or text write still mutates the DOM).
  function setProp(node, key, value) { if (node && node[key] !== value) node[key] = value; }
  function setData(node, key, value) { if (node && node.dataset[key] !== value) node.dataset[key] = value; }

  function createPaneChrome(deps) {
    var options = deps.options || {};
    var state = deps.state;
    var layoutController = deps.layoutController;
    var root = deps.root;
    var doc = deps.doc;
    var jt = deps.jt;
    var actionButton = deps.actionButton;
    var call = deps.call;
    var paneDrafts = deps.paneDrafts;
    var panes = deps.panes;
    var paneSessionId = deps.paneSessionId;
    var pane0Root = deps.pane0Root;

    /* ── the non-focused pane's composer (the pipeline's renderComposerState
       reads document-global composer chrome, so a second pane syncs its own
       controls here: lifecycle, Send/Stop, offline, queued copy, its rail) ── */
    function syncPaneComposer(pane) {
      if (!pane || !pane.dom.chatInput) return;
      var sessionId = paneSessionId(pane.paneId);
      var streaming = call('isSessionStreaming', sessionId) === true;
      var approvalPending = call('hasPendingToolApproval', sessionId) === true;
      var phase = state.backend && state.backend.phase;
      var usable = phase === 'ready' || phase === 'model_unavailable';
      var offline = !usable && BACKEND_PREPARING.indexOf(phase) === -1;
      var authenticated = !(state.auth && state.auth.authenticated === false);
      var hasDraft = Boolean(String(pane.dom.chatInput.value || '').trim());
      // A queued attachment with an empty draft enables Send too (pane 0's rule,
      // renderer-render-pipeline-chrome.js hasComposerDraft): decided once, written once.
      var hasFiles = Boolean(sessionId) && ((call('getQueuedAttachments', sessionId) || []).length > 0);
      var queued = Number(call('countQueuedSends', sessionId)) || 0;
      var lifecycle = normalizeId(call('getSendLifecycle', sessionId)) || 'idle';
      setProp(pane.dom.chatInput, 'disabled', offline || !authenticated || approvalPending);
      if (pane.sendButton) {
        setProp(pane.sendButton, 'disabled', !authenticated || !usable || !(hasDraft || hasFiles) || approvalPending);
        setProp(pane.sendButton, 'textContent', streaming ? jt('chat.panes.queue', 'Queue') : '↑');
        pane.sendButton.classList.toggle('composer-send-queue', streaming);
      }
      if (pane.stopButton) {
        pane.stopButton.classList.toggle('hidden', !streaming);
        setProp(pane.stopButton, 'disabled', !streaming);
      }
      if (pane.queuedNotice) {
        setProp(pane.queuedNotice, 'textContent', queued > 0 ? jt('chat.panes.queued', '{count} queued', { count: queued }) : '');
        setProp(pane.queuedNotice, 'hidden', queued === 0);
      }
      setData(pane.dom.composerWrap, 'sendLifecycle', lifecycle);
      setData(pane.composer, 'sendLifecycle', lifecycle);
      if (pane.rail) pane.rail.sync({ offline: offline, authenticated: authenticated }); // W2-2a: model, effort, run mode
      syncPaneAttachments(pane);
      if (pane.notices.status) call('renderComposerStatusNotice', { node: pane.notices.status, sessionId: sessionId }); // W3-1
    }

    /* ── W2-2b: the pane's tray renders from its session's queue (the
       renderer rebuilds its markup only when the ids or the drag depth
       changed); syncPaneComposer counts the queue for Send ── */
    function syncPaneAttachments(pane) {
      if (!pane.dom.attachmentTray) return;
      var sessionId = paneSessionId(pane.paneId);
      var queued = (sessionId && call('getQueuedAttachments', sessionId)) || [];
      call('renderAttachmentTray', { tray: pane.dom.attachmentTray, notice: null, chatView: pane.root, queued: queued, dragDepth: pane.dragDepth || 0, sessionId: sessionId });
    }

    /* Paste on its textarea, drop on its root, its attach button and its tray,
       keyed by its session; the document-level listeners stay pane 0's. */
    function createPaneAttachments(pane) {
      var utils = options.attachmentEventUtils || root.rendererAttachmentEventUtils;
      var queue = options.attachmentCallbacks;
      if (!queue || !pane.dom.attachmentTray || !utils || typeof utils.createAttachmentEventBindings !== 'function') return null;
      var bindings = utils.createAttachmentEventBindings({
        state: state,
        sessionContext: layoutController.createSessionContext(pane.paneId),
        constants: { TOAST_SOURCE: options.TOAST_SOURCE || {} },
        dom: { attachmentTray: pane.dom.attachmentTray, composerAttachShortcut: pane.dom.composerAttachShortcut, chatInput: pane.dom.chatInput, chatView: pane.root },
        callbacks: Object.assign({}, queue, {
          renderAttachmentTray: function () { syncPaneComposer(pane); },
          setDropActive: function (active) { pane.dragDepth = active ? 1 : 0; syncPaneAttachments(pane); },
          renderComposerPopover: noop, renderCommandPopover: noop,
          updateComposerSafeOffset: noop, closeComposerPopover: noop, closeCommandPopover: noop,
        }),
      }) || null;
      if (bindings && typeof bindings.bind === 'function') bindings.bind();
      return bindings;
    }

    /* ── W3-1: the template's notice hosts. Pane 0's ids stay its own (the
       surface dom reaches them by id), so these resolve by data-chat-node
       inside the pane root only. ── */
    function resolvePaneNotices(rootEl) {
      var q = function (name) { return rootEl.querySelector('[data-chat-node="' + name + '"]'); };
      return { pill: q('composerAttachmentPreviewPill'), status: q('composerStatusNotice'), failed: q('composerV2FailedSendNotice') };
    }

    /* The pill and the failed-send notice exist only where pane 0 mounted its
       own (composer v2 on); pane 1 mirrors that and builds its own renderers. */
    function mountPaneNotices(pane, getSessionId) {
      var render = options.composerV2Render || root.rendererComposerV2Render;
      var zero = pane0Root();
      var mirrorsOn = function (id) { var node = zero && zero.querySelector('#' + id); return Boolean(node && node.dataset.composerV2 === 'on'); };
      if (pane.notices.pill && pane.dom.attachmentTray && mirrorsOn('composerAttachmentPreviewPill')
        && render && typeof render.createComposerAttachmentTrayPreviewRenderer === 'function') {
        pane.notices.pill.dataset.composerV2 = 'on';
        try {
          pane.previewPill = render.createComposerAttachmentTrayPreviewRenderer({ tray: pane.dom.attachmentTray, pill: pane.notices.pill });
        } catch (_error) { pane.previewPill = null; }
      }
      if (pane.notices.failed && pane.dom.chatTimeline && mirrorsOn('composerV2FailedSendNotice')) {
        pane.failedSendNotice = call('mountFailedSendNotice', {
          noticeNode: pane.notices.failed,
          chatThread: pane.dom.chatTimeline,
          getSessionId: getSessionId,
          getShellController: function () { return pane.shell; },
        }) || null;
      }
    }

    /* ── P1 (Astra pane findings): each pane's composer shows the draft of
       the session it displays. Pane 0's live composer is rebound by the
       composer state controller; pane 1's textarea is bound to
       `pane.draftSessionId`. A rekey keeps the text (the same chat under its
       server id); the sign-out reset moves nothing (the store is cleared). ── */
    function composerDrafts() {
      var controller = typeof options.getComposerSessionState === 'function'
        ? options.getComposerSessionState() : root.rendererComposerSessionStateController;
      return paneDrafts && controller && typeof controller.capturePaneDraft === 'function' ? controller : null;
    }
    /* Before pane 1 mounts or unmounts: captures first (a swap reads both
       panes before writing either), then pane 0 takes its new session's draft. */
    function handOffDrafts(prev, next, reason) {
      var drafts = composerDrafts();
      if (!drafts || !prev || reason === 'reset' || reason === 'rekey') return;
      var side = panes.get(1);
      var sideNext = next.panes[1] ? next.panes[1].sessionId : '';
      if (side && side.draftSessionId && side.draftSessionId !== sideNext) drafts.capturePaneDraft(side.draftSessionId, side.dom.chatInput);
      paneDrafts.rebindLive(drafts, prev.panes[0] ? prev.panes[0].sessionId : '', next.panes[0] ? next.panes[0].sessionId : '');
    }
    function showPaneDraft(pane, sessionId, reason) {
      var id = normalizeId(sessionId);
      if (!pane || !pane.dom.chatInput || pane.draftSessionId === id) return;
      pane.draftSessionId = id;
      var drafts = reason === 'rekey' ? null : composerDrafts();
      if (!drafts) return;
      drafts.restorePaneDraft(id, pane.dom.chatInput);
      autosizeInput(pane.dom.chatInput);
    }

    function autosizeInput(input) {
      if (!input || !input.style) return;
      input.style.height = 'auto';
      var next = Number(input.scrollHeight) || 0;
      if (next > 0) input.style.height = next + 'px';
    }

    function insertButton(host, buttonOptions) {
      if (!host || typeof actionButton !== 'function') return null;
      host.insertAdjacentHTML('beforeend', actionButton(Object.assign({ plain: true }, buttonOptions)));
      return host.lastElementChild;
    }

    function buildPaneDom(rootEl, paneDom, pane) {
      var q = function (selector) { return rootEl.querySelector(selector); };
      return Object.assign({}, paneDom, {
        chatView: rootEl,
        composer: pane.composer,
        heroStack: q('.hero-stack'),
        heroAvatar: q('.hero-avatar'),
        heroTitle: q('.hero-title'),
        heroSubtitle: q('.hero-subtitle'),
        heroRuntimeHint: q('.hero-runtime-hint'),
        sendButton: pane.sendButton,
        stopStreamButton: pane.stopButton,
        attachmentTray: paneDom.attachmentTray || null,
        composerAttachShortcut: pane.attachButton || null,
        jumpToTopButton: null,
        jumpToLastPromptButton: null,
        jumpToBottomButton: null,
        artifactReviewResizer: null,
        artifactReviewPanel: null,
        chatContextPanel: null,
      });
    }

    /* Mount step: the composer's Stop / Send / Attach buttons, the notice
       hosts, the queued-count span and the pane's `dom` bag, in the order the
       composition's mount always built them. Returns the right toolbar (the
       pane's rail mounts there). */
    function buildComposerNodes(pane, paneDom) {
      var rootEl = pane.root;
      var toolbarRight = rootEl.querySelector('.composer-toolbar-right');
      pane.stopButton = insertButton(toolbarRight, {
        className: 'composer-stop-button hidden',
        ariaLabel: jt('composer.stopCurrentResponse', 'Stop current response'),
        title: jt('composer.stop', 'Stop'),
        trustedHtml: ICON_STOP,
      });
      pane.sendButton = insertButton(toolbarRight, {
        className: 'composer-send',
        ariaLabel: jt('composer.send', 'Send'),
        title: jt('composer.sendTitle', 'Send message (Enter)'),
        trustedHtml: '&#8593;',
      });
      var toolbarLeft = rootEl.querySelector('.composer-toolbar-left');
      pane.attachButton = insertButton(toolbarLeft, {
        className: 'composer-icon-button',
        ariaLabel: jt('composer.attachFile', 'Attach file'),
        title: jt('composer.attachFile', 'Attach file'),
        dataset: { 'chat-node': 'composerAttachShortcut' },
        trustedHtml: ICON_ATTACH,
      });
      var pane0Tray = pane0Root() && pane0Root().querySelector('[data-chat-node="attachmentTray"]');
      if (paneDom.attachmentTray && pane0Tray) paneDom.attachmentTray.dataset.composerV2 = pane0Tray.dataset.composerV2 || 'off';
      pane.notices = resolvePaneNotices(rootEl);
      if (toolbarLeft && doc) {
        pane.queuedNotice = doc.createElement('span');
        pane.queuedNotice.className = 'chat-pane-queued';
        pane.queuedNotice.setAttribute('aria-live', 'polite');
        pane.queuedNotice.hidden = true;
        toolbarLeft.appendChild(pane.queuedNotice);
      }
      pane.dom = buildPaneDom(rootEl, paneDom, pane);
      return toolbarRight;
    }

    return {
      syncPaneComposer: syncPaneComposer,
      syncPaneAttachments: syncPaneAttachments,
      createPaneAttachments: createPaneAttachments,
      resolvePaneNotices: resolvePaneNotices,
      mountPaneNotices: mountPaneNotices,
      composerDrafts: composerDrafts,
      handOffDrafts: handOffDrafts,
      showPaneDraft: showPaneDraft,
      autosizeInput: autosizeInput,
      insertButton: insertButton,
      buildPaneDom: buildPaneDom,
      buildComposerNodes: buildComposerNodes,
    };
  }

  return { createPaneChrome: createPaneChrome };
});
