/* global window */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('../shared/async-fence'), require('./renderer-side-panel-motion')); return; }
  root.rendererContextPanelUtils = factory(root.rendererAsyncFence, root.rendererSidePanelMotion);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence, sidePanelMotionModule) {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  var STORAGE_KEY = 'jenny.contextPanel.v1';
  var globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  var documentRef = globalRef.document || null;
  var windowRef = globalRef.window || globalRef;

  function normalizePreferences(value) {
    var source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    // Collapsed unless the user explicitly expanded it (owner decision
    // 2026-09-07): a stored `false` wins, an absent preference collapses.
    return { collapsed: source.collapsed !== false };
  }

  function createContextPanelController(deps) {
    var state = deps.state;
    var dom = deps.dom;
    var callbacks = deps.callbacks;
    var constants = deps.constants;

    var activity = globalRef.rendererChatActivity?.createChatActivity?.({state:state,panel:dom.chatContextPanel,
      sidePanel:callbacks.sidePanel,closeArtifact:callbacks.closeArtifact,onOutput:callbacks.openActivityOutput,
      onDiagnostics:()=>callbacks.setActiveView?.('logs'),updateLayout:()=>callbacks.updateComposerSafeOffset?.({force:true,syncViewport:true})});
    var bound = false;
    var prefs = loadPreferences();
    var logsExpanded = false;
    var fence = asyncFence.createDisposalFence();
    var layoutUpdateTimer = null;
    // The column glides while the reading text reflows once (renderer-side-panel-motion.js); the width and
    // content transitions in styles/context-panel.css run only under #chatView[data-panel-motion].
    var chatViewRef = dom.chatContextPanel && typeof dom.chatContextPanel.closest === 'function' ? dom.chatContextPanel.closest('.chat-view') : null;
    var motion = chatViewRef && sidePanelMotionModule && sidePanelMotionModule.createSidePanelMotion
      ? sidePanelMotionModule.createSidePanelMotion({ chatView: chatViewRef, getCoordinators: function () { return callbacks.getScrollCoordinators ? callbacks.getScrollCoordinators() : []; } })
      : null;

    function setCollapsed(panel, collapse) {
      var apply = function () { panel.classList.toggle('collapsed', collapse); };
      if (!motion) { apply(); return; }
      if (collapse) motion.close({ panel: panel, applyEnd: apply });
      else motion.open({ panel: panel, applyEnd: apply, applyStart: function () { panel.classList.add('collapsed'); } });
    }

    function cancelDelayedLayoutUpdate() {
      if (layoutUpdateTimer !== null) {
        windowRef.clearTimeout(layoutUpdateTimer);
        layoutUpdateTimer = null;
      }
    }

    fence.onDispose(cancelDelayedLayoutUpdate);
    fence.onDispose(function () { if (motion) motion.dispose(); });

    function loadPreferences() {
      try {
        var raw = windowRef.localStorage.getItem(STORAGE_KEY);
        return normalizePreferences(raw ? JSON.parse(raw) : {});
      } catch (_) { return normalizePreferences({}); }
    }

    function savePreferences() {
      try { windowRef.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); }
      catch (_) { /* storage blocked */ }
    }

    /* Split view W3-2: the session this panel shows. `callbacks.sidePanel` is
       the shell artifact bridge's owner bag (renderer-side-panel-owner.js):
       with two panes the chat that opened the side panel, with one pane
       `state.currentSessionId` as before. */
    function panelSessionId() {
      return callbacks.sidePanel ? callbacks.sidePanel.getSessionId() : state.currentSessionId;
    }

    // The panel's own document (the global one in the app, a JSDOM one in tests).
    function byId(id) {
      var doc = (dom.chatContextPanel && dom.chatContextPanel.ownerDocument) || documentRef;
      return doc ? doc.getElementById(id) : null;
    }

    function getLogDisclosureButton() {
      return byId('contextLogDisclosure');
    }

    // The header row is the disclosure: it stays visible with zero entries and
    // only mirrors the expanded state (aria-expanded, section class, feed hidden).
    function syncLogDisclosure() {
      var button = getLogDisclosureButton();
      if (state.features?.featureFlags?.activity_monitor === true) {
        button?.removeAttribute('aria-expanded');button?.removeAttribute('aria-controls');
        button?.querySelector('.context-disclosure-chevron')?.setAttribute('hidden','');
        var count = byId('contextLogCount');if(count)count.hidden=true;
        if(dom.contextSessionLogs)dom.contextSessionLogs.hidden=true;
        return;
      }
      if (button) button.setAttribute('aria-expanded', logsExpanded ? 'true' : 'false');
      var logSection = byId('contextLogSection');
      if (logSection) logSection.classList.toggle('logs-collapsed', !logsExpanded);
      if (dom.contextSessionLogs) dom.contextSessionLogs.toggleAttribute('hidden', !logsExpanded);
    }

    function renderContextLogs() {
      var el = dom.contextSessionLogs;
      if (!el) return;
      var maxLogs = (constants && constants.MAX_CONTEXT_LOGS) || 10;
      var entries = callbacks.getLogEntries ? callbacks.getLogEntries(panelSessionId()) : [];

      var countEl = byId('contextLogCount');
      if (countEl) countEl.textContent = String(Math.min(entries.length, maxLogs));

      syncLogDisclosure();
      if (!entries.length) {
        el.innerHTML = '<p class="context-empty-state">' + callbacks.escapeHtml(jt('context.logs.empty', 'Nothing logged yet.')) + '</p>';
        return;
      }
      var html = '';
      for (var i = 0; i < entries.length && i < maxLogs; i++) {
        var entry = entries[i];
        var ts = '';
        if (entry.ts) {
          var d = new Date(entry.ts);
          if (!isNaN(d.getTime())) {
            ts = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
          }
        }
        var msg = callbacks.escapeHtml(String(entry.event || entry.source || '').slice(0, 120));
        html += '<div class="context-log-line">'
          + '<span class="context-log-timestamp">' + callbacks.escapeHtml(ts) + '</span>'
          + '<span class="context-log-message">' + msg + '</span>'
          + '</div>';
      }
      el.innerHTML = html;
    }

    function renderContextPanel() {
      activity?.render();
      if (!dom.chatContextPanel) return;
      if (state.ui && state.ui.activeView !== 'chat') return;
      renderContextLogs();
      syncPanelOwnerLine();
    }

    // Activity names its owner in one-pane view too (the context list stays split-only), so it syncs as its own mode.
    function syncPanelOwnerLine() {
      if (callbacks.sidePanel) callbacks.sidePanel.syncOwnerLine(dom.chatContextPanel, activity?.isOpen() ? 'activity' : 'context');
    }

    function syncToggleAria() {
      // The timeline cluster's toggle (owner decision 2026-09-26): the one way
      // back once the panel is collapsed, since its own chevron collapses with it.
      if (dom.contextPanelOpenToggle && dom.chatContextPanel) {
        var open = !dom.chatContextPanel.classList.contains('collapsed');
        dom.contextPanelOpenToggle.setAttribute('aria-pressed', String(open));
        dom.contextPanelOpenToggle.classList.toggle('active', open);
      }
      if (dom.contextPanelToggle) {
        var expanded = !dom.chatContextPanel.classList.contains('collapsed');
        dom.contextPanelToggle.setAttribute('aria-expanded', String(expanded));
        dom.contextPanelToggle.setAttribute('aria-label', expanded ? jt('context.panel.collapse', 'Collapse context panel') : jt('context.panel.expand', 'Expand context panel'));
      }
    }

    function handleToggle() {
      if(activity?.isOpen()){activity.close();dom.chatContextPanel.classList.add('collapsed');}
      var panel = dom.chatContextPanel;
      if (!panel) return;
      // Expanding is an explicit open: with two panes it claims the panel for
      // the focused pane's chat and repaints for it (no-op with one pane).
      var claimed = panel.classList.contains('collapsed') && callbacks.sidePanel && callbacks.sidePanel.claim();
      setCollapsed(panel, !panel.classList.contains('collapsed'));
      prefs.collapsed = panel.classList.contains('collapsed');
      syncToggleAria();
      if (claimed) renderContextPanel();
      scheduleLayoutUpdate();
      savePreferences();
    }

    // Split view: the pane that owned the side panel closed. Collapse an open
    // context panel like the artifact review, without saving the preference.
    function collapseForOwnerClose() {
      activity?.close();
      var panel = dom.chatContextPanel;
      if (!panel || panel.classList.contains('collapsed')) return false;
      setCollapsed(panel, true);
      syncToggleAria();
      scheduleLayoutUpdate();
      return true;
    }

    function scheduleLayoutUpdate() {
      if (callbacks.updateComposerSafeOffset) {
        callbacks.updateComposerSafeOffset({
          force: true,
          syncViewport: true,
        });
        cancelDelayedLayoutUpdate();
        layoutUpdateTimer = windowRef.setTimeout(fence.guard(function () {
          layoutUpdateTimer = null;
          callbacks.updateComposerSafeOffset({
            force: true,
            syncViewport: true,
          });
        }), 260);
      }
    }

    function handleLogDisclosureToggle() {
      if(state.features?.featureFlags?.activity_monitor === true){callbacks.setActiveView?.('logs');return;}
      logsExpanded = !logsExpanded;
      renderContextLogs();
      if (callbacks.updateComposerSafeOffset) {
        callbacks.updateComposerSafeOffset({
          force: true,
          syncViewport: true,
        });
      }
    }

    // The timeline cluster's toggle (owner decision 2026-09-26): the collapsed
    // panel hides its own chevron, so this is the way back. Built with the
    // inventory primitive after pane 0's artifact split-view toggle.
    function mountOpenToggle() {
      var doc = dom.chatContextPanel.ownerDocument;
      var cluster = doc && doc.querySelector('#chatPane0 [data-chat-node="chatTimelineUtilityCluster"]');
      var build = globalRef.inventoryActionButton;
      if (!cluster || typeof build !== 'function' || doc.getElementById('contextPanelOpenToggle')) return;
      var label = jt('chat.utilities.toggleContextPanel', 'Toggle context panel');
      var html = build({
        plain: true, className: 'chat-timeline-utility-button', domId: 'contextPanelOpenToggle',
        ariaPressed: false, ariaLabel: label, title: label,
        trustedHtml: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="1.5"></rect><path d="M10.5 2v12"></path></svg>',
      });
      var anchor = cluster.querySelector('[data-chat-node="artifactSplitViewToggle"]');
      if (anchor) anchor.insertAdjacentHTML('afterend', html);
      else cluster.insertAdjacentHTML('afterbegin', html);
      dom.contextPanelOpenToggle = doc.getElementById('contextPanelOpenToggle');
    }

    function bind() {
      if (bound || !dom.chatContextPanel) return;
      bound = true;
      mountOpenToggle();
      activity?.bind();
      if (prefs.collapsed) dom.chatContextPanel.classList.add('collapsed');
      syncToggleAria();
      syncLogDisclosure();
      if (dom.contextPanelToggle) dom.contextPanelToggle.addEventListener('click', handleToggle);
      if (dom.contextPanelOpenToggle) dom.contextPanelOpenToggle.addEventListener('click', handleToggle);
      var logDisclosureButton = getLogDisclosureButton();
      if (logDisclosureButton) logDisclosureButton.addEventListener('click', handleLogDisclosureToggle);
    }

    function dispose() {
      fence.dispose();
      activity?.dispose();
      if (!bound || !dom.chatContextPanel) return;
      bound = false;
      if (dom.contextPanelToggle) dom.contextPanelToggle.removeEventListener('click', handleToggle);
      if (dom.contextPanelOpenToggle) {
        dom.contextPanelOpenToggle.removeEventListener('click', handleToggle);
        dom.contextPanelOpenToggle.remove();
        dom.contextPanelOpenToggle = null;
      }
      var logDisclosureButton = getLogDisclosureButton();
      if (logDisclosureButton) logDisclosureButton.removeEventListener('click', handleLogDisclosureToggle);
    }

    return { openActivity: () => { var opened = activity?.open(); if (opened) syncPanelOwnerLine(); return opened; }, renderContextPanel: renderContextPanel, bind: bind, dispose: dispose, collapseForOwnerClose: collapseForOwnerClose };
  }

  return { createContextPanelController: createContextPanelController };
});
