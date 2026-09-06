/* renderer/features/renderer-ide-explode-toggle.js — the Code | Exploded
 * segmented control shown in #ideViewModeBar for TS/JS file tabs when the
 * workspace_exploded_view flag is on. Reflects the active tab's viewMode and
 * calls onSelect(mode) on click. Built with createElement (no HTML-string
 * primitives). The controller decides visibility (flag + file-tab + TS/JS) and
 * passes it in; this module only paints + reports clicks. UMD. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeExplodeToggle = factory();
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

  // createExplodeToggle({ bar, onSelect }) — bar is #ideViewModeBar.
  function createExplodeToggle(deps) {
    const d = deps || {};
    const bar = d.bar || null;
    const onSelect = typeof d.onSelect === 'function' ? d.onSelect : null;
    const documentRef = bar && bar.ownerDocument ? bar.ownerDocument : null;

    let disposed = false;
    let seg = null;
    let codeBtn = null;
    let explodeBtn = null;

    function onSegClick(event) {
      const target = event.target;
      const btn = target && typeof target.closest === 'function' ? target.closest('[data-viewmode]') : null;
      const mode = btn && btn.dataset ? btn.dataset.viewmode : null;
      if (mode && onSelect && !disposed) onSelect(mode);
    }

    function build() {
      if (seg || !documentRef || !bar || typeof actionButton !== 'function') return;
      // Buttons come from the inventory action-button primitive (no raw element).
      const holder = documentRef.createElement('div');
      holder.innerHTML = actionButton({ plain: true, className: 'ide-viewmode-seg-btn', label: 'Code', ariaLabel: 'Show file as code', title: 'Show file as code', dataset: { viewmode: 'code' } })
        + actionButton({ plain: true, className: 'ide-viewmode-seg-btn', label: 'Exploded', ariaLabel: 'Show file as an exploded node graph', title: 'Show file as an exploded node graph', dataset: { viewmode: 'exploded' } });
      seg = documentRef.createElement('div');
      seg.className = 'ide-viewmode-seg';
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'File view mode');
      while (holder.firstChild) seg.appendChild(holder.firstChild);
      codeBtn = seg.querySelector('[data-viewmode="code"]');
      explodeBtn = seg.querySelector('[data-viewmode="exploded"]');
      seg.addEventListener('click', onSegClick);
      bar.appendChild(seg);
    }

    // render({ visible, mode }) — visible=false hides the whole bar (byte-clean
    // for non-TS/JS tabs and flag-off). mode marks the active segment.
    function render(opts) {
      if (disposed || !bar) return;
      const o = opts || {};
      if (!o.visible) {
        bar.classList.add('hidden');
        return;
      }
      build();
      bar.classList.remove('hidden');
      const mode = o.mode === 'exploded' ? 'exploded' : 'code';
      if (codeBtn) {
        codeBtn.classList.toggle('is-active', mode === 'code');
        codeBtn.setAttribute('aria-pressed', String(mode === 'code'));
      }
      if (explodeBtn) {
        explodeBtn.classList.toggle('is-active', mode === 'exploded');
        explodeBtn.setAttribute('aria-pressed', String(mode === 'exploded'));
      }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (seg && seg.parentNode) seg.parentNode.removeChild(seg);
      seg = null;
      codeBtn = null;
      explodeBtn = null;
      if (bar) bar.classList.add('hidden');
    }

    return { render, dispose };
  }

  return { createExplodeToggle };
});
