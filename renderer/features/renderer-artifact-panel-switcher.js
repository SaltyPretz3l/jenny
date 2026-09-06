/** Artifact Panel V3 title switcher over the shared anchored-listbox. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/anchored-listbox'), require('./renderer-artifacts-projection'), require('./renderer-artifact-panel-chrome-render'));
    return;
  }
  root.rendererArtifactPanelSwitcher = factory(root.inventoryAnchoredListbox, root.rendererArtifactsProjection, root.rendererArtifactPanelChromeRender);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (anchoredListbox, projection, chromeRender) {
  'use strict';

  var OVERLAY_ID = 'artifact-panel-switcher';

  function artifactPath(artifact) {
    return String(artifact?.generatedFile?.displayPath || artifact?.generatedFile?.fileName || artifact?.image?.fileName || '');
  }

  function artifactMeta(artifact) {
    var parts = [];
    var turn = Number(artifact?.turnIndex || artifact?.turnNumber);
    if (Number.isInteger(turn) && turn > 0) parts.push('turn ' + turn);
    var time = chromeRender?.formatFooterTimestamp?.(artifact?.timestamp);
    if (time) parts.push(time);
    return parts.join(' · ');
  }

  function createArtifactPanelSwitcher(deps) {
    var options = deps || {};
    var panelEl = options.panelEl || null;
    var doc = options.documentRef || panelEl?.ownerDocument || null;
    var overlayManager = options.overlayManager || null;
    var listbox = null;
    var triggerEl = null;
    var registered = false;
    var outsideBound = false;

    function resolveTrigger() {
      if (triggerEl && triggerEl.isConnected !== false) return triggerEl;
      triggerEl = doc?.getElementById?.('artifactReviewDetailTitle') || null;
      return triggerEl;
    }

    function setExpanded(value) {
      resolveTrigger()?.setAttribute?.('aria-expanded', value ? 'true' : 'false');
    }

    function handleOutside(event) {
      if (!listbox || listbox.root.contains(event.target) || resolveTrigger()?.contains?.(event.target)) return;
      close();
    }

    function close() {
      var wasOpen = Boolean(listbox);
      listbox?.destroy?.();
      listbox = null;
      setExpanded(false);
      if (outsideBound) {
        doc.removeEventListener('mousedown', handleOutside, true);
        outsideBound = false;
      }
      if (registered && overlayManager?.close) overlayManager.close(OVERLAY_ID);
      registered = false;
      return wasOpen;
    }

    function open(input) {
      var config = input || {};
      var artifacts = Array.isArray(config.artifacts) ? config.artifacts : [];
      if (artifacts.length < 2 || !panelEl || !doc || !anchoredListbox?.createAnchoredListbox) return false;
      close();
      triggerEl = config.triggerEl || null;
      var sorted = typeof projection?.sortArtifactsNewestFirst === 'function'
        ? projection.sortArtifactsNewestFirst(artifacts)
        : artifacts.slice().reverse();
      var predicates = config.predicates || {};
      var items = sorted.map(function (artifact) {
        var capabilities = options.resolveCapabilities?.(artifact, predicates) || { kind: 'text' };
        var title = chromeRender?.titleForArtifact?.(artifact) || String(artifact?.title || 'Artifact');
        var path = artifactPath(artifact);
        return {
          id: artifact.id,
          value: artifact.id,
          label: title,
          meta: artifactMeta(artifact),
          searchText: title + ' ' + path,
          trustedGlyphHtml: chromeRender?.kindGlyphHtml?.(capabilities.kind) || '',
          selected: artifact.id === config.currentArtifactId,
        };
      });
      var panelRect = panelEl.getBoundingClientRect();
      var anchorEl = panelEl.querySelector('.artifact-panel-header') || triggerEl;
      listbox = anchoredListbox.createAnchoredListbox({
        id: 'artifactPanelSwitcher',
        documentRef: doc,
        className: 'artifact-panel-switcher',
        ariaLabel: 'Select an artifact',
        filterPlaceholder: 'Search artifacts',
        filterAriaLabel: 'Search artifacts',
        items: items,
        width: Math.max(240, panelRect.width - 16),
        anchorEl: anchorEl,
        onSelect: function (artifactId) {
          close();
          if (typeof options.onSelect === 'function') options.onSelect(artifactId);
        },
        onEscape: function () { if (!registered) close(); },
      });
      if (!listbox) return false;
      listbox.position(anchorEl);
      setExpanded(true);
      if (overlayManager?.open) {
        registered = overlayManager.open({
          id: OVERLAY_ID,
          root: listbox.root,
          restoreFocusTo: triggerEl,
          trapFocus: true,
          onRequestClose: function () { close(); },
        }) === true;
      }
      doc.addEventListener('mousedown', handleOutside, true);
      outsideBound = true;
      listbox.focus();
      return true;
    }

    function dispose() { close(); }
    function isOpen() { return Boolean(listbox); }
    return { open: open, close: close, dispose: dispose, isOpen: isOpen };
  }

  return { createArtifactPanelSwitcher: createArtifactPanelSwitcher };
});
