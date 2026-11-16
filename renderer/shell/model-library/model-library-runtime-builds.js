/* Row 142 S2: pieces shared by the surfaces that deal with llama-server builds.
 * - createRemedies: "Use build N" buttons (or "Add runtime folder…" / "Get build N") under a
 *   failed model load, on the library row and in the Tune drawer's footer.
 * - createBuildDownload: the one poller behind "Get build N".
 * Every answer from main is dropped once its owner was cleared or disposed. The renderer never
 * sends a path: only a model tag, an option id, an architecture name and the saved folder list. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.modelLibraryRuntimeBuilds = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var POLL_MS = 1000;
  var MAX_FOLDERS = 8;
  // Polls in a row that answer "idle" before a started download is taken as gone.
  var MAX_IDLE_POLLS = 5;

  function resolveActionButton() {
    return (root && root.inventoryActionButton)
      || (typeof require === 'function' ? require('../../inventory/action-button') : null);
  }

  function size(bytes) {
    var utils = (root && root.rendererModelLibraryFormatUtils)
      || (typeof require === 'function' ? require('../renderer-model-library-format-utils') : null);
    return (utils && utils.formatHumanSize(bytes)) || '';
  }

  function llamaServer(windowRef) {
    return (windowRef && windowRef.jennyShell && windowRef.jennyShell.llamaServer) || null;
  }

  function hasBridge(windowRef, name) {
    var server = llamaServer(windowRef);
    return Boolean(server && typeof server[name] === 'function');
  }

  // A bridge call that never rejects: a missing method or a failure answers null.
  function invoke(windowRef, name, payload) {
    var server = llamaServer(windowRef);
    if (!server || typeof server[name] !== 'function') return Promise.resolve(null);
    return Promise.resolve().then(function () { return server[name](payload); }).catch(function () { return null; });
  }

  function positive(value) {
    var n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // runtimeOptions's answer, or null when main did not give one (flag off, unknown model, no bridge).
  function readOptions(answer) {
    if (!answer || answer.ok !== true) return null;
    var candidates = (Array.isArray(answer.candidates) ? answer.candidates : []).filter(function (item) {
      return item && typeof item.id === 'string' && item.id && positive(item.build);
    }).slice(0, 3).map(function (item) {
      return { id: item.id, build: positive(item.build), label: String(item.label || '') };
    });
    var offer = answer.download && positive(answer.download.build)
      ? { build: positive(answer.download.build), sizeBytes: positive(answer.download.sizeBytes) } : null;
    var current = answer.current && typeof answer.current === 'object' ? answer.current : {};
    return {
      candidates: candidates,
      download: offer,
      architecture: typeof answer.architecture === 'string' ? answer.architecture : '',
      current: { source: String(current.source || ''), build: positive(current.build), label: String(current.label || '') },
    };
  }

  function useBuildText(candidate) {
    return candidate.label === 'bundled'
      ? jt('models.library.tuning.useBundled', 'Use bundled')
      : jt('models.library.runtime.useBuild', 'Use build {build}', { build: candidate.build });
  }

  function addFolderText() {
    return jt('models.library.runtime.addFolder', 'Add runtime folder…');
  }

  function getBuildText(build) {
    return jt('models.library.runtime.getBuild', 'Get build {build}', { build: build });
  }

  function rowStartingText(build) {
    return jt('models.library.runtime.usingBuildForModel', 'Using build {build} for this model · starting…', { build: build });
  }

  function noOtherBuildRowText() {
    return jt('models.library.runtime.noOtherBuild', 'No other build Jenny knows may read it.');
  }

  function switchFailedText(build) {
    return jt('models.library.runtime.switchFailed', 'Couldn\'t switch to build {build}.', { build: build });
  }

  // ---- Get a build (download) wording ----
  function noSpaceText(needBytes, freeBytes) {
    return needBytes > 0
      ? jt('models.library.runtime.noSpace', 'Needs {need} free. {free} is free.', { need: size(needBytes), free: size(freeBytes) || '0 KB' })
      : jt('models.library.runtime.noSpaceShort', 'There is not enough free space.');
  }

  function localOnlyText() {
    return jt('models.library.runtime.localOnly', 'Local only is on, so Jenny downloads nothing.');
  }

  // runtimeDownloadStart refused.
  function refusalText(result) {
    var reason = String(result && result.reason || '');
    if (reason === 'local_only') return localOnlyText();
    if (reason === 'no_space') return noSpaceText(positive(result.needBytes), positive(result.freeBytes));
    if (reason === 'busy') return jt('models.library.runtime.downloadBusy', 'Another build is downloading.');
    return jt('models.library.runtime.downloadNotStarted', 'Couldn\'t start the download.');
  }

  // runtimeDownloadStatus said failed.
  function failureSub(status) {
    var reason = String(status && status.reason || '');
    if (reason === 'sha_mismatch' || reason === 'size_mismatch') return jt('models.library.runtime.downloadChecksum', 'The download didn\'t match its checksum, so Jenny deleted it.');
    if (reason === 'unsafe_entry' || reason === 'too_large') return jt('models.library.runtime.downloadArchive', 'The archive looked wrong, so Jenny deleted it.');
    if (reason === 'probe_failed') return jt('models.library.runtime.downloadProbe', 'The downloaded build didn\'t start.');
    if (reason === 'no_space') return noSpaceText(positive(status.needBytes), positive(status.freeBytes));
    if (reason === 'local_only') return localOnlyText();
    return jt('models.library.runtime.downloadStopped', 'The download stopped. Try again.');
  }

  // The words for one download state: { line, sub, percent }.
  function downloadParts(dl) {
    var build = dl.build;
    if (dl.phase === 'failed') {
      return { line: jt('models.library.runtime.getFailed', 'Couldn\'t get build {build}.', { build: build }), sub: failureSub(dl), percent: 0 };
    }
    if (dl.phase === 'ready') return { line: jt('models.library.runtime.buildReady', 'Build {build} is ready.', { build: build }), sub: '', percent: 100 };
    var checking = dl.step === 'verifying' || dl.step === 'extracting' || dl.step === 'probing';
    return {
      line: jt('models.library.runtime.gettingBuild', 'Getting build {build}', { build: build }),
      sub: checking
        ? jt('models.library.runtime.checkingBuild', 'Checking build {build}…', { build: build })
        : jt('models.library.runtime.downloadProgress', '{received} of {total}', { received: size(dl.received) || '0 KB', total: size(dl.total) || '?' }),
      percent: dl.total > 0 ? Math.min(100, Math.round((dl.received / dl.total) * 100)) : 0,
    };
  }

  function isRunning(dl) {
    return Boolean(dl && (dl.phase === 'starting' || dl.phase === 'running'));
  }

  // One poller for "Get build N". State: null, or { phase: 'starting'|'running'|'failed'|'ready'|'refused',
  // build, step, received, total, reason, message }. onChange fires on a phase or step change, onProgress
  // when only the byte counts moved. A cancelled or vanished download goes back to null.
  function createBuildDownload(options) {
    var opts = options || {};
    var windowRef = opts.windowRef;
    var onChange = typeof opts.onChange === 'function' ? opts.onChange : function () {};
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    var state = null;
    var timer = 0;
    var inFlight = false;
    var idlePolls = 0;
    var token = 0;
    var disposed = false;

    function set(next) {
      state = next;
      if (!disposed) onChange(state);
    }

    function stopPolling() {
      if (timer) windowRef.clearInterval(timer);
      timer = 0;
      inFlight = false;
    }

    function apply(status) {
      var step = String(status.state || '');
      var build = positive(status.build) || state.build;
      if (step === 'downloading' || step === 'verifying' || step === 'extracting' || step === 'probing') {
        idlePolls = 0;
        var changed = state.step !== step;
        state.step = step;
        state.build = build;
        state.received = positive(status.receivedBytes);
        state.total = positive(status.totalBytes);
        if (changed) onChange(state); else onProgress(state);
      } else if (step === 'ready') {
        stopPolling();
        set({ phase: 'ready', build: build });
      } else if (step === 'failed') {
        stopPolling();
        set({ phase: 'failed', build: build, reason: String(status.reason || ''), needBytes: status.needBytes, freeBytes: status.freeBytes });
      } else if (step === 'cancelled') {
        stopPolling();
        set(null);
      } else {
        idlePolls += 1;
        if (idlePolls >= MAX_IDLE_POLLS) {
          stopPolling();
          set(null);
        }
      }
    }

    function tick() {
      if (inFlight || disposed) return;
      inFlight = true;
      var mine = token;
      invoke(windowRef, 'runtimeDownloadStatus').then(function (status) {
        if (mine !== token) return;
        inFlight = false;
        if (disposed || !isRunning(state)) return;
        apply(status || {});
      });
    }

    function start(architecture, build) {
      if (disposed || isRunning(state)) return Promise.resolve(null);
      var mine = ++token;
      set({ phase: 'starting', build: build, step: 'downloading', received: 0, total: 0 });
      return invoke(windowRef, 'runtimeDownloadStart', { architecture: String(architecture || '') }).then(function (result) {
        if (disposed || mine !== token) return null;
        if (!result || result.ok !== true) {
          set({ phase: 'refused', build: build, message: refusalText(result) });
          return null;
        }
        idlePolls = 0;
        state.phase = 'running';
        state.build = positive(result.build) || build;
        onChange(state);
        if (!timer) timer = windowRef.setInterval(tick, POLL_MS);
        return state.build;
      });
    }

    function reset() {
      token += 1;
      stopPolling();
      state = null;
    }

    return {
      start: start,
      reset: reset,
      cancel: function () { return invoke(windowRef, 'runtimeDownloadCancel'); },
      state: function () { return state; },
      dispose: function () { disposed = true; token += 1; stopPolling(); },
    };
  }

  // ---- Add runtime folder (one dialog, then one list write) ----
  function sameFolder(left, right) {
    var norm = function (value) { return String(value || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase(); };
    return norm(left) === norm(right);
  }

  function folderRefusalText(reason) {
    if (reason === 'network_path') return jt('models.library.runtimeFolders.networkPath', 'Jenny can\'t run programs from a network folder.');
    if (reason === 'link_folder') return jt('models.library.runtimeFolders.linkFolder', 'Choose the folder itself, not a link to it.');
    return jt('models.library.folders.pickerFailed', 'Could not open the folder picker.');
  }

  // write(mutate) saves what mutate(savedRoots) returns, or nothing when it returns null.
  // Resolves { state: 'added'|'exists'|'full'|'cancelled'|'refused'|'failed', reason, path, saved }.
  function addRuntimeFolder(windowRef, write) {
    if (!hasBridge(windowRef, 'chooseRuntimeFolder')) return Promise.resolve({ state: 'failed' });
    var server = llamaServer(windowRef);
    return Promise.resolve().then(function () {
      return server.chooseRuntimeFolder();
    }).then(function (result) {
      if (!result || result.ok === false) return { state: 'refused', reason: String(result && result.reason || '') };
      if (result.picked !== true || typeof result.path !== 'string' || !result.path) return { state: 'cancelled' };
      var outcome = { state: 'added', path: result.path };
      return Promise.resolve(write(function (roots) {
        if (roots.some(function (saved) { return sameFolder(saved, result.path); })) { outcome.state = 'exists'; return null; }
        if (roots.length >= MAX_FOLDERS) { outcome.state = 'full'; return null; }
        return roots.concat([result.path]);
      })).then(function (saved) {
        outcome.saved = saved;
        if (outcome.state === 'added' && !savedRuntimeRoots(saved && saved.localEngines).some(function (kept) { return sameFolder(kept, result.path); })) {
          outcome.state = 'failed';
        }
        return outcome;
      });
    }).catch(function () {
      return { state: 'failed' };
    });
  }

  function savedRuntimeRoots(localEngines) {
    var roots = localEngines && localEngines.openaiCompatible && localEngines.openaiCompatible.managed
      && localEngines.openaiCompatible.managed.runtimeRoots;
    return Array.isArray(roots) ? roots.map(function (item) { return String(item || '').trim(); }).filter(Boolean) : [];
  }

  // A writer that reads the saved folders fresh (for surfaces that do not hold the settings).
  function settingsWriter(windowRef) {
    return function (mutate) {
      var engines = windowRef.jennyShell && windowRef.jennyShell.engines;
      if (!engines || typeof engines.getSettings !== 'function' || typeof engines.updateSettings !== 'function') return Promise.reject(new Error('unavailable'));
      return Promise.resolve(engines.getSettings()).then(function (settings) {
        var list = mutate(savedRuntimeRoots(settings && settings.localEngines));
        return list ? engines.updateSettings({ managed: { runtimeRoots: list } }) : null;
      });
    };
  }

  // ---- Remedies for a failed load ----
  // options: windowRef, scope ('row'|'tune'), actionsTag ('div'|'span'), actionsClass, onChange(),
  // onSwitched(tag, build), onSettings(localEngines), noneText(base) -> the text when no build is left,
  // allowDownload. begin(tag, base) asks main; view(tag, base) is null unless the answer is for that
  // failure text; handleClick(target) runs a button.
  function createRemedies(options) {
    var opts = options || {};
    var windowRef = opts.windowRef;
    var scope = opts.scope || 'row';
    var actionButton = opts.actionButton || resolveActionButton();
    var escapeHtml = opts.escapeHtml || (actionButton && actionButton.escapeHtml);
    var state = null;
    var token = 0;
    var disposed = false;
    var download = createBuildDownload({
      windowRef: windowRef,
      onChange: function (dl) {
        if (disposed) return;
        if (dl && dl.phase === 'ready') {
          var tag = state && state.tag;
          download.reset();
          if (tag) void refresh(tag);
          return;
        }
        changed();
      },
      onProgress: paintProgress,
    });

    function changed() {
      if (!disposed && typeof opts.onChange === 'function') opts.onChange();
    }

    function button(label, action, extra) {
      var more = extra || {};
      var dataset = { 'runtime-build-scope': scope, 'runtime-build-action': action };
      if (more.id) dataset['runtime-build-id'] = more.id;
      return actionButton({ label: label, variant: more.variant || 'secondary', size: 'sm', disabled: more.disabled === true, dataset: dataset });
    }

    function paintProgress(dl) {
      var doc = windowRef && windowRef.document;
      if (!doc || !dl) return;
      var nodes = doc.querySelectorAll('[data-runtime-build-progress]');
      for (var i = 0; i < nodes.length; i += 1) nodes[i].textContent = progressLine(dl);
    }

    function progressLine(dl) {
      var parts = downloadParts(dl);
      return parts.line + ' · ' + parts.sub;
    }

    // Asks main for the builds worth offering; base is the failure text the buttons sit under.
    function load(tag, base) {
      var mine = token;
      return invoke(windowRef, 'runtimeOptions', { modelTag: tag }).then(function (answer) {
        if (disposed || mine !== token) return;
        var read = readOptions(answer);
        if (!read) return;
        state = {
          tag: tag, base: base, candidates: read.candidates, offer: read.download,
          architecture: read.architecture || (state && state.architecture) || '', switching: false, adding: false, error: '',
        };
        changed();
      });
    }

    function refresh(tag) {
      return load(tag, state ? state.base : '');
    }

    function begin(tag, base) {
      token += 1;
      download.reset();
      state = null;
      return load(tag, base);
    }

    function clear() {
      token += 1;
      download.reset();
      state = null;
    }

    function view(tag, base) {
      if (!state || state.tag !== tag || (base !== undefined && state.base !== base)) return null;
      var dl = download.state();
      var text = state.base;
      var html;
      if (isRunning(dl)) {
        html = '<span class="model-library-add-sub model-library-add-num" data-runtime-build-progress>' + escapeHtml(progressLine(dl)) + '</span>'
          + button(jt('common.cancel', 'Cancel'), 'cancel-download', { variant: 'ghost' });
      } else {
        var canGet = opts.allowDownload === true && state.offer && state.architecture;
        if (state.candidates.length) {
          html = state.candidates.map(function (item) {
            return button(useBuildText(item), 'use', { id: item.id, disabled: state.switching });
          }).join('');
        } else {
          text = typeof opts.noneText === 'function' ? opts.noneText(text) : text;
          var retry = dl && dl.phase === 'failed';
          html = button(addFolderText(), 'add-folder')
            + (canGet ? button(retry ? jt('models.library.tuning.companion.retry', 'Try again') : getBuildText(state.offer.build), 'get-build') : '');
        }
        if (dl && dl.phase === 'failed') {
          var parts = downloadParts(dl);
          text += ' ' + parts.line + ' ' + parts.sub;
        } else if (dl && dl.phase === 'refused') text += ' ' + dl.message;
        if (state.error) text += ' ' + state.error;
      }
      var tagName = opts.actionsTag || 'div';
      return {
        text: text,
        actionsHtml: html ? '<' + tagName + ' class="' + escapeHtml(opts.actionsClass || 'model-card-note-actions') + '">' + html + '</' + tagName + '>' : '',
      };
    }

    function use(id) {
      var current = state;
      var candidate = current && current.candidates.filter(function (item) { return item.id === id; })[0];
      if (!candidate || current.switching) return;
      var mine = token;
      current.switching = true;
      current.error = '';
      changed();
      void invoke(windowRef, 'useRuntimeBuild', { modelTag: current.tag, id: candidate.id }).then(function (result) {
        if (disposed || mine !== token) return;
        if (result && result.ok === true) {
          var tag = current.tag;
          state = null;
          opts.onSwitched(tag, positive(result.build) || candidate.build);
        } else if (result && result.reason === 'stale_option') {
          return refresh(current.tag);
        } else {
          current.switching = false;
          current.error = switchFailedText(candidate.build);
          changed();
        }
      });
    }

    function addFolder() {
      var current = state;
      if (!current || current.switching || current.adding) return;
      var mine = token;
      current.adding = true;
      void addRuntimeFolder(windowRef, settingsWriter(windowRef)).then(function (outcome) {
        current.adding = false;
        if (disposed || mine !== token || state !== current) return;
        if (outcome.state === 'added') {
          var saved = outcome.saved;
          if (saved && saved.localEngines && typeof opts.onSettings === 'function') opts.onSettings(saved.localEngines);
          return refresh(current.tag);
        }
        if (outcome.state === 'refused' || outcome.state === 'failed') {
          current.error = folderRefusalText(outcome.reason);
          changed();
        }
        return null;
      });
    }

    function handleClick(target) {
      var control = target && typeof target.closest === 'function' ? target.closest('[data-runtime-build-action]') : null;
      if (!control || control.getAttribute('data-runtime-build-scope') !== scope || !state) return false;
      var action = control.getAttribute('data-runtime-build-action');
      if (action === 'use') use(control.getAttribute('data-runtime-build-id') || '');
      else if (action === 'add-folder') addFolder();
      else if (action === 'get-build' && state.offer && state.architecture) void download.start(state.architecture, state.offer.build);
      else if (action === 'cancel-download') void download.cancel();
      return true;
    }

    return {
      begin: begin,
      clear: clear,
      view: view,
      handleClick: handleClick,
      dispose: function () { disposed = true; token += 1; download.dispose(); state = null; },
    };
  }

  return {
    addRuntimeFolder: addRuntimeFolder,
    createBuildDownload: createBuildDownload,
    createRemedies: createRemedies,
    downloadParts: downloadParts,
    folderRefusalText: folderRefusalText,
    hasBridge: hasBridge,
    invoke: invoke,
    positive: positive,
    sameFolder: sameFolder,
    MAX_FOLDERS: MAX_FOLDERS,
    getBuildText: getBuildText,
    addFolderText: addFolderText,
    noOtherBuildRowText: noOtherBuildRowText,
    readOptions: readOptions,
    rowStartingText: rowStartingText,
    settingsWriter: settingsWriter,
  };
});
