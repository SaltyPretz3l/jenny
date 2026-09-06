/* renderer/features/renderer-ide-explode-states.js — the loading / empty /
 * parse-failed overlay for the Exploded View. A single absolutely-positioned
 * panel layered above the graph content (z-index in styles/ide-explode-view.css).
 * Built with createElement (no HTML-string primitives) so it stays clear of the
 * raw-primitive check. UMD, mirroring the repo's module style. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeExplodeStates = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) return globalRef[globalName];
    if (typeof require === 'function') {
      try { return require(requirePath); } catch (_error) { /* unavailable */ }
    }
    return {};
  }

  const inventoryButton = resolveModule('inventoryActionButton', '../inventory/action-button');
  const actionButton = typeof inventoryButton === 'function'
    ? inventoryButton
    : inventoryButton.actionButton || inventoryButton.default || null;

  // createExplodeStates({ host, onRetry? }) — host is the .ide-exploded-host.
  function createExplodeStates(deps) {
    const d = deps || {};
    const host = d.host || null;
    const onRetry = typeof d.onRetry === 'function' ? d.onRetry : null;
    const documentRef = host && host.ownerDocument ? host.ownerDocument : null;

    let panel = null;
    let disposed = false;

    function ensurePanel() {
      if (panel || !documentRef || !host) return panel;
      panel = documentRef.createElement('div');
      panel.className = 'ide-explode-state hidden';
      // Live region so 'Building…' / 'Nothing to explode' / parse-failed text
      // changes are announced to assistive tech (showError bumps this to
      // assertive). Default polite for the non-error states.
      panel.setAttribute('role', 'status');
      panel.setAttribute('aria-live', 'polite');
      host.appendChild(panel);
      return panel;
    }

    function clear() {
      if (panel) panel.textContent = '';
    }

    // Loading/empty are polite (role=status); a parse failure is assertive
    // (role=alert) so it interrupts. Re-applied per show* since one panel is
    // reused across all three states.
    function setPoliteness(assertive) {
      if (!panel) return;
      panel.setAttribute('role', assertive ? 'alert' : 'status');
      panel.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
    }

    function addTitle(text) {
      const el = documentRef.createElement('div');
      el.className = 'ide-explode-state-title';
      el.textContent = text;
      panel.appendChild(el);
    }

    function addDetail(text) {
      if (!text) return;
      const el = documentRef.createElement('div');
      el.className = 'ide-explode-state-detail';
      el.textContent = text;
      panel.appendChild(el);
    }

    function show() {
      if (panel) panel.classList.remove('hidden');
    }

    function hide() {
      if (panel) panel.classList.add('hidden');
    }

    function showLoading() {
      if (disposed || !ensurePanel()) return;
      clear();
      setPoliteness(false);
      const spinner = documentRef.createElement('div');
      spinner.className = 'ide-explode-state-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      panel.appendChild(spinner);
      addTitle('Building exploded view…');
      show();
    }

    function showEmpty() {
      if (disposed || !ensurePanel()) return;
      clear();
      setPoliteness(false);
      addTitle('Nothing to explode');
      addDetail('No functions or module data were found in this file.');
      show();
    }

    function showError(detail) {
      if (disposed || !ensurePanel()) return;
      clear();
      setPoliteness(true);
      addTitle('Couldn’t parse this file');
      addDetail(detail || 'The editor’s language service could not analyze this file.');
      if (onRetry && typeof actionButton === 'function') {
        // Button from the inventory action-button primitive (no raw element).
        const holder = documentRef.createElement('div');
        holder.innerHTML = actionButton({ plain: true, className: 'ide-viewmode-seg-btn', label: 'Retry', ariaLabel: 'Retry building the exploded view', title: 'Retry building the exploded view' });
        const btn = holder.firstElementChild;
        if (btn) {
          btn.addEventListener('click', () => { if (!disposed) onRetry(); });
          panel.appendChild(btn);
        }
      }
      show();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      panel = null;
    }

    return { showLoading, showEmpty, showError, hide, dispose };
  }

  return { createExplodeStates };
});
