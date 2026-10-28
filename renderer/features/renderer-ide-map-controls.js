/* renderer/features/renderer-ide-map-controls.js - the Workspace File Map's
 * controls bar for the Living Atlas rework: the Atlas | Components lens
 * switch (row 77 phase 3), a search field, three toggleable
 * layer chips (Activity / Health / Deps), the "Hide tests" toggle (with a
 * "N tests" / "N hidden" readout), a flexible spacer, and Generate/Refresh/
 * Overview action buttons plus a transient-over-persistent status slot. Pure
 * presentation + callbacks — no scan/graph/camera logic lives here (that
 * stays in the controller). Built exclusively from inventory primitives
 * (textField/toggleSwitch/actionButton/statusRow) so it passes
 * check_no_raw_html_primitives.py.
 *
 * The search field does NOT filter nodes out of the canvas — the atlas is a
 * zoomable whole, not a filtered subset. It only emits search events; the
 * controller owns flying the camera to matches. Likewise the retired lens
 * select dropdown (Architecture / Size & cap) is gone: layering is now
 * three independent toggleable chips, not a mutually-exclusive mode.
 *
 * Renders into hostEl (expected class `ide-map-controls`; styles/
 * ide-file-map.css already gives it `pointer-events:none` with `auto` on
 * children so the bar never intercepts canvas panning — this module does not
 * touch pointer-events itself).
 *
 * ── Public interface — createMapControls(deps) → controller ─────────────────
 * deps:
 *   hostEl            (Element) mount point; innerHTML is fully owned here.
 *   onSearchChange    (fn?)     (searchText) => void. Debounced ~150ms; fires
 *                                as the user types.
 *   onSearchSubmit    (fn?)     (searchText) => void. Fires immediately (NOT
 *                                debounced) when Enter is pressed in the
 *                                search field.
 *   onSearchClear     (fn?)     () => void. Fires when Escape is pressed in
 *                                the search field, AFTER the field's value has
 *                                been cleared.
 *   onLayerToggle     (fn?)     (name, pressed) => void. name is one of
 *                                'activity'|'health'|'deps'; pressed is the
 *                                chip's new boolean state.
 *   onHideTestsChange (fn?)     (checked:boolean) => void.
 *   onGenerate        (fn?)     () => void. "Generate" button.
 *   onRefresh         (fn?)     () => void. "Refresh" button.
 *   onOverviewToggle  (fn?)     () => void. "Overview" button (P5 Project
 *                                Overview panel toggle).
 *   onLensChange      (fn?)     (lens) => void. 'atlas'|'components' from the
 *                                lens switch (not fired by setState).
 *   timers            (object?) { setTimeout, clearTimeout } — defaults to
 *                                window/global; injectable for fake-timer
 *                                tests (debounces the search input).
 *
 * controller methods:
 *   setState({search?,hideTests?,layers?,lens?})  Restores UI state (e.g. from
 *                                    persisted prefs) without re-firing the
 *                                    change callbacks. `layers` may be a
 *                                    partial object; omitted keys keep their
 *                                    current value.
 *   setTestCounts(hidden, total)    Updates the "Hide tests" readout (hidden =
 *                                    count currently hidden by the toggle, total
 *                                    = total test files found): empty for no
 *                                    tests, "N hidden" while some are hidden,
 *                                    else "1 test" / "N tests".
 *   setHasMap(hasMap)               While true a map is drawn, so the Generate
 *                                    button is hidden (Refresh stays); false
 *                                    shows it again. Survives re-renders.
 *   setStatus(message, opts?)       Shows a transient status chip in the bar
 *                                    (opts: { tone?, spinner?, autoClearMs? }).
 *                                    Empty/absent message clears it. Used for
 *                                    "Rescanning…" / "Map updated · …" feedback
 *                                    — deliberately NOT the full-screen state
 *                                    overlay, so a refresh never blanks the
 *                                    drawn map.
 *   clearStatus()                   Clears the status chip.
 *   setPersistentStatus(message)    Sets the partial-map disclosure shown
 *                                    whenever no transient message is active.
 *   clearPersistentStatus()         Clears that persistent disclosure.
 *   setOverviewPressed(pressed)     Reflects the Overview panel's open state on
 *                                    the Overview button via aria-pressed.
 *   focusSearch()                   Focuses the search field.
 *   dispose()                       Removes listeners + clears hostEl.
 *                                    Idempotent.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapControls = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

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

  const textField = resolveModule('inventoryTextField', '../inventory/text-field');
  const toggleSwitchModule = resolveModule('inventoryToggleSwitch', '../inventory/toggle-switch');
  const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
  const statusRow = resolveModule('inventoryStatusRow', '../inventory/status-row');
  const segmentedControl = resolveModule('inventorySegmentedControl', '../inventory/segmented-control');

  const SEARCH_DEBOUNCE_MS = 150;

  const LAYER_DEFS = [
    { name: 'activity', label: jt('ide.map.layers.activity', 'Activity') },
    { name: 'health', label: jt('ide.map.layers.health', 'Health') },
    { name: 'deps', label: jt('ide.map.layers.dependencies', 'Deps') },
  ];
  const LAYER_NAMES = new Set(LAYER_DEFS.map((def) => def.name));

  // Same defaults as renderer-ide-map-prefs.js's DEFAULT_PREFS — mirrored
  // here so the bar renders a sensible state before the controller's first
  // setState() (restored prefs) lands.
  const DEFAULT_LAYERS = { activity: true, health: false, deps: true };
  const LENSES = new Set(['atlas', 'components']);
  const LENS_SWITCH_ID = 'ide-map-lens';

  function createMapControls(deps) {
    const d = deps || {};
    const hostEl = d.hostEl || null;
    const onSearchChange = typeof d.onSearchChange === 'function' ? d.onSearchChange : noop;
    const onSearchSubmit = typeof d.onSearchSubmit === 'function' ? d.onSearchSubmit : noop;
    const onSearchClear = typeof d.onSearchClear === 'function' ? d.onSearchClear : noop;
    const onLayerToggle = typeof d.onLayerToggle === 'function' ? d.onLayerToggle : noop;
    const onHideTestsChange = typeof d.onHideTestsChange === 'function' ? d.onHideTestsChange : noop;
    const onGenerate = typeof d.onGenerate === 'function' ? d.onGenerate : noop;
    const onRefresh = typeof d.onRefresh === 'function' ? d.onRefresh : noop;
    const onOverviewToggle = typeof d.onOverviewToggle === 'function' ? d.onOverviewToggle : noop;
    const onLensChange = typeof d.onLensChange === 'function' ? d.onLensChange : noop;
    const timers = d.timers || globalThis;

    let disposed = false;
    let state = { search: '', hideTests: false, layers: { ...DEFAULT_LAYERS }, lens: 'atlas' };
    let searchDebounceId = null;
    let transientStatus = { text: '', tone: 'default', spinner: false };
    let persistentStatus = { text: '', tone: 'warning', spinner: false };
    let statusClearId = null;
    let overviewPressed = false;
    let hasMap = false;
    let testCountText = '';

    let searchInputEl = null;
    let toggleCountEl = null;

    function render() {
      if (!hostEl) return;
      const parts = [];
      if (typeof segmentedControl === 'function') {
        parts.push(segmentedControl({
          id: LENS_SWITCH_ID,
          className: 'inv-segmented--compact ide-map-lens',
          ariaLabel: jt('ide.map.lens.label', 'Map view'),
          value: state.lens,
          options: [
            { value: 'atlas', label: jt('ide.map.lens.atlas', 'Atlas') },
            { value: 'components', label: jt('ide.map.lens.components', 'Components') },
          ],
        }));
      }
      if (typeof textField === 'function') {
        parts.push(textField({
          id: 'ide-map-search',
          value: state.search,
          placeholder: jt('ide.map.searchPlaceholder', 'Search files…'),
          className: 'ide-map-search',
          ariaLabel: jt('ide.map.searchLabel', 'Search files'),
        }));
      }
      if (typeof actionButton === 'function') {
        const chips = LAYER_DEFS.map((def) => actionButton({
          id: `layer-${def.name}`,
          label: def.label,
          plain: true,
          className: 'ide-map-layer-chip',
          ariaPressed: state.layers[def.name] === true,
        })).join('');
        parts.push(`<div class="ide-map-layers">${chips}</div>`);
      }
      if (toggleSwitchModule && typeof toggleSwitchModule.toggleSwitch === 'function') {
        parts.push(''
          + '<span class="ide-map-hide-tests">'
          + toggleSwitchModule.toggleSwitch({
            id: 'ide-map-hide-tests',
            label: jt('ide.map.hideTests', 'Hide tests'),
            checked: state.hideTests,
          })
          + '<span class="ide-map-hide-tests-count" data-map-hide-tests-count></span>'
          + '</span>');
      }
      parts.push('<div class="ide-map-controls-spacer"></div>');
      if (typeof actionButton === 'function') {
        parts.push(actionButton({
          id: 'generate',
          label: jt('ide.map.generate', 'Generate'),
          variant: 'primary',
          className: 'ide-map-generate',
        }));
        parts.push(actionButton({
          id: 'refresh',
          label: jt('common.refresh', 'Refresh'),
          className: 'ide-map-refresh',
        }));
        parts.push(actionButton({
          id: 'overview',
          label: jt('ide.map.overview', 'Overview'),
          className: 'ide-map-overview-toggle',
        }));
      }
      // Transient status chip (Rescanning… / Map updated · …). A stable slot
      // the setStatus seam fills; kept out of the full-screen state overlay so
      // a refresh never blanks the drawn map.
      parts.push('<span class="ide-map-status-slot" data-map-status-slot></span>');
      hostEl.innerHTML = parts.join('');
      bindElements();
      // Re-apply status chrome that lives outside `state` so it survives the
      // innerHTML rebuild a setState()/render() performs.
      applyStatusToSlot();
      applyOverviewPressed();
      applyHasMap();
      if (toggleCountEl) toggleCountEl.textContent = testCountText;
    }

    function bindElements() {
      if (!hostEl) return;
      searchInputEl = hostEl.querySelector('.ide-map-search .inv-text-field-control');
      toggleCountEl = hostEl.querySelector('[data-map-hide-tests-count]');
    }

    function applyStatusToSlot() {
      if (!hostEl) return;
      const slot = hostEl.querySelector('[data-map-status-slot]');
      if (!slot) return;
      const status = transientStatus.text ? transientStatus : persistentStatus;
      if (!status.text) {
        slot.innerHTML = '';
        return;
      }
      if (typeof statusRow === 'function') {
        slot.innerHTML = statusRow({
          tone: status.tone,
          message: status.text,
          spinner: status.spinner,
          compact: true,
          ariaLive: 'polite',
          className: 'ide-map-status',
        });
      } else {
        slot.textContent = status.text;
      }
    }

    function applyOverviewPressed() {
      if (!hostEl) return;
      const btn = hostEl.querySelector('[data-action="overview"]');
      if (btn) btn.setAttribute('aria-pressed', overviewPressed ? 'true' : 'false');
    }

    // Generate is a no-op once a map is drawn (it returns the cached graph),
    // so it is hidden while one exists; Refresh stays.
    function applyHasMap() {
      if (!hostEl) return;
      const btn = hostEl.querySelector('[data-action="generate"]');
      if (btn) btn.hidden = hasMap;
    }

    function setHasMap(next) {
      if (disposed) return;
      hasMap = next === true;
      applyHasMap();
    }

    function setStatus(message, opts) {
      if (disposed) return;
      const o = opts || {};
      transientStatus = {
        text: message == null ? '' : String(message),
        tone: o.tone || 'default',
        spinner: o.spinner === true,
      };
      applyStatusToSlot();
      if (statusClearId != null) {
        timers.clearTimeout(statusClearId);
        statusClearId = null;
      }
      if (transientStatus.text && Number.isFinite(o.autoClearMs) && o.autoClearMs > 0) {
        statusClearId = timers.setTimeout(() => {
          statusClearId = null;
          clearStatus();
        }, o.autoClearMs);
      }
    }

    function clearStatus() {
      if (disposed) return;
      transientStatus = { text: '', tone: 'default', spinner: false };
      if (statusClearId != null) {
        timers.clearTimeout(statusClearId);
        statusClearId = null;
      }
      applyStatusToSlot();
    }

    function setPersistentStatus(message, opts) {
      if (disposed) return;
      const o = opts || {};
      persistentStatus = {
        text: message == null ? '' : String(message),
        tone: o.tone || 'warning',
        spinner: false,
      };
      applyStatusToSlot();
    }

    function clearPersistentStatus() {
      if (disposed) return;
      persistentStatus = { text: '', tone: 'warning', spinner: false };
      applyStatusToSlot();
    }

    function setOverviewPressed(pressed) {
      if (disposed) return;
      overviewPressed = pressed === true;
      applyOverviewPressed();
    }

    function handleSearchInput() {
      if (disposed || !searchInputEl) return;
      const value = searchInputEl.value;
      if (searchDebounceId != null) {
        timers.clearTimeout(searchDebounceId);
      }
      searchDebounceId = timers.setTimeout(() => {
        searchDebounceId = null;
        if (disposed) return;
        state = { ...state, search: value };
        onSearchChange(value);
      }, SEARCH_DEBOUNCE_MS);
    }

    function handleSearchKeydown(event) {
      if (disposed || !searchInputEl || event.target !== searchInputEl) return;
      if (event.key === 'Enter') {
        if (searchDebounceId != null) {
          timers.clearTimeout(searchDebounceId);
          searchDebounceId = null;
        }
        const value = searchInputEl.value;
        state = { ...state, search: value };
        onSearchSubmit(value);
      } else if (event.key === 'Escape') {
        if (searchDebounceId != null) {
          timers.clearTimeout(searchDebounceId);
          searchDebounceId = null;
        }
        searchInputEl.value = '';
        state = { ...state, search: '' };
        onSearchClear();
      }
    }

    function handleToggleClick(event) {
      const target = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-inv-toggle="ide-map-hide-tests"]')
        : null;
      if (!target || disposed) return;
      // toggle-switch's own delegated handler (if installed globally) may have
      // already flipped aria-checked; read the POST-click intended state by
      // inverting the current attribute (installToggleHandlers toggles on the
      // same click event, so by the time this bubbles here it may already be
      // flipped — guard by tracking our own state instead of trusting the DOM).
      const nextChecked = !state.hideTests;
      state = { ...state, hideTests: nextChecked };
      if (toggleSwitchModule && typeof toggleSwitchModule.toggle === 'function') {
        toggleSwitchModule.toggle(target, nextChecked);
      }
      onHideTestsChange(nextChecked);
    }

    function handleActionClick(event) {
      const target = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-action]')
        : null;
      if (!target || disposed) return;
      const action = target.getAttribute('data-action') || '';
      if (action === 'generate') {
        onGenerate();
      } else if (action === 'refresh') {
        onRefresh();
      } else if (action === 'overview') {
        onOverviewToggle();
      } else if (action.indexOf('layer-') === 0) {
        const name = action.slice('layer-'.length);
        if (!LAYER_NAMES.has(name)) return;
        const pressed = !state.layers[name];
        state = { ...state, layers: { ...state.layers, [name]: pressed } };
        target.setAttribute('aria-pressed', pressed ? 'true' : 'false');
        onLayerToggle(name, pressed);
      }
    }

    function handleLensChange(event) {
      const detail = event && event.detail;
      if (disposed || !detail || detail.id !== LENS_SWITCH_ID || !LENSES.has(detail.value)) return;
      if (detail.value === state.lens) return;
      state = { ...state, lens: detail.value };
      onLensChange(detail.value);
    }

    function bindEvents() {
      if (!hostEl || typeof hostEl.addEventListener !== 'function') return;
      if (segmentedControl && typeof segmentedControl.initSegmentedHandlers === 'function') {
        segmentedControl.initSegmentedHandlers(hostEl);
      }
      hostEl.addEventListener('inv-segmented-change', handleLensChange);
      hostEl.addEventListener('input', handleSearchInput);
      hostEl.addEventListener('keydown', handleSearchKeydown);
      hostEl.addEventListener('click', handleToggleClick);
      hostEl.addEventListener('click', handleActionClick);
    }
    function unbindEvents() {
      if (!hostEl || typeof hostEl.removeEventListener !== 'function') return;
      hostEl.removeEventListener('inv-segmented-change', handleLensChange);
      hostEl.removeEventListener('input', handleSearchInput);
      hostEl.removeEventListener('keydown', handleSearchKeydown);
      hostEl.removeEventListener('click', handleToggleClick);
      hostEl.removeEventListener('click', handleActionClick);
    }

    function setState(next) {
      if (disposed) return;
      const n = next || {};
      const nextLayers = n.layers && typeof n.layers === 'object' ? n.layers : {};
      state = {
        search: typeof n.search === 'string' ? n.search : state.search,
        hideTests: typeof n.hideTests === 'boolean' ? n.hideTests : state.hideTests,
        layers: {
          activity: typeof nextLayers.activity === 'boolean' ? nextLayers.activity : state.layers.activity,
          health: typeof nextLayers.health === 'boolean' ? nextLayers.health : state.layers.health,
          deps: typeof nextLayers.deps === 'boolean' ? nextLayers.deps : state.layers.deps,
        },
        lens: LENSES.has(n.lens) ? n.lens : state.lens,
      };
      render();
    }

    function setTestCounts(hidden, total) {
      if (disposed || !toggleCountEl) return;
      const h = Number.isFinite(Number(hidden)) ? Number(hidden) : 0;
      const t = Number.isFinite(Number(total)) ? Number(total) : 0;
      const fmt = (n) => n.toLocaleString(globalThis.jennyI18n?.tag?.());
      if (t <= 0) {
        testCountText = '';
      } else if (h > 0) {
        testCountText = jt('ide.map.hideTestsHidden', '{count} hidden', { count: fmt(h) });
      } else {
        testCountText = jtn('ide.map.hideTestsCount', t, { count: fmt(t) }, '{count} test', '{count} tests');
      }
      toggleCountEl.textContent = testCountText;
    }

    function focusSearch() {
      if (disposed || !searchInputEl || typeof searchInputEl.focus !== 'function') return;
      searchInputEl.focus();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (searchDebounceId != null) {
        timers.clearTimeout(searchDebounceId);
        searchDebounceId = null;
      }
      if (statusClearId != null) {
        timers.clearTimeout(statusClearId);
        statusClearId = null;
      }
      unbindEvents();
      if (hostEl) {
        hostEl.innerHTML = '';
      }
      searchInputEl = null;
      toggleCountEl = null;
    }

    render();
    bindEvents();

    return {
      setState,
      setTestCounts,
      setHasMap,
      setStatus,
      clearStatus,
      setPersistentStatus,
      clearPersistentStatus,
      setOverviewPressed,
      focusSearch,
      dispose,
    };
  }

  return { createMapControls };
});
