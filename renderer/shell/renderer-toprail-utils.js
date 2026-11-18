/* renderer/shell/renderer-toprail-utils.js – the title bar's view nav (UMD)
   Self-contained on purpose: the nav owns its own markup, click handling, and
   horizontal keyboard navigation (it is the sole view-switch nav; the legacy
   sidebar nav it replaced has been removed). Top chrome, one row: Home / Chat /
   Workspace / Team are text tabs in the title bar; Diagnostics and Settings are
   glyph buttons in the right cluster (#titlebarSettingsSlot), not tabs. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTopRailUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  // Single source of truth for rail order and numbered view shortcuts.
  // Memory management lives under Settings rather than as a primary view.
  var VIEW_TAB_ORDER = ['home', 'chat', 'ide', 'logs', 'settings'];
  // The rail's own order. Board (row 150, slice B4) and Team (row 123, slice 1g-2)
  // follow Workspace and are not in VIEW_TAB_ORDER: each exists only while its
  // model entry's `isAvailable()` says so, and Ctrl+1..5 keep their views. A tab
  // with `getBadge()` carries one count, patched in place so a new number never
  // rebuilds the rail.
  var RAIL_TAB_ORDER = ['home', 'chat', 'ide', 'board', 'team'];

  // 12-tooth cog, 1.6px stroke (the old glyph read as a sun).
  var GEAR_PATH = 'M10 2.5l1.1 1.9 2.1-.5.6 2.1 2.1.6-.5 2.1 1.9 1.1-1.9 1.1.5 2.1-2.1.6-.6 2.1-2.1-.5L10 17.5l-1.1-1.9-2.1.5-.6-2.1-2.1-.6.5-2.1L2.5 10l1.9-1.1-.5-2.1 2.1-.6.6-2.1 2.1.5z';
  // A pulse trace: the Diagnostics glyph.
  var PULSE_PATH = 'M2.5 10.5h3.2l2-5.5 3.6 10 2.2-4.5h4';

  function glyphMarkup(inner) {
    return '<svg class="titlebar-icon" viewBox="0 0 20 20" aria-hidden="true">' + inner + '</svg>';
  }

  // Views reached through a glyph button in the right cluster rather than a
  // tab, in drawn order (Ctrl+4 and Ctrl+5 still map here through
  // VIEW_TAB_ORDER). Each keeps its "<view>TopRailTab" id.
  var ICON_VIEWS = [
    {
      id: 'logs',
      className: 'titlebar-diagnostics-button',
      fallbackLabel: 'Diagnostics',
      domId: 'logsTopRailTab',
      title: function (label) { return jt('shell.topNav.diagnosticsTitle', '{label} (Ctrl+4)', { label: label }); },
      glyph: glyphMarkup('<path d="' + PULSE_PATH + '"/>'),
    },
    {
      id: 'settings',
      className: 'titlebar-settings-button',
      fallbackLabel: 'Settings',
      domId: 'settingsTopRailTab',
      title: function (label) { return jt('shell.topNav.settingsTitle', '{label} (Ctrl+5)', { label: label }); },
      glyph: glyphMarkup('<circle cx="10" cy="10" r="2.6"/><path d="' + GEAR_PATH + '"/>'),
    },
  ];

  function resolveActionButton() {
    if (typeof globalThis !== 'undefined' && typeof globalThis.inventoryActionButton === 'function') {
      return globalThis.inventoryActionButton;
    }
    if (typeof require === 'function') {
      try { return require('../inventory/action-button'); } catch (_error) { /* browser without the module */ }
    }
    return null;
  }

  function createTopRailController(deps) {
    const { state, staticModel } = deps;
    const { topRail, topRailTabs, topRailIndicator } = deps.dom;
    const {
      escapeHtml = (v) => String(v == null ? '' : v),
      setActiveView,
    } = deps.callbacks || {};
    const settingsSlot = deps.dom.settingsSlot
      || topRail?.ownerDocument?.getElementById?.('titlebarSettingsSlot')
      || null;

    const allRailTabs = RAIL_TAB_ORDER
      .map((id) => (staticModel.tabs || []).find((tab) => tab.id === id))
      .filter(Boolean);
    function currentRailTabs() {
      return allRailTabs.filter((tab) => typeof tab.isAvailable !== 'function' || tab.isAvailable() === true);
    }
    const iconViews = ICON_VIEWS
      .map((view) => ({ view, tab: (staticModel.tabs || []).find((tab) => tab.id === view.id) }))
      .filter((entry) => entry.tab);
    // view id -> its live button in the slot.
    const iconButtons = new Map();

    let _lastRailMarkup = null;
    // Remeasure the indicator on rail/tab resize and scroller movement.
    let _resizeObserver = null;
    let _indicatorRaf = 0;
    let _bound = false;
    let _suppressIndicatorTransition = false;

    // When the active view has no tab, keep tab zero as the sole
    // roving-tabindex stop.
    function resolveTabbable(hasMatch, isActive, index) {
      return hasMatch ? isActive : index === 0;
    }

    function isTabbableIndex(tabs, index) {
      const hasMatch = tabs.some((tab) => tab.id === state.ui.activeView);
      return resolveTabbable(hasMatch, tabs[index].id === state.ui.activeView, index);
    }

    function buildRailTabMarkup(tabs) {
      return tabs
        .map(
          (tab, index) => `
          <button
            class="toprail-tab"
            id="${escapeHtml(`${tab.id}TopRailTab`)}"
            type="button"
            data-tab-id="${escapeHtml(tab.id)}"
            role="tab"
            aria-selected="${tab.id === state.ui.activeView ? 'true' : 'false'}"
            aria-controls="${escapeHtml(`${tab.id}View`)}"
            tabindex="${isTabbableIndex(tabs, index) ? '0' : '-1'}"
          >
            <span class="toprail-tab__label">${escapeHtml(tab.label)}</span>${typeof tab.getBadge === 'function' ? '<span class="toprail-tab__count" aria-hidden="true" hidden></span>' : ''}
          </button>
        `
        )
        .join('');
    }

    // The count is drawn for sighted users and said through the tab's label and
    // tooltip ("Team: 1 person wants to join"); all are patched on the existing node.
    function syncBadges() {
      if (!topRailTabs) {
        return;
      }
      for (const tab of allRailTabs) {
        if (typeof tab.getBadge !== 'function') continue;
        const element = topRailTabs.querySelector(`.toprail-tab[data-tab-id="${tab.id}"]`);
        const countEl = element?.querySelector('.toprail-tab__count');
        if (!countEl) continue;
        const badge = tab.getBadge() || null;
        const count = badge && badge.count > 0 ? String(badge.count) : '';
        if (countEl.textContent !== count) countEl.textContent = count;
        countEl.hidden = !count;
        // The same words as the tooltip, for a pointer (plan row E39: the tooltip says what the number counts).
        if (count && badge.label) { element.setAttribute('aria-label', String(badge.label)); element.setAttribute('title', String(badge.label)); } else {
          element.removeAttribute('aria-label');
          element.removeAttribute('title');
        }
      }
    }

    function getRailTabElements() {
      return topRailTabs ? [...topRailTabs.querySelectorAll('.toprail-tab[data-tab-id]')] : [];
    }

    function updateIndicator() {
      if (!topRail || !topRailIndicator) {
        return;
      }
      const activeTab = getRailTabElements().find((tab) => tab.dataset.tabId === state.ui.activeView);
      const width = activeTab ? activeTab.offsetWidth : 0;
      if (!activeTab || !width) {
        // Layout not measurable (hidden rail, jsdom) — keep the CSS ::after fallback.
        // A tabless view (Diagnostics, Settings) must not leave the slider
        // under the last tab either.
        topRail.removeAttribute('data-indicator-ready');
        topRailIndicator.hidden = true;
        return;
      }
      topRail.setAttribute('data-indicator-ready', 'true');
      topRailIndicator.hidden = false;
      // Scroll/resize tracking must not animate — the slide transition is for
      // tab activation only; a scrolling underline that lags its tab reads as
      // drift, not motion.
      topRailIndicator.style.transition = _suppressIndicatorTransition ? 'none' : '';
      _suppressIndicatorTransition = false;
      // offsetLeft ignores the ≤719px tab scroller's scrollLeft, and the
      // indicator lives OUTSIDE that scroller (sibling in .toprail).
      const scrollLeft = topRailTabs ? (topRailTabs.scrollLeft || 0) : 0;
      topRailIndicator.style.width = `${width}px`;
      topRailIndicator.style.transform = `translateX(${activeTab.offsetLeft - scrollLeft}px)`;
    }

    // rAF-coalesced re-measure for continuous signals (scroll, resize), and
    // after a render with `slide` (a read inside a view switch forced a layout).
    function syncIndicatorToLayout(slide) {
      if (slide !== true) _suppressIndicatorTransition = true;
      const raf = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame.bind(window)
        : null;
      if (!raf) {
        updateIndicator();
        return;
      }
      if (_indicatorRaf) {
        return;
      }
      let ran = false; // a frame that runs at once must not leave its handle behind
      const handle = raf(() => {
        ran = true;
        _indicatorRaf = 0;
        updateIndicator();
      });
      if (!ran) _indicatorRaf = handle;
    }

    function observeRailLayout() {
      if (!_resizeObserver) {
        return;
      }
      _resizeObserver.disconnect();
      if (topRail) {
        _resizeObserver.observe(topRail);
      }
      // Per-tab observation: a label or font-scale change can resize one tab
      // without changing the flex container's own box.
      for (const tab of getRailTabElements()) {
        _resizeObserver.observe(tab);
      }
    }

    // The Diagnostics and Settings glyphs: inventory buttons in the right
    // cluster, each marked aria-current while its view is the active one.
    function renderIconButtons() {
      if (!settingsSlot || !iconViews.length) {
        return;
      }
      const live = iconViews.every(({ view }) => settingsSlot.contains(iconButtons.get(view.id) || null));
      if (!live) {
        const actionButton = resolveActionButton();
        if (!actionButton) {
          return;
        }
        unbindIconButtons();
        settingsSlot.innerHTML = iconViews.map(({ view, tab }) => {
          const label = String(tab.label || view.fallbackLabel);
          return actionButton({
            plain: true,
            domId: view.domId,
            className: `titlebar-icon-button ${view.className}`,
            ariaLabel: label,
            title: view.title(label),
            dataset: { 'tab-id': view.id },
            trustedHtml: view.glyph,
          });
        }).join('');
        for (const { view } of iconViews) {
          const button = settingsSlot.querySelector(`#${view.domId}`);
          if (!button) continue;
          button.addEventListener('click', handleIconClick);
          iconButtons.set(view.id, button);
        }
      }
      for (const [viewId, button] of iconButtons) {
        if (state.ui.activeView === viewId) {
          button.setAttribute('aria-current', 'page');
        } else {
          button.removeAttribute('aria-current');
        }
      }
    }

    function handleIconClick(event) {
      activateRailTab(event.currentTarget.dataset.tabId);
    }

    function unbindIconButtons() {
      for (const button of iconButtons.values()) {
        button.removeEventListener('click', handleIconClick);
      }
      iconButtons.clear();
    }

    function renderTopRail() {
      renderIconButtons();
      if (!topRailTabs) {
        return;
      }
      const markup = buildRailTabMarkup(currentRailTabs());
      if (markup !== _lastRailMarkup) {
        // A rebuild (a tab came or went) keeps keyboard focus on the tab that had it.
        const doc = topRailTabs.ownerDocument;
        const focused = doc && topRailTabs.contains(doc.activeElement) ? doc.activeElement : null;
        const focusedId = focused ? focused.id : '';
        topRailTabs.innerHTML = markup;
        _lastRailMarkup = markup;
        if (focused) {
          const again = (focusedId && doc.getElementById(focusedId))
            || getRailTabElements().find((tab) => tab.tabIndex === 0) || null;
          again?.focus?.();
        }
        observeRailLayout(); // rebuilt nodes — re-observe the new tab elements
      } else {
        // Cheap sync when only the active view changed; resolveTabbable()
        // keeps the tabless-view fallback (tab 0 stays the one reachable
        // roving-tabindex stop) identical to the full-markup build above.
        const elements = getRailTabElements();
        const hasMatch = elements.some((tab) => tab.dataset.tabId === state.ui.activeView);
        // Writes only what changed: a tabindex write costs a style pass.
        elements.forEach((tab, index) => {
          const isActive = tab.dataset.tabId === state.ui.activeView;
          const selected = isActive ? 'true' : 'false';
          const tabindex = resolveTabbable(hasMatch, isActive, index) ? '0' : '-1';
          if (tab.getAttribute('aria-selected') !== selected) tab.setAttribute('aria-selected', selected);
          if (tab.getAttribute('tabindex') !== tabindex) tab.setAttribute('tabindex', tabindex);
        });
      }
      syncBadges();
      syncIndicatorToLayout(true);
    }

    // Returns false when no matching rail tab exists so callers can use their fallback.
    function focusRailTab(tabId) {
      const targetId = String(tabId || '').trim();
      if (!targetId) {
        return false;
      }
      const target = iconButtons.get(targetId)
        || getRailTabElements().find((tab) => tab.dataset.tabId === targetId);
      if (!target) {
        return false;
      }
      window.requestAnimationFrame(() => { target.focus(); });
      return true;
    }

    function activateRailTab(tabId) {
      // The view already showing: a switch would only redraw it.
      if (tabId === state.ui.activeView) {
        focusRailTab(tabId);
        return;
      }
      if (typeof setActiveView === 'function') {
        setActiveView(tabId);
      }
      // For a host whose setActiveView does not render the rail.
      if (!getRailTabElements().some((tab) => tab.dataset.tabId === tabId && tab.getAttribute('aria-selected') === 'true')) {
        renderTopRail();
      }
      focusRailTab(tabId);
    }

    // Arrows, Home and End move focus; Enter or Space opens (opening on every
    // arrow built each area on the way past).
    function moveRailFocus(tabs, nextTab) {
      tabs.forEach((tab) => { tab.tabIndex = tab === nextTab ? 0 : -1; });
      nextTab.focus();
    }

    function handleRailClick(event) {
      const tabButton = event.target.closest('.toprail-tab[data-tab-id]');
      if (!tabButton) {
        return;
      }
      activateRailTab(tabButton.dataset.tabId);
    }

    function handleRailKeydown(event) {
      const currentTab = event.target.closest('.toprail-tab[data-tab-id]');
      if (!currentTab) {
        return;
      }
      const tabs = getRailTabElements();
      if (!tabs.length) {
        return;
      }
      const currentIndex = Math.max(tabs.indexOf(currentTab), 0);
      let nextIndex;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        nextIndex = (currentIndex + 1) % tabs.length;
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = tabs.length - 1;
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateRailTab(currentTab.dataset.tabId);
        return;
      } else {
        return;
      }
      event.preventDefault();
      const nextTab = tabs[nextIndex];
      if (nextTab) {
        moveRailFocus(tabs, nextTab);
      }
    }

    function setTopRailVisible(visible) {
      if (!topRail) {
        return;
      }
      topRail.classList.toggle('hidden', !visible);
      if (visible) {
        renderTopRail();
      }
    }

    function bind() {
      if (_bound || !topRailTabs) {
        return;
      }
      _bound = true;
      topRailTabs.addEventListener('click', handleRailClick);
      topRailTabs.addEventListener('keydown', handleRailKeydown);
      topRailTabs.addEventListener('scroll', syncIndicatorToLayout, { passive: true });
      const ResizeObserverRef = typeof window !== 'undefined' ? window.ResizeObserver : undefined;
      if (typeof ResizeObserverRef === 'function') {
        _resizeObserver = new ResizeObserverRef(syncIndicatorToLayout);
        observeRailLayout();
      }
    }

    function dispose() {
      if (!_bound || !topRailTabs) {
        return;
      }
      _bound = false;
      topRailTabs.removeEventListener('click', handleRailClick);
      topRailTabs.removeEventListener('keydown', handleRailKeydown);
      topRailTabs.removeEventListener('scroll', syncIndicatorToLayout);
      unbindIconButtons();
      if (_resizeObserver) {
        _resizeObserver.disconnect();
        _resizeObserver = null;
      }
      if (_indicatorRaf && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(_indicatorRaf);
      }
      _indicatorRaf = 0;
    }

    return {
      renderTopRail,
      setTopRailVisible,
      focusRailTab,
      syncBadges,
      updateIndicator,
      bind,
      dispose,
    };
  }

  return { createTopRailController, VIEW_TAB_ORDER, RAIL_TAB_ORDER };
});
