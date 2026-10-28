/**
 * renderer/shell/renderer-settings-search.js
 *
 * Settings search: a static, case-insensitive substring index built from the
 * section registry (group + section labels) and the field-copy map (toggle /
 * select label + description + host section). Sections lazy-load their DOM,
 * so the index deliberately never reads live markup — it is built once from
 * the two data sources that already describe every setting up front.
 *
 * Pure halves (buildSettingsSearchIndex: data -> index[]; searchSettingsIndex:
 * index + query -> ordered hits) stay apart from createSettingsSearchController
 * (box markup, rail filter, results list, keyboard nav, jump-and-flash).
 *
 * The merged skills section resolves to its Extensions host in the index;
 * `rawSectionId` keeps the original copy-map sectionId for reference.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-settings-section-registry'),
      require('./renderer-settings-field-copy'),
      require('../inventory/text-field'),
      require('../shared/async-fence')
    );
    return;
  }
  root.rendererSettingsSearch = factory(
    root.rendererSettingsSectionRegistry,
    root.rendererSettingsFieldCopy,
    root.inventoryTextField,
    root.rendererAsyncFence
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (sectionRegistry, fieldCopy, textField, asyncFence) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var registry = sectionRegistry || {};
  var copy = fieldCopy || {};

  function resolveHostSectionId(sectionId) {
    var id = String(sectionId || '').trim();
    return id && typeof registry.normalizeSettingsSectionId === 'function' ? registry.normalizeSettingsSectionId(id) : id;
  }

  function sectionLabel(sectionId) {
    var definition = typeof registry.getSettingsSectionDefinition === 'function'
      ? registry.getSettingsSectionDefinition(sectionId)
      : null;
    return (definition && definition.label) || sectionId;
  }

  // The lowercase text a query is matched against, built once per entry.
  function withHaystack(entry) {
    var keywords = Array.isArray(entry.keywords) ? entry.keywords.join(' ') : '';
    entry.haystack = [entry.label, entry.description, entry.sectionLabel, keywords]
      .map(function (part) { return String(part || ''); }).join(' ').toLowerCase();
    return entry;
  }

  /**
   * Build the static search index: one entry per section (matches on the
   * section's own label) plus one entry per field-copy toggle/select.
   * @returns {Array<{id:string,kind:'section'|'field',label:string,description:string,sectionId:string,rawSectionId:string,sectionLabel:string,haystack:string}>}
   */
  function buildSettingsSearchIndex() {
    var entries = [];
    var sections = typeof registry.getSettingsSections === 'function' ? registry.getSettingsSections() : [];
    for (var i = 0; i < sections.length; i++) {
      var section = sections[i];
      var hostId = resolveHostSectionId(section.id);
      entries.push(withHaystack({
        id: 'section:' + section.id,
        kind: 'section',
        label: section.label,
        description: '',
        sectionId: hostId,
        rawSectionId: section.id,
        sectionLabel: sectionLabel(hostId),
        keywords: Array.isArray(section.keywords) ? section.keywords : [],
      }));
    }
    var fields = typeof copy.listSettingsSearchEntries === 'function' ? copy.listSettingsSearchEntries()
      : (typeof copy.listSettingsFieldCopyEntries === 'function' ? copy.listSettingsFieldCopyEntries() : []);
    for (var j = 0; j < fields.length; j++) {
      var field = fields[j];
      var fieldHostId = resolveHostSectionId(field.sectionId);
      entries.push(withHaystack({
        id: field.id,
        kind: 'field',
        label: field.label,
        description: field.description || '',
        sectionId: fieldHostId,
        rawSectionId: field.sectionId,
        sectionLabel: sectionLabel(fieldHostId),
        keywords: field.keywords || [],
      }));
    }
    return entries;
  }

  function normalizeQuery(query) {
    return String(query == null ? '' : query).trim().toLowerCase();
  }

  /**
   * Match a query against a prebuilt index. Field hits are ordered before
   * section hits (fields are the more specific, more actionable result),
   * each group preserving index order; empty/whitespace query returns [].
   * @param {Array} index
   * @param {string} query
   * @returns {Array} ordered hit entries
   */
  function searchSettingsIndex(index, query) {
    var needle = normalizeQuery(query);
    if (!needle || !Array.isArray(index)) {
      return [];
    }
    var fieldHits = [];
    var sectionHits = [];
    for (var i = 0; i < index.length; i++) {
      var entry = index[i];
      if (entry.haystack.indexOf(needle) === -1) {
        continue;
      }
      if (entry.kind === 'field') {
        fieldHits.push(entry);
      } else {
        sectionHits.push(entry);
      }
    }
    return fieldHits.concat(sectionHits);
  }

  /** Distinct section ids (nav-reachable, already host-resolved) of a hit list. */
  function sectionIdsOfHits(hits) {
    var seen = Object.create(null);
    var ids = [];
    for (var i = 0; i < hits.length; i++) {
      var id = hits[i].sectionId;
      if (!id || seen[id]) {
        continue;
      }
      seen[id] = true;
      ids.push(id);
    }
    return ids;
  }

  /** Distinct section ids (nav-reachable, already host-resolved) hit by a query. */
  function searchSettingsSectionIds(index, query) {
    return sectionIdsOfHits(searchSettingsIndex(index, query));
  }

  // ── DOM wiring ─────────────────────────────────────────────────────────

  var SEARCH_INPUT_ID = 'settingsSearchInput';
  var SEARCH_RESULTS_ID = 'settingsSearchResults';
  var SEARCH_STATUS_ID = 'settingsSearchStatus';
  // Fallback only — the live timeout is derived from the computed
  // `settings-search-hit-fade` duration (var(--motion-duration-highlight)),
  // so preset scaling and reduced-motion zeroing stay in sync with CSS.
  var HIT_FLASH_MS = 2500;

  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  /** Markup for the search box + empty results list, meant for `.settings-nav-header`. */
  function buildSettingsSearchBoxMarkup() {
    var field = typeof textField === 'function'
      ? textField({
        id: SEARCH_INPUT_ID,
        ariaLabel: jt('settings.search.ariaLabel', 'Search settings'),
        placeholder: jt('settings.search.placeholder', 'Search settings…'),
        className: 'settings-search-input rail-search-field',
        dataset: { 'settings-search-input': 'true' },
      })
      : '<span class="settings-search-fallback"></span>';
    return ''
      + '<div class="settings-search" data-settings-search>'
      + field
      + '<ul class="settings-search-results" id="' + SEARCH_RESULTS_ID + '" role="listbox"'
      + ' aria-label="' + escapeHtml(jt('settings.search.resultsAria', 'Settings search results')) + '" hidden></ul>'
      // UIUX-038: a dedicated, always-present status region for the
      // no-results case -- kept OUT of the listbox (whose children must be
      // role="option") so it announces via aria-live without breaking the
      // listbox's expected structure. Empty text = nothing to announce.
      + '<p class="settings-search-status" id="' + SEARCH_STATUS_ID + '" role="status" aria-live="polite"></p>'
      + '</div>';
  }

  function buildResultItemMarkup(entry, index) {
    return '<li class="settings-search-result" role="option" id="settingsSearchResult-' + index + '"'
      + ' data-search-result-index="' + index + '" data-search-result-section="' + escapeHtml(entry.sectionId) + '"'
      + ' aria-selected="false">'
      + '<span class="settings-search-result-label">' + escapeHtml(entry.label) + '</span>'
      + '<span class="settings-search-result-section">' + escapeHtml(entry.sectionLabel) + '</span>'
      + '</li>';
  }

  /**
   * Wires the search box: filters nav-rail items to matching sections,
   * renders a flat results list, and activates + flashes the chosen row.
   * Pure-logic (index/match) stays in the functions above; this is DOM-only.
   */
  function createSettingsSearchController(deps) {
    var options = deps || {};
    var doc = options.documentRef || (typeof document !== 'undefined' ? document : null);
    var settingsNav = options.settingsNav || null;
    var navigateToSection = typeof options.navigateToSection === 'function' ? options.navigateToSection : function () {};
    // Queued-flash hardening: a lazy section renders only once its refresh
    // settles, so activateHit() defers the flash to that promise (flashing at
    // once blinks an empty card). Absent, the flash waits a single rAF.
    var getSectionRefreshPromise = typeof options.getSectionRefreshPromise === 'function'
      ? options.getSectionRefreshPromise
      : null;
    var getNavItems = typeof options.getNavItems === 'function'
      ? options.getNavItems
      : function () {
        return settingsNav ? [].slice.call(settingsNav.querySelectorAll('[data-settings-section]')) : [];
      };

    var index = buildSettingsSearchIndex();
    var inputEl = null;
    var resultsEl = null;
    var statusEl = null;
    var bound = false;
    var activeHits = [];
    var activeIndex = -1;
    // The result row painted active; renderResults repaints every row inactive.
    var highlightedIndex = -1;
    var flashTimer = null;
    var flashTarget = null;
    var clearFlashTimer = clearTimeout;
    var bindingFence = null;
    var bindingGate = asyncFence.createGenerationGate();
    var queuedAnimationFrames = [];

    // UIUX-038: `queryActive` (not sectionIds.length) decides whether an
    // allow-list is built at all: a blank query shows every item, while a
    // nonblank query that matched nothing gets an empty allow-list and hides
    // every item (it used to restore the full nav instead).
    function applyNavFilter(sectionIds, queryActive) {
      var items = getNavItems();
      var allow = queryActive ? Object.create(null) : null;
      if (allow) {
        for (var i = 0; i < (sectionIds || []).length; i++) {
          allow[sectionIds[i]] = true;
        }
      }
      for (var j = 0; j < items.length; j++) {
        var item = items[j];
        var id = item.getAttribute('data-settings-section');
        var visible = !allow || Boolean(allow[id]);
        item.classList.toggle('settings-nav-item-search-hidden', !visible);
      }
    }

    function clearNavFilter() {
      applyNavFilter(null, false);
    }

    // Ends the running flash: its timer and its target's hit mark.
    function stopFlash() {
      if (flashTimer) {
        clearFlashTimer(flashTimer);
        flashTimer = null;
      }
      if (flashTarget) {
        flashTarget.removeAttribute('data-search-hit');
        flashTarget = null;
      }
    }

    function findFieldTarget(fieldId) {
      var toggleTrack = doc.querySelector('[data-inv-toggle="' + fieldId + '"]');
      if (toggleTrack) return toggleTrack.closest('.settings-field') || toggleTrack.closest('.settings-field-row') || toggleTrack.closest('.inv-toggle') || toggleTrack;
      var target = doc.querySelector('[data-limits-line="' + fieldId + '"]') || doc.getElementById(fieldId) || doc.querySelector('[data-settings-field="' + fieldId + '"]');
      var row = target && (target.closest('.settings-field') || target);
      return row && row.closest('[hidden]') ? null : row;
    }

    function flashRow(sectionId, fieldId, rawSectionId) {
      stopFlash();
      if (!doc) {
        return;
      }
      var target = null;
      if (fieldId) {
        target = findFieldTarget(fieldId);
      }
      if (!target) {
        // A page folded into another is a group on its host page, or its own card under the host's.
        var ownId = rawSectionId || sectionId;
        target = doc.querySelector('[data-settings-merged-section="' + ownId + '"]')
          || doc.querySelector('.settings-card[data-settings-section="' + ownId + '"]:not([hidden])')
          || doc.querySelector('.settings-card[data-settings-section="' + sectionId + '"]');
      }
      if (!target) {
        return;
      }
      var fold = target.closest('details');
      if (fold) fold.open = true;
      if (typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'center' });
      }
      // Re-picking the row that still flashes restarts its fade: stopFlash
      // removed the mark, and the layout read commits that before it returns.
      void target.offsetWidth;
      target.setAttribute('data-search-hit', 'true');
      flashTarget = target;
      var win = (target.ownerDocument && target.ownerDocument.defaultView) || (typeof window !== 'undefined' ? window : null);
      var setTimer = win && typeof win.setTimeout === 'function' ? win.setTimeout : setTimeout;
      clearFlashTimer = win && typeof win.clearTimeout === 'function' ? win.clearTimeout : clearTimeout;
      var flashMs = HIT_FLASH_MS;
      if (win && typeof win.getComputedStyle === 'function') {
        // The target may run several animations (e.g. the active card's
        // scrim-in enter + the hit fade) — match durations by name so we
        // never time the clear off the wrong animation.
        var hitStyle = win.getComputedStyle(target);
        var hitNames = String(hitStyle.animationName || '').split(',');
        var hitDurations = String(hitStyle.animationDuration || '').split(',');
        for (var hitIdx = 0; hitIdx < hitNames.length; hitIdx++) {
          if (hitNames[hitIdx].trim() !== 'settings-search-hit-fade') {
            continue;
          }
          var hitSeconds = parseFloat(hitDurations[hitIdx] || hitDurations[0]);
          if (isFinite(hitSeconds)) {
            flashMs = hitSeconds > 0 ? hitSeconds * 1000 + 100 : 0;
          }
          break;
        }
      }
      flashTimer = setTimer(function () {
        flashTimer = null;
        stopFlash();
      }, flashMs);
    }

    // `rawQuery` is the trimmed query text, or '' for a cleared/blank query
    // -- distinguishing "no query yet" from "a real query matched nothing"
    // is exactly the UIUX-038 fix (see applyNavFilter's `queryActive` doc).
    function renderResults(hits, rawQuery) {
      activeHits = hits;
      activeIndex = hits.length ? 0 : -1;
      var queryActive = !!(rawQuery && rawQuery.trim());
      if (statusEl) {
        statusEl.textContent = (queryActive && !hits.length)
          ? jt('settings.search.noMatches', 'No settings match "{query}".', { query: rawQuery.trim() })
          : '';
      }
      if (!resultsEl) {
        return;
      }
      highlightedIndex = -1;
      if (!hits.length) {
        resultsEl.innerHTML = '';
        resultsEl.hidden = true;
        if (inputEl) {
          inputEl.removeAttribute('aria-activedescendant');
          inputEl.setAttribute('aria-expanded', 'false');
        }
        return;
      }
      resultsEl.innerHTML = hits.map(buildResultItemMarkup).join('');
      resultsEl.hidden = false;
      if (inputEl) inputEl.setAttribute('aria-expanded', 'true');
      highlightActiveResult();
    }

    function paintResultRow(row, isActive) {
      if (!row) {
        return;
      }
      row.classList.toggle('active', isActive);
      row.setAttribute('aria-selected', String(isActive));
    }

    // Repaints only the row leaving and the row taking the active state.
    function highlightActiveResult() {
      if (!resultsEl) {
        return;
      }
      var rows = resultsEl.children;
      paintResultRow(rows[highlightedIndex], false);
      paintResultRow(rows[activeIndex], true);
      highlightedIndex = activeIndex;
      if (inputEl) {
        if (activeIndex >= 0 && rows[activeIndex]) {
          inputEl.setAttribute('aria-activedescendant', rows[activeIndex].id);
        } else {
          inputEl.removeAttribute('aria-activedescendant');
        }
      }
    }

    // The host's pending refresh plus its companions' (a Skills hit lands
    // under Extensions): the flash waits for all of them.
    function pendingSectionRefresh(sectionId) {
      if (!getSectionRefreshPromise) {
        return null;
      }
      var ids = [sectionId].concat((registry.getSettingsCompanionSectionIds?.(sectionId) || []));
      var pending = ids.map(function (id) { return getSectionRefreshPromise(id); })
        .filter(function (promise) { return promise && typeof promise.then === 'function'; });
      if (pending.length < 2) {
        return pending[0] || null;
      }
      return Promise.all(pending.map(function (promise) { return Promise.resolve(promise).catch(function () {}); }));
    }

    function activateHit(hit) {
      if (!hit) {
        return;
      }
      // A pick closes the list so it no longer covers the page; the query and the nav filter stay.
      renderResults([], '');
      var token = bindingGate.capture();
      var activeFence = bindingFence;
      // A vetoed switch (unsaved personality changes) stays put: nothing to flash.
      if (navigateToSection(hit.sectionId) === false) {
        return;
      }
      var fieldId = hit.kind === 'field' ? hit.id : '';
      var win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
      var raf = win && typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame : function (cb) { cb(); };
      var cancelRaf = win && typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame : function () {};
      function queueFlash() {
        if (!activeFence || activeFence.isDisposed() || !bindingGate.isCurrent(token)) {
          return;
        }
        var frame = { handle: null, cancel: cancelRaf };
        queuedAnimationFrames.push(frame);
        frame.handle = raf(function () {
          var frameIndex = queuedAnimationFrames.indexOf(frame);
          if (frameIndex >= 0) queuedAnimationFrames.splice(frameIndex, 1);
          if (activeFence.isDisposed() || !bindingGate.isCurrent(token)) return;
          flashRow(hit.sectionId, fieldId, hit.rawSectionId);
        });
      }
      // navigateToSection() may have just kicked off (synchronously, via the
      // shell controller) the lazy section's refresh — check immediately
      // after so a still-pending promise is caught before this call returns.
      var pendingRefresh = pendingSectionRefresh(hit.sectionId);
      if (pendingRefresh) {
        Promise.resolve(pendingRefresh).then(queueFlash, queueFlash).catch(function () {});
        return;
      }
      queueFlash();
    }

    function runQuery(rawQuery) {
      var query = String(rawQuery == null ? '' : rawQuery);
      if (!query.trim()) {
        clearNavFilter();
        renderResults([], '');
        return;
      }
      var hits = searchSettingsIndex(index, query);
      // queryActive=true even with no hits: a real miss filters the nav to nothing (UIUX-038).
      applyNavFilter(sectionIdsOfHits(hits), true);
      renderResults(hits, query);
    }

    function handleInput(event) {
      runQuery(event && event.target ? event.target.value : '');
    }

    function handleFocus() {
      if (inputEl && resultsEl && resultsEl.hidden && inputEl.value.trim()) runQuery(inputEl.value);
    }

    function handleDocumentPointerDown(event) {
      var box = inputEl && inputEl.closest('[data-settings-search]');
      if (!resultsEl || resultsEl.hidden || (box && box.contains(event.target))) return;
      renderResults([], '');
    }

    function handleKeydown(event) {
      var key = event.key;
      if (key === 'ArrowDown') {
        event.preventDefault();
        if (activeHits.length) {
          activeIndex = (activeIndex + 1) % activeHits.length;
          highlightActiveResult();
        }
        return;
      }
      if (key === 'ArrowUp') {
        event.preventDefault();
        if (activeHits.length) {
          activeIndex = (activeIndex - 1 + activeHits.length) % activeHits.length;
          highlightActiveResult();
        }
        return;
      }
      if (key === 'Enter') {
        event.preventDefault();
        if (activeHits.length && activeIndex >= 0) {
          activateHit(activeHits[activeIndex]);
        }
        return;
      }
      if (key === 'Escape') {
        event.preventDefault();
        if (inputEl) {
          inputEl.value = '';
        }
        clearNavFilter();
        renderResults([], '');
      }
    }

    function handleResultsClick(event) {
      var item = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('.settings-search-result')
        : null;
      if (!item) {
        return;
      }
      var idx = Number(item.getAttribute('data-search-result-index'));
      var hit = activeHits[idx];
      if (hit) {
        activateHit(hit);
      }
    }

    function bind() {
      if (bound || !doc) {
        return;
      }
      inputEl = doc.getElementById(SEARCH_INPUT_ID);
      resultsEl = doc.getElementById(SEARCH_RESULTS_ID);
      statusEl = doc.getElementById(SEARCH_STATUS_ID); // optional -- older markup without it degrades to "no announcement"
      if (!inputEl || !resultsEl) {
        return;
      }
      bindingGate.bump();
      bindingFence = asyncFence.createDisposalFence();
      bound = true;
      inputEl.setAttribute('role', 'combobox');
      inputEl.setAttribute('aria-autocomplete', 'list');
      inputEl.setAttribute('aria-haspopup', 'listbox');
      inputEl.setAttribute('aria-controls', SEARCH_RESULTS_ID);
      inputEl.setAttribute('aria-describedby', SEARCH_STATUS_ID);
      inputEl.setAttribute('aria-expanded', 'false');
      inputEl.addEventListener('input', handleInput);
      inputEl.addEventListener('keydown', handleKeydown);
      inputEl.addEventListener('focus', handleFocus);
      resultsEl.addEventListener('click', handleResultsClick);
      doc.addEventListener('pointerdown', handleDocumentPointerDown, true);
    }

    function dispose() {
      if (!bound) {
        return;
      }
      bound = false;
      bindingGate.bump();
      bindingFence.dispose();
      bindingFence = null;
      if (inputEl) {
        inputEl.removeEventListener('input', handleInput);
        inputEl.removeEventListener('keydown', handleKeydown);
        inputEl.removeEventListener('focus', handleFocus);
      }
      doc.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      if (resultsEl) {
        resultsEl.removeEventListener('click', handleResultsClick);
      }
      stopFlash();
      while (queuedAnimationFrames.length) {
        var frame = queuedAnimationFrames.pop();
        frame.cancel(frame.handle);
      }
      clearNavFilter();
      inputEl = null;
      resultsEl = null;
      statusEl = null;
    }

    return {
      bind: bind,
      dispose: dispose,
      runQuery: runQuery,
      getIndex: function () { return index.slice(); },
      getActiveHits: function () { return activeHits.slice(); },
    };
  }

  return {
    buildSettingsSearchIndex: buildSettingsSearchIndex,
    searchSettingsIndex: searchSettingsIndex,
    searchSettingsSectionIds: searchSettingsSectionIds,
    buildSettingsSearchBoxMarkup: buildSettingsSearchBoxMarkup,
    createSettingsSearchController: createSettingsSearchController,
  };
});
