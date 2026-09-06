/* renderer/features/renderer-ide-map-states.js - the Workspace File Map's
 * state-panel renderer (idle / loading / empty / error / no-root),
 * copy + tone per WORKSPACE_FILE_MAP_PLAN.md "State machine
 * (renderer-ide-map-states.js)". Mirrors the three-state copy/tone convention
 * used by renderer-ide-search-panel.js (buildStatusMarkup) and
 * renderer-ide-tree.js, and is built exclusively from inventory components
 * (statusRow / spinner / actionButton) so it passes
 * scripts/checks/check_no_raw_html_primitives.py with zero exceptions.
 *
 * Public interface — createMapStates({ hostEl }):
 *   .render(stateName, payload)  Renders one of the five states into hostEl.
 *     stateName ∈ 'idle' | 'loading' | 'empty' | 'error' | 'no-root'
 *     payload:
 *       idle      — {} (no payload needed)
 *       loading   — {} (no payload needed)
 *       empty     — {} (no payload needed)
 *       error     — { message } — {message} interpolated into the copy.
 *       no-root   — {} (no payload needed)
 *   .clear()    Empties hostEl (removes any rendered state markup).
 *   .hide()     Hides hostEl (adds the 'hidden' class) without clearing it.
 *   .show()     Un-hides hostEl (removes the 'hidden' class).
 *   .dispose()  Removes delegated listeners and clears hostEl. Idempotent —
 *     safe to call multiple times or after the host element is gone.
 *
 * Callbacks (passed at construction, all optional, default to no-op):
 *   onGenerate()        — idle state's "Generate Map" action button.
 *   onRetry()           — error state's "Retry" action button (tone:'danger').
 *   onChooseFolder()     — no-root state's "Choose Folder" action button.
 *
 * Rendering is done via delegated click listeners on hostEl (data-map-state-
 * action dataset attribute), so repeated .render() calls (which replace
 * innerHTML) never leak listeners and never need per-render rebinding.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapStates = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  const statusRow = resolveModule('inventoryStatusRow', '../inventory/status-row');
  const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');

  function defaultEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  const VALID_STATES = new Set(['idle', 'loading', 'empty', 'error', 'no-root']);

  function buildActionMarkup(label, action, opts) {
    if (typeof actionButton !== 'function') {
      return '';
    }
    const o = opts || {};
    return actionButton({
      label,
      variant: o.tone === 'danger' ? 'danger' : 'primary',
      dataset: { 'map-state-action': action },
      className: 'ide-map-state-action',
    });
  }

  function buildStatusRowMarkup(opts) {
    if (typeof statusRow !== 'function') {
      return `<div class="ide-map-state-fallback">${defaultEscapeHtml(opts.message || '')}</div>`;
    }
    return statusRow({
      tone: opts.tone || 'default',
      message: opts.message || '',
      spinner: opts.spinner === true,
      compact: opts.compact === true,
      ariaLive: opts.ariaLive || 'polite',
      className: opts.className || '',
    });
  }

  function createMapStates(deps) {
    const d = deps || {};
    const hostEl = d.hostEl || null;
    const onGenerate = typeof d.onGenerate === 'function' ? d.onGenerate : noop;
    const onRetry = typeof d.onRetry === 'function' ? d.onRetry : noop;
    const onChooseFolder = typeof d.onChooseFolder === 'function' ? d.onChooseFolder : noop;

    let currentState = null;
    let disposed = false;

    function handleClick(event) {
      if (disposed) {
        return;
      }
      const target = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-map-state-action]')
        : null;
      if (!target) {
        return;
      }
      const action = target.getAttribute('data-map-state-action');
      if (action === 'generate') {
        onGenerate();
      } else if (action === 'retry') {
        onRetry();
      } else if (action === 'choose-folder') {
        onChooseFolder();
      }
    }

    if (hostEl && typeof hostEl.addEventListener === 'function') {
      hostEl.addEventListener('click', handleClick);
    }

    function buildIdleMarkup() {
      return ''
        + buildStatusRowMarkup({ message: 'Generate a map of this workspace.', tone: 'default' })
        + buildActionMarkup('Generate Map', 'generate');
    }

    function buildLoadingMarkup() {
      return buildStatusRowMarkup({ message: 'Building the map…', tone: 'pending', spinner: true });
    }

    function buildEmptyMarkup() {
      return buildStatusRowMarkup({ message: 'Workspace is empty — nothing to map.', tone: 'default' });
    }

    function buildErrorMarkup(payload) {
      // statusRow's message field is escaped internally, so pass the raw
      // string through here — escaping twice would double-encode entities.
      const message = String((payload && payload.message) || 'Unknown error.');
      return ''
        + buildStatusRowMarkup({ message: `Couldn't build the map. ${message}`, tone: 'danger' })
        + buildActionMarkup('Retry', 'retry', { tone: 'danger' });
    }

    function buildNoRootMarkup() {
      return ''
        + buildStatusRowMarkup({ message: 'Choose a workspace folder to map.', tone: 'default' })
        + buildActionMarkup('Choose Folder', 'choose-folder');
    }

    function markupFor(stateName, payload) {
      switch (stateName) {
        case 'idle': return buildIdleMarkup();
        case 'loading': return buildLoadingMarkup();
        case 'empty': return buildEmptyMarkup();
        case 'error': return buildErrorMarkup(payload);
        case 'no-root': return buildNoRootMarkup();
        default: return '';
      }
    }

    function render(stateName, payload) {
      if (disposed || !hostEl) {
        return;
      }
      if (!VALID_STATES.has(stateName)) {
        throw new Error(`renderer-ide-map-states: unknown state "${stateName}"`);
      }
      currentState = stateName;
      hostEl.innerHTML = markupFor(stateName, payload);
      // A rendered state must be visible, and a full state owns the whole
      // (opaque) panel — visibility is NOT left to the caller: the host is an
      // inset-0 opaque cover, so a shown-but-empty host silently blanks the
      // map underneath it.
      if (hostEl.classList) {
        hostEl.classList.remove('hidden');
      }
    }

    function clear() {
      if (disposed || !hostEl) {
        return;
      }
      hostEl.innerHTML = '';
      currentState = null;
      // No state to show → the opaque cover must get out of the map's way.
      if (hostEl.classList) {
        hostEl.classList.add('hidden');
      }
    }

    function hide() {
      if (disposed || !hostEl || typeof hostEl.classList === 'undefined') {
        return;
      }
      hostEl.classList.add('hidden');
    }

    function show() {
      if (disposed || !hostEl || typeof hostEl.classList === 'undefined') {
        return;
      }
      hostEl.classList.remove('hidden');
    }

    function dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (hostEl && typeof hostEl.removeEventListener === 'function') {
        hostEl.removeEventListener('click', handleClick);
      }
      if (hostEl) {
        hostEl.innerHTML = '';
      }
      currentState = null;
    }

    return {
      render,
      clear,
      hide,
      show,
      dispose,
      get currentState() {
        return currentState;
      },
    };
  }

  return { createMapStates };
});
