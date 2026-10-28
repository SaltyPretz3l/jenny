/* Model Library section › a card's ⋯ menu (Remove… or Remove from library,
 * Copy tag) and the options the card's Tune button hands the tuning drawer.
 * This helper owns whether the shared context menu is one it opened. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.modelLibrarySectionMenu = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  // deps: { windowRef, documentRef, state, contextMenu, isLibraryTag(tag),
  //   focusQuietly(element), card(), host(), toolbarHost(), folders(),
  //   isDisposed(), setStatusMessage(text), ninferLibraryInput(),
  //   getSourceData(), requestRemove(tag) }
  function createModelLibrarySectionMenu(deps) {
    var d = deps || {};
    var windowRef = d.windowRef;
    var documentRef = d.documentRef;
    var state = d.state || {};
    var focusQuietly = d.focusQuietly;
    var setStatusMessage = d.setStatusMessage;

    // inventoryContextMenu is a process-wide singleton, so this controller may
    // only dismiss a menu it opened itself - a background render must never
    // close (and steal focus from) an Explorer or chat menu. show() dismisses
    // any prior menu first, firing its onHide, so this flag cannot go stale.
    var menuOpen = false;

    function hideOwnContextMenu() {
      if (!menuOpen) return;
      menuOpen = false;
      d.contextMenu?.hide?.();
    }

    // The library GGUF behind a card: its saved entry, named by a
    // library-shaped tag. Nothing else (an Ollama model's engine setting)
    // ever offers Remove from library.
    function libraryTagOf(model) {
      var entry = model && model.libraryGguf === true
        ? state.localEngines?.openaiCompatible?.managed?.perModel?.[model.managedKey] : null;
      var tag = entry && typeof entry.tag === 'string' ? entry.tag : '';
      return d.isLibraryTag(tag) ? tag : '';
    }

    // ⋯ ▸ Remove from library. Once it settles, a focus the re-render dropped
    // goes back to the card's ⋯, else to the card now in its place.
    function removeFromLibrary(tag, control) {
      var controller = d.folders();
      if (!controller) return null;
      var focused = documentRef.activeElement === control;
      var row = control.closest('[data-model-key]');
      var rows = row && d.host() ? Array.from(d.host().querySelectorAll('[data-model-key]')) : [];
      var index = rows.indexOf(row);
      var keys = index < 0 ? [] : [rows[index], rows[index + 1], rows[index - 1]].filter(Boolean)
        .map(function (element) { return element.getAttribute('data-model-key'); });
      return controller.removeLibraryModel(tag).then(function (removed) {
        if (focused && !d.isDisposed()) restoreCardFocus(keys);
        return removed;
      });
    }

    function restoreCardFocus(keys) {
      var active = documentRef.activeElement;
      var section = d.host();
      if (!section || (active && active !== documentRef.body && active.isConnected !== false)) return;
      var rowsByKey = Object.create(null);
      Array.from(section.querySelectorAll('[data-model-key]')).forEach(function (element) {
        var key = element.getAttribute('data-model-key');
        if (!rowsByKey[key]) rowsByKey[key] = element;
      });
      for (var i = 0; i < keys.length; i += 1) {
        var match = rowsByKey[keys[i]];
        var target = match && (match.querySelector('[data-model-card-action="menu"]')
          || match.querySelector('[data-model-card-action]'));
        if (target) {
          focusQuietly(target);
          return;
        }
      }
      // No card left in view (the last one under a filter): the pressed filter
      // chip, else Add GGUF model…, so focus never falls to the page.
      var toolbar = d.toolbarHost();
      var fallback = toolbar && (toolbar.querySelector('.model-library-filter-chips [aria-pressed="true"]')
        || toolbar.querySelector('[data-model-library-folder-action="add-model"]'));
      if (fallback) focusQuietly(fallback);
    }

    function copyTag(tag) {
      var writeText = windowRef.navigator?.clipboard?.writeText;
      if (typeof writeText !== 'function') {
        setStatusMessage(jt('settings.modelLibrary.clipboardUnavailable', 'Clipboard access is unavailable right now.'));
        return null;
      }
      return Promise.resolve(writeText.call(windowRef.navigator.clipboard, tag))
        .then(function () {
          if (!d.isDisposed()) setStatusMessage(jt('settings.modelLibrary.copiedTag', 'Copied {tag}', { tag: tag }));
          return null;
        })
        .catch(function () {
          if (!d.isDisposed()) setStatusMessage(jt('settings.modelLibrary.copyFailed', 'Could not copy {tag} to the clipboard.', { tag: tag }));
          return null;
        });
    }

    // The ⋯ menu for one card; `tag` is the card's data-model-tag.
    function open(model, tag, anchor) {
      var libraryTag = libraryTagOf(model);
      d.contextMenu.show({
        rootEl: d.card(),
        anchorEl: anchor,
        restoreFocusTo: anchor,
        onHide: function () { menuOpen = false; },
        items: [
          libraryTag ? {
            // A library GGUF only leaves the library: its file stays on
            // disk, and a model in use keeps its entry.
            label: jt('settings.modelLibrary.removeFromLibrary', 'Remove from library'),
            danger: true,
            disabled: model.active === true || model.serving === true,
            action: function () { return removeFromLibrary(libraryTag, anchor); },
          } : {
            // Same gate the standalone Remove button carried: ollama only,
            // and never the loaded model (the main process rejects that
            // delete with model_in_use, so offering it is a dead end).
            label: jt('settings.modelLibrary.removeMenu', 'Remove…'),
            danger: true,
            disabled: String(model.engineType || '').toLowerCase() !== 'ollama'
              || model.active === true,
            action: function () { d.requestRemove(tag); },
          },
          {
            // Returned so the menu wrapper owns the rejection and the
            // status line reports what actually happened - a denied or
            // absent clipboard must not read as a successful copy.
            label: jt('settings.modelLibrary.copyTag', 'Copy tag'),
            action: function () { return copyTag(tag); },
          },
        ],
      });
      menuOpen = true;
    }

    // A pin's window list: context_windows, or fp8_kv_windows (the drawer labels their 8-bit cache).
    function ninferPinWindows(model, key) {
      var pin = (d.ninferLibraryInput()?.pins || []).find(function (entry) { return entry.id === model.ninferArtifactId; });
      return Array.isArray(pin?.[key]) ? pin[key] : [];
    }

    // While Ollama's tag list is unreadable nobody knows whether Ollama has
    // the model: the drawer gets no Ollama facts (it reads that as unknown),
    // and keeps the llama-server ones.
    function tuneEngines(model) {
      var engines = model && model.engines ? model.engines : null;
      var sourceData = d.getSourceData();
      return engines && sourceData && sourceData.unavailable && sourceData.unavailable.ollamaTags
        ? Object.assign({}, engines, { ollama: null }) : engines;
    }

    // The card's merged engine facts (Ollama/GGUF availability) seed the
    // drawer so both surfaces agree on what can run this model. A library
    // GGUF is in no model list until served, so its engine type rides along.
    function tuneOptions(tuned) {
      return {
        displayName: tuned?.displayName || '',
        engines: tuneEngines(tuned),
        engineTypeHint: tuned?.libraryGguf || tuned?.selectedEngine === 'ninfer' ? 'openai-compatible' : '',
        // An NInfer row: the drawer shows the NInfer section (context + MTP) instead of the Engine one.
        ninfer: tuned?.selectedEngine === 'ninfer' ? { artifactId: tuned.ninferArtifactId, modelId: tuned.tag, contextWindows: ninferPinWindows(tuned, 'context_windows'), fp8KvWindows: ninferPinWindows(tuned, 'fp8_kv_windows'), supportsMtp: tuned.mtp?.eligible === true } : null,
      };
    }

    return { open: open, hide: hideOwnContextMenu, tuneOptions: tuneOptions };
  }

  return { createModelLibrarySectionMenu: createModelLibrarySectionMenu };
});
