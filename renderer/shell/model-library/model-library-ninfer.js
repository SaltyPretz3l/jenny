/**
 * Model Library › NInfer engine (UMD). Row 54 N2 (Step 10).
 *
 * The block under the model grid for the managed NInfer runtime (RTX 5090
 * only): one "Set up" that installs the pinned runtime and then downloads the
 * pinned Qwen3.8 27B artifact, a status row that owns every message while the
 * set-up runs, the one-time "Use it on NInfer" suggestion, Restart after a
 * crash, the inline Remove confirm and the opt-in GPU power/temperature
 * watchdog (user-settable thresholds). It talks to main only through
 * `jennyShell.ninfer.*`; an ineligible card renders nothing at all. The model
 * row itself is a normal library card (merge `ninfer` input, `selectedEngine:
 * 'ninfer'`); this block only reports the section-level state.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../../inventory/action-button'),
      require('../../inventory/status-row'),
      require('../../inventory/toggle-switch'),
      require('../../inventory/number-input'),
      require('../../inventory/checkbox'),
      require('../renderer-model-library-format-utils'),
      require('../../inventory/badge')
    );
    return;
  }
  root.modelLibraryNinfer = factory(root.inventoryActionButton, root.inventoryStatusRow, root.inventoryToggleSwitch,
    root.inventoryNumberInput, root.inventoryCheckbox, root.rendererModelLibraryFormatUtils, root.inventoryBadge);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (actionButton, statusRow, toggleModule, numberInput, checkboxModule, formatUtils, inventoryBadge) {
  'use strict';
  var checkbox = typeof checkboxModule === 'function' ? checkboxModule : checkboxModule && checkboxModule.checkbox;

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var toggleSwitch = typeof toggleModule === 'function' ? toggleModule : toggleModule && toggleModule.toggleSwitch;
  var initToggleHandlers = toggleModule && typeof toggleModule.initToggleHandlers === 'function' ? toggleModule.initToggleHandlers : null;

  if (typeof actionButton !== 'function' || typeof actionButton.escapeHtml !== 'function' || typeof statusRow !== 'function'
    || typeof toggleSwitch !== 'function' || typeof numberInput !== 'function' || typeof checkbox !== 'function'
    || !formatUtils || typeof formatUtils.formatHumanSize !== 'function' || typeof inventoryBadge !== 'function') {
    throw new Error('model-library-ninfer: missing required dependency');
  }
  var escapeHtml = actionButton.escapeHtml;
  var formatHumanSize = formatUtils.formatHumanSize;

  // Bounds of the watchdog thresholds (mirrors services/shell-config-engines.js).
  var WATTS_MIN = 100; var WATTS_MAX = 1000; var TEMP_MIN = 40; var TEMP_MAX = 110;
  var STRIKES = 3;
  var NETWORK_REASONS = ['download_failed', 'download_inactivity', 'response_timeout', 'redirect_host_rejected', 'redirect_scheme_rejected'];
  var FINGERPRINT_REASONS = ['hash_mismatch', 'size_mismatch', 'digest_mismatch', 'byte_overflow', 'sums_mismatch'];

  function sizeText(bytes) {
    return formatHumanSize(bytes) || jt('models.library.ninfer.sizeUnknown', 'size unknown');
  }

  function objectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  // C8: one sentence per failure, the engine (github.com) and the model
  // (huggingface.co) named apart. `resumeFrom` is the partial already on disk.
  function setupFailureMessage(reason, kind, extra) {
    var e = extra || {};
    if (NETWORK_REASONS.indexOf(reason) >= 0) {
      return kind === 'model'
        ? jt('models.library.ninfer.failedModelNetwork', 'huggingface.co could not be reached. The download will resume from {done}.', { done: sizeText(e.resumeFrom) })
        : jt('models.library.ninfer.failedEngineNetwork', 'github.com could not be reached. Nothing was changed.');
    }
    if (FINGERPRINT_REASONS.indexOf(reason) >= 0) {
      return jt('models.library.ninfer.failedFingerprint', 'The download did not match the expected fingerprint and was deleted. Nothing was changed.');
    }
    if (reason === 'ninfer_disk_space') {
      return jt('models.library.ninfer.failedDisk', 'Not enough free disk space: NInfer needs {size}.', { size: sizeText(e.needed) });
    }
    if (reason === 'extract_failed' || reason === 'publish_failed') {
      return jt('models.library.ninfer.failedUnpack', 'The engine could not be unpacked. Nothing was changed.');
    }
    return jt('models.library.ninfer.failedOther', 'NInfer could not be set up. Nothing was changed.');
  }

  function createModelLibraryNinferController(options) {
    var opts = options || {};
    var windowRef = opts.windowRef || globalThis;
    var documentRef = opts.documentRef || windowRef.document || null;
    var hostId = String(opts.hostId || '');
    var isEnabled = typeof opts.isEnabled === 'function' ? opts.isEnabled : function () { return true; };
    // The library re-merges its rows from libraryInput() after every state change.
    var onState = typeof opts.onState === 'function' ? opts.onState : function () {};
    // Use on the suggestion runs the library's own Use (the switch copy, the lock).
    var onUse = typeof opts.onUse === 'function' ? opts.onUse : function () {};
    var boundHost = null;
    var disposed = false;
    var unsubscribe = null;
    var engine = null; // latest getState answer
    var pending = false;
    var confirmRemove = false;
    var deleteModel = false;
    var note = '';
    var generation = 0;
    var refreshing = false;
    var refreshQueued = false;
    var lastFocusKey = '';

    function bridge() {
      var shell = windowRef.jennyShell;
      return shell && shell.ninfer && typeof shell.ninfer === 'object' ? shell.ninfer : null;
    }

    function host() {
      return documentRef && documentRef.getElementById ? documentRef.getElementById(hostId) : null;
    }

    function eligible() {
      return Boolean(engine && engine.eligible === true);
    }

    // The one pinned artifact (ninfer-artifacts.json pins exactly one today).
    function pin() {
      var pins = engine && engine.runtime && Array.isArray(engine.runtime.pins) ? engine.runtime.pins : [];
      return pins.length ? pins[0] : null;
    }

    function installState() { return objectOrEmpty(engine && engine.runtime && engine.runtime.install); }
    function artifactState() { return objectOrEmpty(engine && engine.runtime && engine.runtime.artifacts); }
    function manager() { return objectOrEmpty(engine && engine.manager); }
    function settings() { return objectOrEmpty(engine && engine.settings); }
    function watchdog() { return objectOrEmpty(settings().watchdog); }

    function modelPresent() {
      var current = pin();
      var installed = engine && Array.isArray(engine.installed) ? engine.installed : [];
      return Boolean(current) && installed.some(function (entry) { return entry && entry.id === current.id && entry.present === true; });
    }

    function runtimeInstalled() { return installState().status === 'installed'; }
    function settingUp() { return installState().status === 'installing' || artifactState().status === 'downloading'; }
    function ready() { return runtimeInstalled() && modelPresent(); }
    function modelName() { var current = pin(); return current ? String(current.display_name || current.id || '') : ''; }
    function engineSize() { return Number(installState().download_size_bytes) || 0; }
    function modelSize() { var current = pin(); return current ? Number(current.size_bytes) || 0 : 0; }

    // The failure the last set-up left behind (the user's own Cancel is not one).
    function setupFailure() {
      var install = installState();
      var artifacts = artifactState();
      if (install.last_error && install.last_error !== 'cancelled') return { kind: 'engine', reason: String(install.last_error) };
      if (artifacts.last_error && artifacts.last_error !== 'cancelled') {
        return { kind: 'model', reason: String(artifacts.last_error), resumeFrom: Number(objectOrEmpty(artifacts.download).done) || 0 };
      }
      return null;
    }

    function setupCancelled() {
      return installState().last_error === 'cancelled' || artifactState().last_error === 'cancelled';
    }

    function progressRow(done, total, label) {
      return total > 0 ? { value: done, max: total, label: label } : null;
    }

    // C5: one status row owns the whole set-up; the model row shows nothing meanwhile.
    function setupStatus() {
      var install = installState();
      var artifacts = artifactState();
      var progressLabel = jt('models.library.ninfer.setupProgress', 'Set-up progress');
      var step = function (n, what) { return jt('models.library.ninfer.settingUp', 'Setting up · step {n} of 2 · {what}', { n: n, what: what }); };
      if (install.status === 'installing') {
        var phase = objectOrEmpty(install.install);
        if (phase.phase === 'downloading') {
          var done = Number(phase.done) || 0; var total = Number(phase.total) || engineSize();
          return { tone: 'pending', spinner: true, progress: progressRow(done, total, progressLabel),
            message: step(1, jt('models.library.ninfer.engineProgress', 'engine {done} of {total}', { done: sizeText(done), total: sizeText(total) })) };
        }
        if (phase.phase === 'verifying') return { tone: 'pending', spinner: true, message: step(1, jt('models.library.ninfer.checkingFingerprint', 'Checking the fingerprint…')) };
        return { tone: 'pending', spinner: true, message: step(1, jt('models.library.ninfer.unpacking', 'Unpacking…')) };
      }
      var download = objectOrEmpty(artifacts.download);
      if (artifacts.phase === 'verify') return { tone: 'pending', spinner: true, message: step(2, jt('models.library.ninfer.checkingFingerprint', 'Checking the fingerprint…')) };
      if (artifacts.phase === 'publish') return { tone: 'pending', spinner: true, message: step(2, jt('models.library.ninfer.finishing', 'Finishing…')) };
      if (artifacts.phase === 'stream' || download.total) {
        var modelDone = Number(download.done) || 0; var modelTotal = Number(download.total) || modelSize();
        return { tone: 'pending', spinner: true, progress: progressRow(modelDone, modelTotal, progressLabel),
          message: step(2, jt('models.library.ninfer.modelProgress', '{model} {done} of {total}', { model: modelName(), done: sizeText(modelDone), total: sizeText(modelTotal) })) };
      }
      return { tone: 'pending', spinner: true, message: step(2, jt('models.library.ninfer.startingDownload', 'Starting the download…')) };
    }

    function serverStatus() {
      var server = manager();
      var version = String(server.runtimeLabel || installState().version || '');
      var readyPrefix = jt('models.library.ninfer.readyVersion', 'Ready · {version}', { version: version });
      if (server.state === 'ready') {
        return { tone: 'success', message: jt('models.library.ninfer.serving', '{ready} · serving {model} on :{port}{mtp}', {
          ready: readyPrefix, model: modelName(), port: server.port || 8034, mtp: server.mtp === true ? jt('models.library.ninfer.mtpSuffix', ' · MTP') : '',
        }) };
      }
      if (server.state === 'starting') return { tone: 'pending', spinner: true, message: jt('models.library.ninfer.starting', 'Starting NInfer…') };
      if (server.state === 'stopping') return { tone: 'pending', spinner: true, message: jt('models.library.ninfer.stopping', 'Stopping NInfer…') };
      if (server.state === 'crashed' && server.stoppedBy === 'watchdog') {
        return { tone: 'danger', message: jt('models.library.ninfer.watchdogStopped', 'Stopped by the power watchdog ({watts} W, {temp} °C). Restart it once the card has cooled.', {
          watts: Number(server.watchdogWatts) || 0, temp: Number(server.watchdogTempC) || 0,
        }) };
      }
      if (server.state === 'crashed') return { tone: 'danger', message: jt('models.library.ninfer.crashed', '{ready} · stopped unexpectedly. It restarts with your next message.', { ready: readyPrefix }) };
      var lastError = String(server.lastError || '');
      if (lastError.indexOf('ninfer_host_memory') === 0) {
        // C9: the pinned host memory the runtime could not reserve.
        return { tone: 'warning', message: jt('models.library.ninfer.hostMemory', 'NInfer couldn\'t reserve {gb} GB of system memory. Close other apps or wait a minute, then press Use again.', { gb: Number(server.hostMemoryGb) || 0 }) };
      }
      if (lastError === 'stop_unconfirmed') return { tone: 'warning', message: jt('models.library.ninfer.stopUnconfirmed', 'The last stop could not be confirmed. Restart Jenny if NInfer stays stuck.') };
      if (lastError) return { tone: 'warning', message: jt('models.library.ninfer.couldNotStart', 'NInfer could not start · {reason}', { reason: lastError.slice(0, 80) }) };
      if (settings().suggestionDismissed !== true) {
        // C6, shown once: Not now persists the dismissal.
        return { tone: 'success', message: jt('models.library.ninfer.readySuggest', '{ready} · NInfer runs {model} about 2.5× faster on long prompts on this card.', { ready: readyPrefix, model: modelName() }) };
      }
      return { tone: 'success', message: readyPrefix };
    }

    function statusModel() {
      if (!engine) return { tone: 'default', spinner: true, message: jt('models.library.ninfer.loading', 'Checking…') };
      if (settingUp()) return setupStatus();
      var failure = setupFailure();
      if (failure) {
        return { tone: 'danger', message: jt('models.library.ninfer.notSetUpReason', 'Not set up · {reason}', {
          reason: setupFailureMessage(failure.reason, failure.kind, { resumeFrom: failure.resumeFrom, needed: modelSize() }),
        }) };
      }
      if (setupCancelled() && !ready()) return { tone: 'default', message: jt('models.library.ninfer.setupCancelled', 'Set-up cancelled. It resumes where it stopped.') };
      if (!ready()) return { tone: 'default', message: jt('models.library.ninfer.notSetUpRecommended', 'Not set up · recommended for this card') };
      return serverStatus();
    }

    function button(id, label, variant, extra) {
      var config = { id: id, label: label, variant: variant || 'secondary', size: 'sm', disabled: pending || !bridge(), dataset: { 'ninfer-action': id } };
      if (extra) Object.keys(extra).forEach(function (key) { config[key] = extra[key]; });
      return actionButton(config);
    }

    function setupLabel() {
      var total = engineSize() + modelSize();
      return total
        ? jt('models.library.ninfer.setUp', 'Set up NInfer · about {size}', { size: sizeText(total) })
        : jt('models.library.ninfer.setUpNoSize', 'Set up NInfer…');
    }

    function actions() {
      if (settingUp()) return button('cancel-setup', jt('common.cancel', 'Cancel'), 'ghost');
      if (!ready()) return button('setup', setupFailure() ? jt('models.library.ninfer.retry', 'Retry') : setupLabel(), 'primary');
      if (confirmRemove) {
        return button('confirm-remove', jt('common.remove', 'Remove'), 'danger') + button('keep', jt('models.library.ninfer.keep', 'Keep it'), 'ghost');
      }
      var server = manager();
      var html = '';
      if (server.state === 'crashed') html += button('restart', jt('models.library.ninfer.restartNow', 'Restart now'));
      else if (server.state === 'stopped' && server.lastError && server.lastError !== 'stop_unconfirmed') html += button('restart', jt('models.library.ninfer.tryAgain', 'Try again'));
      else if (server.state === 'stopped' && !server.lastError && settings().suggestionDismissed !== true) {
        html += button('use', jt('models.library.ninfer.useOn', 'Use {model} on NInfer', { model: modelName() }), 'primary')
          + button('not-now', jt('models.library.ninfer.notNow', 'Not now'), 'ghost');
      }
      if (server.state !== 'starting' && server.state !== 'stopping') html += button('remove-ask', jt('models.library.ninfer.remove', 'Remove NInfer…'), 'ghost');
      return html;
    }

    // Owner addition (2026-10-13): the watchdog that stops ninfer-serve after
    // three seconds above a power or temperature line, off by default, both
    // lines the user's own (a card limited elsewhere wants a lower one).
    function watchdogMarkup() {
      var config = watchdog();
      var enabled = config.enabled === true;
      return '<div class="model-library-ninfer-watchdog" data-ninfer-watchdog>'
        + toggleSwitch({
          id: 'ninferWatchdogEnabled', label: jt('models.library.ninfer.watchdog', 'Power watchdog'), checked: enabled, disabled: pending,
          description: jt('models.library.ninfer.watchdogHelp', 'Stops NInfer after {seconds} s above {watts} W or {temp} °C. For an RTX 5090 whose connector may overheat; match a lower power limit you set elsewhere.', {
            seconds: STRIKES, watts: Number(config.maxWatts) || 460, temp: Number(config.maxTempC) || 83,
          }),
        })
        + '<div class="model-library-image-engine-actions">'
        + numberInput({ id: 'ninferWatchdogWatts', label: jt('models.library.ninfer.watchdogWatts', 'Power limit'), suffix: 'W', value: config.maxWatts, fallback: 460,
          min: WATTS_MIN, max: WATTS_MAX, step: 10, dataset: { 'ninfer-field': 'watchdog-watts' } })
        + numberInput({ id: 'ninferWatchdogTemp', label: jt('models.library.ninfer.watchdogTemp', 'Temperature limit'), suffix: '°C', value: config.maxTempC, fallback: 83,
          min: TEMP_MIN, max: TEMP_MAX, step: 1, dataset: { 'ninfer-field': 'watchdog-temp' } })
        + '</div></div>';
    }

    function markup() {
      var status = statusModel();
      var current = pin();
      var html = '<div class="model-library-image-engine model-library-ninfer">'
        + '<span class="model-library-folders-title">' + escapeHtml(jt('models.library.ninfer.title', 'NInfer engine')) + '</span>'
        + (!ready() && !confirmRemove ? inventoryBadge({ tone: 'default', size: 'sm', text: jt('models.library.recommended', 'Recommended') }) : '')
        + '<span class="model-library-image-engine-help">' + escapeHtml(jt('models.library.ninfer.help', 'NInfer is a fast engine built only for the RTX 5090. It runs {model} about 2.5× faster on long prompts than llama-server on this card. It uses its own model files (.ninfer), not GGUF.', { model: modelName() })) + '</span>'
        + statusRow({ tone: status.tone, spinner: status.spinner === true, progress: status.progress || null, compact: true,
          label: jt('models.library.ninfer.statusLabel', 'Status'), message: status.message, className: 'model-library-image-engine-status' });
      if (confirmRemove) {
        // C10: the runtime goes; the model file stays unless asked.
        html += '<span class="model-library-image-engine-confirm">' + escapeHtml(jt('models.library.ninfer.removeConfirm', 'Remove NInfer? Chats switch back to your other models.')) + '</span>'
          + checkbox({ id: 'ninferRemoveDeleteModel', checked: deleteModel, disabled: pending, dataset: { 'ninfer-field': 'delete-model' },
            label: jt('models.library.ninfer.removeDeleteModel', 'Also delete the {model} model file ({size})', { model: modelName(), size: sizeText(modelSize()) }) });
      }
      html += '<div class="model-library-image-engine-actions">' + actions() + '</div>';
      if (settingUp()) {
        html += '<span class="model-library-folders-empty">' + escapeHtml(jt('models.library.ninfer.workingNote', 'Chats keep working meanwhile. A cancelled download resumes where it stopped.')) + '</span>';
      }
      if (ready() && !confirmRemove) html += watchdogMarkup();
      html += '<span class="model-library-image-engine-note" aria-live="polite">' + escapeHtml(note) + '</span>';
      if (!ready() && !settingUp()) {
        // C3: what a set-up downloads, and from where.
        html += '<span class="model-library-folders-empty">' + escapeHtml(jt('models.library.ninfer.sourceNote', 'Installs the engine ({engineSize}, github.com), then downloads {model} ({modelSize}, huggingface.co). Each is checked against a fingerprint built into this version of Jenny. Nothing is sent anywhere.', {
          engineSize: sizeText(engineSize()), model: modelName(), modelSize: sizeText(modelSize()),
        })) + '</span>';
      }
      return html + '</div>';
    }

    function focusKeyOf(element) {
      if (!element || typeof element.getAttribute !== 'function') return '';
      var action = element.getAttribute('data-ninfer-action');
      var field = element.getAttribute('data-ninfer-field');
      return action ? 'action:' + action : field ? 'field:' + field : '';
    }

    function focusByKey(target, key) {
      var parts = key.split(':');
      var candidate = parts[0] === 'action'
        ? target.querySelector('[data-ninfer-action="' + parts[1] + '"]') || target.querySelector('[data-ninfer-action]:not([disabled])')
        : target.querySelector('[data-ninfer-field="' + parts[1] + '"]');
      if (candidate && typeof candidate.focus === 'function') candidate.focus();
    }

    function render() {
      if (disposed) return;
      var target = host();
      if (!target) return;
      // Hidden (chosen): an ineligible card, the kill switch, or no answer yet.
      if (!isEnabled() || !eligible()) { target.innerHTML = ''; return; }
      var active = documentRef && documentRef.activeElement;
      var key = active && target.contains(active) ? focusKeyOf(active) : '';
      if (key) lastFocusKey = key;
      target.innerHTML = markup();
      if (!pending && lastFocusKey) {
        focusByKey(target, lastFocusKey);
        lastFocusKey = '';
      }
    }

    function applyState(next) {
      if (disposed || !next || typeof next !== 'object') return;
      engine = next;
      if (!ready()) { confirmRemove = false; deleteModel = false; }
      render();
      try { onState(); } catch (_error) { /* the library's re-merge never breaks the block */ }
    }

    // One getState in flight; an event arriving meanwhile re-reads once after.
    function refresh() {
      var api = bridge();
      if (disposed || !api || typeof api.getState !== 'function') return Promise.resolve(null);
      if (refreshing) { refreshQueued = true; return Promise.resolve(null); }
      refreshing = true;
      var token = ++generation;
      return Promise.resolve().then(function () { return api.getState(); }).then(function (result) {
        refreshing = false;
        if (disposed || token !== generation) return null;
        if (result && typeof result === 'object' && result.ok !== false) applyState(result);
        else render();
        if (refreshQueued) { refreshQueued = false; return refresh(); }
        return null;
      }).catch(function () {
        refreshing = false;
        if (!disposed && token === generation) render();
        return null;
      });
    }

    // One action at a time; the outcome is written beside the buttons. A
    // set-up answers only when both downloads finish, so it never holds the
    // block (`wait: false`): progress arrives through onChanged, Cancel stays live.
    function invoke(method, payload, onResult, options) {
      var api = bridge();
      var blocking = !(options && options.wait === false);
      if (pending || disposed || !api || typeof api[method] !== 'function') return Promise.resolve(null);
      pending = blocking;
      note = '';
      render();
      return Promise.resolve().then(function () {
        return payload === undefined ? api[method]() : api[method](payload);
      }).then(function (result) {
        if (disposed) return null;
        if (blocking) pending = false;
        if (typeof onResult === 'function') onResult(result || {});
        return refresh();
      }).catch(function () {
        if (disposed) return null;
        if (blocking) pending = false;
        note = jt('models.library.ninfer.actionFailed', 'That did not work. Try again.');
        render();
        return null;
      });
    }

    function setup() {
      if (!eligible() || settingUp()) return Promise.resolve(null);
      return invoke('setup', undefined, function (result) {
        if (result.ok === false && result.reason !== 'busy' && result.reason !== 'cancelled') {
          note = setupFailureMessage(result.reason, runtimeInstalled() ? 'model' : 'engine', { needed: modelSize() });
        }
      }, { wait: false });
    }

    function restart() {
      return invoke('restart', undefined, function (result) {
        if (result.ok === false) note = jt('models.library.ninfer.restartFailed', 'NInfer could not be restarted.');
      });
    }

    function updateWatchdog(patch) {
      var current = watchdog();
      var next = { enabled: current.enabled === true, maxWatts: Number(current.maxWatts) || 460, maxTempC: Number(current.maxTempC) || 83 };
      Object.keys(patch).forEach(function (key) { next[key] = patch[key]; });
      // Optimistic: the toggle must not snap back while main answers.
      engine = Object.assign({}, engine, { settings: Object.assign({}, settings(), { watchdog: next }) });
      return invoke('updateSettings', { watchdog: next }, function (result) {
        if (result.ok === false) note = jt('models.library.ninfer.settingsFailed', 'The watchdog setting could not be saved.');
      });
    }

    function boundedNumber(value, min, max, fallback) {
      var number = Math.round(Number(value));
      return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
    }

    function onClick(event) {
      var target = event && event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-ninfer-action]') : null;
      if (!target || !host() || !host().contains(target)) return;
      event.preventDefault();
      switch (target.getAttribute('data-ninfer-action')) {
        case 'setup': void setup(); break;
        case 'cancel-setup': void invoke('cancelSetup'); break;
        case 'use': { var current = pin(); if (current) onUse(String(current.model_id || current.id)); break; }
        case 'not-now': void invoke('dismissSuggestion'); break;
        case 'restart': void restart(); break;
        case 'remove-ask': confirmRemove = true; deleteModel = false; render(); break;
        case 'keep': confirmRemove = false; render(); break;
        case 'confirm-remove': confirmRemove = false; void invoke('remove', { confirmed: true, deleteModel: deleteModel }, function (result) {
          if (result.ok === false) note = jt('models.library.ninfer.removeFailed', 'NInfer could not be removed.');
        }); break;
        default: break;
      }
    }

    function onChange(event) {
      var target = event && event.target;
      var field = target && typeof target.getAttribute === 'function' ? target.getAttribute('data-ninfer-field') : '';
      if (!field || !host() || !host().contains(target)) return;
      if (field === 'delete-model') { deleteModel = Boolean(target.checked); return; }
      if (field === 'watchdog-watts') void updateWatchdog({ maxWatts: boundedNumber(target.value, WATTS_MIN, WATTS_MAX, 460) });
      else if (field === 'watchdog-temp') void updateWatchdog({ maxTempC: boundedNumber(target.value, TEMP_MIN, TEMP_MAX, 83) });
    }

    function onToggle(event) {
      var detail = event && event.detail;
      if (!detail || detail.id !== 'ninferWatchdogEnabled' || !host()) return;
      void updateWatchdog({ enabled: detail.checked === true });
    }

    function bind() {
      if (disposed) return;
      var target = host();
      if (!target || target === boundHost) return;
      unbind();
      boundHost = target;
      target.addEventListener('click', onClick);
      target.addEventListener('change', onChange);
      target.addEventListener('inv-toggle-change', onToggle);
      if (initToggleHandlers && documentRef) initToggleHandlers(documentRef);
      var api = bridge();
      if (api && typeof api.onChanged === 'function') {
        try {
          // A change event says only what moved; getState is the one truth.
          var maybe = api.onChanged(function () { void refresh(); });
          if (typeof maybe === 'function') unsubscribe = maybe;
        } catch (_error) { /* the block still works without live updates */ }
      }
      if (engine) render();
      else void refresh();
    }

    function unbind() {
      if (boundHost) {
        boundHost.removeEventListener('click', onClick);
        boundHost.removeEventListener('change', onChange);
        boundHost.removeEventListener('inv-toggle-change', onToggle);
        boundHost = null;
      }
      if (typeof unsubscribe === 'function') {
        try { unsubscribe(); } catch (_error) { /* best effort */ }
        unsubscribe = null;
      }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      unbind();
    }

    // What the library merge needs for the NInfer rows: null while ineligible
    // (or unanswered), so the grid stays exactly as before.
    function libraryInput() {
      if (!isEnabled() || !eligible()) return null;
      var server = manager();
      return {
        pins: (engine.runtime && Array.isArray(engine.runtime.pins) ? engine.runtime.pins : []).map(function (entry) {
          return { id: entry.id, model_id: entry.model_id, display_name: entry.display_name, size_bytes: entry.size_bytes,
            supports_mtp: entry.supports_mtp === true, default_context_window: entry.default_context_window, context_windows: entry.context_windows,
            fp8_kv_windows: Array.isArray(entry.fp8_kv_windows) ? entry.fp8_kv_windows : [] };
        }),
        installed: Array.isArray(engine.installed) ? engine.installed.map(function (entry) { return { id: entry.id, present: entry.present === true }; }) : [],
        manager: { state: String(server.state || 'stopped'), alias: String(server.alias || ''), port: Number(server.port) || 0,
          artifactId: String(server.artifactId || ''), identityRetained: server.identityRetained === true, mtp: server.mtp === true, lastError: String(server.lastError || '') },
        settingUp: settingUp(),
        settings: { mtp: settings().mtp !== false, contextSize: Number(settings().contextSize) || 0 },
      };
    }

    return { bind: bind, render: render, refresh: refresh, dispose: dispose, setup: setup, libraryInput: libraryInput };
  }

  return { createModelLibraryNinferController: createModelLibraryNinferController, setupFailureMessage: setupFailureMessage };
});
