/* Model Library section › rendering: the toolbar (filter chips, pull input,
 * refresh, hardware line), the card grid, and one card patched in place,
 * each keeping the focused control focused across the rebuild. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.modelLibrarySectionRender = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function focusQuietly(element) {
    try { element.focus({ preventScroll: true }); }
    catch (_focusError) { element.focus(); }
  }

  // deps: { documentRef, view, actions, viewModule, mergeModule, inventoryTextField,
  //   inventoryActionButton, host(), toolbarHost(), extrasHost(), isDisposed(),
  //   getMerged(), hardwarePending(), accelerationFlagEnabled(), getEngineBlocks(),
  //   renderFolders(), hideMenu(), currentPulls(), activationState(),
  //   renderConfirmModal(), findModel(key) }
  function createModelLibrarySectionRender(deps) {
    var d = deps || {};
    var documentRef = d.documentRef;
    var view = d.view;
    var viewModule = d.viewModule;
    var mergeModule = d.mergeModule;

    function toolbarHtml() {
      var modelView = d.getMerged() || { hardware: {}, cards: [] };
      var cards = Array.isArray(modelView.cards) ? modelView.cards : [];
      return '<div class="model-library-section-toolbar">'
        + viewModule.buildFilterChips(view.filter, mergeModule.filterCounts(cards))
        + '<div class="model-library-section-toolbar-actions">'
        + d.inventoryTextField({
          id: 'modelLibrarySectionPullInput',
          value: view.pullTag,
          placeholder: jt('settings.modelLibrary.tagPlaceholder', 'ollama tag, e.g. qwen3:8b'),
          ariaLabel: jt('settings.modelLibrary.tagAria', 'Ollama model tag'),
          className: 'model-library-section-pull-input',
          dataset: { 'model-library-section-input': 'pull-tag' },
        })
        + d.inventoryActionButton({
          id: 'pull-tag',
          label: jt('settings.modelLibrary.pull', 'Pull'),
          variant: 'secondary',
          size: 'sm',
          dataset: { 'model-library-section-action': 'pull-tag' },
        })
        + d.inventoryActionButton({
          id: 'refresh',
          label: '↻',
          ariaLabel: jt('settings.modelLibrary.refreshCatalog', 'Refresh catalog'),
          variant: 'ghost',
          size: 'sm',
          className: 'model-library-section-refresh',
          dataset: { 'model-library-section-action': 'refresh' },
        })
        + '</div></div>'
        + viewModule.buildHardwareSummaryLine(modelView.hardware, { pending: d.hardwarePending() });
    }

    function extrasHtml() {
      var engineBlocks = d.getEngineBlocks();
      return (d.accelerationFlagEnabled() ? '<div id="modelLibraryFoldersHost"></div>' : '')
        + (engineBlocks ? engineBlocks.hostsHtml() : '');
    }

    function renderToolbar() {
      if (d.isDisposed()) return;
      var target = d.toolbarHost();
      if (!target) return;
      var extras = d.extrasHost();
      var activeElement = documentRef.activeElement;
      // The GGUF folders row is rebuilt with the toolbar: its focused control
      // gets the focus back, like the pull input.
      var folderScope = extras || target;
      var folderAction = activeElement && folderScope.contains(activeElement)
        ? activeElement.getAttribute?.('data-model-library-folder-action') || '' : '';
      var preservePullFocus = activeElement
        && activeElement.getAttribute?.('data-model-library-section-input') === 'pull-tag';
      var pullFocus = preservePullFocus ? {
        value: String(activeElement.value || ''),
        selectionStart: activeElement.selectionStart,
        selectionEnd: activeElement.selectionEnd,
        selectionDirection: activeElement.selectionDirection,
      } : null;
      if (pullFocus) view.pullTag = pullFocus.value;
      target.innerHTML = toolbarHtml() + (extras ? '' : extrasHtml());
      if (extras) extras.innerHTML = extrasHtml();
      d.renderFolders();
      var engineBlocks = d.getEngineBlocks();
      if (engineBlocks) engineBlocks.render();
      if (pullFocus) {
        var nextInput = target.querySelector('[data-model-library-section-input="pull-tag"]');
        if (nextInput) {
          nextInput.value = pullFocus.value;
          focusQuietly(nextInput);
          if (typeof nextInput.setSelectionRange === 'function'
            && Number.isInteger(pullFocus.selectionStart)
            && Number.isInteger(pullFocus.selectionEnd)) {
            nextInput.setSelectionRange(
              pullFocus.selectionStart,
              pullFocus.selectionEnd,
              pullFocus.selectionDirection || 'none'
            );
          }
        }
      } else if (folderAction) {
        var nextControl = Array.from(folderScope.querySelectorAll('[data-model-library-folder-action]')).find(function (control) {
          return control.getAttribute('data-model-library-folder-action') === folderAction;
        });
        if (nextControl) focusQuietly(nextControl);
      }
    }

    function renderRows() {
      d.hideMenu();
      if (d.isDisposed()) return;
      var target = d.host();
      if (!target) return;
      var activeElement = documentRef.activeElement;
      var activeRow = activeElement && target.contains(activeElement)
        ? activeElement.closest?.('[data-model-key]') : null;
      var rowFocus = activeRow ? {
        action: activeElement.getAttribute?.('data-model-card-action') || '',
        key: activeRow.getAttribute('data-model-key') || '',
      } : null;
      var modelView = d.getMerged() || { hardware: {}, cards: [] };
      target.innerHTML = viewModule.buildModelGrid(modelView, {
        filter: view.filter,
        actions: d.actions,
        pulls: d.currentPulls(),
        compact: false,
        activation: d.activationState(),
      });
      var duplicateHardware = target.querySelector(
        '.model-library-view > .model-library-hardware-summary'
      );
      if (duplicateHardware) duplicateHardware.remove();
      var duplicateChips = target.querySelector('.model-library-view > .model-library-filter-chips');
      if (duplicateChips) duplicateChips.remove();
      if (rowFocus && rowFocus.action && rowFocus.key) {
        var nextRow = Array.from(target.querySelectorAll('[data-model-key]')).find(
          function (candidate) {
            return candidate.getAttribute('data-model-key') === rowFocus.key;
          }
        );
        var nextAction = nextRow && nextRow.querySelector(
          '[data-model-card-action="' + rowFocus.action + '"]'
        );
        if (nextAction) focusQuietly(nextAction);
      }
      d.renderConfirmModal();
    }

    // Progress ticks patch one row in place; group membership only changes on
    // 'done', which goes through the section's refresh().
    function replaceRow(key) {
      var section = d.host();
      var model = d.findModel(key);
      if (!section || !model) return false;
      var element = Array.from(section.querySelectorAll('[data-model-key]')).find(function (candidate) {
        return candidate.getAttribute('data-model-key') === key;
      });
      if (!element) return false;
      var pulls = d.currentPulls();
      var merged = d.getMerged();
      element.outerHTML = viewModule.buildModelRow(Object.assign({}, model, {
        budgetMb: Number(merged && merged.hardware && merged.hardware.budgetMb) || 0,
      }), {
        actions: d.actions,
        pull: pulls[key] || {},
        activation: d.activationState(),
      });
      return true;
    }

    return { renderToolbar: renderToolbar, renderRows: renderRows, replaceRow: replaceRow };
  }

  return { createModelLibrarySectionRender: createModelLibrarySectionRender, focusQuietly: focusQuietly };
});
