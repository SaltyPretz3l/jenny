// Tune drawer > Engine > "Drafter file" and "Vision" rows (row 140): the state of
// a GGUF model's companion files and the one button that fetches, cancels or
// retries one. The Engine section renders both rows hidden (engine utils); this
// module fills and unhides them from llamaServer.companionStatus. Pure builders
// first, then the controller that owns the click, the poll and the status line.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('./renderer-model-tuning-engine-utils'), require('../inventory/action-button'), require('../inventory/progress-bar'));
    return;
  }
  root.rendererModelTuningCompanions = factory(root, root.rendererModelTuningEngineUtils, root.inventoryActionButton, root.inventoryProgressBar);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, engineUtils, bundledActionButton, bundledProgressBar) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var POLL_MS = 1000;
  // Failed status reads in a row that end a download's poll (the model left the scan, IPC down).
  var MAX_MISSES = 3;
  // Row key, bridge kind and status field per view kind.
  var KINDS = {
    drafter: { row: 'drafter', wire: 'drafter', field: 'drafter' },
    vision: { row: 'vision', wire: 'projector', field: 'projector' },
  };

  var escapeHtml = function (value) {
    return (globalThis.stringUtils || require('../shared/string-utils')).escapeHtml(value);
  };

  function kindOf(kind) {
    return String(kind) === 'projector' || String(kind) === 'vision' ? 'vision' : 'drafter';
  }

  // File sizes read decimal, as the download page shows them: 1.4 GB, 610 MB.
  function gbText(bytes) {
    return (Math.round((Number(bytes) || 0) / 1e8) / 10) + ' GB';
  }

  function receivedText(bytes) {
    var n = Number(bytes) || 0;
    return n < 1e9 ? Math.round(n / 1e6) + ' MB' : gbText(n);
  }

  function vramText(mb) {
    return engineUtils.formatGb(Number(mb) || 0);
  }

  function noteText(kind, status) {
    var vision = kind === 'vision';
    var reason = String(status.reason || '');
    switch (reason) {
      case 'local_only': return jt('models.library.tuning.companion.localOnly', 'Local only is on, so Jenny downloads nothing.');
      case 'ollama_copy': return jt('models.library.tuning.companion.ollamaCopy', 'This is Ollama\'s copy. Move the model into a GGUF folder to add files beside it.');
      case 'not_in_catalog': return vision
        ? jt('models.library.tuning.companion.visionNotListed', 'Jenny doesn\'t know a vision file for this model yet.')
        : jt('models.library.tuning.companion.drafterNotListed', 'Jenny doesn\'t know a drafter for this model yet. You can still put an mtp-*.gguf beside it.');
      case 'not_paired': return jt('models.library.tuning.companion.notPaired', 'Jenny wouldn\'t use this file beside the other models in this folder. Move the model into a folder of its own.');
      case 'name_taken': return jt('models.library.tuning.companion.nameTaken', 'Another file already has this name beside the model. Jenny never replaces it.');
      case 'folder_rejected': return jt('models.library.tuning.companion.folderRejected', 'Jenny can\'t write to this model\'s folder.');
      case 'insufficient_space': return jt('models.library.tuning.companion.noSpace', 'Needs {needed} free on {drive}. {free} is free.', {
        needed: gbText(status.neededBytes), drive: String(status.drive || ''), free: gbText(status.freeBytes),
      });
      case 'hf_gated': return jt('models.library.tuning.companion.gated', 'This file needs a Hugging Face sign-in.');
      case 'busy': return jt('models.library.tuning.companion.busy', 'Another file is downloading. This one can start when it finishes.');
      case 'disabled': return jt('models.library.tuning.companion.disabled', 'Downloading companion files is turned off.');
      case 'sha256_mismatch': return jt('models.library.tuning.companion.checksum', 'The download didn\'t match its checksum and was deleted.');
      default: return status.state === 'failed'
        ? jt('models.library.tuning.companion.stopped', 'The download stopped. Try again to resume it.')
        : jt('models.library.tuning.companion.unavailable', 'Jenny can\'t download this file right now.');
    }
  }

  function fileValueHtml(name) {
    return '<code class="model-tuning-gguf-path" data-model-tuning-companion-file tabindex="-1" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</code>';
  }

  function plainValueHtml(text) {
    return '<span class="model-tuning-companion-value" tabindex="-1">' + escapeHtml(text) + '</span>';
  }

  function emptyValueHtml(kind) {
    return plainValueHtml(kind === 'vision'
      ? jt('models.library.tuning.companion.valueVisionOff', 'Off · no vision file beside this model')
      : jt('models.library.tuning.companion.valueNone', 'None beside this model'));
  }

  function getLabel(kind) {
    return kind === 'vision' ? jt('models.library.tuning.companion.getVision', 'Get vision') : jt('models.library.tuning.companion.getDrafter', 'Get drafter');
  }

  function madeFor(status) {
    return status.fineTune && status.baseName
      ? ' ' + jt('models.library.tuning.companion.madeFor', 'Made for {name}.', { name: String(status.baseName) })
      : '';
  }

  // The row's state as data (plan section 3.5). `serving` is true only while the
  // file arrived after the running server started (the controller decides).
  // opts.download is the bridge's { receivedBytes, totalBytes } for this kind.
  function companionView(kindInput, status, opts) {
    var kind = kindOf(kindInput);
    var options = opts || {};
    if (!status || typeof status !== 'object') {
      return { kind: kind, hidden: true, valueHtml: '', note: '', tone: '', action: null, progress: null, state: '' };
    }
    var state = String(status.state || '');
    var view = { kind: kind, hidden: false, valueHtml: emptyValueHtml(kind), note: '', tone: '', action: null, progress: null, state: state };
    var fileName = String(status.fileName || '');
    if (state === 'installed') {
      view.valueHtml = fileValueHtml(fileName);
      if (options.serving) {
        view.note = jt('models.library.tuning.companion.installedServing', 'Installed. Takes effect the next time the model starts.');
        view.action = { id: 'restart', label: jt('models.library.tuning.companion.restart', 'Restart now'), disabled: false };
      } else if (kind === 'vision') {
        view.note = jt('models.library.tuning.companion.visionInstalled', 'Images you attach are read by this model.');
      }
    } else if (state === 'embedded') {
      view.valueHtml = plainValueHtml(jt('models.library.tuning.companion.valueBuiltIn', 'Using the head built into the model'));
      // The service sends the gain only when it offers the drafter over the head.
      var gain = status.gainOverBuiltInPct == null ? NaN : Number(status.gainOverBuiltInPct);
      if (Number.isFinite(gain)) {
        view.note = jt('models.library.tuning.companion.embeddedOffer', 'MTP already works. A separate drafter is about {percent}% faster on this model: {size} download, about {memory} more VRAM.', {
          percent: Math.round(gain), size: gbText(status.bytes), memory: vramText(status.vramOverBuiltInMb),
        }) + madeFor(status);
        view.action = { id: 'get', label: getLabel(kind), disabled: false };
      } else {
        view.note = jt('models.library.tuning.companion.embeddedNoGain', 'This model carries its own MTP head, so no separate file is needed.');
        view.tone = 'muted';
      }
    } else if (state === 'available') {
      view.note = (kind === 'vision'
        ? jt('models.library.tuning.companion.visionOffer', '{size} download, checked before use. Uses about {memory} more VRAM.', { size: gbText(status.bytes), memory: vramText(status.vramMb) })
        : jt('models.library.tuning.companion.drafterOffer', '{size} download, checked before use. Uses about {memory} more VRAM while MTP is on.', { size: gbText(status.bytes), memory: vramText(status.vramMb) }))
        + madeFor(status);
      view.action = { id: 'get', label: getLabel(kind), disabled: false };
    } else if (state === 'downloading') {
      view.valueHtml = '';
      var download = options.download || {};
      view.progress = { receivedBytes: Number(download.receivedBytes) || 0, totalBytes: Number(download.totalBytes) || Number(status.bytes) || 0 };
      view.note = jt('models.library.tuning.companion.downloading', 'Checked before use. Cancel keeps what is done, so the next try resumes.');
      view.action = { id: 'cancel', label: jt('models.library.tuning.companion.cancel', 'Cancel'), disabled: false };
    } else if (state === 'failed') {
      view.note = noteText(kind, status);
      view.tone = 'warn';
      view.action = { id: 'retry', label: jt('models.library.tuning.companion.retry', 'Try again'), disabled: false };
    } else {
      // unavailable, or a state this build does not know: greyed out with its reason.
      view.note = noteText(kind, status);
      view.tone = 'muted';
      view.action = { id: 'get', label: getLabel(kind), disabled: true };
    }
    return view;
  }

  function actionHtml(view, actionButton) {
    var action = view.action;
    if (!action || typeof actionButton !== 'function') return '';
    var button = actionButton({
      id: 'model-tuning-companion-' + action.id, label: action.label,
      variant: action.id === 'cancel' ? 'ghost' : 'secondary', size: 'sm', disabled: action.disabled === true,
      dataset: { 'model-tuning-companion-action': action.id, 'model-tuning-companion-kind': view.kind },
    });
    return '<span class="model-tuning-row-actions">' + button + '</span>';
  }

  function progressText(progress) {
    return jt('models.library.tuning.companion.bytesOf', '{received} of {total}', {
      received: receivedText(progress.receivedBytes), total: gbText(progress.totalBytes),
    });
  }

  // The control column: the value (or the progress bar and its bytes) and the one action.
  function rowControlHtml(view, deps) {
    var d = deps || {};
    var inner = view.valueHtml || '';
    if (view.progress) {
      var bar = typeof d.progressBar === 'function' ? d.progressBar : null;
      var label = view.kind === 'vision'
        ? jt('models.library.tuning.companion.downloadingVision', 'Downloading the vision file')
        : jt('models.library.tuning.companion.downloadingDrafter', 'Downloading the drafter file');
      inner = (bar ? bar({
        value: view.progress.receivedBytes, max: view.progress.totalBytes || 1, label: label,
        warningThreshold: 2, dangerThreshold: 2,
      }) : '')
        + '<span class="model-tuning-companion-bytes">' + escapeHtml(progressText(view.progress)) + '</span>';
    }
    return '<div class="model-tuning-companion">' + inner + actionHtml(view, d.actionButton) + '</div>';
  }

  function resolveBridge() {
    return (typeof window !== 'undefined' && window.jennyShell && window.jennyShell.llamaServer) || undefined;
  }

  var controllers = new WeakMap();

  // Fills the two skeleton rows inside `host` and keeps them current. Returns
  // { dispose, refresh }; mounting the same host again replaces the old controller.
  function mount(host, opts) {
    var o = opts || {};
    var bridge = o.bridge || resolveBridge();
    if (!host || typeof host.querySelector !== 'function') return null;
    if (!host.querySelector('[data-model-tuning-row="drafter"], [data-model-tuning-row="vision"]')
        || !bridge || typeof bridge.companionStatus !== 'function') return null;
    var previous = controllers.get(host);
    if (previous) previous.dispose();
    var setTimer = o.setTimeoutImpl || function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimer = o.clearTimeoutImpl || function (id) { clearTimeout(id); };
    var key = o.tag + '|' + o.modelPath;
    // Survives a re-render of the same model, so a finished install keeps its Restart now
    // and the rows repaint from the last status at once instead of hiding until it answers.
    var memory = previous && previous.key === key ? previous.memory : { installedHere: {}, seen: {}, last: null };
    var mtpRow = host.querySelector('[data-model-tuning-row="mtp"]');
    var engineOn = !mtpRow || !mtpRow.hidden;
    var disposed = false;
    var timer = null;
    var last = memory.last || { drafter: null, projector: null, download: null };
    var rendered = {};
    var misses = 0;

    function rowOf(kind) { return host.querySelector('[data-model-tuning-row="' + KINDS[kind].row + '"]'); }

    function announce(text) {
      var line = host.querySelector('.model-tuning-drawer-status');
      if (line) line.textContent = text;
    }

    function viewFor(kind) {
      var status = last[KINDS[kind].field];
      var download = last.download && kindOf(last.download.kind) === kind ? last.download : null;
      var serving = Boolean(o.serving) && memory.installedHere[kind] === true;
      return companionView(kind, status, { serving: serving, download: download });
    }

    function focusAfter(row, hadFocus) {
      if (!hadFocus) return;
      var target = row.querySelector('[data-model-tuning-companion-action]:not([disabled])')
        || row.querySelector('.model-tuning-companion-value, [data-model-tuning-companion-file]');
      if (target && typeof target.focus === 'function') target.focus();
    }

    function patchRow(kind) {
      var row = rowOf(kind);
      if (!row) return;
      var view = viewFor(kind);
      row.hidden = view.hidden || !engineOn;
      if (view.hidden) return;
      var note = row.querySelector('[data-model-tuning-note]');
      var control = row.querySelector('.model-tuning-row-control');
      if (!note || !control) return;
      var shape = [view.state, view.note, view.tone, view.action ? view.action.id + view.action.disabled : '', view.valueHtml].join('\u0001');
      var progressNode = view.progress ? control.querySelector('.inv-progress') : null;
      if (progressNode && rendered[kind] === shape) {
        // Same downloading row: move the bar and the bytes, keep the button the user may be pressing.
        var total = view.progress.totalBytes || 1;
        var percent = Math.round(Math.min(Math.max(view.progress.receivedBytes / total, 0), 1) * 100);
        progressNode.style.setProperty('--progress', percent + '%');
        progressNode.setAttribute('aria-valuenow', String(view.progress.receivedBytes));
        progressNode.setAttribute('aria-valuemax', String(total));
        var bytes = control.querySelector('.model-tuning-companion-bytes');
        if (bytes) bytes.textContent = progressText(view.progress);
        return;
      }
      var doc = host.ownerDocument;
      var hadFocus = Boolean(doc && doc.activeElement && control.contains(doc.activeElement));
      note.textContent = view.note;
      if (view.tone) note.setAttribute('data-tone', view.tone); else note.removeAttribute('data-tone');
      control.innerHTML = rowControlHtml(view, {
        actionButton: bundledActionButton || root.inventoryActionButton,
        progressBar: bundledProgressBar || root.inventoryProgressBar,
      });
      rendered[kind] = shape;
      focusAfter(row, hadFocus);
    }

    function render() {
      patchRow('drafter');
      patchRow('vision');
    }

    // A download seen finishing (or failing) is announced once, in the drawer's polite line.
    function noteTransitions(next) {
      ['drafter', 'vision'].forEach(function (kind) {
        var status = next[KINDS[kind].field];
        var was = memory.seen[kind];
        var now = status ? String(status.state || '') : '';
        memory.seen[kind] = now;
        if (was !== 'downloading' || now === 'downloading') return;
        if (now === 'installed') {
          memory.installedHere[kind] = true;
          announce(kind === 'vision' ? jt('models.library.tuning.companion.visionInstalledStatus', 'Vision file installed.') : jt('models.library.tuning.companion.drafterInstalledStatus', 'Drafter file installed.'));
        } else if (now === 'failed') {
          announce(companionView(kind, status, {}).note);
        }
      });
    }

    function active() {
      return !disposed && host.isConnected !== false && Boolean(rowOf('drafter') || rowOf('vision'));
    }

    async function fetchStatus() {
      var result;
      try {
        result = await bridge.companionStatus({ tag: o.tag, modelPath: o.modelPath });
      } catch (_error) {
        result = { ok: false, reason: 'ipc_failed' };
      }
      if (!active()) return false;
      if (!result || result.ok !== true) {
        // A download whose status keeps failing hides its rows instead of polling a frozen bar.
        misses += 1;
        if (misses >= MAX_MISSES && downloading()) {
          last = { drafter: null, projector: null, download: null };
          memory.last = null;
          render();
        }
        return false;
      }
      misses = 0;
      noteTransitions(result);
      last = { drafter: result.drafter || null, projector: result.projector || null, download: result.download || null };
      memory.last = last;
      render();
      return true;
    }

    function downloading() {
      return Boolean(last.download) || (last.drafter && last.drafter.state === 'downloading') || (last.projector && last.projector.state === 'downloading');
    }

    function stopPolling() {
      if (timer != null) clearTimer(timer);
      timer = null;
    }

    function schedule() {
      stopPolling();
      if (!active() || !downloading()) return;
      timer = setTimer(async function () {
        timer = null;
        if (!active()) return;
        await fetchStatus();
        schedule();
      }, POLL_MS);
    }

    async function refresh() {
      await fetchStatus();
      schedule();
    }

    async function onClick(event) {
      var button = event.target && event.target.closest ? event.target.closest('[data-model-tuning-companion-action]') : null;
      if (!button || !host.contains(button) || button.disabled) return;
      var kind = kindOf(button.dataset.modelTuningCompanionKind);
      var action = button.dataset.modelTuningCompanionAction;
      if (action === 'restart') {
        var restarted = false;
        try { restarted = typeof o.restart === 'function' ? await o.restart() : false; } catch (_error) { /* the drawer reports it */ }
        if (restarted !== false && !disposed) { memory.installedHere = {}; render(); }
        return;
      }
      if (action === 'cancel') {
        try { await bridge.cancelCompanion(); } catch (_error) { /* the next status says what happened */ }
        await refresh();
        return;
      }
      if (action !== 'get' && action !== 'retry') return;
      var result;
      try {
        result = await bridge.installCompanion({ tag: o.tag, modelPath: o.modelPath, kind: KINDS[kind].wire });
      } catch (_error) {
        result = { ok: false, reason: 'ipc_failed' };
      }
      if (disposed) return;
      if (!result || result.ok !== true) {
        announce(companionView(kind, { state: 'failed', reason: result && result.reason }, {}).note);
      }
      await refresh();
    }

    // The drawer hides its MTP row with the engine choice; these rows go with it.
    function onEngineChange(event) {
      if (!event || !event.detail || event.detail.id !== 'modelTuningEngine') return;
      engineOn = event.detail.value === 'llama-server';
      render();
    }

    function dispose() {
      disposed = true;
      stopPolling();
      host.removeEventListener('click', onClick);
      host.removeEventListener('inv-segmented-change', onEngineChange);
      if (controllers.get(host) === controller) controllers.delete(host);
    }

    var controller = { dispose: dispose, refresh: refresh, key: key, memory: memory };
    controllers.set(host, controller);
    host.addEventListener('click', onClick);
    host.addEventListener('inv-segmented-change', onEngineChange);
    if (memory.last) render();
    void refresh();
    return controller;
  }

  return {
    companionView: companionView,
    mount: mount,
    rowControlHtml: rowControlHtml,
  };
});
