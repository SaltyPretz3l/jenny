/* renderer/shell/renderer-settings-nav-utils.js — Discord-style settings sidebar navigation. */
/* global window */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-settings-search'));
    return;
  }
  root.rendererSettingsNavUtils = factory(root.rendererSettingsSearch);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (settingsSearch) {

  var sectionRegistry = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsSectionRegistry)
    || (typeof require === 'function' ? require('./renderer-settings-section-registry') : null)
    || {};
  var searchUtils = settingsSearch
    || (typeof globalThis !== 'undefined' && globalThis.rendererSettingsSearch)
    || (typeof require === 'function' ? require('./renderer-settings-search') : null)
    || {};
  var STORAGE_KEY = sectionRegistry.SETTINGS_STORAGE_KEY || 'jenny.settings.activeSection';
  var DEFAULT_SECTION = sectionRegistry.DEFAULT_SETTINGS_SECTION || 'models';
  var escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  function createSettingsNavController(deps) {
    var state = deps.state;
    var settingsNav = deps.settingsNav;
    var settingsContentScroll = deps.settingsContentScroll;
    var onSectionChange = deps.onSectionChange || null;
    var beforeSectionChange = typeof deps.beforeSectionChange === 'function'
      ? deps.beforeSectionChange : null;
    var appendClientLog = typeof deps.appendClientLog === 'function'
      ? deps.appendClientLog
      : function noopAppendClientLog() {};
    var sectionPicker = settingsNav ? settingsNav.querySelector('#settingsNavPicker') : null;
    var bound = false;
    var navItemCache = null;
    var cardCache = null;
    // settings_search (default-ON, env-rollback JENNY_ENABLE_SETTINGS_SEARCH=0):
    // gates only the search-box DOM wiring below. The nav itself is unaffected
    // when the flag is off — createSettingsSearchController simply never binds.
    // Default-ON semantics must match the markup gate (`!== false`): a flag
    // payload that omits the key would otherwise render a search box that
    // never binds.
    var searchFeatureEnabled = Boolean(state && state.features && state.features.featureFlags)
      && state.features.featureFlags.settings_search !== false;
    var searchController = (searchFeatureEnabled && searchUtils && typeof searchUtils.createSettingsSearchController === 'function')
      ? searchUtils.createSettingsSearchController({
        settingsNav: settingsNav,
        navigateToSection: function (sectionId) {
          setActiveSection(sectionId);
        },
        getNavItems: function () { return getAllNavItems(); },
        getSectionRefreshPromise: typeof deps.getSectionRefreshPromise === 'function' ? deps.getSectionRefreshPromise : null,
      })
      : null;

    function isVisibleNode(node) {
      return Boolean(node)
        && !node.hidden
        && !node.classList.contains('hidden')
        && !node.closest('[hidden]');
    }

    function getSectionNavItem(sectionId) {
      var id = String(sectionId || '').trim();
      if (!id || !settingsNav) {
        return null;
      }
      return settingsNav.querySelector('[data-settings-section="' + id + '"]');
    }

    function resolveSectionId(sectionId) {
      // Merged sections resolve through the registry first, while empty or unknown
      // identifiers resolve to the default section.
      var id = typeof sectionRegistry.normalizeSettingsSectionId === 'function'
        ? sectionRegistry.normalizeSettingsSectionId(sectionId)
        : (String(sectionId || '').trim() || DEFAULT_SECTION);
      var item = getSectionNavItem(id);
      if (!item) {
        return DEFAULT_SECTION;
      }
      if (item.getAttribute('data-dev-only') === 'true' && (
        item.hidden || item.classList.contains('hidden')
      )) {
        return DEFAULT_SECTION;
      }
      // Feature-gated nav items (e.g. Plugins behind featureFlags.plugins) are
      // stamped data-feature-gated + hidden by their sibling controller while
      // the flag is off. A persisted/deep-linked id must not activate a card
      // whose nav item is absent — same contract as data-dev-only above.
      if (item.hasAttribute('data-feature-gated') && (
        item.hidden || item.classList.contains('hidden')
      )) {
        return DEFAULT_SECTION;
      }
      return id;
    }

    function syncSectionPicker() {
      if (!sectionPicker) return;
      [].forEach.call(sectionPicker.options, function (option) {
        var item = getSectionNavItem(option.value);
        option.hidden = !isVisibleNode(item);
        option.disabled = option.hidden;
      });
      sectionPicker.value = resolveSectionId(state.ui.activeSettingsSection);
    }

    function handleSectionPickerChange() {
      setActiveSection(sectionPicker.value);
      syncSectionPicker();
      // Arrowing the picker changes the page on every step, and the new page takes
      // focus for its heading a frame later; queued behind that, the picker keeps it.
      window.requestAnimationFrame(function () {
        sectionPicker.focus({ preventScroll: true });
      });
    }

    function getAllNavItems() {
      if (!settingsNav) {
        return [];
      }
      if (!navItemCache) {
        navItemCache = [].slice.call(settingsNav.querySelectorAll('[data-settings-section]'));
      }
      return navItemCache.filter(function (item) {
        return isVisibleNode(item);
      });
    }

    function getAllCards() {
      if (!settingsContentScroll) {
        return [];
      }
      if (!cardCache) {
        cardCache = [].slice.call(settingsContentScroll.querySelectorAll('.settings-card[data-settings-section]'));
      }
      return cardCache.filter(function (card) {
        return isVisibleNode(card);
      });
    }

    function setActiveSection(sectionId) {
      var previousSectionId = state.ui.activeSettingsSection;
      var id = resolveSectionId(sectionId);
      if (id !== previousSectionId && beforeSectionChange && beforeSectionChange(id, previousSectionId) === false) {
        return false;
      }
      state.ui.activeSettingsSection = id;
      syncSectionPicker();

      var navItems = getAllNavItems();
      var activeNavItem = null;
      for (var i = 0; i < navItems.length; i++) {
        var item = navItems[i];
        var isActive = item.getAttribute('data-settings-section') === id;
        item.classList.toggle('active', isActive);
        item.setAttribute('aria-selected', String(isActive));
        item.setAttribute('tabindex', isActive ? '0' : '-1');
        if (isActive) activeNavItem = item;
      }
      var contentPanel = settingsContentScroll && settingsContentScroll.closest
        ? settingsContentScroll.closest('#settingsContentPanel')
        : null;
      if (contentPanel && activeNavItem && activeNavItem.id) {
        contentPanel.setAttribute('aria-labelledby', activeNavItem.id);
      }

      var activeCard = null;
      var cards = getAllCards();
      for (var j = 0; j < cards.length; j++) {
        var cardSectionId = cards[j].getAttribute('data-settings-section');
        cards[j].classList.toggle('settings-section-active', cardSectionId === id);
        if (cardSectionId === id) {
          activeCard = cards[j];
        }
      }

      if (settingsContentScroll) {
        settingsContentScroll.scrollTop = 0;
      }

      try {
        localStorage.setItem(STORAGE_KEY, id);
      } catch (error) {
        appendClientLog('WARN', 'settings.active_section_persist_failed', {
          section: id,
          message: error.message || String(error),
        });
      }

      if (id !== previousSectionId) {
        // Wait one frame: the active card just transitioned display:none→block
        // and isn't focusable yet. Re-check the active section inside the
        // callback so a rapid switch doesn't steal focus into a stale card.
        if (activeCard) {
          var heading = activeCard.querySelector('h3');
          if (heading) {
            window.requestAnimationFrame(function () {
              if (state.ui.activeSettingsSection === id) {
                heading.focus({ preventScroll: true });
              }
            });
          }
        }
        if (onSectionChange) {
          onSectionChange(id, previousSectionId);
        }
      }
      return true;
    }

    function restoreActiveSection() {
      var stored = DEFAULT_SECTION;
      try {
        stored = localStorage.getItem(STORAGE_KEY) || DEFAULT_SECTION;
      } catch (_) { /* storage blocked */ }

      setActiveSection(resolveSectionId(stored));
    }

    function focusNavItem(sectionId) {
      var targetId = resolveSectionId(sectionId);
      if (!targetId || !settingsNav) {
        return;
      }
      window.requestAnimationFrame(function () {
        var target = getSectionNavItem(targetId);
        if (isVisibleNode(target)) {
          target.focus();
        }
      });
    }

    /*
     * Section-level UI feedback. Pairs with [data-surface-state] tokens in
     * styles/settings-sections.css. Distinct from data-activity-state, which
     * the runtime activity system stamps on individual controls — this helper
     * is for section-card glow that the activity system doesn't reach.
     */
    var settleTimers = Object.create(null);
    function findSectionCard(sectionId) {
      var id = String(sectionId || '').trim();
      if (!id) {
        return null;
      }
      if (cardCache) {
        for (var i = 0; i < cardCache.length; i++) {
          if (cardCache[i].getAttribute('data-settings-section') === id) {
            return cardCache[i];
          }
        }
      }
      if (!settingsContentScroll) {
        return null;
      }
      return settingsContentScroll.querySelector('.settings-card[data-settings-section="' + id + '"]');
    }
    function markSectionState(sectionId, nextState, options) {
      var card = findSectionCard(sectionId);
      if (!card) {
        return;
      }
      var pendingTimer = settleTimers[sectionId];
      if (pendingTimer) {
        window.clearTimeout(pendingTimer);
        delete settleTimers[sectionId];
      }
      if (!nextState) {
        if (card.dataset.surfaceState !== undefined) {
          delete card.dataset.surfaceState;
        }
        return;
      }
      var nextValue = String(nextState);
      if (card.dataset.surfaceState !== nextValue) {
        card.dataset.surfaceState = nextValue;
      }
      var settleAfter = options && Number(options.settleAfter);
      if (settleAfter > 0) {
        settleTimers[sectionId] = window.setTimeout(function () {
          if (card.dataset.surfaceState === nextValue) {
            delete card.dataset.surfaceState;
          }
          delete settleTimers[sectionId];
        }, settleAfter);
      }
    }
    function setNavItemDirty(sectionId, dirty) {
      var item = getSectionNavItem(sectionId);
      if (!item) {
        return;
      }
      var isDirty = item.getAttribute('data-dirty') === 'true';
      if (dirty && !isDirty) {
        item.setAttribute('data-dirty', 'true');
      } else if (!dirty && isDirty) {
        item.removeAttribute('data-dirty');
      }
    }

    function handleSettingsNavKeydown(event) {
      if (event.target === sectionPicker) return;
      var currentItem = event.target.closest('[data-settings-section]');
      if (!currentItem || !settingsNav) {
        return;
      }
      var items = getAllNavItems();
      if (!items.length) {
        return;
      }
      var currentIndex = Math.max(items.indexOf(currentItem), 0);
      var nextIndex;

      if (event.key === 'ArrowDown') {
        nextIndex = (currentIndex + 1) % items.length;
      } else if (event.key === 'ArrowUp') {
        nextIndex = (currentIndex - 1 + items.length) % items.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = items.length - 1;
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setActiveSection(currentItem.getAttribute('data-settings-section'));
        focusNavItem(currentItem.getAttribute('data-settings-section'));
        return;
      } else {
        return;
      }

      event.preventDefault();
      var nextItem = items[nextIndex];
      if (!nextItem) {
        return;
      }
      setActiveSection(nextItem.getAttribute('data-settings-section'));
      focusNavItem(nextItem.getAttribute('data-settings-section'));
    }

    function handleSettingsNavClick(event) {
      var navItem = event.target.closest('[data-settings-section]');
      if (!navItem) {
        return;
      }
      setActiveSection(navItem.getAttribute('data-settings-section'));
    }

    function bind() {
      if (!settingsNav || bound) {
        return;
      }
      bound = true;
      navItemCache = [].slice.call(settingsNav.querySelectorAll('[data-settings-section]'));
      cardCache = settingsContentScroll
        ? [].slice.call(settingsContentScroll.querySelectorAll('.settings-card[data-settings-section]'))
        : [];
      for (var k = 0; k < navItemCache.length; k++) {
        var sectionId = navItemCache[k].getAttribute('data-settings-section');
        if (!navItemCache[k].id && sectionId) {
          navItemCache[k].id = 'settingsNav-' + sectionId;
        }
        if (!navItemCache[k].hasAttribute('aria-controls')) {
          navItemCache[k].setAttribute('aria-controls', 'settingsContentPanel');
        }
        if (!navItemCache[k].hasAttribute('aria-keyshortcuts')) {
          navItemCache[k].setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown Home End Enter');
        }
      }
      // Make each section's h3 programmatically focusable so setActiveSection
      // can move focus to it for screen-reader announcement on switch.
      for (var c = 0; c < cardCache.length; c++) {
        var heading = cardCache[c].querySelector('h3');
        if (heading && !heading.hasAttribute('tabindex')) {
          heading.setAttribute('tabindex', '-1');
        }
      }
      syncSectionPicker();
      sectionPicker?.addEventListener('change', handleSectionPickerChange);
      // A page can be gated on or off while Settings is open; the picker re-reads the rail as it opens.
      sectionPicker?.addEventListener('pointerdown', syncSectionPicker);
      sectionPicker?.addEventListener('focus', syncSectionPicker);
      settingsNav.addEventListener('keydown', handleSettingsNavKeydown);
      settingsNav.addEventListener('click', handleSettingsNavClick);
      searchController?.bind?.();
    }

    function dispose() {
      if (!settingsNav || !bound) {
        return;
      }
      bound = false;
      navItemCache = null;
      cardCache = null;
      sectionPicker?.removeEventListener('change', handleSectionPickerChange);
      sectionPicker?.removeEventListener('pointerdown', syncSectionPicker);
      sectionPicker?.removeEventListener('focus', syncSectionPicker);
      settingsNav.removeEventListener('keydown', handleSettingsNavKeydown);
      settingsNav.removeEventListener('click', handleSettingsNavClick);
      searchController?.dispose?.();
    }

    return {
      setActiveSection: setActiveSection,
      restoreActiveSection: restoreActiveSection,
      focusNavItem: focusNavItem,
      markSectionState: markSectionState,
      setNavItemDirty: setNavItemDirty,
      setNavItemBadge: function (sectionId, text, tone) { return setNavItemBadge(settingsNav, sectionId, text, tone); },
      bind: bind,
      dispose: dispose,
    };
  }

  /*
   * Registry-driven nav rendering. The left-rail markup is generated from the
   * section registry (the single source of truth for groups/order/labels) rather
   * than hand-authored in index.html, so the nav can never drift from the registry.
   * Must run BEFORE bootstrap-dom resolves the per-section nav-item ids
   * (usageSettingsNavItem, developerSettingsNavItem, …) — see renderer-bootstrap-utils.js.
   */
  function buildNavItemMarkup(section, options) {
    var isDefault = Boolean(options && options.isDefault);
    var classes = 'settings-nav-item';
    if (isDefault) { classes += ' active'; }
    var navItemId = section.navItemId || ('settingsNav-' + section.id);
    var idAttr = ' id="' + escapeHtml(navItemId) + '"';
    return '<button class="' + classes + '"' + idAttr
      + ' role="tab" aria-selected="' + (isDefault ? 'true' : 'false') + '"'
      + ' aria-controls="settingsContentPanel"'
      + (options && options.groupLabelId ? ' aria-describedby="' + escapeHtml(options.groupLabelId) + '"' : '')
      + ' tabindex="' + (isDefault ? '0' : '-1') + '"'
      + ' data-settings-section="' + escapeHtml(section.id) + '">'
      // Label span + fixed badge slot (empty at zero, so geometry never changes).
      + '<span class="settings-nav-item-label">' + escapeHtml(section.label) + '</span>'
      + '<span class="settings-nav-item-badge" data-tone=""></span></button>';
  }

  /* Paint or clear (empty text) the count badge on one nav item; `root` is any
   * node that can querySelector the rail. Idempotent, safe on every render pass. */
  function setNavItemBadge(root, sectionId, text, tone) {
    var id = String(sectionId || '').trim();
    var item = id && root && typeof root.querySelector === 'function'
      ? root.querySelector('.settings-nav-item[data-settings-section="' + id + '"]') : null;
    var slot = item ? item.querySelector('.settings-nav-item-badge') : null;
    if (!slot) return null;
    var nextText = String(text == null ? '' : text).trim();
    var nextTone = nextText && /^(warning|pending|success|danger)$/.test(String(tone || '').trim()) ? String(tone).trim() : '';
    if (slot.textContent !== nextText) slot.textContent = nextText;
    if (slot.getAttribute('data-tone') !== nextTone) slot.setAttribute('data-tone', nextTone);
    return slot;
  }

  /* A tablist may own tabs only. The group wrapper is presentational and the
   * group name is hidden as an element, then read with each tab as its
   * description, so the grouping is still announced. */
  function buildSettingsNavMarkup(groups, defaultSectionId) {
    return groups.map(function (group) {
      var labelId = 'settingsNavGroupLabel-' + group.id;
      var items = (group.sections || []).map(function (section) {
        return buildNavItemMarkup(section, { isDefault: section.id === defaultSectionId, groupLabelId: labelId });
      }).join('');
      return '<div class="settings-nav-group" role="presentation" data-settings-nav-group="' + escapeHtml(group.id) + '">'
        + '<div class="settings-nav-label" id="' + escapeHtml(labelId) + '" aria-hidden="true">' + escapeHtml(group.label) + '</div>'
        + items
        + '</div>';
    }).join('');
  }

  /*
   * `options.searchEnabled` gates the search-box markup injected into
   * `.settings-nav-header` (settings_search flag; default-ON — pass `false`
   * explicitly to roll back). renderSettingsNav runs at bootstrap before
   * `state` exists, so the caller resolves the flag and passes the boolean
   * through rather than this module reading state directly.
   */
  function renderSettingsNav(documentRef, options) {
    var doc = documentRef || (typeof globalThis !== 'undefined' ? globalThis.document : null);
    if (!doc || typeof doc.querySelector !== 'function') {
      return false;
    }
    var scroll = doc.querySelector('.settings-nav .settings-nav-scroll');
    if (!scroll) {
      return false;
    }
    var groups = typeof sectionRegistry.getSettingsGroups === 'function'
      ? sectionRegistry.getSettingsGroups()
      : [];
    if (!groups.length) {
      return false;
    }
    scroll.innerHTML = buildSettingsNavMarkup(groups, DEFAULT_SECTION);
    var searchEnabled = !(options && options.searchEnabled === false);
    var header = doc.querySelector('.settings-nav .settings-nav-header');
    if (header) {
      var inventory = (typeof globalThis !== 'undefined' && globalThis.inventory)
        || (typeof require === 'function' ? { selectField: require('../inventory/select-field') } : null);
      var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (key, fallback) { return fallback; };
      var existingPicker = header.querySelector('[data-settings-nav-picker]');
      existingPicker?.remove();
      header.insertAdjacentHTML('beforeend', '<div class="settings-nav-picker" data-settings-nav-picker>' + inventory.selectField({
        id: 'settingsNavPicker',
        ariaLabel: jt('settings.shell.sectionPickerLabel', 'Settings section'),
        value: DEFAULT_SECTION,
        options: groups.map(function (group) {
          return { label: group.label, options: group.sections.map(function (section) { return { value: section.id, label: section.label }; }) };
        }),
      }) + '</div>');
      var existingSearch = header.querySelector('[data-settings-search]');
      if (existingSearch) {
        existingSearch.parentNode.removeChild(existingSearch);
      }
      if (searchEnabled && searchUtils && typeof searchUtils.buildSettingsSearchBoxMarkup === 'function') {
        header.insertAdjacentHTML('beforeend', searchUtils.buildSettingsSearchBoxMarkup());
      }
    }
    return true;
  }

  return {
    createSettingsNavController: createSettingsNavController,
    buildSettingsNavMarkup: buildSettingsNavMarkup,
    renderSettingsNav: renderSettingsNav,
    setNavItemBadge: setNavItemBadge,
  };
});
