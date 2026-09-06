/* renderer/features/renderer-ide-mru-switcher.js - Ctrl+Tab MRU tab switcher
 * most-recently-used tab switcher for the Workspace IDE. Hold Ctrl and press Tab
 * to step forward through open tabs in most-recently-used order (Shift+Tab steps
 * backward); releasing Ctrl commits to the highlighted tab, Esc cancels. With
 * fewer than two tabs it is a no-op.
 *
 * The overlay is purely VISUAL (it never takes focus), so once open the switcher
 * owns its interaction through WINDOW-level capture listeners — robust even when
 * focus sits on <body> rather than inside #ideView:
 *   - keydown (capture): Tab/Shift+Tab cycle, Esc cancels; both stopPropagation so
 *     the #ideView keydown handler does not also fire handleTabKey.
 *   - keyup   (capture): when Control/Meta is released, commit the selection.
 *   - blur / visibilitychange: cancel, so a missed Ctrl-release can't strand it.
 * The FIRST Tab is delivered by the #ideView keydown branch (commands.js) which
 * calls handleTabKey while the window listeners are not yet bound; every Tab after
 * open is owned by the window listener. Reuses the shared .ide-picker-* chrome but
 * builds its own input-less DOM (createIdePickerOverlay focuses an input and
 * swallows Esc/Enter — wrong for a Tab-driven, focus-less overlay). Constructed +
 * bound/disposed through the QoL collector (renderer-ide-qol-wiring.js). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMruSwitcher = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  // Most-recently-used order over OPEN FILE tabs: getRecentFiles() is already
  // open-filtered + MRU-first (index 0 = active, 1 = previous); any open file tab
  // not yet activated this session is appended at the tail so it stays reachable.
  // Diff/preview review tabs are excluded (they never enter the MRU).
  function buildMruPaths(getRecentFiles, getOpenTabs) {
    const recent = (getRecentFiles() || []).filter((path) => typeof path === 'string');
    const openFilePaths = (getOpenTabs() || [])
      .filter((tab) => tab && tab.kind === 'file' && typeof tab.path === 'string')
      .map((tab) => tab.path);
    const openSet = new Set(openFilePaths);
    const seen = new Set();
    const ordered = [];
    for (const path of recent) {
      if (openSet.has(path) && !seen.has(path)) {
        seen.add(path);
        ordered.push(path);
      }
    }
    for (const path of openFilePaths) {
      if (!seen.has(path)) {
        seen.add(path);
        ordered.push(path);
      }
    }
    return ordered;
  }

  function basenameOf(path) {
    const str = String(path || '');
    const slash = str.lastIndexOf('/');
    return slash === -1 ? str : str.slice(slash + 1);
  }

  function dirOf(path) {
    const str = String(path || '');
    const slash = str.lastIndexOf('/');
    return slash === -1 ? '' : str.slice(0, slash);
  }

  function createIdeMruSwitcher(deps) {
    const d = deps || {};
    const getDom = typeof d.getDom === 'function' ? d.getDom : () => ({});
    const windowRef = d.windowRef || globalRef.window || globalRef;
    const escapeHtml = typeof d.escapeHtml === 'function' ? d.escapeHtml : (v) => String(v == null ? '' : v);
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;
    const getRecentFiles = typeof d.getRecentFiles === 'function' ? d.getRecentFiles : () => [];
    const getOpenTabs = typeof d.getOpenTabs === 'function' ? d.getOpenTabs : () => [];
    const activateTab = typeof d.activateTab === 'function' ? d.activateTab : noop;
    // Defaults to 'ide' so a standalone (non-controller) construction stays active;
    // the controller threads the live view so the overlay self-cancels if focus
    // leaves the IDE while it is open (an in-page view switch fires no window blur).
    const getActiveView = typeof d.getActiveView === 'function' ? d.getActiveView : () => 'ide';

    let overlayEl = null;
    let resultsEl = null;
    let visible = false;
    let items = [];
    let selectedIndex = 0;

    function ensureOverlay() {
      if (overlayEl) {
        return overlayEl;
      }
      const dom = getDom();
      const stage = (dom && (dom.ideEditorStage || dom.ideView)) || null;
      const documentRef = stage && stage.ownerDocument;
      if (!stage || !documentRef) {
        return null;
      }
      overlayEl = documentRef.createElement('div');
      overlayEl.className = 'ide-picker-overlay ide-mru-switcher hidden';
      overlayEl.innerHTML = '<div class="ide-picker-panel ide-mru-switcher-panel">'
        + '<div class="ide-picker-results ide-mru-switcher-results" role="listbox" aria-label="Recent tabs"></div>'
        + '</div>';
      // A click on a row commits directly to that tab (mouse parity with the keys).
      overlayEl.addEventListener('click', handleOverlayClick);
      stage.appendChild(overlayEl);
      resultsEl = overlayEl.querySelector('.ide-mru-switcher-results');
      return overlayEl;
    }

    function rowMarkup(path, index) {
      const selected = index === selectedIndex;
      return `<div class="ide-picker-row ide-mru-row${selected ? ' ide-picker-row--selected' : ''}"`
        + ` role="option" aria-selected="${selected ? 'true' : 'false'}"`
        + ` data-ide-mru-path="${escapeHtml(path)}">`
        + `<span class="ide-picker-name">${escapeHtml(basenameOf(path))}</span>`
        + `<span class="ide-picker-path">${escapeHtml(dirOf(path))}</span>`
        + '</div>';
    }

    function render() {
      if (!resultsEl) {
        return;
      }
      resultsEl.innerHTML = items.map((path, index) => rowMarkup(path, index)).join('');
      const active = resultsEl.querySelector('.ide-picker-row--selected');
      if (active && typeof active.scrollIntoView === 'function') {
        active.scrollIntoView({ block: 'nearest' });
      }
    }

    function bindWindowKeys() {
      windowRef.addEventListener?.('keydown', handleWindowKeydown, true);
      windowRef.addEventListener?.('keyup', handleWindowKeyup, true);
      windowRef.addEventListener?.('blur', cancel);
      windowRef.document?.addEventListener?.('visibilitychange', handleVisibilityChange);
    }

    function unbindWindowKeys() {
      windowRef.removeEventListener?.('keydown', handleWindowKeydown, true);
      windowRef.removeEventListener?.('keyup', handleWindowKeyup, true);
      windowRef.removeEventListener?.('blur', cancel);
      windowRef.document?.removeEventListener?.('visibilitychange', handleVisibilityChange);
    }

    function open(forward) {
      items = buildMruPaths(getRecentFiles, getOpenTabs);
      if (items.length < 2) {
        items = [];
        return; // nothing to switch between
      }
      if (!ensureOverlay()) {
        appendClientLog('WARN', 'ide.mru_switcher_no_mount', {});
        return;
      }
      // On the switcher's first press, pre-select the previous tab (forward) or
      // the last tab (backward); index 0 is the currently-active tab.
      selectedIndex = forward ? 1 : items.length - 1;
      visible = true;
      overlayEl.classList.remove('hidden');
      render();
      bindWindowKeys();
    }

    function advance(forward) {
      if (!visible || !items.length) {
        return;
      }
      const count = items.length;
      selectedIndex = ((selectedIndex + (forward ? 1 : -1)) % count + count) % count;
      render();
    }

    function close() {
      if (!visible) {
        return;
      }
      visible = false;
      unbindWindowKeys();
      if (overlayEl) {
        overlayEl.classList.add('hidden');
      }
    }

    function commit() {
      const path = items[selectedIndex];
      // items is snapshotted at open(); if the target was closed elsewhere while the
      // overlay was held, don't resurrect it — only commit to a still-open tab.
      const stillOpen = !!path && (getOpenTabs() || []).some((tab) => tab && tab.path === path);
      close();
      if (stillOpen) {
        activateTab(path);
      }
    }

    function cancel() {
      close();
    }

    // The single keyboard entry point, called by the #ideView keydown handler on
    // the FIRST Ctrl+Tab (before the window listener is bound) and thereafter by
    // the window keydown listener while the overlay is open.
    function handleTabKey(forward) {
      if (visible) {
        advance(forward);
      } else {
        open(forward !== false);
      }
    }

    function handleWindowKeydown(event) {
      if (!visible) {
        return;
      }
      if (getActiveView() !== 'ide') {
        cancel(); // the IDE is no longer the active surface — stand down
        return;
      }
      const key = String(event.key || '').toLowerCase();
      if (key === 'tab') {
        event.preventDefault();
        event.stopPropagation();
        advance(!event.shiftKey);
      } else if (key === 'escape') {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    }

    function handleWindowKeyup(event) {
      if (!visible) {
        return;
      }
      if (getActiveView() !== 'ide') {
        cancel(); // released the modifier on a non-IDE surface — cancel, don't switch
        return;
      }
      // Commit the moment the held modifier (Ctrl on Windows/Linux, Cmd on Mac) is
      // released — the canonical "let go to switch" gesture.
      if (event.key === 'Control' || event.key === 'Meta') {
        commit();
      }
    }

    function handleVisibilityChange() {
      if (visible && windowRef.document?.hidden) {
        cancel();
      }
    }

    function handleOverlayClick(event) {
      const row = event.target?.closest?.('[data-ide-mru-path]');
      if (!row) {
        return;
      }
      // Mirror commit()'s still-open guard: a row whose tab was closed elsewhere
      // while the overlay was held must not resurrect the file on click.
      const path = row.dataset.ideMruPath;
      const stillOpen = !!path && (getOpenTabs() || []).some((tab) => tab && tab.path === path);
      close();
      if (stillOpen) {
        activateTab(path);
      }
    }

    // bindEvents/dispose are the collector's lifecycle contract. The window key
    // listeners are added lazily on open (not here) so they are only live while the
    // overlay is showing; dispose tears everything down.
    function bindEvents() {
      /* no eager listeners: the #ideView keydown handler drives handleTabKey */
    }

    function dispose() {
      close();
      if (overlayEl) {
        overlayEl.removeEventListener('click', handleOverlayClick);
        overlayEl.remove?.();
      }
      overlayEl = null;
      resultsEl = null;
      items = [];
      selectedIndex = 0;
    }

    return { bindEvents, dispose, handleTabKey };
  }

  return { createIdeMruSwitcher, buildMruPaths };
});
