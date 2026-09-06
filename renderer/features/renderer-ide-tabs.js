/* renderer/features/renderer-ide-tabs.js - Workspace IDE open-file tab strip.
 * Pure markup builder + renderer over #ideTabStrip; click/keyboard intent is
 * delegated by the IDE controller. All button markup renders through the
 * inventory action-button primitive (no raw primitives in this file). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTabs = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function resolveActionButton() {
    if (typeof globalRef.inventoryActionButton === 'function') {
      return globalRef.inventoryActionButton;
    }
    if (typeof require === 'function') {
      try {
        return require('../inventory/action-button');
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  function fileNameOf(path) {
    const normalized = String(path || '');
    return normalized.split('/').pop() || normalized;
  }

  // The label a tab shows: diff/preview review surfaces carry an explicit
  // label (their path is a diff:// or preview:// id); file tabs show their
  // basename. Exported so the tab-strip controller's overflow quick-pick
  // resolves names through the same helper instead of re-deriving them.
  function tabDisplayName(tab) {
    if (tab.kind === 'diff' || tab.kind === 'preview') {
      return String(tab.label || (tab.kind === 'preview' ? 'Preview' : 'Diff'));
    }
    return fileNameOf(tab.path);
  }

  function createIdeTabStrip(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const escapeHtml = typeof deps?.escapeHtml === 'function'
      ? deps.escapeHtml
      : (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const actionButton = resolveActionButton();

    function buildTabMarkup(tab, { active, dirty, stale, pinned }) {
      if (!actionButton) {
        return '';
      }
      // Diff/preview review tabs carry a display label (their path is a
      // diff:// or preview:// id) and never show dirty/stale decorations -
      // they are read-only views.
      const isDiff = tab.kind === 'diff' || tab.kind === 'preview';
      const isTransientPreview = tab.kind === 'file' && tab.transientPreview === true;
      // Only real file tabs pin (review surfaces are session-scoped); the caller
      // already passes a normalized boolean.
      const isPinned = pinned && !isDiff;
      const name = tabDisplayName(tab);
      // Screen-reader label: a diff surface reads only "(diff view)"; a file tab
      // joins its state suffixes (stale takes precedence over dirty) so a pinned
      // unsaved tab reads "(unsaved changes, pinned)".
      let ariaLabel = name;
      if (isDiff) {
        ariaLabel = `${name} (diff view)`;
      } else {
        const states = [];
        if (stale) {
          states.push('changed on disk');
        } else if (dirty) {
          states.push('unsaved changes');
        }
        if (isPinned) {
          states.push('pinned');
        }
        if (isTransientPreview) {
          states.push('preview');
        }
        if (states.length) {
          ariaLabel = `${name} (${states.join(', ')})`;
        }
      }
      // A small inline pin glyph distinguishes a pinned tab; it precedes the
      // name and rides through the same trustedHtml path (no raw primitives).
      const pinGlyph = isPinned
        ? '<span class="ide-tab-pin" aria-hidden="true">'
          + '<svg viewBox="0 0 16 16" width="11" height="11" focusable="false">'
          + '<path d="M9.5 1.5l5 5-1.8.6-1.7 1.7-.4 3.2-1.3-1.3-3 3-.7-.7 3-3-1.3-1.3 3.2-.4'
          + ' 1.7-1.7.6-1.8z" fill="currentColor"></path></svg></span>'
        : '';
      const labelButton = actionButton({
        plain: true,
        className: 'ide-tab-label',
        role: 'tab',
        ariaSelected: active,
        // Every tab drives the single shared editor stage (role="tabpanel").
        ariaControls: 'ideEditorStage',
        tabIndex: active ? 0 : -1,
        title: isDiff ? name : stale ? `${tab.path} - changed on disk` : tab.path,
        dataset: { 'ide-tab-path': tab.path },
        trustedHtml: pinGlyph
          + `<span class="ide-tab-name">${escapeHtml(name)}</span>`
          + `<span class="ide-tab-dirty-dot" aria-hidden="true"></span>`,
        ariaLabel,
      });
      const closeButton = actionButton({
        plain: true,
        className: 'ide-tab-close',
        ariaLabel: `Close ${name}`,
        title: !isDiff && dirty ? `Close ${name} — discards unsaved changes (Ctrl+F4)` : `Close ${name} (Ctrl+F4)`,
        tabIndex: -1,
        dataset: { 'ide-tab-close': tab.path },
        trustedHtml: '<span aria-hidden="true">&times;</span>',
      });
      const flags = `${active ? ' ide-tab--active' : ''}${dirty && !isDiff ? ' ide-tab--dirty' : ''}`
        + `${stale && !isDiff ? ' ide-tab--stale' : ''}${isDiff ? ' ide-tab--diff' : ''}`
        + `${isPinned ? ' ide-tab--pinned' : ''}${isTransientPreview ? ' ide-tab--preview' : ''}`;
      // draggable: HTML5 DnD reorder handled by renderer-ide-tabs-controller.
      return `<div class="ide-tab${flags}" data-ide-tab="${escapeHtml(tab.path)}" draggable="true">${labelButton}${closeButton}</div>`;
    }

    // The "show all tabs" overflow control. Rendered (but CSS-hidden) whenever
    // any tab is open, and revealed only once the strip actually overflows -
    // see syncOverflow. A sticky-right button so it stays pinned to the visible
    // edge while the strip scrolls; the click intent is handled by the tab-strip
    // controller, which builds the quick-pick from the same openTabs list.
    function buildOverflowControl() {
      if (!actionButton) {
        return '';
      }
      return actionButton({
        plain: true,
        className: 'ide-tabstrip-overflow',
        ariaLabel: 'Show all open tabs',
        ariaHaspopup: 'menu',
        title: 'Show all open tabs',
        tabIndex: 0,
        dataset: { 'ide-tab-overflow': '' },
        trustedHtml: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">'
          + '<path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"'
          + ' stroke-linecap="round" stroke-linejoin="round"></path></svg>',
      });
    }

    // The overflow control markup never varies, so build it once per strip.
    const overflowControl = buildOverflowControl();

    // Toggle the overflow affordance and keep the active tab visible. Measured
    // with the affordance hidden (the class is dropped first) so the button's
    // own width never feeds back into the overflow decision. jsdom reports 0 for
    // both metrics unless a test stubs them, so the empty/non-overflow path is a
    // no-op under test - matching the live "no affordance, no layout shift" case.
    function syncOverflow(strip) {
      strip.classList.remove('ide-tabstrip--overflowing');
      const overflowing = (strip.scrollWidth || 0) > (strip.clientWidth || 0) + 1;
      strip.classList.toggle('ide-tabstrip--overflowing', overflowing);
      const active = strip.querySelector('.ide-tab--active');
      if (active && typeof active.scrollIntoView === 'function') {
        active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      }
    }

    function renderTabs({ openTabs = [], activeTabPath = '', dirtyByPath = {}, staleByPath = {} } = {}) {
      const strip = getDom().ideTabStrip || null;
      if (!strip) {
        return;
      }
      const tabsMarkup = openTabs
        .map((tab) => buildTabMarkup(tab, {
          active: tab.path === activeTabPath,
          dirty: dirtyByPath[tab.path] === true,
          stale: staleByPath[tab.path] === true,
          pinned: tab.pinned === true,
        }))
        .join('');
      // Append the overflow control only when tabs are present, so the empty
      // strip stays truly :empty (its transparent-border styling is unchanged).
      const markup = tabsMarkup + (openTabs.length ? overflowControl : '');
      if (strip.__jennyIdeTabsMarkup !== markup) {
        strip.innerHTML = markup;
        strip.__jennyIdeTabsMarkup = markup;
      }
      syncOverflow(strip);
    }

    return {
      renderTabs,
    };
  }

  return {
    createIdeTabStrip,
    tabDisplayName,
  };
});
