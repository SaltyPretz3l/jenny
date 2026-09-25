/* GGUF library-root controls for the Settings Model library toolbar. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererModelLibraryFolders = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  // Main keeps the first 64 perModel entries by key, so a 65th evicts one.
  var MAX_SAVED_MODELS = 64;

  function resolveActionButton() {
    return (root && root.inventoryActionButton)
      || (typeof require === 'function' ? require('../inventory/action-button') : null);
  }

  function resolveMergeUtils() {
    return (root && root.modelLibraryMerge)
      || (typeof require === 'function' ? require('./model-library/model-library-merge') : null);
  }

  function resolveSources() {
    return (root && root.modelLibrarySources)
      || (typeof require === 'function' ? require('./model-library/model-library-sources') : null);
  }

  // The Tune drawer's engine utils load after this file, so they resolve when
  // a pick needs them rather than when the module loads.
  function resolveEngineUtils() {
    return (root && root.rendererModelTuningEngineUtils)
      || (typeof require === 'function' ? require('./renderer-model-tuning-engine-utils') : null);
  }

  // llama.cpp loads a split model from its first shard only, so a pick of any
  // shard stands for its "-00001-of-NNNNN" sibling in the same folder.
  function firstShardPath(filePath) {
    return String(filePath == null ? '' : filePath).replace(/-\d{5}(-of-\d{5}\.gguf)$/i, '-00001$1');
  }

  // A folder main keeps as lastPickDir. Main saves '' for anything else, and
  // so wipes the folder it had ("C:" is not absolute).
  function usableFolder(dir) {
    var value = typeof dir === 'string' ? dir.trim() : '';
    return /^(?:[a-z]:[\\/]|[\\/])/i.test(value) ? value : '';
  }

  function savedPerModel(localEngines) {
    var saved = localEngines && localEngines.openaiCompatible && localEngines.openaiCompatible.managed
      && localEngines.openaiCompatible.managed.perModel;
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : null;
  }

  // Main's answer no longer has the key.
  function keyGone(localEngines, key) {
    var saved = savedPerModel(localEngines);
    return Boolean(saved && !Object.prototype.hasOwnProperty.call(saved, key));
  }

  function createModelLibraryFoldersController(options) {
    var opts = options || {};
    var windowRef = opts.windowRef || root;
    var documentRef = opts.documentRef || windowRef.document || null;
    var getRoots = typeof opts.getRoots === 'function' ? opts.getRoots : function emptyRoots() { return []; };
    // What an added model must not collide with: the saved managed settings,
    // plus the Ollama tags and installed models as last loaded, and which of
    // those reads failed.
    var getLibrary = typeof opts.getLibrary === 'function' ? opts.getLibrary : function emptyLibrary() { return {}; };
    var onSettings = typeof opts.onSettings === 'function' ? opts.onSettings : function noop() {};
    var refresh = typeof opts.refresh === 'function' ? opts.refresh : function noop() {};
    // "Remove from library" runs from a card's ⋯ menu, so it reports on the
    // host's status line when there is one. This row's own buttons (Add
    // folder…, Add GGUF model…) always report in the span beside them.
    var setStatus = typeof opts.setStatus === 'function' ? opts.setStatus : showOwnStatus;
    var hostId = String(opts.hostId || '');
    var actionButton = resolveActionButton();
    var escapeHtml = actionButton && actionButton.escapeHtml;
    var mergeUtils = resolveMergeUtils();
    var sources = resolveSources();
    var boundHost = null;
    var disposed = false;
    // Add folder… and a folder's Remove: the latest answer wins. An Add GGUF
    // model… or a Remove from library keeps its own answer.
    var generation = 0;
    // One Add GGUF model… at a time: a click while one runs is ignored.
    var adding = false;
    // The row's live region, made once and moved into every render, so each
    // message is written, and announced, once.
    var statusNode = null;

    if (typeof actionButton !== 'function' || typeof escapeHtml !== 'function'
      || !mergeUtils || typeof mergeUtils.managedModelKey !== 'function'
      || typeof mergeUtils.entryTag !== 'function'
      || !sources || typeof sources.libraryTagFromPath !== 'function'
      || typeof sources.isLibraryTag !== 'function'
      || typeof sources.isAuxiliaryGguf !== 'function'
      || typeof sources.sameModelPath !== 'function'
      || typeof sources.sharesModelName !== 'function') {
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

    function liveRegion() {
      if (!statusNode && documentRef && typeof documentRef.createElement === 'function') {
        statusNode = documentRef.createElement('span');
        statusNode.className = 'model-library-folders-status';
        statusNode.setAttribute('aria-live', 'polite');
      }
      return statusNode;
    }

    function showOwnStatus(message) {
      var region = liveRegion();
      if (region) region.textContent = String(message || '');
    }

    function rowHtml(path, index) {
      return '<div class="model-library-folders-row">'
        + '<code class="model-library-folders-path">' + escapeHtml(path) + '</code>'
        + actionButton({
          label: jt('common.remove', 'Remove'),
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
        : '<span class="model-library-folders-empty">' + escapeHtml(jt('models.library.folders.empty', 'No folders yet · llama-server finds mtp-*.gguf drafters beside the models in these folders')) + '</span>';
      target.innerHTML = '<div class="model-library-folders">'
        + '<span class="model-library-folders-title">' + escapeHtml(jt('models.library.folders.title', 'GGUF folders')) + '</span>'
        + '<div class="model-library-folders-list">' + rowsHtml + '</div>'
        + '<div class="model-library-folders-actions">'
        + actionButton({
          label: jt('models.library.folders.add', 'Add folder…'),
          variant: 'secondary',
          size: 'sm',
          dataset: { 'model-library-folder-action': 'add' },
        })
        + actionButton({
          label: jt('models.library.folders.addModel', 'Add GGUF model…'),
          variant: 'secondary',
          size: 'sm',
          dataset: { 'model-library-folder-action': 'add-model' },
        })
        + '</div>'
        + '</div>';
      var region = liveRegion();
      if (region && target.firstElementChild) target.firstElementChild.appendChild(region);
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
          if (isCurrent(token)) showOwnStatus(jt('models.library.folders.updateFailed', 'Could not update GGUF folders.'));
          return null;
        });
    }

    function addFolder() {
      var token = ++generation;
      var llamaServer = windowRef.jennyShell && windowRef.jennyShell.llamaServer;
      var choose = llamaServer && llamaServer.chooseLibraryFolder;
      var pickerFailed = jt('models.library.folders.pickerFailed', 'Could not open the folder picker.');
      if (typeof choose !== 'function') {
        showOwnStatus(pickerFailed);
        return Promise.resolve(null);
      }
      return Promise.resolve().then(function () {
        return choose.call(llamaServer);
      }).then(function (result) {
        if (!isCurrent(token)) return null;
        if (result && result.ok !== false && result.path) {
          showOwnStatus('');
          return updateRoots(roots().concat([result.path]), token);
        }
        if (result && result.ok === false) {
          // Main refuses a folder on another machine; a mapped drive letter works.
          showOwnStatus(result.reason === 'network_path'
            ? jt('models.library.networkPath', 'Jenny can\'t use network locations here. Map the share to a drive letter, then choose it from that drive.')
            : pickerFailed);
        }
        return null;
      }).catch(function () {
        if (isCurrent(token)) showOwnStatus(pickerFailed);
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

    function library() {
      var source = getLibrary() || {};
      var managed = source.managed && typeof source.managed === 'object' ? source.managed : {};
      return {
        managed: managed,
        perModel: managed.perModel && typeof managed.perModel === 'object' ? managed.perModel : {},
        ollamaTags: Array.isArray(source.ollamaTags) ? source.ollamaTags : [],
        installed: Array.isArray(source.installed) ? source.installed : [],
        unavailable: source.unavailable && typeof source.unavailable === 'object' ? source.unavailable : {},
      };
    }

    // An "Add GGUF model…" outcome, beside its button (as Add folder… reports).
    function announce(message) {
      if (!disposed) showOwnStatus(message);
      return null;
    }

    // A "Remove from library" outcome, on the host's status line.
    function report(message) {
      if (!disposed) setStatus(message);
      return null;
    }

    // The saved entry that already answers to this model's name: its own key
    // first, then any entry that would share its card.
    function savedEntryNamed(perModel, key, tag) {
      var own = perModel[key];
      if (own && typeof own === 'object') return own;
      var keys = Object.keys(perModel);
      for (var i = 0; i < keys.length; i += 1) {
        var entry = perModel[keys[i]];
        if (entry && typeof entry === 'object' && sources.sharesModelName(entry.tag, tag)) return entry;
      }
      return null;
    }

    // Ollama tags the load could not read are read again for the collision
    // check. If Ollama still does not answer the Add goes ahead: a machine
    // without Ollama must be able to add models.
    function currentOllamaTags(current) {
      var models = windowRef.jennyShell && windowRef.jennyShell.models;
      if (!current.unavailable.ollamaTags || !models || typeof models.listOllamaTags !== 'function') {
        return Promise.resolve(current.ollamaTags);
      }
      return Promise.resolve().then(function () {
        return models.listOllamaTags();
      }).then(function (result) {
        return result && result.available !== false && Array.isArray(result.data) ? result.data : current.ollamaTags;
      }, function () {
        return current.ollamaTags;
      });
    }

    // Takes back out an entry main kept only part of. It resolves true once
    // main's answer no longer has the key.
    function rollBack(engines, key) {
      var perModel = {};
      perModel[key] = null;
      return Promise.resolve().then(function () {
        return engines.updateSettings({ managed: { perModel: perModel } });
      }).then(function (result) {
        var localEngines = result && result.localEngines;
        if (!disposed && localEngines) onSettings(localEngines);
        return keyGone(localEngines, key);
      }, function () {
        return false;
      });
    }

    // Sends the entry and trusts only what main echoes back. A write main
    // kept (or may have kept) only part of is rolled back, so a failed Add
    // never leaves an entry that owns the name without a card.
    function sendModel(engines, engineUtils, add) {
      var addFailed = jt('models.library.folders.addFailed', 'Could not add the model.');
      var entry = { engine: 'llama-server', tag: add.tag, modelPath: add.modelPath, mtp: { mode: 'off' } };
      var perModel = {};
      perModel[add.key] = entry;
      var managed = { enabled: true, perModel: perModel };
      if (add.lastPickDir) managed.lastPickDir = add.lastPickDir;
      function failed() {
        return (add.existed ? Promise.resolve(false) : rollBack(engines, add.key)).then(function () {
          return announce(addFailed);
        });
      }
      return Promise.resolve().then(function () {
        return engines.updateSettings({ managed: managed });
      }).then(function (result) {
        if (disposed) return null;
        var localEngines = result && result.localEngines;
        // The echo is main's truth whether or not it kept the entry.
        if (localEngines) onSettings(localEngines);
        if (!engineUtils.returnedEntryMatches(localEngines, add.key, entry)) {
          return keyGone(localEngines, add.key) ? announce(addFailed) : failed();
        }
        announce(jt('models.library.folders.added', 'Added {model}.', { model: add.tag }));
        // Main lists a saved file's folder only on its next scan, so a refresh
        // brings the card its size. It rewrites only the host's status line,
        // and a failed one leaves the add standing.
        void Promise.resolve().then(function () {
          return refresh();
        }).catch(function () {
          return null;
        });
        return null;
      }, function () {
        return disposed ? null : failed();
      });
    }

    // Checks a picked file before any write: nothing for a projector or
    // drafter, for a name another model already answers to, or past main's
    // 64 saved models.
    function writeModel(filePath, pickedDir, engineUtils) {
      var addFailed = jt('models.library.folders.addFailed', 'Could not add the model.');
      if (sources.isAuxiliaryGguf(filePath)) {
        return announce(jt('models.library.folders.notMainModel', "That file is a vision projector or MTP drafter, not a model. Choose the model's main .gguf file."));
      }
      var modelPath = firstShardPath(filePath);
      var tag = sources.libraryTagFromPath(modelPath);
      var key = tag ? mergeUtils.managedModelKey(tag) : '';
      if (!key) return announce(addFailed);
      var current = library();
      var saved = savedEntryNamed(current.perModel, key, tag);
      if (saved && sources.sameModelPath(firstShardPath(saved.modelPath), modelPath)) {
        return announce(jt('models.library.folders.alreadyAdded', '{model} is already in the library.', { model: String(saved.tag || tag) }));
      }
      var taken = jt('models.library.folders.nameTaken', 'Another model is already named {model}. Rename the file, then add it.', { model: tag });
      if (saved) return announce(taken);
      var engines = windowRef.jennyShell && windowRef.jennyShell.engines;
      if (!engines || typeof engines.updateSettings !== 'function') return announce(addFailed);
      return currentOllamaTags(current).then(function (ollamaTags) {
        if (disposed) return null;
        var owned = ollamaTags.concat(current.installed).some(function (item) {
          return sources.sharesModelName(mergeUtils.entryTag(item), tag);
        });
        if (owned) return announce(taken);
        var existed = Object.prototype.hasOwnProperty.call(current.perModel, key);
        if (!existed && Object.keys(current.perModel).length >= MAX_SAVED_MODELS) return announce(addFailed);
        return sendModel(engines, engineUtils, {
          tag: tag, key: key, modelPath: modelPath, lastPickDir: usableFolder(pickedDir), existed: existed,
        });
      });
    }

    // "Add GGUF model…": pick a main .gguf file and add it as a library model.
    function addModel() {
      if (disposed || adding) return Promise.resolve(null);
      var llamaServer = windowRef.jennyShell && windowRef.jennyShell.llamaServer;
      var choose = llamaServer && llamaServer.chooseGguf;
      var engineUtils = resolveEngineUtils();
      var pickerFailed = jt('models.library.tuning.pickerFailed', 'Could not open the file picker.');
      if (typeof choose !== 'function' || !engineUtils) return Promise.resolve(announce(pickerFailed));
      var defaultPath = String(library().managed.lastPickDir || roots()[0] || '');
      adding = true;
      // The dialog opens within the click, so a dispose can only drop its answer.
      return new Promise(function (resolve) {
        resolve(choose.call(llamaServer, { defaultPath: defaultPath }));
      }).then(function (result) {
        if (disposed) return null;
        if (result && result.ok === false) return announce(engineUtils.pickerFailureText(result));
        var filePath = result && typeof result.path === 'string' ? result.path : '';
        // A cancelled pick writes nothing and says nothing.
        return filePath ? writeModel(filePath, result.dir, engineUtils) : null;
      }, function () {
        return announce(pickerFailed);
      }).catch(function () {
        return announce(jt('models.library.folders.addFailed', 'Could not add the model.'));
      }).then(function (outcome) {
        adding = false;
        return outcome;
      });
    }

    // ⋯ ▸ "Remove from library" drops the model's managed entry and nothing
    // else: the file stays on disk (never models.delete), and main clears a
    // lastUsedTag that named the entry. Only a library GGUF's tag qualifies.
    function removeLibraryModel(tag) {
      if (disposed) return Promise.resolve(false);
      var name = String(tag == null ? '' : tag).trim();
      var key = sources.isLibraryTag(name) ? mergeUtils.managedModelKey(name) : '';
      var engines = windowRef.jennyShell && windowRef.jennyShell.engines;
      var failed = jt('models.library.folders.removeFailed', 'Could not remove {model} from the library.', { model: name });
      if (!key || !engines || typeof engines.updateSettings !== 'function') {
        report(failed);
        return Promise.resolve(false);
      }
      var perModel = {};
      perModel[key] = null;
      return Promise.resolve().then(function () {
        return engines.updateSettings({ managed: { perModel: perModel } });
      }).then(function (result) {
        if (disposed) return false;
        var localEngines = result && result.localEngines;
        var removed = keyGone(localEngines, key);
        if (localEngines) onSettings(localEngines);
        report(removed
          ? jt('models.library.folders.removed', 'Removed {model} from the library. The file is still on disk.', { model: name })
          : failed);
        return removed;
      }).catch(function () {
        report(failed);
        return false;
      });
    }

    function handleClick(event) {
      var target = event && event.target;
      if (!target || typeof target.closest !== 'function') return;
      var add = target.closest('[data-model-library-folder-action="add"]');
      if (add && boundHost && boundHost.contains(add)) {
        void addFolder();
        return;
      }
      var addModelButton = target.closest('[data-model-library-folder-action="add-model"]');
      if (addModelButton && boundHost && boundHost.contains(addModelButton)) {
        void addModel();
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

    return { render: render, bind: bind, dispose: dispose, removeLibraryModel: removeLibraryModel };
  }

  return { createModelLibraryFoldersController: createModelLibraryFoldersController };
});
