/* renderer/shell/renderer-toprail-utils.js – horizontal top navigation rail (UMD)
   Self-contained on purpose: the rail owns its own markup, click handling, and
   horizontal keyboard navigation (it is the sole view-switch nav; the legacy
   sidebar nav it replaced has been removed). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTopRailUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Single source of truth for rail order and numbered view shortcuts.
  // Memory management lives under Settings rather than as a primary view.
  var VIEW_TAB_ORDER = ['home', 'chat', 'ide', 'logs', 'settings'];

  function getTopRailIconMarkup(tabId) {
    switch (String(tabId || '').trim().toLowerCase()) {
      case 'home':
        return '<svg class="toprail-tab__icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 9.5L10 3l7 6.5V17a1 1 0 01-1 1H4a1 1 0 01-1-1z"/></svg>';
      case 'ide':
        return '<svg class="toprail-tab__icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5.5L3.5 10 7 14.5M13 5.5l3.5 4.5-3.5 4.5"/></svg>';
      case 'logs':
        return '<svg class="toprail-tab__icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6l4 4-4 4"/><path d="M10 14h6"/></svg>';
      case 'settings':
        return '<svg class="toprail-tab__icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="2.5"/><path d="M10 3v1.5M10 15.5V17M3 10h1.5M15.5 10H17M5.05 5.05l1.06 1.06M13.89 13.89l1.06 1.06M5.05 14.95l1.06-1.06M13.89 6.11l1.06-1.06"/></svg>';
      case 'chat':
      default:
        return '<svg class="toprail-tab__icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4h12a1 1 0 011 1v8a1 1 0 01-1 1H7l-3 3V5a1 1 0 011-1z"/></svg>';
    }
  }

  function createTopRailController(deps) {
    const { state, staticModel } = deps;
    const { topRail, topRailTabs, topRailIndicator } = deps.dom;
    const {
      escapeHtml = (v) => String(v == null ? '' : v),
      setActiveView,
    } = deps.callbacks || {};

    const railTabs = VIEW_TAB_ORDER
      .map((id) => (staticModel.tabs || []).find((tab) => tab.id === id))
      .filter(Boolean);

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
            ${getTopRailIconMarkup(tab.id)}
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
        topRail.removeAttribute('data-indicator-ready');
        return;
      }
      topRail.setAttribute('data-indicator-ready', 'true');
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

    function renderTopRail() {
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
      const target = getRailTabElements().find((tab) => tab.dataset.tabId === targetId);
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

  return { createTopRailController, VIEW_TAB_ORDER };
});
