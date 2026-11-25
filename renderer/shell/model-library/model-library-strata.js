/**
 * Model Library › Strata engine (UMD). Row 200 (S2 step 8, renderer half).
 *
 * The block under "Engines and providers" for the owner's own Strata install:
 * one status row that owns every message, the steps that go with a state, Check
 * again / Try again / Restart / Stop, and the opt-in GPU power/temperature
 * watchdog. It talks to main only through `jennyShell.strata.*`. Jenny never
 * installs Strata or downloads its files: no Install button, and no Cancel for
 * the pack check (main has none). The model row is a normal Library card (merge
 * `strata` input); this block reports `summary()` and `libraryInput()`. An
 * ineligible state renders nothing at all.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../../inventory/action-button'),
      require('../../inventory/status-row'),
      require('../../inventory/toggle-switch'),
      require('../../inventory/number-input'),
      require('../renderer-model-library-format-utils')
    );
    return;
  }
  root.modelLibraryStrata = factory(root.inventoryActionButton, root.inventoryStatusRow, root.inventoryToggleSwitch,
    root.inventoryNumberInput, root.rendererModelLibraryFormatUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (actionButton, statusRow, toggleModule, numberInput, formatUtils) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var toggleSwitch = typeof toggleModule === 'function' ? toggleModule : toggleModule && toggleModule.toggleSwitch;
  var initToggleHandlers = toggleModule && typeof toggleModule.initToggleHandlers === 'function' ? toggleModule.initToggleHandlers : null;

  if (typeof actionButton !== 'function' || typeof actionButton.escapeHtml !== 'function' || typeof statusRow !== 'function'
    || typeof toggleSwitch !== 'function' || typeof numberInput !== 'function'
    || !formatUtils || typeof formatUtils.formatHumanSize !== 'function') {
    throw new Error('model-library-strata: missing required dependency');
  }
  var escapeHtml = actionButton.escapeHtml;
  var formatHumanSize = formatUtils.formatHumanSize;

  var COMMAND = 'strata launch --family inkling-2-mini --model SQ-20'; // never translated
  var FOLDER = '%LOCALAPPDATA%\\Strata'; // main sends no path: the copy names the folder, not the user's real one
  var NATIVE_FILE = 'Inkling-2-Mini-SQ-20.strata';
  var VISION_FILE = 'Inkling-2-Mini-Vision.strata';
  // The pinned pack sizes (STRATA_ENGINE plan 2b): the SQ-20 native pack plus the vision pack.
  var PACK_BYTES = 19346685952 + 636526592;
  var DEFAULT_PORT = 8035;
  var STRIKES = 3;
  // Bounds of the watchdog thresholds (mirrors services/main/strata-ipc-registration.js).
  var WATTS_MIN = 100; var WATTS_MAX = 1000; var TEMP_MIN = 40; var TEMP_MAX = 110;
  var SETUP_MISSING = ['no_setup_config', 'setup_config_invalid'];
  var NOT_INSTALLED = ['', 'not_installed', 'no_localappdata'];
  var UNCONFIRMED_STOP = /(^|_)(stop|cleanup)_unconfirmed$/u; // its own, a lower server's, or an orphan's stop

  function objectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function sizeText(bytes) {
    return formatHumanSize(bytes) || '';
  }

  // `**word**` in a translated string is bold; everything else is escaped text.
  function boldHtml(text) {
    return escapeHtml(String(text)).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  }

  function installReasonWord(reason) {
    switch (reason) {
      case 'link_refused': return jt('models.library.strata.installReason.link_refused', 'a linked folder');
      case 'no_terminal': return jt('models.library.strata.installReason.no_terminal', 'no Terminal folder');
      case 'no_python': return jt('models.library.strata.installReason.no_python', 'no Python');
      case 'no_engine': return jt('models.library.strata.installReason.no_engine', 'no Inkling engine');
      default: return jt('models.library.strata.installReason.other', 'an unexpected layout');
    }
  }

  function createModelLibraryStrataController(options) {
    var opts = options || {};
    var windowRef = opts.windowRef || globalThis;
    var documentRef = opts.documentRef || windowRef.document || null;
    var hostId = String(opts.hostId || '');
    var isEnabled = typeof opts.isEnabled === 'function' ? opts.isEnabled : function () { return true; };
    // The library re-merges from libraryInput() and the Engines row re-reads summary() after every state change.
    var onState = typeof opts.onState === 'function' ? opts.onState : function () {};
    var boundHost = null;
    var disposed = false;
    var engine = null; // latest getState answer
    var failedRead = false; // the first read failed: the row is not drawn rather than "Checking…" for ever
    var pending = false;
    var note = '';
    var copied = false;
    var copiedTimer = null;
    var generation = 0;
    var refreshing = false;
    var refreshQueued = false;
    var lastFocusKey = '';

    function bridge() {
      var shell = windowRef.jennyShell;
      return shell && shell.strata && typeof shell.strata === 'object' ? shell.strata : null;
    }

    function host() {
      return documentRef && documentRef.getElementById ? documentRef.getElementById(hostId) : null;
    }

    function eligible() { return Boolean(engine && engine.eligible === true); }
    function runtime() { return objectOrEmpty(engine && engine.runtime); }
    function install() { return objectOrEmpty(runtime().install); }
    function setup() { return objectOrEmpty(runtime().setup); }
    function packs() { return objectOrEmpty(runtime().packs); }
    function pins() { return objectOrEmpty(engine && engine.pins); }
    function manager() { return objectOrEmpty(engine && engine.manager); }
    function settings() { return objectOrEmpty(engine && engine.settings); }
    function watchdog() { return objectOrEmpty(settings().watchdog); }
    function packState(name) { return String(packs()[name] || 'unknown'); }
    function version() { return String(install().version || ''); }
    function port() { return Number(manager().port) || DEFAULT_PORT; }

    // A missing field is unknown, never ready: an unanswered pack counts as checking.
    function packsChecking() { return packState('native') === 'checking' || packState('vision') === 'checking' || packState('native') === 'unknown'; }
    function packBad(name) { return packState(name) === 'failed' || packState(name) === 'missing'; }
    function nativeBad() { return packBad('native') || manager().lastError === 'strata_pack'; }
    function versionWarned() {
      var warnings = install().warnings;
      return Array.isArray(warnings) && (warnings.indexOf('version_unpinned') >= 0 || warnings.indexOf('engine_version_unpinned') >= 0);
    }

    // What stands between "found" and a usable install, or null once install and setup are both found.
    function installFamily() {
      if (!engine) return 'loading';
      var found = install().found;
      if (found === false && install().reason === 'unknown') return 'loading'; // main's first probe has not answered
      if (found === false) return NOT_INSTALLED.indexOf(String(install().reason || '')) >= 0 ? 'notInstalled' : 'broken';
      if (found !== true) return 'loading';
      if (setup().found === false && setup().reason !== 'unknown') return SETUP_MISSING.indexOf(String(setup().reason || '')) >= 0 ? 'noSetup' : 'broken';
      return setup().found === true ? null : 'loading';
    }

    function brokenReason() {
      return install().found === false ? String(install().reason || '') : String(setup().reason || '');
    }

    function progressOf(name) {
      var entry = objectOrEmpty(objectOrEmpty(runtime().progress)[name]);
      var total = Number(entry.total) || 0;
      return total > 0 ? { done: Math.min(Number(entry.done) || 0, total), total: total } : null;
    }

    function checkingProgress() {
      var parts = ['native', 'vision'].filter(function (name) { return packState(name) === 'checking'; }).map(progressOf).filter(Boolean);
      if (!parts.length) return null;
      return parts.reduce(function (sum, part) { return { done: sum.done + part.done, total: sum.total + part.total }; }, { done: 0, total: 0 });
    }

    function checkingStatus(kind) {
      var progress = checkingProgress();
      var base = { kind: kind, tone: 'pending', spinner: true, actions: kind === 'verifying' ? ['stop'] : [] };
      if (kind === 'verifying') base.message = jt('models.library.strata.startingVerifying', 'Checking the packs before the start…');
      else if (!progress) base.message = jt('models.library.strata.checkingPacksNoProgress', 'Checking the packs…');
      else base.message = jt('models.library.strata.checkingPacks', 'Checking the packs · {done} of {total}', { done: sizeText(progress.done), total: sizeText(progress.total) });
      if (progress) base.progress = { value: progress.done, max: progress.total, label: jt('models.library.strata.packProgressLabel', 'Pack check') };
      return base;
    }

    function packFailedMessage() {
      return packState('native') === 'missing'
        ? jt('models.library.strata.packMissing', '{file} was not found where Strata\'s setup says it is. Run the strata launch command again, then press Check again.', { file: NATIVE_FILE })
        : jt('models.library.strata.packFailed', '{file} does not match the fingerprint Jenny was built with. Run the strata launch command again to download it fresh, then press Check again.', { file: NATIVE_FILE });
    }

    // Each start error in its own sentence; never Strata's raw text, except the bounded fallback.
    function errorStatus(server) {
      var code = String(server.lastError || '');
      var detail = String(server.lastErrorDetail || '');
      var message;
      if (code === 'strata_port_busy') message = jt('models.library.strata.portBusy', 'Another program is using port {port}. Close it, then press Try again.', { port: port() });
      else if (code === 'strata_readiness_timeout') message = jt('models.library.strata.timeout', 'Strata did not finish starting in time. Press Try again; the second start is usually faster.');
      else if (code === 'strata_exited') message = jt('models.library.strata.exited', 'Strata stopped while starting (code {code}). Its log is in Jenny\'s logs folder.', { code: detail || '?' });
      else if (code === 'vram_in_use') message = jt('models.library.strata.vramInUse', 'Other programs are using the GPU memory Strata needs. Close them, then press Try again.');
      else if (UNCONFIRMED_STOP.test(code)) message = jt('models.library.strata.stopUnconfirmed', 'The last stop could not be confirmed. Restart Jenny if Strata stays stuck.');
      else message = jt('models.library.strata.couldNotStart', 'Strata could not start · {reason}', { reason: (code + (detail ? ':' + detail : '')).slice(0, 80) });
      return { kind: 'error', tone: 'warning', message: message, actions: UNCONFIRMED_STOP.test(code) ? [] : ['try-again'] };
    }

    function readyStatus(kind, message) {
      var shown = versionWarned()
        ? jt('models.library.strata.versionWarning', 'Strata {version} found. Jenny was checked with {pinned}; it should still work. If chats fail, go back to {pinned} in Strata.', { version: version(), pinned: String(pins().terminal || '') })
        : message;
      return { kind: kind, tone: versionWarned() ? 'warning' : 'success', message: shown,
        actions: kind === 'ready' ? ['reverify', 'stop'] : ['reverify'], watchdog: true };
    }

    // One model of the block: the kind decides the steps, notes and actions; the order is the spec's (3.4).
    function statusModel() {
      var family = installFamily();
      if (family === 'loading') return { kind: 'loading', tone: 'default', spinner: true, message: jt('models.library.strata.loading', 'Checking…'), actions: [] };
      if (family === 'notInstalled') return { kind: family, tone: 'default', message: jt('models.library.strata.notInstalled', 'Not installed · Jenny looks in {folder}', { folder: FOLDER }), actions: ['check-again'] };
      if (family === 'noSetup') return { kind: family, tone: 'default', message: jt('models.library.strata.noSetupConfig', 'Strata is installed, but the Inkling 2 Mini setup was not found.'), actions: ['check-again'] };
      if (family === 'broken') {
        return { kind: family, tone: 'default', actions: ['check-again'],
          message: jt('models.library.strata.installBroken', 'Strata was found but looks incomplete ({reason}). Reinstall it, then press Check again.', { reason: installReasonWord(brokenReason()) }) };
      }
      var server = manager();
      var state = String(server.state || 'stopped');
      if (state === 'starting' && server.phase === 'verifying') return checkingStatus('verifying');
      if (packsChecking()) return checkingStatus('checking');
      if (nativeBad()) return { kind: 'packFailed', tone: 'danger', message: packFailedMessage(), actions: ['check-again', 'copy'] };
      if (server.lastError === 'strata_blocked_by_windows') {
        return { kind: 'blocked', tone: 'danger', actions: ['try-again'],
          message: jt('models.library.strata.blocked', 'Windows blocked the Strata engine. Smart App Control, or a policy set by your organisation, stops programs that are not signed.') };
      }
      if (state === 'starting') {
        return { kind: 'starting', tone: 'pending', spinner: true, actions: ['stop'],
          message: jt('models.library.strata.starting', 'Starting Inkling 2 Mini · the first start can take a few minutes while Strata reads 19 GB from disk') };
      }
      if (state === 'stopping') return { kind: 'stopping', tone: 'pending', spinner: true, message: jt('models.library.strata.stopping', 'Stopping Strata…'), actions: [] };
      if (state === 'ready') {
        return readyStatus('ready', jt('models.library.strata.serving', 'Ready · Strata {version} · serving Inkling 2 Mini on :{port}', { version: version(), port: port() }));
      }
      if (state === 'crashed' && server.stoppedBy === 'watchdog') {
        return { kind: 'crashed', tone: 'danger', actions: ['restart'],
          message: jt('models.library.strata.watchdogStopped', 'Stopped by the power watchdog ({watts} W, {temp} °C). Restart it once the card has cooled.', { watts: Number(server.watchdogWatts) || 0, temp: Number(server.watchdogTempC) || 0 }) };
      }
      if (state === 'crashed') {
        return { kind: 'crashed', tone: 'danger', actions: ['restart'],
          message: jt('models.library.strata.crashed', 'Ready · Strata {version} · stopped unexpectedly. It restarts with your next message.', { version: version() }) };
      }
      if (server.lastError) return errorStatus(server);
      return readyStatus('idle', packState('vision') === 'verified'
        ? jt('models.library.strata.readyVersion', 'Ready · Strata {version} · Inkling 2 Mini and its image pack checked', { version: version() })
        : jt('models.library.strata.readyNoVision', 'Ready · Strata {version} · Inkling 2 Mini checked (no image pack)', { version: version() }));
    }

    function button(id, label, variant) {
      return actionButton({ id: id, label: label, variant: variant || 'secondary', size: 'sm', disabled: (pending && id !== 'stop') || !bridge(), dataset: { 'strata-action': id } })
        + (id === 'copy' && copied ? '<span class="strata-copied" role="status">' + escapeHtml(jt('models.library.strata.copied', 'Copied')) + '</span>' : '');
    }

    function actionsHtml(ids) {
      return ids.map(function (id) {
        switch (id) {
          case 'check-again': return button(id, jt('models.library.strata.checkAgain', 'Check again'));
          case 'copy': return button(id, jt('models.library.strata.copyCommand', 'Copy command'), 'ghost');
          case 'try-again': return button(id, jt('models.library.strata.tryAgain', 'Try again'));
          case 'restart': return button(id, jt('models.library.strata.restartNow', 'Restart now'));
          case 'reverify': return button(id, jt('models.library.strata.reverify', 'Check the packs again'), 'ghost');
          case 'stop': return button(id, jt('models.library.strata.stop', 'Stop'), 'ghost');
          default: return '';
        }
      }).join('');
    }

    function stepsHtml(kind) {
      var items = [];
      if (kind === 'notInstalled') {
        items.push(boldHtml(jt('models.library.strata.step1', 'Install Strata {release} from its release page on github.com (Niko1221/Strata).', { release: String(pins().release || '') })));
      }
      if (kind === 'notInstalled' || kind === 'noSetup') {
        items.push(escapeHtml(jt('models.library.strata.step2', 'In a terminal, run this once. It downloads the Inkling 2 Mini packs (about 20 GB) and writes the setup Jenny reads:'))
          + '<div class="strata-command"><code>' + escapeHtml(COMMAND) + '</code>' + button('copy', jt('common.copy', 'Copy'), 'ghost') + '</div>');
        items.push(boldHtml(jt('models.library.strata.step3', 'Come back and press **Check again**.')));
      }
      if (kind === 'blocked') {
        items.push(escapeHtml(jt('models.library.strata.blockedStep1', 'Open Windows Security › App & browser control › Smart App Control.')));
        items.push(escapeHtml(jt('models.library.strata.blockedStep2', 'Turn it off, or ask whoever manages this PC to allow strata-inkling.exe.')));
        items.push(boldHtml(jt('models.library.strata.blockedStep3', 'Press **Try again**.')));
      }
      return items.length ? '<ol class="strata-steps"><li>' + items.join('</li><li>') + '</li></ol>' : '';
    }

    function noteHtml(text, extraClass) {
      return '<span class="model-library-folders-empty' + (extraClass ? ' ' + extraClass : '') + '">' + (extraClass ? boldHtml(text) : escapeHtml(text)) + '</span>';
    }

    function notesHtml(model) {
      var kind = model.kind;
      var html = '';
      if (kind === 'notInstalled' || kind === 'noSetup' || kind === 'broken') {
        html += noteHtml(jt('models.library.strata.licenceNote', 'Jenny never installs Strata or downloads its files. Strata is a separate program with its own licence.'));
      }
      if (kind === 'checking') html += noteHtml(jt('models.library.strata.checkOnce', 'Once per pack. Later starts skip it while the files are unchanged.'));
      if (kind === 'starting') html += noteHtml(jt('models.library.strata.workingNote', 'Chats keep working on your other models meanwhile.'));
      if (kind === 'packFailed' && packState('vision') === 'verified') {
        html += noteHtml(jt('models.library.strata.visionFine', 'The image pack is fine.') + ' ' + jt('models.library.strata.nothingChanged', 'Nothing was changed.'));
      }
      if (kind === 'starting' || kind === 'ready') {
        html += noteHtml(jt('models.library.strata.leaseNote', 'While Jenny runs Strata, Strata\'s own **update** and **calibrate** wait until Jenny stops it.'), 'strata-lease');
      }
      return html;
    }

    // The opt-in watchdog (off by default); the same bounds as NInfer's.
    function watchdogMarkup() {
      var config = watchdog();
      return '<div class="model-library-ninfer-watchdog" data-strata-watchdog>'
        + toggleSwitch({
          id: 'strataWatchdogEnabled', label: jt('models.library.strata.watchdog', 'Power watchdog'), checked: config.enabled === true, disabled: pending,
          description: jt('models.library.strata.watchdogHelp', 'Stops Strata after {seconds} s above {watts} W or {temp} °C. For an RTX 5090 whose connector may overheat; match a lower power limit you set elsewhere.', {
            seconds: STRIKES, watts: Number(config.maxWatts) || 460, temp: Number(config.maxTempC) || 83,
          }),
        })
        + '<div class="model-library-image-engine-actions">'
        + numberInput({ id: 'strataWatchdogWatts', label: jt('models.library.strata.watchdogWatts', 'Power limit'), suffix: 'W', value: config.maxWatts, fallback: 460,
          min: WATTS_MIN, max: WATTS_MAX, step: 10, dataset: { 'strata-field': 'watchdog-watts' } })
        + numberInput({ id: 'strataWatchdogTemp', label: jt('models.library.strata.watchdogTemp', 'Temperature limit'), suffix: '°C', value: config.maxTempC, fallback: 83,
          min: TEMP_MIN, max: TEMP_MAX, step: 1, dataset: { 'strata-field': 'watchdog-temp' } })
        + '</div></div>';
    }

    function markup() {
      var model = statusModel();
      var unusableVision = !model.kind.match(/^(loading|notInstalled|noSetup|broken|checking|verifying|packFailed)$/) && packBad('vision');
      return '<div class="model-library-image-engine model-library-strata">'
        + '<span class="model-library-folders-title">' + escapeHtml(jt('models.library.strata.title', 'Strata engine')) + '</span>'
        + '<span class="model-library-image-engine-help">' + escapeHtml(jt('models.library.strata.help', 'Strata is an engine you install yourself. Jenny uses your Strata install and the Inkling 2 Mini packs you downloaded with it, and downloads nothing. It serves Inkling 2 Mini, with images, on this card.')) + '</span>'
        + statusRow({ tone: model.tone, spinner: model.spinner === true, progress: model.progress || null, compact: true,
          label: jt('models.library.strata.statusLabel', 'Status'), message: model.message, className: 'model-library-image-engine-status' })
        + stepsHtml(model.kind)
        + (unusableVision ? statusRow({ tone: 'warning', compact: true, message: jt('models.library.strata.visionUnusable', 'The image pack ({file}) did not pass its check, so images are off. Run the strata launch command again to fix it.', { file: VISION_FILE }) }) : '')
        + '<div class="model-library-image-engine-actions">' + actionsHtml(model.actions) + '</div>'
        + notesHtml(model)
        + (model.watchdog ? watchdogMarkup() : '')
        + '<span class="model-library-image-engine-note" aria-live="polite">' + escapeHtml(note) + '</span>'
        + '</div>';
    }

    function focusKeyOf(element) {
      if (!element || typeof element.getAttribute !== 'function') return '';
      var action = element.getAttribute('data-strata-action');
      var field = element.getAttribute('data-strata-field');
      return action ? 'action:' + action : field ? 'field:' + field : '';
    }

    function focusByKey(target, key) {
      var parts = key.split(':');
      var candidate = parts[0] === 'action'
        ? target.querySelector('[data-strata-action="' + parts[1] + '"]') || target.querySelector('[data-strata-action]:not([disabled])')
        : target.querySelector('[data-strata-field="' + parts[1] + '"]');
      if (candidate && typeof candidate.focus === 'function') candidate.focus();
    }

    function render() {
      if (disposed) return;
      var target = host();
      if (!target) return;
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

    function tellLibrary() {
      try { onState(); } catch (_error) { /* the library's re-merge never breaks the block */ }
    }

    function applyState(next) {
      if (disposed || !next || typeof next !== 'object') return;
      engine = next;
      failedRead = false;
      render();
      tellLibrary();
    }

    // One getState in flight; an event arriving meanwhile re-reads once after.
    function refresh() {
      var api = bridge();
      if (disposed || !api || typeof api.getState !== 'function') return Promise.resolve(null);
      if (refreshing) { refreshQueued = true; return Promise.resolve(null); }
      refreshing = true;
      var token = ++generation;
      var failed = function () {
        refreshing = false;
        if (disposed || token !== generation) return null;
        failedRead = !engine;
        render();
        if (failedRead) tellLibrary();
        return null;
      };
      return Promise.resolve().then(function () { return api.getState(); }).then(function (result) {
        if (!result || typeof result !== 'object' || result.ok === false) return failed();
        refreshing = false;
        if (disposed || token !== generation) return null;
        applyState(result);
        if (refreshQueued) { refreshQueued = false; return refresh(); }
        return null;
      }).catch(failed);
    }

    // One action at a time; the outcome is written beside the buttons, in the block's own words, never the reason.
    function invoke(method, payload, failureText) {
      var api = bridge();
      if ((pending && method !== 'stop') || disposed || !api || typeof api[method] !== 'function') return Promise.resolve(null);
      pending = true;
      note = '';
      render();
      return Promise.resolve().then(function () {
        return payload === undefined ? api[method]() : api[method](payload);
      }).then(function (result) {
        if (disposed) return null;
        pending = false;
        if (result && result.ok === false) note = failureText;
        return refresh();
      }).catch(function () {
        if (disposed) return null;
        pending = false;
        note = jt('models.library.strata.actionFailed', 'That did not work. Try again.');
        render();
        return null;
      });
    }

    function actionFailedText() { return jt('models.library.strata.actionFailed', 'That did not work. Try again.'); }

    function copyCommand() {
      var clipboard = windowRef.navigator && windowRef.navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== 'function') { note = actionFailedText(); render(); return Promise.resolve(null); }
      return Promise.resolve().then(function () { return clipboard.writeText(COMMAND); }).then(function () {
        if (disposed) return null;
        copied = true;
        render();
        windowRef.clearTimeout(copiedTimer);
        copiedTimer = windowRef.setTimeout(function () { copied = false; copiedTimer = null; if (!disposed) render(); }, 2000);
        return null;
      }).catch(function () { note = actionFailedText(); if (!disposed) render(); return null; });
    }

    function updateWatchdog(patch) {
      var current = watchdog();
      var next = { enabled: current.enabled === true, maxWatts: Number(current.maxWatts) || 460, maxTempC: Number(current.maxTempC) || 83 };
      Object.keys(patch).forEach(function (key) { next[key] = patch[key]; });
      // Optimistic: the toggle must not snap back while main answers.
      engine = Object.assign({}, engine, { settings: Object.assign({}, settings(), { watchdog: next }) });
      return invoke('updateSettings', { watchdog: next }, jt('models.library.strata.settingsFailed', 'The watchdog setting could not be saved.'));
    }

    function onClick(event) {
      var target = event && event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-strata-action]') : null;
      if (!target || !host() || !host().contains(target)) return;
      event.preventDefault();
      switch (target.getAttribute('data-strata-action')) {
        case 'check-again': case 'reverify': void invoke('reverify', undefined, actionFailedText()); break;
        case 'try-again': case 'restart': void invoke('restart', undefined, jt('models.library.strata.restartFailed', 'Strata could not be restarted.')); break;
        case 'stop': void invoke('stop', undefined, actionFailedText()); break;
        case 'copy': void copyCommand(); break;
        default: break;
      }
    }

    function onChange(event) {
      var target = event && event.target;
      var field = target && typeof target.getAttribute === 'function' ? target.getAttribute('data-strata-field') : '';
      if (!field || !host() || !host().contains(target)) return;
      if (field === 'watchdog-watts') void updateWatchdog({ maxWatts: numberInput.boundedNumber(target.value, WATTS_MIN, WATTS_MAX, 460) });
      else if (field === 'watchdog-temp') void updateWatchdog({ maxTempC: numberInput.boundedNumber(target.value, TEMP_MIN, TEMP_MAX, 83) });
    }

    function onToggle(event) {
      var detail = event && event.detail;
      if (!detail || detail.id !== 'strataWatchdogEnabled' || !host()) return;
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
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      if (copiedTimer !== null) windowRef.clearTimeout(copiedTimer);
      unbind();
    }

    function rowLock() {
      if (packsChecking()) return null;
      if (nativeBad()) return { kind: 'pack', message: jt('models.library.strata.rowLockedPack', 'the SQ-20 pack failed its check. See Engines and providers.') };
      if (manager().lastError === 'strata_blocked_by_windows') return { kind: 'blocked', message: jt('models.library.strata.rowLockedBlocked', 'Windows blocked the engine. See Engines and providers.') };
      return null;
    }

    // What the library merge needs: null until install and setup are found, so the grid stays as before. No VRAM figure.
    function libraryInput() {
      if (!isEnabled() || !eligible() || installFamily() !== null) return null;
      var model = objectOrEmpty(runtime().model);
      var server = manager();
      var id = String(model.id || '');
      if (!id) return null;
      var chosen = settings();
      var fit = objectOrEmpty(objectOrEmpty(engine.fits)[chosen.slots + ':' + chosen.kv]);
      var paramsB = Number(model.paramsB);
      return {
        id: id,
        displayName: String(model.displayName || 'Inkling 2 Mini'),
        aliases: [id].concat(Array.isArray(model.aliases) ? model.aliases.map(String) : []),
        params: Number.isFinite(paramsB) && paramsB > 0 ? paramsB + 'B' : '',
        quant: 'SQ-20',
        contextLength: Number(server.contextFit) || Number(fit.tokens) || undefined,
        sizeBytes: PACK_BYTES,
        manager: { state: String(server.state || 'stopped'), alias: String(server.alias || ''), port: Number(server.port) || 0,
          identityRetained: server.identityRetained === true },
        lock: rowLock(),
      };
    }

    function packPercent() {
      var progress = checkingProgress();
      return progress ? Math.floor(100 * progress.done / progress.total) : 0;
    }

    function errorSummary(server) {
      var lastError = String(server.lastError || '');
      return lastError && !UNCONFIRMED_STOP.test(lastError) ? { text: jt('models.library.strata.summary.couldNotStart', 'Could not start'), tone: 'warn', set: true } : null;
    }

    // The Engines row: null (not drawn) while disabled, ineligible, bridgeless or after a failed first read, else one status.
    function summary() {
      if (!isEnabled() || !bridge() || failedRead || (engine && !eligible())) return null;
      var family = installFamily();
      if (family === 'loading') return { text: jt('models.library.strata.summary.checking', 'Checking…'), tone: 'busy', set: true };
      if (family === 'notInstalled' || (family === 'broken' && install().found === false)) return { text: jt('models.library.strata.summary.notInstalled', 'Not installed'), tone: 'off', set: false };
      if (family) return { text: jt('models.library.strata.summary.noSetup', 'Setup not found'), tone: 'off', set: true };
      var server = manager();
      var state = String(server.state || 'stopped');
      if (packsChecking()) return { text: jt('models.library.strata.summary.checkingPacks', 'Checking the packs · {percent}%', { percent: packPercent() }), tone: 'busy', set: true };
      if (nativeBad()) return { text: jt('models.library.strata.summary.packFailed', 'Inkling 2 Mini pack failed its check'), tone: 'warn', set: true };
      if (server.lastError === 'strata_blocked_by_windows') return { text: jt('models.library.strata.summary.blocked', 'Blocked by Windows'), tone: 'warn', set: true };
      if (state === 'starting') return { text: jt('models.library.strata.summary.starting', 'Starting… the first start can take a few minutes'), tone: 'busy', set: true };
      if (state === 'stopping') return { text: jt('models.library.strata.summary.stopping', 'Stopping…'), tone: 'busy', set: true };
      if (state === 'ready') return { text: jt('models.library.strata.summary.serving', 'Serving on :{port}', { port: port() }), tone: 'ready', set: true };
      if (state === 'crashed') {
        return server.stoppedBy === 'watchdog'
          ? { text: jt('models.library.strata.summary.watchdog', 'Stopped by the power watchdog'), tone: 'warn', set: true }
          : { text: jt('models.library.strata.summary.crashed', 'Stopped unexpectedly'), tone: 'warn', set: true };
      }
      var failed = errorSummary(server);
      if (failed) return failed;
      if (versionWarned()) return { text: jt('models.library.strata.summary.versionWarning', 'Ready · {version} (Jenny checked {pinned})', { version: version(), pinned: String(pins().terminal || '') }), tone: 'warn', set: true };
      return { text: jt('models.library.strata.summary.ready', 'Ready · {version}', { version: version() }), tone: 'ready', set: true };
    }

    return { bind: bind, render: render, refresh: refresh, dispose: dispose, libraryInput: libraryInput, summary: summary };
  }

  return { createModelLibraryStrataController: createModelLibraryStrataController };
});
