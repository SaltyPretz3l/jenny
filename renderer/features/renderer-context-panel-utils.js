/* global window */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('../shared/async-fence')); return; }
  root.rendererContextPanelUtils = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence) {
  'use strict';

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

    /* ── artifact type icon SVG paths ── */
    var ARTIFACT_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h5.5L13 5.5V14H4z"/><path d="M9 2v4h4"/></svg>';

    function getLogDisclosureButton() {
      return documentRef ? documentRef.getElementById('contextLogDisclosure') : null;
    }

    function syncLogDisclosure(hasEntries) {
      var button = getLogDisclosureButton();
      if (!button) return;
      var showButton = Boolean(hasEntries);
      button.classList.toggle('hidden', !showButton);
      button.disabled = !showButton;
      button.setAttribute('aria-expanded', showButton && logsExpanded ? 'true' : 'false');
      button.textContent = logsExpanded ? 'Hide' : 'Show';
      button.title = logsExpanded ? 'Hide session logs' : 'Show session logs';
    }

    function renderContextArtifacts() {
      var el = dom.contextArtifactList;
      if (!el) return;
      var sessionId = state.currentSessionId || '';
      var artifacts = [];
      if (sessionId && callbacks.getArtifactsForSession) {
        artifacts = callbacks.getArtifactsForSession(sessionId);
      }

      var countEl = documentRef ? documentRef.getElementById('contextArtifactCount') : null;
      if (countEl) countEl.textContent = String(artifacts.length);

      if (!artifacts.length) {
        el.innerHTML = '<div class="context-empty-state">Nothing here yet.</div>';
        return;
      }
      var html = '';
      var orbitCardFn = globalThis.inventory && globalThis.inventory.orbitCard;
      for (var i = 0; i < artifacts.length; i++) {
        var a = artifacts[i];
        if (orbitCardFn) {
          html += orbitCardFn({
            id: a.id,
            title: a.title || 'Untitled',
            meta: (a.artifactType || 'file').toUpperCase(),
            icon: ARTIFACT_ICON,
          });
        } else {
          var title = callbacks.escapeHtml(String(a.title || 'Untitled'));
          var type = callbacks.escapeHtml(String(a.artifactType || 'file').toUpperCase());
          html += '<div class="context-artifact-row" role="listitem" data-artifact-id="' + callbacks.escapeHtml(String(a.id || '')) + '">'
            + '<div class="context-artifact-icon">' + ARTIFACT_ICON + '</div>'
            + '<div class="context-artifact-info">'
            + '<div class="context-artifact-title">' + title + '</div>'
            + '<div class="context-artifact-meta">' + type + '</div>'
            + '</div></div>';
        }
      }
      el.innerHTML = html;
    }

    function renderContextPulse() {
      var el = dom.contextPulse;
      if (!el) return;
      var deriveDisplayState = globalRef.rendererShellRuntimeUtils
        && globalRef.rendererShellRuntimeUtils.deriveCanonicalSessionDisplayState;
      var displayState = typeof deriveDisplayState === 'function'
        ? deriveDisplayState(state, state.currentSessionId, {
            estimateTokens: callbacks.estimateTokens,
            contextOverheadTokens: state.ui?.contextOverheadTokens,
            contextLimit: state.status?.effective_context_length,
          })
        : null;
      var modelName = callbacks.escapeHtml(displayState?.model || 'Unknown');
      var tokenText = '0';
      var tokenPct = 0;
      if (typeof callbacks.estimateTokens === 'function' && typeof callbacks.formatTokenUsageDisplay === 'function') {
        var visibleMessages = displayState?.hasHydratedMessages
          ? displayState.messages
          : (typeof callbacks.getCurrentVisibleMessages === 'function'
              ? callbacks.getCurrentVisibleMessages()
              : []);
        var usedTokens = displayState?.usedTokens ?? (
          callbacks.estimateTokens(visibleMessages)
          + Math.max(Number(state.ui?.contextOverheadTokens || 0), 0)
        );
        var activeContextLimit = displayState?.contextLimit || null;
        var activeContextLabel = activeContextLimit && Number.isFinite(activeContextLimit)
          ? activeContextLimit.toLocaleString()
          : '-';
        var tokenDisplay = callbacks.formatTokenUsageDisplay(usedTokens, activeContextLimit, activeContextLabel);
        tokenPct = Math.min(100, Math.round(Number(tokenDisplay.ratio || 0) * 100));
        tokenText = callbacks.escapeHtml(String(tokenDisplay.label || '').replace(/^Est\. tokens:\s*/i, '') || '0');
      }
      var msgCount = displayState?.messageCount ?? 0;

      el.innerHTML =
        '<div class="context-metric-row">'
          + '<div class="context-metric-header"><span class="context-metric-label">Model</span>'
          + '<span class="context-metric-value">' + modelName + '</span></div>'
        + '</div>'
        + '<div class="context-metric-row">'
          + '<div class="context-metric-header"><span class="context-metric-label">Tokens</span>'
          + '<span class="context-metric-value">' + tokenText + '</span></div>'
          + '<div class="context-metric-track"><div class="context-metric-fill" style="width:' + tokenPct + '%"></div></div>'
        + '</div>'
        + '<div class="context-metric-row">'
          + '<div class="context-metric-header"><span class="context-metric-label">Messages</span>'
          + '<span class="context-metric-value">' + msgCount + '</span></div>'
        + '</div>';
    }

    function renderContextLogs() {
      var el = dom.contextSessionLogs;
      if (!el) return;
      var logSection = documentRef ? documentRef.getElementById('contextLogSection') : null;
      var maxLogs = (constants && constants.MAX_CONTEXT_LOGS) || 10;
      var entries = callbacks.getLogEntries ? callbacks.getLogEntries() : [];

      var countEl = documentRef ? documentRef.getElementById('contextLogCount') : null;
      if (countEl) countEl.textContent = String(Math.min(entries.length, maxLogs));

      if (!entries.length) {
        logsExpanded = false;
        syncLogDisclosure(false);
        el.toggleAttribute('hidden', false);
        if (logSection) logSection.classList.remove('logs-collapsed');
        el.innerHTML = '<div class="context-empty-state">Nothing logged yet.</div>';
        return;
      }
      syncLogDisclosure(true);
      el.toggleAttribute('hidden', !logsExpanded);
      if (logSection) logSection.classList.toggle('logs-collapsed', !logsExpanded);
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
      renderContextPulse();
      renderContextLogs();
    }

    function syncToggleAria() {
      if (dom.contextPanelToggle) {
        var expanded = !dom.chatContextPanel.classList.contains('collapsed');
        dom.contextPanelToggle.setAttribute('aria-expanded', String(expanded));
        dom.contextPanelToggle.setAttribute('aria-label', expanded ? 'Collapse context panel' : 'Expand context panel');
      }
    }

    function handleToggle() {
      var panel = dom.chatContextPanel;
      if (!panel) return;
      panel.classList.toggle('collapsed');
      prefs.collapsed = panel.classList.contains('collapsed');
      syncToggleAria();
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
      savePreferences();
    }

    function handleArtifactClick(e) {
      var row = e.target.closest('.orbit-card') || e.target.closest('.context-artifact-row');
      if (!row) return;
      var id = row.dataset.orbitCardId || row.dataset.artifactId;
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
      syncLogDisclosure(true);
      renderContextLogs();
      if (callbacks.updateComposerSafeOffset) {
        callbacks.updateComposerSafeOffset({
          force: true,
          syncViewport: true,
        });
      }
    }

    function bind() {
      if (bound || !dom.chatContextPanel) return;
      bound = true;
      if (prefs.collapsed) dom.chatContextPanel.classList.add('collapsed');
      syncToggleAria();
      syncLogDisclosure(false);
      if (dom.contextPanelToggle) dom.contextPanelToggle.addEventListener('click', handleToggle);
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
      if (dom.contextArtifactList) dom.contextArtifactList.removeEventListener('click', handleArtifactClick);
      if (dom.contextArtifactExpand) dom.contextArtifactExpand.removeEventListener('click', handleExpandClick);
      var logDisclosureButton = getLogDisclosureButton();
      if (logDisclosureButton) logDisclosureButton.removeEventListener('click', handleLogDisclosureToggle);
    }

    return { renderContextPanel: renderContextPanel, bind: bind, dispose: dispose };
  }

  return { createContextPanelController: createContextPanelController };
});
