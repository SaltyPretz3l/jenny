/**
 * Tune drawer › NInfer section (UMD). Row 54 N2 (Step 11).
 *
 * For a model row served by the managed NInfer runtime the drawer shows this
 * section in place of the llama-server Engine section: only the context
 * window (`--max-context`), multi-token prediction (`--spec mtp`) and vision. No GGUF
 * row, no build row, no "Run with". The settings save through
 * `jennyShell.ninfer.updateSettings`; the windows above 128k run with an 8-bit
 * KV cache (`--kv-dtype fp8`, main decides) and their options say so. While NInfer serves this model the
 * restart flow mirrors the llama-server one (confirm only while a chat
 * streams), with NInfer named instead.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererModelTuningNinfer = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  var DEFAULT_WINDOWS = [16384, 32768, 65536, 131072, 153600, 196608, 262144];
  var DEFAULT_FP8_KV_WINDOWS = [153600, 196608, 262144];

  function contextLabel(tokens) {
    var value = Number(tokens) || 0;
    return value >= 1024 ? Math.round(value / 1024) + 'k' : String(value);
  }

  // The drawer's NInfer hint (from the library card) plus the saved settings.
  function normalizeHint(hint) {
    var source = hint && typeof hint === 'object' ? hint : {};
    var hinted = Array.isArray(source.contextWindows) && source.contextWindows.length;
    var windows = hinted ? source.contextWindows.slice() : DEFAULT_WINDOWS;
    var fp8 = hinted ? (Array.isArray(source.fp8KvWindows) ? source.fp8KvWindows.slice() : []) : DEFAULT_FP8_KV_WINDOWS;
    return {
      artifactId: String(source.artifactId || ''),
      modelId: String(source.modelId || ''),
      contextWindows: windows,
      fp8KvWindows: fp8,
      supportsMtp: source.supportsMtp !== false,
    };
  }

  function createNinferTuningSection(deps) {
    var d = deps || {};
    var windowRef = d.windowRef || globalThis;
    var escapeHtml = d.escapeHtml;
    var getStreamingCount = typeof d.getStreamingCount === 'function' ? d.getStreamingCount : function () { return 0; };
    var confirmDialog = d.confirmDialog || null;
    var hint = null;
    var saved = { contextSize: 0, mtp: true, vision: true }; // what main holds
    var draft = { contextSize: 0, mtp: true, vision: true };
    function copyTuning(value) { return { contextSize: value.contextSize, mtp: value.mtp, vision: value.vision }; }
    var status = ''; // the section's own status line
    var pending = false;
    var manager = null; // last jennyShell.ninfer.getState().manager
    var generation = 0; // bumped by open/close so a stale read or apply never lands in a newer session

    function api() {
      var shell = windowRef.jennyShell;
      return shell && shell.ninfer && typeof shell.ninfer === 'object' ? shell.ninfer : null;
    }

    function active() { return Boolean(hint); }

    function open(nextHint) {
      var gen = ++generation;
      hint = nextHint ? normalizeHint(nextHint) : null;
      status = '';
      pending = false;
      manager = null;
      if (!hint) return Promise.resolve(false);
      var bridge = api();
      if (!bridge || typeof bridge.getState !== 'function') return Promise.resolve(false);
      return Promise.resolve().then(function () { return bridge.getState(); }).then(function (state) {
        if (gen !== generation) return false;
        var settings = state && state.settings && typeof state.settings === 'object' ? state.settings : {};
        manager = state && state.manager && typeof state.manager === 'object' ? state.manager : null;
        saved = { contextSize: Number(settings.contextSize) || hint.contextWindows[2] || hint.contextWindows[0], mtp: settings.mtp !== false, vision: settings.vision !== false };
        draft = copyTuning(saved);
        return true;
      }).catch(function () { return false; });
    }

    function close() {
      generation += 1;
      hint = null;
      manager = null;
    }

    // NInfer serves this very model (the sidecar addresses it by the artifact's model_id).
    function serving() {
      return Boolean(manager && manager.state === 'ready' && hint
        && (manager.artifactId === hint.artifactId || String(manager.alias || '') === hint.modelId));
    }

    // Row ids the drawer's dirty pass marks (they match data-model-tuning-row).
    function dirtyRows() {
      var rows = [];
      if (draft.contextSize !== saved.contextSize) rows.push('ninferContext');
      if (Boolean(draft.mtp) !== Boolean(saved.mtp)) rows.push('ninferMtp');
      if (draft.vision !== saved.vision) rows.push('ninferVision');
      return rows;
    }

    function dirty() {
      return dirtyRows().length > 0;
    }

    function statusText() {
      if (status) return status;
      if (serving()) {
        return jt('models.tuning.ninfer.servingOn', 'Serving on :{port}', { port: manager.port || 8034 })
          + (manager.mtp === true ? jt('models.library.tuning.mtpOnSuffix', ' · MTP on') : '');
      }
      return jt('models.tuning.ninfer.startsOnUse', 'Starts when you press Use');
    }

    function html(ctx) {
      var c = ctx || {};
      if (!hint || typeof c.selectField !== 'function' || typeof c.toggleSwitch !== 'function' || typeof c.actionButton !== 'function') return '';
      var disabled = pending || c.pending === true;
      return '<section class="model-tuning-section model-tuning-engine" data-model-tuning-ninfer>'
        + '<h4 class="model-tuning-section-title">NInfer</h4>'
        + '<p class="model-tuning-section-hint">' + escapeHtml(jt('models.tuning.ninfer.hint', 'Runs on the managed NInfer runtime. The context window, multi-token prediction and vision apply after NInfer restarts.')) + '</p>'
        + '<div class="model-tuning-row" data-model-tuning-row="ninferContext">'
        + '<span class="model-tuning-row-label">' + escapeHtml(jt('models.tuning.contextWindow', 'Context window')) + '</span>'
        + '<div class="model-tuning-row-control">'
        + c.selectField({
          id: 'modelTuningNinferContext', ariaLabel: jt('models.tuning.contextWindow', 'Context window'), value: String(draft.contextSize), disabled: disabled,
          options: hint.contextWindows.map(function (tokens) {
            var label = contextLabel(tokens) + ' ' + jt('models.tuning.ninfer.tokens', 'tokens');
            if (hint.fp8KvWindows.indexOf(tokens) >= 0) label += jt('models.tuning.ninfer.fp8KvSuffix', ' · 8-bit cache');
            return { value: String(tokens), label: label };
          }),
          dataset: { 'model-tuning-ninfer-field': 'contextSize' },
        })
        + '</div>'
        + '<span class="model-tuning-row-range" data-dirty="' + (draft.contextSize !== saved.contextSize ? 'true' : 'false') + '">' + escapeHtml(statusText()) + '</span>'
        + '</div>'
        + '<div class="model-tuning-row model-tuning-row--mtp" data-model-tuning-row="ninferMtp">'
        + '<span class="model-tuning-row-label"></span>'
        + '<div class="model-tuning-row-control">'
        + c.toggleSwitch({
          id: 'modelTuningNinferMtp', label: jt('models.library.tuning.mtpLabel', 'Multi-token prediction'),
          checked: Boolean(draft.mtp && hint.supportsMtp), disabled: disabled || !hint.supportsMtp,
        })
        + '</div>'
        + '<span class="model-tuning-row-range" data-dirty="' + (Boolean(draft.mtp) !== Boolean(saved.mtp) ? 'true' : 'false') + '">'
        + escapeHtml(hint.supportsMtp ? jt('models.tuning.ninfer.mtpNote', 'Drafts 3 tokens per step; no separate file needed') : jt('models.library.tuning.mtpFamilyUnsupported', 'MTP not supported for this family'))
        + '</span>'
        + '</div>'
        + '<div class="model-tuning-row" data-model-tuning-row="ninferVision">'
        + '<span class="model-tuning-row-label"></span>'
        + '<div class="model-tuning-row-control">'
        + c.toggleSwitch({
          id: 'modelTuningNinferVision', label: jt('models.tuning.ninfer.visionLabel', 'Vision'),
          checked: draft.vision, disabled: disabled,
        })
        + '</div>'
        + '<span class="model-tuning-row-range" data-dirty="' + (draft.vision !== saved.vision ? 'true' : 'false') + '">'
        + escapeHtml(jt('models.tuning.ninfer.visionNote', 'Lets Qwen3.8 understand attached images. Applies after NInfer restarts.'))
        + '</span>'
        + '</div>'
        + '<div class="model-tuning-row" data-model-tuning-row="ninferApply">'
        + '<span class="model-tuning-row-label"></span>'
        + '<div class="model-tuning-row-control">'
        + c.actionButton({ id: 'apply-ninfer-tuning', label: pending ? jt('models.tuning.applying', 'Applying…') : jt('models.tuning.ninfer.apply', 'Apply NInfer settings'), variant: 'secondary', size: 'sm', disabled: disabled || !dirty() })
        + '</div>'
        + '</div>'
        + '</section>';
    }

    function onChange(event) {
      var target = event && event.target;
      var field = target && typeof target.getAttribute === 'function' ? target.getAttribute('data-model-tuning-ninfer-field') : '';
      if (field === 'contextSize') {
        var value = Number(target.value);
        if (hint && hint.contextWindows.indexOf(value) >= 0) draft.contextSize = value;
        return true;
      }
      return false;
    }

    function onToggle(event) {
      var detail = event && event.detail;
      if (!detail) return false;
      if (detail.id === 'modelTuningNinferMtp') draft.mtp = detail.checked === true;
      else if (detail.id === 'modelTuningNinferVision') draft.vision = detail.checked === true;
      else return false;
      return true;
    }

    // Confirm only while a chat streams (its response would end), exactly as
    // the llama-server flow; NInfer named in every line.
    function confirmRestart() {
      var streaming = getStreamingCount();
      if (!streaming) return Promise.resolve(true);
      if (!confirmDialog || typeof confirmDialog.confirm !== 'function') return Promise.resolve(false);
      return Promise.resolve().then(function () {
        return confirmDialog.confirm({
          title: jt('models.tuning.ninfer.restartConfirmTitle', 'Restart NInfer?'),
          message: jtn('models.tuning.ninfer.restartStreamingWarning', streaming, { count: streaming },
            'A chat is still streaming. Restarting NInfer will end that response. The new settings only take effect after a restart.',
            '{count} chats are still streaming. Restarting NInfer will end those responses. The new settings only take effect after a restart.'),
          confirmLabel: jt('models.tuning.restartAnyway', 'Restart anyway'),
          cancelLabel: jt('models.tuning.notNow', 'Not now'),
          variant: 'danger',
        });
      }).then(function (confirmed) { return confirmed === true; }, function () { return false; });
    }

    // Save, then (while NInfer serves this model) restart it so the settings go live.
    function apply(render) {
      var bridge = api();
      if (pending || !hint || !bridge || typeof bridge.updateSettings !== 'function') return Promise.resolve(false);
      var paint = typeof render === 'function' ? render : function () {};
      var request = { contextSize: draft.contextSize, mtp: Boolean(draft.mtp && hint.supportsMtp), vision: draft.vision };
      var gen = generation;
      var artifactId = hint.artifactId;
      pending = true;
      status = jt('models.tuning.applyingCheckingRuntime', 'Applying and checking the runtime…');
      paint();
      return Promise.resolve().then(function () { return bridge.updateSettings(request); }).then(function (result) {
        if (gen !== generation) return false;
        if (!result || result.ok === false) {
          status = jt('models.tuning.ninfer.saveFailed', 'The NInfer settings could not be saved.');
          return false;
        }
        saved = copyTuning(request);
        if (!serving()) {
          status = jt('models.tuning.ninfer.savedNextStart', 'Setting saved. It takes effect when NInfer next starts.');
          return true;
        }
        return confirmRestart().then(function (confirmed) {
          if (gen !== generation) return false;
          if (!confirmed) {
            status = jt('models.tuning.ninfer.savedNextRestart', 'Setting saved. The new settings will take effect on the next NInfer restart.');
            return true;
          }
          status = jt('models.tuning.ninfer.restarting', 'Restarting NInfer…');
          paint();
          return Promise.resolve().then(function () { return bridge.restart({ artifactId: artifactId, contextSize: request.contextSize, mtp: request.mtp, vision: request.vision }); })
            .then(function (restarted) {
              if (gen !== generation) return false;
              manager = restarted && restarted.status && typeof restarted.status === 'object' ? restarted.status : manager;
              var live = Boolean(restarted && restarted.ok !== false && manager && manager.state === 'ready');
              status = live
                ? jt('models.tuning.ninfer.restarted', 'NInfer restarted with the new settings.')
                : jt('models.tuning.ninfer.restartFailedSaved', 'NInfer restart failed. The setting was saved and is not live yet.');
              return live;
            }, function () {
              if (gen !== generation) return false;
              status = jt('models.tuning.ninfer.restartFailedSaved', 'NInfer restart failed. The setting was saved and is not live yet.');
              return false;
            });
        });
      }, function () {
        if (gen !== generation) return false;
        status = jt('models.tuning.ninfer.saveFailed', 'The NInfer settings could not be saved.');
        return false;
      }).then(function (outcome) {
        if (gen !== generation) return outcome;
        pending = false;
        paint();
        return outcome;
      });
    }

    return {
      open: open, close: close, active: active, html: html, onChange: onChange, onToggle: onToggle, apply: apply,
      dirty: dirty, dirtyRows: dirtyRows, busy: function () { return pending; }, draft: function () { return copyTuning(draft); },
    };
  }

  return { createNinferTuningSection: createNinferTuningSection, contextLabel: contextLabel, DEFAULT_WINDOWS: DEFAULT_WINDOWS };
});
