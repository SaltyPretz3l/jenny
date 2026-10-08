/* renderer/shell/renderer-toprail-utils.js – the title bar's view nav (UMD)
   Self-contained on purpose: the nav owns its own markup, click handling, and
   horizontal keyboard navigation (it is the sole view-switch nav; the legacy
   sidebar nav it replaced has been removed). Top chrome, one row: Home / Chat /
   Workspace / Diagnostics are text tabs in the title bar, and Settings is the
   gear in the right cluster (#titlebarSettingsSlot), not a tab. */
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
  // The view reached through the gear rather than a tab (Ctrl+5 still maps
  // here through VIEW_TAB_ORDER).
  var GEAR_VIEW_ID = 'settings';

  // 12-tooth cog, 1.6px stroke (the old glyph read as a sun).
  var GEAR_PATH = 'M10 2.5l1.1 1.9 2.1-.5.6 2.1 2.1.6-.5 2.1 1.9 1.1-1.9 1.1.5 2.1-2.1.6-.6 2.1-2.1-.5L10 17.5l-1.1-1.9-2.1.5-.6-2.1-2.1-.6.5-2.1L2.5 10l1.9-1.1-.5-2.1 2.1-.6.6-2.1 2.1.5z';

  function getSettingsGearMarkup(className) {
    return '<svg class="' + (className || 'titlebar-icon') + '" viewBox="0 0 20 20" aria-hidden="true">'
      + '<circle cx="10" cy="10" r="2.6"/><path d="' + GEAR_PATH + '"/></svg>';
  }

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

    const railTabs = VIEW_TAB_ORDER
      .filter((id) => id !== GEAR_VIEW_ID)
      .map((id) => (staticModel.tabs || []).find((tab) => tab.id === id))
      .filter(Boolean);
    const gearTab = (staticModel.tabs || []).find((tab) => tab.id === GEAR_VIEW_ID) || null;
    let gearButton = null;

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
            <span class="toprail-tab__label">${escapeHtml(tab.label)}</span>
          </button>
        `
        )
        .join('');
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
        // A tabless view (Settings is the gear) must not leave the slider
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

    // rAF-coalesced re-measure for continuous signals (scroll, resize).
    function syncIndicatorToLayout() {
      _suppressIndicatorTransition = true;
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
      _indicatorRaf = raf(() => {
        _indicatorRaf = 0;
        updateIndicator();
      });
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

    // The Settings gear: an inventory button in the right cluster, marked
    // aria-current while Settings is the active view.
    function renderGear() {
      if (!settingsSlot || !gearTab) {
        return;
      }
      if (!gearButton || !settingsSlot.contains(gearButton)) {
        const actionButton = resolveActionButton();
        if (!actionButton) {
          return;
        }
        const label = String(gearTab.label || 'Settings');
        settingsSlot.innerHTML = actionButton({
          plain: true,
          domId: 'settingsTopRailTab',
          className: 'titlebar-icon-button titlebar-settings-button',
          ariaLabel: label,
          title: jt('shell.topNav.settingsTitle', '{label} (Ctrl+5)', { label }),
          dataset: { 'tab-id': GEAR_VIEW_ID },
          trustedHtml: getSettingsGearMarkup('titlebar-icon'),
        });
        gearButton = settingsSlot.querySelector('#settingsTopRailTab');
        gearButton?.addEventListener('click', handleGearClick);
      }
      if (state.ui.activeView === GEAR_VIEW_ID) {
        gearButton?.setAttribute('aria-current', 'page');
      } else {
        gearButton?.removeAttribute('aria-current');
      }
    }

    function handleGearClick() {
      activateRailTab(GEAR_VIEW_ID);
    }

    function renderTopRail() {
      renderGear();
      if (!topRailTabs) {
        return;
      }
      const markup = buildRailTabMarkup(railTabs);
      if (markup !== _lastRailMarkup) {
        topRailTabs.innerHTML = markup;
        _lastRailMarkup = markup;
        observeRailLayout(); // rebuilt nodes — re-observe the new tab elements
      } else {
        // Cheap sync when only the active view changed; resolveTabbable()
        // keeps the tabless-view fallback (tab 0 stays the one reachable
        // roving-tabindex stop) identical to the full-markup build above.
        const elements = getRailTabElements();
        const hasMatch = elements.some((tab) => tab.dataset.tabId === state.ui.activeView);
        elements.forEach((tab, index) => {
          const isActive = tab.dataset.tabId === state.ui.activeView;
          tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
          tab.tabIndex = resolveTabbable(hasMatch, isActive, index) ? 0 : -1;
        });
      }
      updateIndicator();
    }

    // Returns false when no matching rail tab exists so callers can use their fallback.
    function focusRailTab(tabId) {
      const targetId = String(tabId || '').trim();
      if (!targetId) {
        return false;
      }
      const target = targetId === GEAR_VIEW_ID && gearButton
        ? gearButton
        : getRailTabElements().find((tab) => tab.dataset.tabId === targetId);
      if (!target) {
        return false;
      }
      window.requestAnimationFrame(() => { target.focus(); });
      return true;
    }

    function activateRailTab(tabId) {
      if (typeof setActiveView === 'function') {
        setActiveView(tabId);
      }
      renderTopRail();
      focusRailTab(tabId);
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
        activateRailTab(nextTab.dataset.tabId);
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
      gearButton?.removeEventListener('click', handleGearClick);
      gearButton = null;
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
      updateIndicator,
      bind,
      dispose,
    };
  }

  return { createTopRailController, VIEW_TAB_ORDER, getSettingsGearMarkup };
});
