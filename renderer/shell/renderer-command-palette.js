/* renderer/shell/renderer-command-palette.js — UMD
 * ⌘K / Ctrl+K command palette. Gated by state.features.featureFlags.command_palette
 * so the module is togglable with zero impact on Jenny's build.
 *
 * This file owns the state machine only — scoring, scopes, keyboard, open/close,
 * and overlay-manager registration. Result sources live in
 * renderer-command-palette-providers.js; row DOM and the keyed reconciler live
 * in renderer-command-palette-render.js.
 *
 * Overlay-manager integration (UIUX-019): fully registered with the shared
 * overlay stack (renderer-overlay-manager.js) when `overlayManager` is
 * injected -- open() pushes an entry (trapFocus: false, since the palette owns
 * its own Tab behavior: Tab cycles the scope), close() pops it, and Escape is
 * handled EXCLUSIVELY through the manager's onRequestClose so only the topmost
 * overlay on the shared stack ever reacts to a single Escape press. Escape is
 * never staged (clearing a scope first, closing second) for exactly that
 * reason -- Backspace on an empty query clears the scope instead. Absent a
 * manager, the palette falls back to its prior self-contained Escape handling.
 *
 * scoreMatch/highlightRanges are exported and reused verbatim by the IDE Quick
 * Open, symbol-nav, branch-switcher, and mention-autocomplete pickers -- their
 * signatures are load-bearing beyond this feature.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-command-palette-providers'),
      require('./renderer-command-palette-render')
    );
    return;
  }
  root.rendererCommandPaletteUtils = factory(
    root.rendererCommandPaletteProviders,
    root.rendererCommandPaletteRender
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (providersModule, renderModule) {
  'use strict';

  const providers = providersModule || {};
  const renderUtils = renderModule || {};
  const SCOPES = providers.SCOPES || [{ id: 'all', label: '', groups: null }];
  const SCOPE_PREFIXES = providers.SCOPE_PREFIXES || {};

  // Rows shown with no query (a curated landing list), and the hard render cap
  // for a query. The footer count always reports the true match total.
  const DEFAULT_ROW_CAP = 20;
  const MAX_ROW_CAP = 50;
  const MRU_DEPTH = 8;

  function isCommandPaletteEnabled(state) {
    if (state && state.features && state.features.featureFlags) {
      return state.features.featureFlags.command_palette === true;
    }
    return false;
  }

  function isWordBoundary(code) {
    // space, dash, slash, underscore
    return code === 32 || code === 45 || code === 47 || code === 95;
  }

  /* One consecutive-biased subsequence scan starting at `start`. Returns
     { score, ranges } or null. No allocations per char beyond the ranges. */
  function scanFrom(t, q, start) {
    let score = 0;
    let ti = start;
    let qi = 0;
    let lastMatchIndex = -2;
    const ranges = [];
    let rangeStart = -1;

    while (qi < q.length && ti < t.length) {
      if (t.charCodeAt(ti) === q.charCodeAt(qi)) {
        if (ti === 0) score += 8; // prefix bonus
        if (ti === lastMatchIndex + 1) score += 4; // consecutive bonus
        if (ti > 0 && isWordBoundary(t.charCodeAt(ti - 1))) score += 3; // word-boundary bonus
        score += 1;
        if (rangeStart < 0) rangeStart = ti;
        lastMatchIndex = ti;
        qi += 1;
      } else if (rangeStart >= 0) {
        ranges.push([rangeStart, ti]);
        rangeStart = -1;
      }
      ti += 1;
    }

    if (qi < q.length) return null;
    if (rangeStart >= 0) ranges.push([rangeStart, lastMatchIndex + 1]);
    // Shorter haystacks score slightly higher so "chat" beats "chat-thread-settings-pane".
    score += Math.max(0, 24 - t.length) * 0.1;
    return { score, ranges };
  }

  /* ── Subsequence scorer ──
     Returns { score, ranges } for the best of two candidate scans, or null.

     The single greedy scan this replaced never backtracked, so a later
     word-boundary start always lost to an earlier weak one: "cp" against
     "spec compare" matched the `c` inside "spec" and forfeited both the
     boundary and the consecutive bonuses. Trying the first word-boundary
     occurrence of the leading query char first fixes that whole class for one
     extra linear scan and no backtracking. */
  function scoreMatch(text, query) {
    const t = String(text || '').toLowerCase();
    const q = String(query || '').toLowerCase();
    if (!q) return { score: 0, ranges: [] };
    if (!t) return null;

    const head = q.charCodeAt(0);
    let boundaryStart = -1;
    for (let i = 1; i < t.length; i += 1) {
      if (t.charCodeAt(i) === head && isWordBoundary(t.charCodeAt(i - 1))) {
        boundaryStart = i;
        break;
      }
    }

    const greedy = scanFrom(t, q, 0);
    if (boundaryStart > 0) {
      const boundary = scanFrom(t, q, boundaryStart);
      if (boundary && (!greedy || boundary.score > greedy.score)) return boundary;
    }
    return greedy;
  }

  function highlightRanges(text, ranges, escapeHtml) {
    const esc = typeof escapeHtml === 'function' ? escapeHtml : (s) => String(s || '');
    if (!ranges || !ranges.length) return esc(text);
    const parts = [];
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (start > cursor) parts.push(esc(text.slice(cursor, start)));
      parts.push('<mark>' + esc(text.slice(start, end)) + '</mark>');
      cursor = end;
    }
    if (cursor < text.length) parts.push(esc(text.slice(cursor)));
    return parts.join('');
  }

  function recencyBoost(isoString) {
    if (!isoString) return 0;
    const ts = Date.parse(String(isoString));
    if (!Number.isFinite(ts)) return 0;
    const ageMs = Date.now() - ts;
    if (ageMs <= 0) return 0.9;
    const halfLifeMs = 24 * 60 * 60 * 1000;
    const decay = Math.pow(0.5, ageMs / halfLifeMs);
    return decay * 0.9;
  }

  function createCommandPaletteController(deps) {
    const {
      state,
      dom = {},
      callbacks = {},
      overlayManager = null,
    } = deps || {};

    const documentRef = (typeof document !== 'undefined') ? document : null;
    const globalRef = (typeof globalThis !== 'undefined') ? globalThis : {};
    const asyncFenceUtils = globalRef.rendererAsyncFence
      || (typeof require === 'function' ? require('../shared/async-fence') : null);
    const openGate = asyncFenceUtils.createGenerationGate();

    const {
      commandPaletteOverlay = null,
      commandPaletteInput = null,
      commandPaletteList = null,
      commandPaletteScope = null,
      commandPaletteCount = null,
      commandPaletteLegend = null,
      commandPaletteStatus = null,
      commandPaletteFieldIcon = null,
      titlebarPalettePill = null,
    } = dom;

    const {
      appendClientLog = function noopLog() {},
      showToastMessage = function noopToast() {},
      escapeHtml = function fallbackEscape(value) {
        return String(value || '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      },
    } = callbacks;

    const OVERLAY_ID = 'command-palette';

    const boundListeners = [];
    let _active = false;
    let _query = '';
    let _items = [];
    let _snapshot = [];
    let _activeIndex = 0;
    let _scopeIndex = 0;
    let _lastFocus = null;
    let _lastTrigger = null;
    const _mru = [];
    const pills = [titlebarPalettePill].filter(Boolean);

    // UIUX-020: a view switch must land focus on the destination toprail tab,
    // otherwise close()'s focus restore leaves it on a control that the switch
    // just made hidden/inert. Resolved off the absent-safe globalThis seam the
    // top-nav shell stashes at boot; views without a rail tab no-op.
    function focusDestinationView(viewId) {
      const topNavShellController = globalRef.rendererTopNavShellController || null;
      try {
        if (topNavShellController && typeof topNavShellController.focusActiveViewTab === 'function') {
          topNavShellController.focusActiveViewTab(viewId);
        }
      } catch (_err) { /* noop */ }
    }

    const itemProviders = (providers.createPaletteProviders || (() => ({ snapshot: () => [] })))({
      state,
      globalRef,
      callbacks: Object.assign({}, callbacks, { focusDestinationView }),
    });

    const renderer = (renderUtils.createPaletteRenderer || (() => ({
      render() {}, setActive() { return ''; }, reset() {},
    })))({
      documentRef,
      listEl: commandPaletteList,
      scopeEl: commandPaletteScope,
      countEl: commandPaletteCount,
      legendEl: commandPaletteLegend,
      statusEl: commandPaletteStatus,
      fieldIconEl: commandPaletteFieldIcon,
      escapeHtml,
      highlightRanges,
    });

    function addListener(target, type, handler, options) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, handler, options);
      boundListeners.push({ target, type, handler, options });
    }

    function removeAllListeners() {
      while (boundListeners.length) {
        const { target, type, handler, options } = boundListeners.pop();
        try { target.removeEventListener(type, handler, options); } catch (_err) { /* noop */ }
      }
    }

    function currentScope() {
      return SCOPES[_scopeIndex] || SCOPES[0];
    }

    function inScope(item) {
      const scopeAllows = providers.scopeAllows;
      return typeof scopeAllows === 'function' ? scopeAllows(currentScope(), item.group) : true;
    }

    function mruBoost(itemId) {
      const rank = _mru.indexOf(itemId);
      if (rank < 0) return 0;
      return 2.5 - (rank * (2 / (MRU_DEPTH - 1)));
    }

    function recordMru(itemId) {
      const existing = _mru.indexOf(itemId);
      if (existing >= 0) _mru.splice(existing, 1);
      _mru.unshift(itemId);
      while (_mru.length > MRU_DEPTH) _mru.pop();
    }

    /* ── Ranking ──
       With a query this is ONE flat, globally ranked list. The pre-split
       renderer re-bucketed the score-sorted results by group, which set each
       group's position from its single best member and then pulled every other
       member of that group up with it -- so the second-best result overall
       could land below eight weak rows. Groups now appear only in the
       no-query landing view, where there is no ranking to destroy. */
    function rankForQuery(query) {
      const scored = [];
      for (const item of _snapshot) {
        if (!inScope(item)) continue;
        const labelMatch = scoreMatch(item.label, query);
        const descMatch = scoreMatch(item.description, query);
        if (!labelMatch && !descMatch) continue;
        let score = 0;
        if (labelMatch) score += labelMatch.score * 2;
        if (descMatch) score += descMatch.score * 0.7;
        if (item.group === 'Sessions') score += recencyBoost(item.recencyTimestamp) * 3;
        else score += mruBoost(item.id);
        scored.push({
          item,
          score,
          labelRanges: labelMatch ? labelMatch.ranges : [],
          descriptionRanges: descMatch ? descMatch.ranges : [],
        });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored;
    }

    /* The no-query landing list: recent undo, then what you actually run, then
       the views, a few recent chats, and the rest of the actions. Capped --
       everything else is one keystroke away. */
    function buildDefaultList() {
      const scoped = _snapshot.filter(inScope);
      const byId = new Map(scoped.map((item) => [item.id, item]));
      const ordered = [];
      const seen = new Set();
      const push = (item) => {
        if (!item || seen.has(item.id)) return;
        seen.add(item.id);
        ordered.push(item);
      };

      scoped.filter((item) => item.group === 'Undo').forEach(push);
      _mru.forEach((id) => push(byId.get(id)));
      scoped.filter((item) => item.group === 'Navigate').forEach(push);
      scoped.filter((item) => item.group === 'Sessions').slice(0, 5).forEach(push);
      scoped.filter((item) => item.group === 'Actions').forEach(push);
      // In a narrow scope the buckets above may not fill the list; top it up in
      // the canonical group order so a scope is never emptier than its contents.
      const groupOrder = providers.groupOrder || (() => 0);
      scoped
        .slice()
        .sort((a, b) => groupOrder(a.group) - groupOrder(b.group))
        .forEach(push);

      return ordered.map((item) => ({ item, labelRanges: [], descriptionRanges: [] }));
    }

    function render() {
      if (!commandPaletteList) return;
      const query = _query.trim();
      const grouped = !query;
      const ranked = query ? rankForQuery(query) : buildDefaultList();
      const cap = query ? MAX_ROW_CAP : DEFAULT_ROW_CAP;
      const entries = ranked.slice(0, cap);

      _items = entries.map((entry) => entry.item);
      if (_activeIndex >= _items.length) _activeIndex = 0;
      if (_activeIndex < 0) _activeIndex = 0;

      renderer.render({
        entries,
        grouped,
        query,
        totalCount: ranked.length,
        scopeLabel: currentScope().label,
      });
      applyActiveHighlight();
    }

    // WAI-ARIA combobox pattern: the input owns focus at all times and
    // aria-activedescendant tells assistive tech which option is "virtually"
    // focused. Keyboard-driven scroll is always instant -- the list's
    // scroll-behavior: smooth is for pointer scrolling only, and animating it
    // per arrow press made held-arrow navigation trail the keyboard.
    function applyActiveHighlight() {
      const activeRowId = _items.length ? renderer.setActive(_activeIndex, 'auto') : '';
      if (!commandPaletteInput) return;
      if (activeRowId) commandPaletteInput.setAttribute('aria-activedescendant', activeRowId);
      else commandPaletteInput.removeAttribute('aria-activedescendant');
    }

    /* ── Open / close ── */

    function setPillsExpanded(expanded) {
      const value = expanded ? 'true' : 'false';
      for (const pill of pills) pill.setAttribute('aria-expanded', value);
    }

    function setInputExpanded(expanded) {
      if (!commandPaletteInput) return;
      commandPaletteInput.setAttribute('role', 'combobox');
      commandPaletteInput.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      if (!expanded) commandPaletteInput.removeAttribute('aria-activedescendant');
    }

    function restoreFocus(target) {
      if (!target || typeof target.focus !== 'function') return;
      try { target.focus({ preventScroll: true }); }
      catch (_err) { try { target.focus(); } catch (_err2) { /* noop */ } }
    }

    function isAnotherOverlayOpen() {
      const ui = (state && state.ui) || {};
      return Boolean(
        ui.composerPopoverOpen
        || ui.commandPopoverOpen
        || (state && state.auth && !state.auth.authenticated)
        || (overlayManager && typeof overlayManager.isOpen === 'function' && overlayManager.isOpen())
      );
    }

    // Monaco and the terminal own Ctrl+K while focused -- it is Monaco's chord
    // prefix (Ctrl+K Ctrl+C, Ctrl+K Z, ...). Deliberately narrower than the
    // global shortcuts' isTextEditingSurfaceFocused: the composer must keep
    // opening the palette, because that is where people are when they reach
    // for it.
    function isEditorSurface(target) {
      if (!target || typeof target.closest !== 'function') return false;
      try {
        return Boolean(target.closest('.monaco-editor, .xterm, .ide-terminal-panel'));
      } catch (_err) { return false; }
    }

    function isActive() {
      return _active;
    }

    function setScope(nextIndex) {
      const count = SCOPES.length;
      _scopeIndex = ((nextIndex % count) + count) % count;
      _activeIndex = 0;
      render();
    }

    function open(trigger) {
      if (!commandPaletteOverlay || !commandPaletteInput) return;
      if (_active) return;
      if (isAnotherOverlayOpen()) return;
      openGate.bump();
      const openToken = openGate.capture();
      _active = true;
      _query = '';
      _scopeIndex = 0;
      _activeIndex = 0;
      _lastTrigger = trigger || (documentRef && documentRef.activeElement) || null;
      _lastFocus = documentRef ? documentRef.activeElement : null;
      commandPaletteInput.value = '';
      commandPaletteOverlay.classList.remove('hidden');
      setPillsExpanded(true);
      setInputExpanded(true);
      // Snapshot every provider ONCE: nothing they read can change while the
      // palette is up, and the palette closes before any item runs.
      try { _snapshot = itemProviders.snapshot() || []; } catch (_err) { _snapshot = []; }
      render();
      if (overlayManager && typeof overlayManager.open === 'function') {
        overlayManager.open({
          id: OVERLAY_ID,
          root: commandPaletteOverlay,
          onRequestClose: () => close(),
          restoreFocusTo: _lastTrigger || _lastFocus,
          trapFocus: false,
        });
      }
      // Defer focus so the open animation starts from a clean frame.
      Promise.resolve().then(() => {
        if (!_active || !openGate.isCurrent(openToken)) return;
        restoreFocus(commandPaletteInput);
      });
      try { appendClientLog('INFO', 'palette.opened', {}); } catch (_err) { /* noop */ }
    }

    function close() {
      if (!commandPaletteOverlay) return;
      if (!_active) return;
      openGate.bump();
      _active = false;
      commandPaletteOverlay.classList.add('hidden');
      setPillsExpanded(false);
      setInputExpanded(false);
      if (commandPaletteInput) commandPaletteInput.value = '';
      _query = '';
      _items = [];
      _snapshot = [];
      _activeIndex = 0;
      _scopeIndex = 0;
      renderer.reset();
      if (overlayManager && typeof overlayManager.close === 'function') {
        overlayManager.close(OVERLAY_ID);
      } else {
        restoreFocus(_lastTrigger || _lastFocus);
      }
      _lastTrigger = null;
      _lastFocus = null;
    }

    function toggle(trigger) {
      if (_active) close();
      else open(trigger);
    }

    function executeActiveItem() {
      const item = _items[_activeIndex];
      if (!item) return;
      if (item.disabled) {
        showToastMessage(item.unavailableReason || 'That command is unavailable.', {
          title: 'Command unavailable',
          tone: 'warning',
        });
        return;
      }
      if (item.group !== 'Sessions') recordMru(item.id);
      close();
      Promise.resolve().then(() => {
        try { item.run(); } catch (error) {
          try { appendClientLog('WARN', 'palette.item_error', { id: item.id, message: String((error && error.message) || error) }); } catch (_err) { /* noop */ }
        }
      });
    }

    /* ── Event handlers ── */

    function handleGlobalKeydown(event) {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        const key = String(event.key || '').toLowerCase();
        if (key === 'k') {
          // Both guards return BEFORE preventDefault: swallowing the keystroke
          // and then doing nothing is what made Ctrl+K look dead.
          if (!_active && isEditorSurface(event.target)) return;
          if (!_active && isAnotherOverlayOpen()) return;
          event.preventDefault();
          event.stopPropagation();
          toggle(event.target || null);
          return;
        }
      }
      if (!_active) return;
      // Escape is the shared overlay manager's job when one is injected
      // (UIUX-019): only the TOPMOST registered overlay may act on it. Handle
      // it locally only when no manager is present (older callers/tests).
      if (!overlayManager && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }

    function moveActive(delta) {
      if (!_items.length) return;
      _activeIndex = (_activeIndex + delta + _items.length) % _items.length;
      applyActiveHighlight();
    }

    function setActiveIndex(index) {
      if (!_items.length) return;
      _activeIndex = Math.max(0, Math.min(_items.length - 1, index));
      applyActiveHighlight();
    }

    function handleDialogKeydown(event) {
      if (!_active) return;
      const key = event.key;
      if (key === 'ArrowDown') { event.preventDefault(); moveActive(1); return; }
      if (key === 'ArrowUp') { event.preventDefault(); moveActive(-1); return; }
      if (key === 'Home') { event.preventDefault(); setActiveIndex(0); return; }
      if (key === 'End') { event.preventDefault(); setActiveIndex(_items.length - 1); return; }
      if (key === 'PageDown') { event.preventDefault(); setActiveIndex(_activeIndex + 10); return; }
      if (key === 'PageUp') { event.preventDefault(); setActiveIndex(_activeIndex - 10); return; }
      if (key === 'Enter') { event.preventDefault(); executeActiveItem(); return; }
      if (key === 'Tab') {
        event.preventDefault();
        setScope(_scopeIndex + (event.shiftKey ? -1 : 1));
        return;
      }
      if (key === 'Backspace' && _scopeIndex !== 0 && !String(commandPaletteInput?.value || '')) {
        event.preventDefault();
        setScope(0);
      }
    }

    function handleInput() {
      const raw = String(commandPaletteInput?.value || '');
      // A scope prefix typed at the very start of an unscoped query jumps to
      // that scope and is consumed, never inserted.
      if (_scopeIndex === 0 && !_query && raw.length > 0) {
        const prefixScope = SCOPE_PREFIXES[raw.charAt(0)];
        if (prefixScope) {
          const rest = raw.slice(1);
          commandPaletteInput.value = rest;
          _query = rest;
          const index = SCOPES.findIndex((scope) => scope.id === prefixScope);
          setScope(index < 0 ? 0 : index);
          return;
        }
      }
      if (raw === _query) return;
      _query = raw;
      _activeIndex = 0;
      render();
    }

    function rowIndexFrom(target) {
      const row = target && typeof target.closest === 'function'
        ? target.closest('.command-palette-item')
        : null;
      if (!row) return -1;
      const index = Number(row.getAttribute('data-palette-index'));
      return Number.isFinite(index) ? index : -1;
    }

    function handleListClick(event) {
      const index = rowIndexFrom(event.target);
      if (index < 0) return;
      _activeIndex = index;
      executeActiveItem();
    }

    /* Pointer movement MOVES the selection rather than painting a second
       "looks selected" state. Before this, hover and keyboard-active shared one
       CSS rule but not one index, so two rows looked chosen and Enter ran the
       one the cursor was not on. mousemove (not mouseover) so a list scrolling
       under a stationary cursor does not steal the selection. */
    function handleListPointerMove(event) {
      if (!_active) return;
      const index = rowIndexFrom(event.target);
      if (index < 0 || index === _activeIndex) return;
      _activeIndex = index;
      applyActiveHighlight();
    }

    function handleScrimClick(event) {
      const target = event.target;
      if (!target || !target.classList || !target.classList.contains('command-palette-scrim')) return;
      close();
    }

    function handlePillClick(event) {
      open(event.currentTarget || null);
    }

    /* ── Lifecycle ── */

    // bind() is re-entrant: the first call runs on placeholder feature flags
    // (command_palette absent → disabled) and the shell re-binds after the
    // real feature state loads. Already-bound calls are no-ops.
    let _bound = false;

    function bind() {
      if (_bound) return;
      if (!isCommandPaletteEnabled(state)) {
        for (const pill of pills) pill.classList.add('hidden');
        return;
      }
      _bound = true;
      for (const pill of pills) {
        pill.classList.remove('hidden');
        pill.setAttribute('aria-expanded', 'false');
        addListener(pill, 'click', handlePillClick);
      }
      if (documentRef) addListener(documentRef, 'keydown', handleGlobalKeydown, true);
      if (commandPaletteInput) {
        addListener(commandPaletteInput, 'input', handleInput);
        addListener(commandPaletteInput, 'keydown', handleDialogKeydown);
      }
      if (commandPaletteList) {
        addListener(commandPaletteList, 'click', handleListClick);
        addListener(commandPaletteList, 'mousemove', handleListPointerMove);
      }
      if (commandPaletteOverlay) addListener(commandPaletteOverlay, 'click', handleScrimClick);
    }

    function dispose() {
      if (_active) close();
      removeAllListeners();
      _bound = false;
    }

    return {
      bind,
      dispose,
      open,
      close,
      toggle,
      isActive,
    };
  }

  return {
    createCommandPaletteController,
    // Shared fuzzy primitives (also used by the IDE Quick Open picker).
    highlightRanges,
    isCommandPaletteEnabled,
    scoreMatch,
  };
});
