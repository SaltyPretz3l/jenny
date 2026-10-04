/**
 * Model Library › Image engine (UMD).
 *
 * The section under GGUF folders that installs the pinned stable-diffusion.cpp
 * engine (or points at the user's own sd-cli.exe), scans a model folder into
 * three slots and keeps the saved model sets. It talks to main only through
 * `jennyShell.imageEngine.*`; every path comes from a main-owned dialog, never
 * from a text field. The capability ships, the model does not: nothing here
 * names, links or recommends a model.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../../inventory/action-button'),
      require('../../inventory/status-row'),
      require('../../inventory/select-field')
    );
    return;
  }
  root.modelLibraryImageEngine = factory(root.inventoryActionButton, root.inventoryStatusRow, root.inventorySelectField);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (actionButton, statusRow, selectField) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var SLOTS = ['diffusion', 'text_encoder', 'vae'];
  var ID_RE = /^[a-f0-9]{12}$/;

  if (typeof actionButton !== 'function' || typeof actionButton.escapeHtml !== 'function'
    || typeof statusRow !== 'function' || typeof selectField !== 'function') {
    throw new Error('model-library-image-engine: missing required dependency');
  }
  var escapeHtml = actionButton.escapeHtml;

  function megabytes(bytes) {
    var value = Number(bytes);
    return Number.isFinite(value) && value > 0 ? Math.round(value / 1048576) : 0;
  }

  function gigabytes(bytes) {
    var value = Number(bytes);
    return Number.isFinite(value) && value > 0 ? (value / 1073741824).toFixed(1) : '0.0';
  }

  function quantOf(name) {
    var match = /(Q\d[A-Z0-9_]*|IQ\d[A-Z0-9_]*|BF16|F16|F32|FP8)/i.exec(String(name || ''));
    return match ? match[1].toUpperCase() : '';
  }

  function installFailureMessage(reason) {
    switch (reason) {
      case 'download_failed':
      case 'download_inactivity':
      case 'response_timeout':
      case 'redirect_host_rejected':
      case 'redirect_scheme_rejected':
        return jt('models.library.imageEngine.failedNetwork', 'github.com could not be reached. Nothing was changed.');
      case 'hash_mismatch':
      case 'size_mismatch':
      case 'byte_overflow':
        return jt('models.library.imageEngine.failedFingerprint', 'The download did not match the expected fingerprint and was deleted. Nothing was changed.');
      case 'image_engine_archive_invalid':
        return jt('models.library.imageEngine.failedArchive', 'The downloaded file could not be unpacked. Nothing was changed.');
      case 'image_engine_probe_failed':
      case 'image_engine_path_missing':
        return jt('models.library.imageEngine.failedProbe', 'That file is not a stable-diffusion.cpp build.');
      case 'image_engine_path_rejected':
        return jt('models.library.networkPath', 'Jenny can\'t use network locations here. Map the share to a drive letter, then choose it from that drive.');
      case 'platform_unsupported':
        return jt('models.library.imageEngine.unsupported', 'Not available for this platform yet.');
      default:
        return jt('models.library.imageEngine.failedOther', 'The engine could not be installed. Nothing was changed.');
    }
  }

  function saveFailureMessage(reason) {
    switch (reason) {
      case 'image_text_encoder_unsupported':
        return jt('models.library.imageEngine.saveEncoderUnsupported', 'That text encoder format is not supported by the engine. Pick a GGUF or bf16 encoder.');
      case 'family_mismatch':
      case 'unknown_family':
        return jt('models.library.imageEngine.saveFamily', 'The diffusion model does not match the chosen family.');
      case 'too_many_sets':
        return jt('models.library.imageEngine.saveTooMany', 'Remove a saved set first (16 at most).');
      case 'root_not_local_path':
        return jt('models.library.networkPath', 'Jenny can\'t use network locations here. Map the share to a drive letter, then choose it from that drive.');
      case 'file_missing':
      case 'name_escapes_root':
      case 'invalid_name':
        return jt('models.library.imageEngine.saveFilesChanged', 'Those files changed since the scan. Rescan the folder.');
      default:
        return jt('models.library.imageEngine.saveFailed', 'The model set could not be saved.');
    }
  }

  function createModelLibraryImageEngineController(options) {
    var opts = options || {};
    var windowRef = opts.windowRef || globalThis;
    var documentRef = opts.documentRef || windowRef.document || null;
    var hostId = String(opts.hostId || '');
    var isEnabled = typeof opts.isEnabled === 'function' ? opts.isEnabled : function () { return true; };
    var boundHost = null;
    var disposed = false;
    var unsubscribe = null;
    // Latest getState answer: engine status, install progress, handoff and sets.
    var engine = null;
    // The last folder scan and the user's slot picks over it.
    var scan = null;
    var picks = { diffusion: '', text_encoder: '', vae: '', family: '' };
    var pending = false;
    var confirmRemove = false;
    var note = '';
    var generation = 0;
    var lastFocusKey = '';

    function bridge() {
      var shell = windowRef.jennyShell;
      return shell && shell.imageEngine && typeof shell.imageEngine === 'object' ? shell.imageEngine : null;
    }

    function host() {
      return documentRef && documentRef.getElementById ? documentRef.getElementById(hostId) : null;
    }

    // Family presets ride along with getState (labels only matter here).
    function families() {
      return engine && engine.families && typeof engine.families === 'object' ? engine.families : {};
    }

    function familyLabel(id) {
      var family = families()[id];
      return family && family.label ? String(family.label) : String(id || '');
    }

    function sets() {
      var store = engine && engine.model_sets;
      return store && Array.isArray(store.sets) ? store.sets : [];
    }

    function defaultId() {
      var store = engine && engine.model_sets;
      return store && typeof store.default_id === 'string' ? store.default_id : null;
    }

    function setLabel(set) {
      if (set.label) return set.label;
      var diffusion = set.files && set.files.diffusion ? set.files.diffusion.name : '';
      var quant = quantOf(diffusion);
      return quant ? familyLabel(set.family) + ' · ' + quant : familyLabel(set.family);
    }

    function setSizeBytes(set) {
      var files = set.files || {};
      var total = 0;
      SLOTS.forEach(function (slot) {
        var entry = files[slot];
        total += entry && Number.isFinite(Number(entry.size_bytes)) ? Number(entry.size_bytes) : 0;
      });
      return total;
    }

    function statusModel() {
      var status = engine ? engine.status : 'not_installed';
      var tag = engine && engine.engine_tag ? engine.engine_tag : '';
      if (!engine) return { tone: 'default', message: jt('models.library.imageEngine.loading', 'Checking…'), spinner: true };
      if (status === 'installing') {
        var install = engine.install || {};
        var done = megabytes(install.downloaded_bytes);
        var total = megabytes(install.total_bytes);
        if (install.phase === 'downloading') {
          return {
            tone: 'pending', spinner: true,
            message: total ? jt('models.library.imageEngine.downloading', 'Downloading · {done} of {total} MB', { done: done, total: total })
              : jt('models.library.imageEngine.downloadingStart', 'Downloading…'),
            progress: total ? { value: done, max: total, label: jt('models.library.imageEngine.downloadProgress', 'Download progress') } : null,
          };
        }
        if (install.phase === 'verifying') return { tone: 'pending', spinner: true, message: jt('models.library.imageEngine.verifying', 'Checking the fingerprint…') };
        return { tone: 'pending', spinner: true, message: jt('models.library.imageEngine.installing', 'Unpacking…') };
      }
      // The user's own Cancel is not a failure (F24).
      if (status === 'error' && engine.last_error === 'cancelled') {
        return { tone: 'default', message: jt('models.library.imageEngine.installCancelled', 'Install cancelled.') };
      }
      if (status === 'error') return { tone: 'danger', message: jt('models.library.imageEngine.notInstalledReason', 'Not installed · {reason}', { reason: installFailureMessage(engine.last_error) }) };
      if (engine.handoff && engine.handoff.retained) {
        return { tone: 'warning', message: jt('models.library.imageEngine.cleanupPending', 'Installed · the last image did not finish cleanly. Chat models stay paused until it is cleaned up.') };
      }
      if (status === 'custom') {
        return { tone: 'success', message: jt('models.library.imageEngine.custom', 'Using your own sd-cli.exe · {path}', { path: engine.custom_executable || '' }) };
      }
      if (status === 'installed') return { tone: 'success', message: jt('models.library.imageEngine.installed', 'Installed · {tag}', { tag: tag }) };
      return { tone: 'default', message: jt('models.library.imageEngine.notInstalled', 'Not installed') };
    }

    function button(id, label, variant, extra) {
      var config = { id: id, label: label, variant: variant || 'secondary', size: 'sm', disabled: pending || !bridge(), dataset: { 'image-engine-action': id } };
      if (extra) Object.keys(extra).forEach(function (key) { config[key] = extra[key]; });
      return actionButton(config);
    }

    function engineActions() {
      var status = engine ? engine.status : 'not_installed';
      var size = engine ? megabytes(engine.download_size_bytes) : 0;
      var installLabel = size
        ? jt('models.library.imageEngine.install', 'Install engine… ({size} MB)', { size: size })
        : jt('models.library.imageEngine.installNoSize', 'Install engine…');
      var own = button('choose-runtime', jt('models.library.imageEngine.useOwn', 'Use my own sd-cli.exe…'));
      if (engine && engine.handoff && engine.handoff.retained) {
        return button('reconcile', jt('models.library.imageEngine.cleanUp', 'Clean up now'), 'primary');
      }
      if (status === 'installing') return button('cancel-install', jt('common.cancel', 'Cancel'));
      if (status === 'custom') return button('clear-runtime', jt('models.library.imageEngine.stopUsingOwn', 'Stop using it'), 'ghost') + button('install', installLabel);
      if (status === 'installed') {
        if (confirmRemove) {
          return button('confirm-remove', jt('common.remove', 'Remove'), 'danger') + button('keep', jt('models.library.imageEngine.keep', 'Keep it'), 'ghost');
        }
        return button('remove', jt('models.library.imageEngine.remove', 'Remove engine'), 'ghost');
      }
      if (status === 'error' && engine.last_error !== 'cancelled') {
        return button('install', jt('models.library.imageEngine.retry', 'Retry'), 'primary') + own;
      }
      return button('install', installLabel, 'primary') + own;
    }

    function slotSelect(slot, label) {
      var candidates = scan && scan.candidates && Array.isArray(scan.candidates[slot]) ? scan.candidates[slot] : [];
      var choices = candidates.map(function (candidate) {
        return { value: candidate.name, label: candidate.name + ' · ' + jt('models.library.imageEngine.gigabytes', '{size} GB', { size: gigabytes(candidate.size_bytes) }) };
      });
      if (!choices.length) choices = [{ value: '', label: jt('models.library.imageEngine.noneFound', 'None found in this folder') }];
      return selectField({
        id: 'imageEngineSlot-' + slot, label: label, value: picks[slot], options: choices,
        disabled: pending || !candidates.length, dataset: { 'image-engine-slot': slot },
      });
    }

    function familySelect() {
      var guess = detectedFamily();
      if (guess) {
        return selectField({
          id: 'imageEngineSlot-family', label: jt('models.library.imageEngine.family', 'Family'), value: guess, disabled: true,
          options: [{ value: guess, label: jt('models.library.imageEngine.familyDetected', '{family} (read from the model file)', { family: familyLabel(guess) }) }],
        });
      }
      var choices = Object.keys(families()).map(function (id) { return { value: id, label: familyLabel(id) }; });
      choices.unshift({ value: '', label: jt('models.library.imageEngine.familyPick', 'Choose the model family') });
      return selectField({
        id: 'imageEngineSlot-family', label: jt('models.library.imageEngine.family', 'Family'), value: picks.family,
        options: choices, disabled: pending, dataset: { 'image-engine-slot': 'family' },
      });
    }

    function detectedFamily() {
      var candidates = scan && scan.candidates && Array.isArray(scan.candidates.diffusion) ? scan.candidates.diffusion : [];
      for (var i = 0; i < candidates.length; i += 1) {
        if (candidates[i].name === picks.diffusion) return candidates[i].family_guess || '';
      }
      return '';
    }

    function modelsMarkup() {
      var status = engine ? engine.status : 'not_installed';
      if (status !== 'installed' && status !== 'custom') return '';
      var rootPath = scan && scan.root ? scan.root : '';
      var html = '<span class="model-library-image-engine-subtitle">' + escapeHtml(jt('models.library.imageEngine.models', 'Image models')) + '</span>'
        + '<div class="model-library-image-engine-folder">'
        + (rootPath ? '<code class="model-library-folders-path">' + escapeHtml(rootPath) + '</code>'
          : '<span class="model-library-folders-empty">' + escapeHtml(jt('models.library.imageEngine.noFolder', 'Choose the folder that holds your diffusion model, text encoder and VAE.')) + '</span>')
        + button('choose-folder', jt('models.library.imageEngine.chooseFolder', 'Choose folder…'))
        + (rootPath ? button('rescan', jt('models.library.imageEngine.rescan', 'Rescan'), 'ghost') : '')
        + '</div>';
      if (scan) {
        html += '<div class="model-library-image-engine-slots">'
          + slotSelect('diffusion', jt('models.library.imageEngine.slotDiffusion', 'Diffusion model'))
          + slotSelect('text_encoder', jt('models.library.imageEngine.slotEncoder', 'Text encoder'))
          + slotSelect('vae', jt('models.library.imageEngine.slotVae', 'VAE'))
          + familySelect()
          + '</div>'
          + '<div class="model-library-image-engine-actions">'
          + button('save-set', jt('models.library.imageEngine.saveSet', 'Save model set'), sets().length ? 'secondary' : 'primary', { disabled: pending || !canSave() })
          + '</div>'
          + (scan.truncated ? '<span class="model-library-folders-empty">' + escapeHtml(jt('models.library.imageEngine.truncated', 'The folder has more files than Jenny lists. Move the model files nearer the top.')) + '</span>' : '');
      }
      html += setsMarkup();
      return html;
    }

    function canSave() {
      return Boolean(picks.diffusion && picks.text_encoder && picks.vae && (detectedFamily() || picks.family));
    }

    function setsMarkup() {
      var list = sets();
      if (!list.length) {
        return '<span class="model-library-folders-empty">' + escapeHtml(jt('models.library.imageEngine.noSets', 'No sets yet · a set is one diffusion model, its text encoder and its VAE.')) + '</span>';
      }
      var current = defaultId();
      return '<div class="model-library-image-engine-sets">' + list.map(function (set) {
        var isDefault = set.id === current;
        return '<div class="model-library-image-engine-set" data-image-engine-set="' + escapeHtml(set.id) + '">'
          + '<div class="model-library-image-engine-set-text">'
          + '<span class="model-library-image-engine-set-name">' + escapeHtml(setLabel(set)) + '</span>'
          + '<span class="model-library-image-engine-set-meta">' + escapeHtml(jt('models.library.imageEngine.gigabytes', '{size} GB', { size: gigabytes(setSizeBytes(set)) }))
          + (isDefault ? ' · <span class="model-library-image-engine-default">' + escapeHtml(jt('models.library.imageEngine.default', 'Default')) + '</span>' : '')
          + '</span></div>'
          + (isDefault ? '<span></span>' : button('make-default', jt('models.library.imageEngine.makeDefault', 'Make default'), 'ghost', { dataset: { 'image-engine-action': 'make-default', 'image-engine-set': set.id } }))
          + button('remove-set', jt('common.remove', 'Remove'), 'ghost', { dataset: { 'image-engine-action': 'remove-set', 'image-engine-set': set.id } })
          + '</div>';
      }).join('') + '</div>'
        + '<span class="model-library-folders-empty">' + escapeHtml(jt('models.library.imageEngine.defaultNote', 'Jenny uses the default set when you ask for an image.')) + '</span>';
    }

    function markup() {
      var status = statusModel();
      var notInstalled = !engine || engine.status === 'not_installed' || engine.status === 'error';
      return '<div class="model-library-image-engine">'
        + '<span class="model-library-folders-title">' + escapeHtml(jt('models.library.imageEngine.title', 'Image engine')) + '</span>'
        + '<span class="model-library-image-engine-help">' + escapeHtml(jt('models.library.imageEngine.help', 'Lets Jenny draw images in chat from diffusion models you already have. The engine is stable-diffusion.cpp, a small open-source program. The models and their licences are yours.')) + '</span>'
        + statusRow({ tone: status.tone, spinner: status.spinner === true, progress: status.progress || null, compact: true,
          label: jt('models.library.imageEngine.statusLabel', 'Status'), message: status.message, className: 'model-library-image-engine-status' })
        + (confirmRemove ? '<span class="model-library-image-engine-help">' + escapeHtml(jt('models.library.imageEngine.removeConfirm', 'Remove the image engine? Saved model sets stay.')) + '</span>' : '')
        + '<div class="model-library-image-engine-actions">' + engineActions() + '</div>'
        + (engine && engine.status === 'installing'
          ? '<span class="model-library-folders-empty">' + escapeHtml(jt('models.library.imageEngine.workingNote', 'Then: verify fingerprint → unpack → ready. Chats keep working meanwhile.')) + '</span>' : '')
        + modelsMarkup()
        + '<span class="model-library-image-engine-note" aria-live="polite">' + escapeHtml(note) + '</span>'
        + (notInstalled
          ? '<span class="model-library-folders-empty">' + escapeHtml(jt('models.library.imageEngine.sourceNote', 'Downloads from github.com, checked against a fingerprint built into this version of Jenny. Nothing is sent anywhere.')) + '</span>'
          : '<span class="model-library-folders-empty">' + escapeHtml(jt('models.library.imageEngine.pathNote', 'Folders on this computer or a mapped drive letter. Network paths (\\\\server\\share) are not supported.')) + '</span>')
        + '</div>';
    }

    // Focus survives a re-render: the key names the control, including a
    // per-set button or a slot select, and falls back to the closest live one.
    function focusKeyOf(element) {
      if (!element || typeof element.getAttribute !== 'function') return '';
      var action = element.getAttribute('data-image-engine-action');
      var slot = element.getAttribute('data-image-engine-slot');
      if (action) return 'action:' + action + ':' + (element.getAttribute('data-image-engine-set') || '');
      if (slot) return 'slot:' + slot;
      return '';
    }

    function focusByKey(target, key) {
      if (!key) return;
      var parts = key.split(':');
      var candidate = null;
      if (parts[0] === 'action') {
        var selector = '[data-image-engine-action="' + parts[1] + '"]';
        candidate = target.querySelector(parts[2] ? selector + '[data-image-engine-set="' + parts[2] + '"]' : selector)
          || target.querySelector(selector) || target.querySelector('[data-image-engine-action]:not([disabled])');
      } else if (parts[0] === 'slot') {
        candidate = target.querySelector('[data-image-engine-slot="' + parts[1] + '"]');
      }
      if (candidate && typeof candidate.focus === 'function') candidate.focus();
    }

    function render() {
      if (disposed) return;
      var target = host();
      if (!target) return;
      if (!isEnabled()) { target.innerHTML = ''; return; }
      var active = documentRef && documentRef.activeElement;
      var key = active && target.contains(active) ? focusKeyOf(active) : '';
      // A control that disables itself while an action runs still loses focus;
      // remember the last focused control until the next interactive render.
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
      // Main's answer clears the engine-side failure once the engine is back.
      if (engine.status !== 'installed') confirmRemove = false;
      render();
    }

    function refresh() {
      var api = bridge();
      if (disposed || !api || typeof api.getState !== 'function') return Promise.resolve(null);
      var token = ++generation;
      return Promise.resolve().then(function () { return api.getState(); }).then(function (result) {
        if (token !== generation) return null;
        // A refused answer still re-renders so a pending control comes back.
        if (result && result.ok !== false) applyState(result);
        else render();
        return null;
      }).catch(function () {
        if (token === generation) render();
        return null;
      });
    }

    // One action at a time; the outcome is written beside the buttons. An
    // install answers only when the download has finished, so it does not
    // hold the section: progress arrives through onChanged and Cancel must
    // stay clickable meanwhile.
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
        note = jt('models.library.imageEngine.actionFailed', 'That did not work. Try again.');
        render();
        return null;
      });
    }

    function applyScan(result) {
      if (result && result.ok === false) {
        note = result.reason === 'root_not_local_path' || result.reason === 'image_engine_path_rejected'
          ? jt('models.library.networkPath', 'Jenny can\'t use network locations here. Map the share to a drive letter, then choose it from that drive.')
          : result.reason === 'cancelled' ? '' : jt('models.library.imageEngine.scanFailed', 'Could not read that folder.');
        return;
      }
      if (!result || !result.candidates) return;
      scan = { root: result.root, candidates: result.candidates, truncated: result.truncated === true };
      SLOTS.forEach(function (slot) {
        var list = Array.isArray(scan.candidates[slot]) ? scan.candidates[slot] : [];
        picks[slot] = list.length === 1 || !list.some(function (c) { return c.name === picks[slot]; })
          ? (list.length ? list[0].name : '') : picks[slot];
      });
    }

    function saveSet() {
      if (!scan || !canSave()) return Promise.resolve(null);
      var payload = { root: scan.root, diffusion: picks.diffusion, text_encoder: picks.text_encoder, vae: picks.vae,
        family: detectedFamily() || picks.family, label: '' };
      return invoke('saveModelSet', payload, function (result) {
        note = result.ok === false ? saveFailureMessage(result.reason) : jt('models.library.imageEngine.saved', 'Saved.');
      });
    }

    function onClick(event) {
      var target = event && event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-image-engine-action]') : null;
      if (!target || !host() || !host().contains(target)) return;
      var action = target.getAttribute('data-image-engine-action');
      var setId = target.getAttribute('data-image-engine-set') || '';
      event.preventDefault();
      switch (action) {
        case 'install': void invoke('install', { confirmed: true }, function (result) {
          if (result.ok === false && result.reason !== 'install_in_progress' && result.reason !== 'cancelled') {
            note = installFailureMessage(result.reason);
          }
        }, { wait: false }); break;
        case 'cancel-install': void invoke('cancelInstall'); break;
        case 'remove': confirmRemove = true; render(); break;
        case 'keep': confirmRemove = false; render(); break;
        case 'confirm-remove': confirmRemove = false; void invoke('remove', { confirmed: true }, function (result) {
          if (result.ok === false) note = jt('models.library.imageEngine.removeFailed', 'The engine could not be removed.');
        }); break;
        case 'choose-runtime': void invoke('chooseRuntime', undefined, function (result) {
          if (result.ok === false && result.reason !== 'cancelled') note = installFailureMessage(result.reason);
        }); break;
        case 'clear-runtime': void invoke('clearRuntime'); break;
        case 'reconcile': void invoke('reconcile', undefined, function (result) {
          if (result.ok === false) note = jt('models.library.imageEngine.cleanUpFailed', 'Clean-up could not confirm the render ended. Restart Jenny if this repeats.');
        }); break;
        case 'choose-folder': void invoke('chooseModelFolder', undefined, applyScan); break;
        case 'rescan': if (scan) void invoke('scanModels', { root: scan.root }, applyScan); break;
        case 'save-set': void saveSet(); break;
        case 'make-default': if (ID_RE.test(setId)) void invoke('setDefaultModelSet', { id: setId }); break;
        case 'remove-set': if (ID_RE.test(setId)) void invoke('removeModelSet', { id: setId }); break;
        default: break;
      }
    }

    function onChange(event) {
      var target = event && event.target;
      var slot = target && typeof target.getAttribute === 'function' ? target.getAttribute('data-image-engine-slot') : '';
      if (!slot || !host() || !host().contains(target)) return;
      picks[slot] = String(target.value || '');
      // A different diffusion file may carry a different family.
      if (slot === 'diffusion') picks.family = '';
      render();
    }

    function bind() {
      if (disposed) return;
      var target = host();
      if (!target || target === boundHost) return;
      unbind();
      boundHost = target;
      target.addEventListener('click', onClick);
      target.addEventListener('change', onChange);
      var api = bridge();
      if (api && typeof api.onChanged === 'function') {
        try {
          var maybe = api.onChanged(function (next) {
            if (next && typeof next === 'object' && !Array.isArray(next)) {
              // A change event carries the engine record only; sets and handoff come from getState.
              applyState(Object.assign({}, engine || {}, next));
              void refresh();
            }
          });
          if (typeof maybe === 'function') unsubscribe = maybe;
        } catch (_error) { /* the section still works without live updates */ }
      }
      // A parent re-render swaps the host; the cached state paints at once
      // and the bridge is only asked again when nothing is cached yet.
      if (engine) render();
      else void refresh();
    }

    function unbind() {
      if (boundHost) {
        boundHost.removeEventListener('click', onClick);
        boundHost.removeEventListener('change', onChange);
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

    return { bind: bind, render: render, refresh: refresh, dispose: dispose, getPicks: function () { return Object.assign({}, picks); } };
  }

  return { createModelLibraryImageEngineController: createModelLibraryImageEngineController, quantOf: quantOf };
});
