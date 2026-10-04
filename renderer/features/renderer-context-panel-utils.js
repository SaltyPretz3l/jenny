/* global window */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('../shared/async-fence'), require('../inventory/orbit-card'), require('../inventory/action-button')); return; }
  root.rendererContextPanelUtils = factory(root.rendererAsyncFence, null, null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence, requiredOrbitCard, requiredActionButton) {
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

    var bound = false;
    var prefs = loadPreferences();
    var logsExpanded = false;
    var fence = asyncFence.createDisposalFence();
    var layoutUpdateTimer = null;

    function cancelDelayedLayoutUpdate() {
      if (layoutUpdateTimer !== null) {
        windowRef.clearTimeout(layoutUpdateTimer);
        layoutUpdateTimer = null;
      }
    }

    fence.onDispose(cancelDelayedLayoutUpdate);

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

    /* ── artifact type icons (16px, stroke-only) ── */
    var ARTIFACT_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h5.5L13 5.5V14H4z"/><path d="M9 2v4h4"/></svg>';
    var IMAGE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2.5 12l3.5-4 3 3 2-2 2.5 3"/><circle cx="10.5" cy="6" r="1.2"/></svg>';
    var TOOL_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2.2a3.2 3.2 0 0 0-3.9 4.1L2.4 10.5a1.3 1.3 0 0 0 1.8 1.8l4.2-4.2a3.2 3.2 0 0 0 4.1-3.9l-2 2-1.6-.5-.5-1.6z"/></svg>';
    var JUMP_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z"/></svg>';
    var lastArtifactHtml = null;
    var lastArtifactEl = null;

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
      if (button) button.setAttribute('aria-expanded', logsExpanded ? 'true' : 'false');
      var logSection = byId('contextLogSection');
      if (logSection) logSection.classList.toggle('logs-collapsed', !logsExpanded);
      if (dom.contextSessionLogs) dom.contextSessionLogs.toggleAttribute('hidden', !logsExpanded);
    }

    function resolveOrbitCard() {
      var inv = globalRef.inventory;
      return (inv && inv.orbitCard) || globalRef.inventoryOrbitCard || requiredOrbitCard;
    }

    function resolveActionButton() {
      return globalRef.inventoryActionButton || requiredActionButton;
    }

    function artifactTypeLabel(a) {
      if (a.artifactType === 'image') return jt('context.artifacts.type.image', 'Image');
      if (a.artifactType === 'tool_output') return jt('context.artifacts.type.toolResult', 'Tool result');
      return a.generatedFile && a.generatedFile.isMarkdownDocument
        ? jt('context.artifacts.type.document', 'Document')
        : jt('context.artifacts.type.file', 'File');
    }

    function artifactDetail(a, title) {
      var detail = '';
      if (a.artifactType === 'image') {
        var w = Number(a.image && a.image.width);
        var h = Number(a.image && a.image.height);
        if (isFinite(w) && isFinite(h) && w > 0 && h > 0) detail = w + '\u00d7' + h;
      } else if (a.artifactType === 'tool_output') {
        detail = String((a.tool && a.tool.toolName) || '');
      } else {
        detail = String((a.generatedFile && a.generatedFile.fileName) || '');
      }
      return detail && detail !== title ? detail : '';
    }

    function artifactStatus(a) {
      var status = String(a.status || '').toLowerCase();
      if (status === 'error' || status === 'failed' || (a.tool && a.tool.isError)) {
        return { text: jt('context.artifacts.status.failed', 'Failed'), tone: 'danger' };
      }
      if (status === 'missing') return { text: jt('context.artifacts.status.missing', 'Missing'), tone: 'muted' };
      return null;
    }

    // Localized relative age (Astra P3, 2026-09-27): the Chats list's
    // formatSessionTime hardcodes 'now' / 'm' / 'h', so the rail formats the
    // same thresholds through Intl.RelativeTimeFormat in the UI locale
    // ("1m ago", "-1 min", "1分前"); a date past a day, like the Chats list.
    function formatArtifactAge(timestamp) {
      var parsed = timestamp ? new Date(timestamp) : null;
      if (!parsed || Number.isNaN(parsed.valueOf())) return '';
      var now = Date.now();
      var tag = globalThis.jennyI18n && typeof globalThis.jennyI18n.tag === 'function' ? globalThis.jennyI18n.tag() : undefined;
      var minutes = Math.floor(Math.max(now - parsed.valueOf(), 0) / 60000);
      var hours = Math.floor(minutes / 60);
      if (hours >= 24) {
        var options = { month: 'short', day: 'numeric' };
        if (parsed.getFullYear() !== new Date(now).getFullYear()) options.year = 'numeric';
        return parsed.toLocaleDateString(tag, options);
      }
      var RelativeTimeFormat = typeof Intl !== 'undefined' ? Intl.RelativeTimeFormat : null;
      if (typeof RelativeTimeFormat !== 'function') {
        var chats = globalRef.rendererChatsPanel;
        return chats && typeof chats.formatSessionTime === 'function' ? String(chats.formatSessionTime(timestamp) || '') : '';
      }
      var relative = new RelativeTimeFormat(tag, { numeric: 'auto', style: 'narrow' });
      if (minutes < 1) return relative.format(0, 'second');
      if (minutes < 60) return relative.format(-minutes, 'minute');
      return relative.format(-hours, 'hour');
    }

    function renderArtifactRow(orbitCardFn, a) {
      var isTool = a.artifactType === 'tool_output';
      var title = String(a.title || (isTool && a.tool && a.tool.toolName) || '') || jt('context.artifacts.untitled', 'Untitled');
      var status = artifactStatus(a);
      var parts = [artifactTypeLabel(a), artifactDetail(a, title)];
      if (!status) parts.push(formatArtifactAge(a.timestamp));
      var sourceMessageId = String(a.sourceMessageId || '');
      var buildButton = resolveActionButton();
      var jumpLabel = jt('context.artifacts.jumpToMessage', 'Jump to message');
      return '<div class="context-artifact-item" role="listitem">'
        + orbitCardFn({
            id: a.id,
            title: title,
            meta: parts.filter(Boolean).join(' \u00b7 '),
            icon: a.artifactType === 'image' ? IMAGE_ICON : (isTool ? TOOL_ICON : ARTIFACT_ICON),
            tone: isTool ? 'muted' : 'accent',
            tooltip: title,
            status: status ? status.text : '',
            statusTone: status ? status.tone : '',
          })
        + (sourceMessageId && typeof buildButton === 'function' && typeof callbacks.jumpToArtifactSource === 'function'
          ? buildButton({
              plain: true, className: 'orbit-card-jump', ariaLabel: jumpLabel, title: jumpLabel,
              dataset: { 'artifact-jump': sourceMessageId }, trustedHtml: JUMP_ICON,
            })
          : '')
        + '</div>';
    }

    function renderContextArtifacts() {
      var el = dom.contextArtifactList;
      if (!el) return;
      var sessionId = panelSessionId() || '';
      var artifacts = [];
      if (sessionId && callbacks.getArtifactsForSession) {
        artifacts = callbacks.getArtifactsForSession(sessionId) || [];
      }

      var countEl = byId('contextArtifactCount');
      if (countEl) countEl.textContent = String(artifacts.length);

      var html = '';
      var orbitCardFn = resolveOrbitCard();
      var hasRows = artifacts.length > 0 && typeof orbitCardFn === 'function';
      if (!hasRows) {
        html = '<p class="context-empty-state">' + callbacks.escapeHtml(jt('context.artifacts.empty', 'Files, images, and tool results from this chat appear here.')) + '</p>';
      } else {
        for (var i = 0; i < artifacts.length; i++) html += renderArtifactRow(orbitCardFn, artifacts[i]);
      }
      // A list only while it holds listitems: the empty sentence is prose, not a one-item list.
      if (hasRows) el.setAttribute('role', 'list');
      else el.removeAttribute('role');
      // Identical output: leave the nodes (and focus) alone.
      if (html === lastArtifactHtml && el === lastArtifactEl) return;

      // Keep keyboard focus on the same row (or its jump button) across the rebuild.
      var active = el.ownerDocument ? el.ownerDocument.activeElement : null;
      var focusId = '';
      var focusJump = false;
      if (active && active !== el && el.contains(active)) {
        var item = active.closest('.context-artifact-item');
        var card = item && item.querySelector('.orbit-card');
        focusId = card ? String(card.getAttribute('data-orbit-card-id') || '') : '';
        focusJump = Boolean(active.closest('.orbit-card-jump'));
      }
      el.innerHTML = html;
      lastArtifactHtml = html;
      lastArtifactEl = el;
      if (!focusId) return;
      var cards = el.querySelectorAll('.orbit-card');
      for (var j = 0; j < cards.length; j++) {
        if (cards[j].getAttribute('data-orbit-card-id') !== focusId) continue;
        var target = focusJump ? cards[j].parentNode.querySelector('.orbit-card-jump') : cards[j];
        if (target) target.focus();
        return;
      }
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
      if (!dom.chatContextPanel) return;
      if (state.ui && state.ui.activeView !== 'chat') return;
      renderContextArtifacts();
      renderContextLogs();
      if (callbacks.sidePanel) callbacks.sidePanel.syncOwnerLine(dom.chatContextPanel, 'context');
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
      var panel = dom.chatContextPanel;
      if (!panel) return;
      // Expanding is an explicit open: with two panes it claims the panel for
      // the focused pane's chat and repaints for it (no-op with one pane).
      var claimed = panel.classList.contains('collapsed') && callbacks.sidePanel && callbacks.sidePanel.claim();
      panel.classList.toggle('collapsed');
      prefs.collapsed = panel.classList.contains('collapsed');
      syncToggleAria();
      if (claimed) renderContextPanel();
      scheduleLayoutUpdate();
      savePreferences();
    }

    // Split view: the pane that owned the side panel closed. Collapse an open
    // context panel like the artifact review, without saving the preference.
    function collapseForOwnerClose() {
      var panel = dom.chatContextPanel;
      if (!panel || panel.classList.contains('collapsed')) return false;
      panel.classList.add('collapsed');
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

    function handleArtifactClick(e) {
      var jump = e.target.closest('.orbit-card-jump');
      if (jump) {
        if (typeof callbacks.jumpToArtifactSource === 'function') callbacks.jumpToArtifactSource(jump.dataset.artifactJump);
        return;
      }
      var row = e.target.closest('.orbit-card');
      if (!row) return;
      var id = row.dataset.orbitCardId;
      if (id && typeof callbacks.openArtifactTarget === 'function') {
        callbacks.openArtifactTarget(id, { source: 'context-panel' }).catch(function () {});
        return;
      }
      // Fall back to selection when the artifact-target opener is unavailable.
      if (id && callbacks.selectArtifact) callbacks.selectArtifact(id);
    }

    function handleExpandClick() {
      if (typeof callbacks.openArtifactTarget === 'function') {
        callbacks.openArtifactTarget('', { source: 'context-panel-expand' }).catch(function () {});
      }
    }

    function handleLogDisclosureToggle() {
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
      if (prefs.collapsed) dom.chatContextPanel.classList.add('collapsed');
      syncToggleAria();
      syncLogDisclosure();
      if (dom.contextPanelToggle) dom.contextPanelToggle.addEventListener('click', handleToggle);
      if (dom.contextPanelOpenToggle) dom.contextPanelOpenToggle.addEventListener('click', handleToggle);
      if (dom.contextArtifactList) dom.contextArtifactList.addEventListener('click', handleArtifactClick);
      if (dom.contextArtifactExpand) dom.contextArtifactExpand.addEventListener('click', handleExpandClick);
      var logDisclosureButton = getLogDisclosureButton();
      if (logDisclosureButton) logDisclosureButton.addEventListener('click', handleLogDisclosureToggle);
    }

    function dispose() {
      fence.dispose();
      if (!bound || !dom.chatContextPanel) return;
      bound = false;
      if (dom.contextPanelToggle) dom.contextPanelToggle.removeEventListener('click', handleToggle);
      if (dom.contextPanelOpenToggle) {
        dom.contextPanelOpenToggle.removeEventListener('click', handleToggle);
        dom.contextPanelOpenToggle.remove();
        dom.contextPanelOpenToggle = null;
      }
      if (dom.contextArtifactList) dom.contextArtifactList.removeEventListener('click', handleArtifactClick);
      if (dom.contextArtifactExpand) dom.contextArtifactExpand.removeEventListener('click', handleExpandClick);
      var logDisclosureButton = getLogDisclosureButton();
      if (logDisclosureButton) logDisclosureButton.removeEventListener('click', handleLogDisclosureToggle);
    }

    return { renderContextPanel: renderContextPanel, bind: bind, dispose: dispose, collapseForOwnerClose: collapseForOwnerClose };
  }

  return { createContextPanelController: createContextPanelController };
});
