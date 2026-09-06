/* renderer/features/renderer-ide-picker-overlay.js - shared Quick-pick overlay
 * factory for the Workspace IDE. Owns the chrome + behavior that the Ctrl+P file
 * picker (renderer-ide-quick-open) and the Ctrl+T workspace-symbol picker
 * (renderer-ide-symbol-nav) had each cloned: an overlay above the editor stage
 * (an inventory text-field + a results listbox), the open/close/toggle/isOpen
 * lifecycle, the ArrowUp/Down/Enter/Escape keyboard nav over a flat result list,
 * backdrop-click-to-dismiss, and the load -> compute -> render refresh cycle.
 *
 * Each picker supplies ONLY its data source and row shape through callbacks:
 *   loadItems()                         async; fetch/index the data on open
 *   resetOnOpen()                       optional; clear caches before each open
 *   computeMatches(query) -> items[]    the picker's own filter/score
 *   buildRowMarkup(item, i, selected)   one result row (caller owns the markup)
 *   isLoading(query) -> bool            show the loading status instead of rows
 *   renderLoadingStatus(query) -> html  the "Indexing…" status markup
 *   renderEmptyStatus(query) -> html    the no-matches status markup
 *   renderTrailingStatus(items, query)  optional html; appended after the rows
 *   onSubmit(item, { close })           Enter on the selected row
 *   onRowClick(rowEl, { close })        click on a result row
 *   onClosed()                          after the overlay hides
 *
 * The chrome carries shared `.ide-picker-*` classes (styled once in
 * styles/ide-chrome.css) plus each picker's specific classes via the *Class
 * options, so existing selectors (tests, smokes) keep matching while the CSS is
 * shared. No Monaco / fs / palette coupling lives here - it is pure DOM plumbing. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePickerOverlay = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

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
    return {};
  }

  // Join the shared base class with a picker-specific class (the specific one is
  // what existing CSS deltas + test/smoke selectors target).
  function pickerClass(base, specific) {
    return specific ? `${base} ${specific}` : base;
  }

  function createIdePickerOverlay(deps) {
    const options = deps || {};
    const getDom = typeof options.getDom === 'function' ? options.getDom : () => ({});
    const textField = typeof options.textField === 'function'
      ? options.textField
      : resolveModule('inventoryTextField', '../inventory/text-field');

    // --- Chrome configuration (the specific classes / attrs per picker) ---
    const overlayClass = String(options.overlayClass || '');
    const panelClass = String(options.panelClass || '');
    const fieldClass = String(options.fieldClass || '');
    const resultsClass = String(options.resultsClass || '');
    const overlayAttrs = (options.overlayAttrs && typeof options.overlayAttrs === 'object')
      ? options.overlayAttrs
      : null;
    const inputId = String(options.inputId || '');
    const inputDataset = (options.inputDataset && typeof options.inputDataset === 'object')
      ? options.inputDataset
      : {};
    const inputSelector = String(options.inputSelector || '');
    const placeholder = String(options.placeholder || '');
    const ariaLabel = String(options.ariaLabel || '');
    const resultsAriaLabel = String(options.resultsAriaLabel || '');
    const rowSelector = String(options.rowSelector || '');
    const panelSelector = String(options.panelSelector || '.ide-picker-panel');
    const selectedRowSelector = String(options.selectedRowSelector || '.ide-picker-row--selected');

    const callbacks = options.callbacks || {};
    const call = (name, ...args) => (typeof callbacks[name] === 'function'
      ? callbacks[name](...args)
      : undefined);

    let overlayEl = null;
    let inputEl = null;
    let resultsEl = null;
    let visible = false;
    let matches = [];
    let selectedIndex = 0;
    // The element focused before the overlay opened, so closing (Escape /
    // backdrop) can return focus there instead of stranding it (Monaco's
    // textarea does not auto-reclaim). Mirrors inventory/help-overlay.js.
    let savedFocus = null;

    function readQuery() {
      return String(inputEl && inputEl.value ? inputEl.value : '').trim();
    }

    // query -> caller matches -> markup. Mirrors the (loading | empty | rows +
    // trailing) decision both pickers used, with the selected row scrolled into
    // view. The caller owns every markup string; this owns the skeleton.
    function refresh() {
      if (!resultsEl) {
        return;
      }
      const query = readQuery();
      matches = call('computeMatches', query) || [];
      selectedIndex = Math.max(0, Math.min(selectedIndex, matches.length - 1));
      let markup;
      if (call('isLoading', query) === true) {
        markup = call('renderLoadingStatus', query) || '';
      } else if (!matches.length) {
        markup = call('renderEmptyStatus', query) || '';
      } else {
        markup = matches
          .map((item, index) => call('buildRowMarkup', item, index, index === selectedIndex))
          .join('');
        markup += call('renderTrailingStatus', matches, query) || '';
      }
      resultsEl.innerHTML = markup;
      const selected = resultsEl.querySelector(selectedRowSelector);
      if (selected && selected.scrollIntoView) {
        selected.scrollIntoView({ block: 'nearest' });
      }
    }

    function moveSelection(delta) {
      if (!matches.length) {
        return;
      }
      selectedIndex = (selectedIndex + delta + matches.length) % matches.length;
      refresh();
    }

    function submit() {
      const item = matches[selectedIndex] || matches[0] || null;
      call('onSubmit', item, { close });
    }

    function handleInputKeydown(event) {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          moveSelection(1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          moveSelection(-1);
          break;
        case 'Enter':
          event.preventDefault();
          submit();
          break;
        case 'Escape':
          event.preventDefault();
          event.stopPropagation();
          close();
          break;
        default:
          break;
      }
    }

    function handleInput() {
      selectedIndex = 0;
      refresh();
    }

    function handleOverlayClick(event) {
      const target = event.target;
      if (!(target && typeof target.closest === 'function')) {
        return;
      }
      const row = rowSelector ? target.closest(rowSelector) : null;
      if (row) {
        call('onRowClick', row, { close });
        return;
      }
      // Clicking the backdrop (not the panel) dismisses.
      if (!target.closest(panelSelector)) {
        close();
      }
    }

    function ensureOverlay() {
      if (overlayEl) {
        return overlayEl;
      }
      const dom = getDom();
      const stage = (dom && (dom.ideEditorStage || dom.ideView)) || null;
      const documentRef = stage && stage.ownerDocument;
      if (!stage || !documentRef || typeof textField !== 'function') {
        return null;
      }
      overlayEl = documentRef.createElement('div');
      overlayEl.className = `${pickerClass('ide-picker-overlay', overlayClass)} hidden`;
      if (overlayAttrs) {
        Object.keys(overlayAttrs).forEach((name) => {
          overlayEl.setAttribute(name, String(overlayAttrs[name]));
        });
      }
      const fieldOpts = {
        className: pickerClass('ide-picker-field', fieldClass),
        placeholder,
        ariaLabel,
        dataset: inputDataset,
      };
      if (inputId) {
        fieldOpts.id = inputId;
      }
      overlayEl.innerHTML = `<div class="${pickerClass('ide-picker-panel', panelClass)}">`
        + textField(fieldOpts)
        + `<div class="${pickerClass('ide-picker-results', resultsClass)}"`
        + ` role="listbox" aria-label="${resultsAriaLabel}"></div>`
        + '</div>';
      stage.appendChild(overlayEl);
      inputEl = (inputSelector && overlayEl.querySelector(inputSelector))
        || overlayEl.querySelector('.inv-text-field-control')
        || null;
      resultsEl = overlayEl.querySelector('.ide-picker-results');
      overlayEl.addEventListener('click', handleOverlayClick);
      if (inputEl) {
        inputEl.addEventListener('keydown', handleInputKeydown);
        inputEl.addEventListener('input', handleInput);
      }
      return overlayEl;
    }

    // Fetch/index the data on open, then re-render if still open. Each picker's
    // loadItems guards its own cache, so this is cheap on re-open.
    async function loadAndRefresh() {
      if (typeof callbacks.loadItems !== 'function') {
        return;
      }
      await callbacks.loadItems();
      if (visible) {
        refresh();
      }
    }

    function handleLoadFailure(error) {
      try {
        call('onLoadError', error);
      } catch (_error) {
        /* caller diagnostics are best-effort */
      }
      if (visible) {
        try {
          refresh();
        } catch (_error) {
          /* caller-owned failure state is best-effort */
        }
      }
    }

    function open() {
      if (!ensureOverlay()) {
        return false;
      }
      // Capture the prior focus only on a real hidden->visible transition, so a
      // re-entrant open() (e.g. re-opening to refresh data) does not clobber it
      // with the picker's own input.
      const wasVisible = visible;
      visible = true;
      overlayEl.classList.remove('hidden');
      if (inputEl) {
        inputEl.value = '';
      }
      selectedIndex = 0;
      call('resetOnOpen');
      refresh();
      loadAndRefresh().catch(handleLoadFailure);
      if (!wasVisible) {
        const documentRef = overlayEl && overlayEl.ownerDocument;
        savedFocus = documentRef ? documentRef.activeElement : null;
      }
      if (inputEl && inputEl.focus) {
        inputEl.focus();
      }
      return true;
    }

    function close() {
      if (!visible) {
        return;
      }
      visible = false;
      if (overlayEl) {
        overlayEl.classList.add('hidden');
      }
      if (savedFocus && typeof savedFocus.focus === 'function') {
        try {
          savedFocus.focus();
        } catch (_error) {
          /* ignore - the prior element may have been removed */
        }
      }
      savedFocus = null;
      call('onClosed');
    }

    function toggle() {
      if (visible) {
        close();
        return;
      }
      open();
    }

    function isOpen() {
      return visible;
    }

    function dispose() {
      if (inputEl) {
        inputEl.removeEventListener('keydown', handleInputKeydown);
        inputEl.removeEventListener('input', handleInput);
      }
      if (overlayEl) {
        overlayEl.removeEventListener('click', handleOverlayClick);
        if (overlayEl.remove) {
          overlayEl.remove();
        }
      }
      overlayEl = null;
      inputEl = null;
      resultsEl = null;
      visible = false;
      matches = [];
      selectedIndex = 0;
      savedFocus = null;
    }

    return {
      open,
      close,
      toggle,
      isOpen,
      refresh,
      dispose,
    };
  }

  return {
    createIdePickerOverlay,
  };
});
