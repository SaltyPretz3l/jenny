/* Row 142 S2: Settings > Models, the "llama-server builds" folder list under the GGUF folders.
 * Built on the shared pieces of model-library-runtime-builds.js. Every answer from main is dropped
 * once the list was disposed. The renderer sends only the saved folder list, never a path of its own. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.modelLibraryRuntimeFolders = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function shared() {
    return (root && root.modelLibraryRuntimeBuilds)
      || (typeof require === 'function' ? require('./model-library-runtime-builds') : null);
  }
  var builds = shared() || {};
  var hasBridge = builds.hasBridge;
  var invoke = builds.invoke;
  var positive = builds.positive;
  var sameFolder = builds.sameFolder;
  var addRuntimeFolder = builds.addRuntimeFolder;
  var folderRefusalText = builds.folderRefusalText;
  var addFolderText = builds.addFolderText;
  var MAX_FOLDERS = builds.MAX_FOLDERS;

  function resolveActionButton() {
    return (root && root.inventoryActionButton)
      || (typeof require === 'function' ? require('../../inventory/action-button') : null);
  }

  function buildsText(info) {
    var count = Number(info && info.builds) || 0;
    var newest = positive(info && info.newest);
    if (!count) return jt('models.library.runtimeFolders.noBuilds', 'No builds found');
    return count === 1
      ? jt('models.library.runtimeFolders.oneBuild', '1 build · {build}', { build: newest })
      : jt('models.library.runtimeFolders.builds', '{count} builds · newest {build}', { count: count, build: newest });
  }

  // options: windowRef, escapeHtml, actionButton, getRoots(), onSettings(localEngines), rerender(),
  // announce(message). html() is '' while the bridge is missing or main turned the feature off.
  function createRuntimeFolders(options) {
    var opts = options || {};
    var windowRef = opts.windowRef;
    var actionButton = opts.actionButton || resolveActionButton();
    var escapeHtml = opts.escapeHtml || (actionButton && actionButton.escapeHtml);
    var summary = null;
    var summarySignature = null;
    var hidden = false;
    var disposed = false;
    var adding = false;
    var chain = Promise.resolve();

    function roots() {
      var values = typeof opts.getRoots === 'function' ? opts.getRoots() : [];
      return Array.isArray(values) ? values.map(function (item) { return String(item || '').trim(); }).filter(Boolean) : [];
    }

    function available() {
      return !hidden && hasBridge(windowRef, 'chooseRuntimeFolder');
    }

    function say(message) {
      if (!disposed && typeof opts.announce === 'function') opts.announce(message);
    }

    // The counts are what main found the last time it looked; they follow the saved list.
    function ensureSummary(current) {
      var signature = current.join('\n');
      if (signature === summarySignature || !hasBridge(windowRef, 'runtimeFolderSummary')) return;
      summarySignature = signature;
      void invoke(windowRef, 'runtimeFolderSummary').then(function (answer) {
        if (disposed || summarySignature !== signature) return;
        if (answer && answer.ok === false && answer.reason === 'flag_off') {
          hidden = true;
        } else if (answer && Array.isArray(answer.folders)) {
          summary = answer.folders;
        } else {
          return;
        }
        opts.rerender();
      });
    }

    function infoFor(path) {
      var found = (summary || []).filter(function (item) { return item && sameFolder(item.path, path); });
      return found[0] || null;
    }

    function rowHtml(path, index) {
      var info = summary ? infoFor(path) : null;
      return '<div class="model-library-folders-row">'
        + '<code class="model-library-folders-path">' + escapeHtml(path) + '</code>'
        + (summary ? '<span class="model-library-folders-builds">' + escapeHtml(buildsText(info)) + '</span>' : '')
        + actionButton({ label: jt('common.remove', 'Remove'), variant: 'ghost', size: 'sm', dataset: { 'runtime-folder-remove': String(index) } })
        + '</div>';
    }

    function html() {
      if (disposed || !available()) return '';
      var current = roots();
      ensureSummary(current);
      var full = current.length >= MAX_FOLDERS;
      var rows = current.length
        ? current.map(rowHtml).join('')
        : '<span class="model-library-folders-empty">' + escapeHtml(jt('models.library.runtimeFolders.empty', 'None yet · Jenny uses the bundled build and any build you chose in Tune. A folder here can hold one llama.cpp build, or one folder per build.')) + '</span>';
      return '<div class="model-library-folders" data-runtime-folders>'
        + '<span class="model-library-folders-title">' + escapeHtml(jt('models.library.runtimeFolders.title', 'llama-server builds')) + '</span>'
        + '<div class="model-library-folders-list">' + rows + '</div>'
        + '<div class="model-library-folders-actions">'
        + actionButton({
          label: addFolderText(), variant: 'secondary', size: 'sm', disabled: full,
          title: full ? jt('models.library.runtimeFolders.full', 'Up to 8 folders') : '',
          dataset: { 'runtime-folder-action': 'add' },
        })
        + '</div></div>';
    }

    // Writes run in order against the saved list.
    function write(mutate) {
      var engines = windowRef.jennyShell && windowRef.jennyShell.engines;
      if (!engines || typeof engines.updateSettings !== 'function') return Promise.reject(new Error('unavailable'));
      var run = chain.then(function () {
        if (disposed) return null;
        var list = mutate(roots());
        return list ? engines.updateSettings({ managed: { runtimeRoots: list } }) : null;
      });
      chain = run.catch(function () {});
      return run.then(function (result) {
        if (!disposed && result && result.localEngines && typeof opts.onSettings === 'function') opts.onSettings(result.localEngines);
        return result;
      });
    }

    function add() {
      if (disposed || adding || roots().length >= MAX_FOLDERS) return Promise.resolve(null);
      adding = true;
      return addRuntimeFolder(windowRef, write).then(function (outcome) {
        adding = false;
        if (disposed) return null;
        if (outcome.state === 'added') say(jt('models.library.runtimeFolders.added', 'Added {folder}.', { folder: outcome.path }));
        else if (outcome.state === 'exists') say(jt('models.library.runtimeFolders.exists', '{folder} is already in the list.', { folder: outcome.path }));
        else if (outcome.state === 'refused') {
          if (outcome.reason === 'flag_off') hidden = true;
          else say(folderRefusalText(outcome.reason));
        } else if (outcome.state === 'failed') say(jt('models.library.runtimeFolders.updateFailed', 'Could not update the runtime folders.'));
        opts.rerender();
        return outcome;
      });
    }

    function remove(index) {
      var current = roots();
      if (disposed || !Number.isInteger(index) || index < 0 || index >= current.length) return Promise.resolve(null);
      var gone = current[index];
      return write(function (saved) {
        var at = saved.indexOf(gone);
        if (at < 0) return null;
        saved.splice(at, 1);
        return saved;
      }).then(function (result) {
        if (result) say(jt('models.library.runtimeFolders.removed', 'Removed {folder}.', { folder: gone }));
        opts.rerender();
        return result;
      }, function () {
        say(jt('models.library.runtimeFolders.updateFailed', 'Could not update the runtime folders.'));
        return null;
      });
    }

    function handleClick(target) {
      var control = target && typeof target.closest === 'function'
        ? target.closest('[data-runtime-folder-action],[data-runtime-folder-remove]') : null;
      if (!control) return false;
      if (control.getAttribute('data-runtime-folder-action') === 'add') void add();
      else void remove(Number(control.getAttribute('data-runtime-folder-remove')));
      return true;
    }

    return { html: html, add: add, handleClick: handleClick, dispose: function () { disposed = true; } };
  }

  return { createRuntimeFolders: createRuntimeFolders };
});
