/* GGUF library-root controls for the Settings Model library toolbar. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererModelLibraryFolders = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function resolveActionButton() {
    return (root && root.inventoryActionButton)
      || (typeof require === 'function' ? require('../inventory/action-button') : null);
  }

  function createModelLibraryFoldersController(options) {
    var opts = options || {};
    var windowRef = opts.windowRef || root;
    var documentRef = opts.documentRef || windowRef.document || null;
    var getRoots = typeof opts.getRoots === 'function' ? opts.getRoots : function emptyRoots() { return []; };
    var onSettings = typeof opts.onSettings === 'function' ? opts.onSettings : function noop() {};
    var refresh = typeof opts.refresh === 'function' ? opts.refresh : function noop() {};
    var hostId = String(opts.hostId || '');
    var actionButton = resolveActionButton();
    var escapeHtml = actionButton && actionButton.escapeHtml;
    var boundHost = null;
    var disposed = false;
    var generation = 0;
    var statusText = '';

    if (typeof actionButton !== 'function' || typeof escapeHtml !== 'function') {
      throw new Error('renderer-model-library-folders: missing required dependency');
    }

    function host() {
      return documentRef && documentRef.getElementById
        ? documentRef.getElementById(hostId) : null;
    }

    function roots() {
      var values = getRoots();
      return Array.isArray(values) ? values.map(function (value) {
        return String(value || '').trim();
      }).filter(Boolean) : [];
    }

    function rowHtml(path, index) {
      return '<div class="model-library-folders-row">'
        + '<code class="model-library-folders-path">' + escapeHtml(path) + '</code>'
        + actionButton({
          label: 'Remove',
          variant: 'ghost',
          size: 'sm',
          dataset: { 'model-library-folder-remove': String(index) },
        })
        + '</div>';
    }

    function render() {
      if (disposed) return;
      var target = host();
      if (!target) return;
      var currentRoots = roots();
      var rowsHtml = currentRoots.length
        ? currentRoots.map(rowHtml).join('')
        : '<span class="model-library-folders-empty">No folders yet · llama-server finds mtp-*.gguf drafters beside the models in these folders</span>';
      target.innerHTML = '<div class="model-library-folders">'
        + '<span class="model-library-folders-title">GGUF folders</span>'
        + '<div class="model-library-folders-list">' + rowsHtml + '</div>'
        + actionButton({
          label: 'Add folder…',
          variant: 'secondary',
          size: 'sm',
          dataset: { 'model-library-folder-action': 'add' },
        })
        + '<span class="model-library-folders-status" aria-live="polite">'
        + escapeHtml(statusText) + '</span>'
        + '</div>';
    }

    function isCurrent(token) {
      return !disposed && generation === token;
    }

    function updateRoots(nextRoots, token) {
      var engines = windowRef.jennyShell && windowRef.jennyShell.engines;
      if (!engines || typeof engines.updateSettings !== 'function') return Promise.resolve(null);
      return Promise.resolve(engines.updateSettings({ managed: { libraryRoots: nextRoots } }))
        .then(function (result) {
          if (!isCurrent(token)) return null;
          if (result && result.localEngines) onSettings(result.localEngines);
          return refresh();
        })
        .catch(function () {
          if (!isCurrent(token)) return null;
          statusText = 'Could not update GGUF folders.';
          render();
          return null;
        });
    }

    function addFolder() {
      var token = ++generation;
      var llamaServer = windowRef.jennyShell && windowRef.jennyShell.llamaServer;
      var choose = llamaServer && llamaServer.chooseLibraryFolder;
      if (typeof choose !== 'function') {
        statusText = 'Could not open the folder picker.';
        render();
        return Promise.resolve(null);
      }
      return Promise.resolve().then(function () {
        return choose.call(llamaServer);
      }).then(function (result) {
        if (!isCurrent(token)) return null;
        if (result && result.ok !== false && result.path) {
          statusText = '';
          return updateRoots(roots().concat([result.path]), token);
        }
        if (result && result.ok === false) {
          statusText = 'Could not open the folder picker.';
          render();
        }
        return null;
      }).catch(function () {
        if (!isCurrent(token)) return null;
        statusText = 'Could not open the folder picker.';
        render();
        return null;
      });
    }

    function removeFolder(index) {
      var currentRoots = roots();
      if (!Number.isInteger(index) || index < 0 || index >= currentRoots.length) return;
      var token = ++generation;
      currentRoots.splice(index, 1);
      void updateRoots(currentRoots, token);
    }

    function handleClick(event) {
      var target = event && event.target;
      if (!target || typeof target.closest !== 'function') return;
      var add = target.closest('[data-model-library-folder-action="add"]');
      if (add && boundHost && boundHost.contains(add)) {
        void addFolder();
        return;
      }
      var remove = target.closest('[data-model-library-folder-remove]');
      if (remove && boundHost && boundHost.contains(remove)) {
        removeFolder(Number(remove.getAttribute('data-model-library-folder-remove')));
      }
    }

    function bind() {
      if (disposed) return;
      var nextHost = host();
      if (boundHost === nextHost) return;
      if (boundHost) boundHost.removeEventListener('click', handleClick);
      boundHost = nextHost;
      if (boundHost) boundHost.addEventListener('click', handleClick);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      if (boundHost) boundHost.removeEventListener('click', handleClick);
      boundHost = null;
    }

    return { render: render, bind: bind, dispose: dispose };
  }

  return { createModelLibraryFoldersController: createModelLibraryFoldersController };
});
