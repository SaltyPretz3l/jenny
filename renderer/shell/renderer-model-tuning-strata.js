/**
 * Tune drawer › Strata section (UMD, row 200): replaces the Engine section for a Strata row. Settings save
 * through `jennyShell.strata.updateSettings` (changed keys only), then the NInfer restart flow. The context
 * sizes offered stay under the fit main reports for the pairing (never computed here); "Largest that fits"
 * saves `context: null`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererModelTuningStrata = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  var SLOTS = [1, 2, 4];
  var KV_FORMATS = ['auto', 'k8v8', 'k8v4'];
  var PRESETS = [16384, 32768, 65536, 131072, 262144];
  var DEFAULTS = { slots: 4, kv: 'k8v8', context: null, vision: true, drafting: 'off' }; // D5 (strata-settings.js)

  function contextLabel(tokens) {
    var value = Number(tokens) || 0;
    return value >= 1024 ? Math.round(value / 1024) + 'k' : String(value);
  }

  function objectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function readSettings(source) {
    var s = objectOrEmpty(source);
    var context = Number(s.context);
    return {
      slots: SLOTS.indexOf(Number(s.slots)) >= 0 ? Number(s.slots) : DEFAULTS.slots,
      kv: KV_FORMATS.indexOf(s.kv) >= 0 ? s.kv : DEFAULTS.kv,
      context: Number.isInteger(context) && context > 0 ? context : null,
      vision: s.vision !== false,
      drafting: s.drafting === 'dspark' ? 'dspark' : 'off',
    };
  }

  function createStrataTuningSection(deps) {
    var d = deps || {};
    var windowRef = d.windowRef || globalThis;
    var escapeHtml = d.escapeHtml;
    var getStreamingCount = typeof d.getStreamingCount === 'function' ? d.getStreamingCount : function () { return 0; };
    var confirmDialog = d.confirmDialog || null;
    var hint = null;
    var saved = Object.assign({}, DEFAULTS); // what main holds
    var draft = Object.assign({}, DEFAULTS);
    var fits = {};
    var packs = {};
    var manager = null; // last jennyShell.strata.getState().manager
    var status = ''; // the section's own status line
    var pending = false;
    var generation = 0; // bumped by open/close so a stale read or apply never lands in a newer session

    function api() {
      var shell = windowRef.jennyShell;
      return shell && shell.strata && typeof shell.strata === 'object' ? shell.strata : null;
    }

    function active() { return Boolean(hint); }

    function open(nextHint) {
      var gen = ++generation;
      hint = nextHint ? { modelId: String(objectOrEmpty(nextHint).modelId || '') } : null;
      status = '';
      pending = false;
      manager = null;
      if (!hint) return Promise.resolve(false);
      var bridge = api();
      if (!bridge || typeof bridge.getState !== 'function') return Promise.resolve(false);
      return Promise.resolve().then(function () { return bridge.getState(); }).then(function (state) {
        if (gen !== generation) return false;
        var s = objectOrEmpty(state);
        manager = s.manager && typeof s.manager === 'object' ? s.manager : null;
        fits = objectOrEmpty(s.fits);
        packs = objectOrEmpty(objectOrEmpty(s.runtime).packs);
        saved = readSettings(s.settings);
        draft = Object.assign({}, saved);
        return true;
      }).catch(function () { return false; });
    }

    function close() {
      generation += 1;
      hint = null;
      manager = null;
    }

    function serving() { return Boolean(manager && manager.state === 'ready'); }
    function visionUnusable() { return packs.vision === 'failed' || packs.vision === 'missing'; }

    // Tokens each chat can hold for a pairing, from main's table; 0 while that pairing is unmeasured.
    function fitFor(slots, kv) {
      var tokens = Number(objectOrEmpty(fits[slots + ':' + kv]).tokens);
      return Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
    }

    // The context a settings object means under its own pairing: null (or a size at or above the fit) is the largest.
    function effectiveContext(s) {
      var fit = fitFor(s.slots, s.kv);
      if (!fit) return s.context;
      return s.context == null || s.context >= fit ? null : s.context;
    }

    // The keys that differ from what main holds (context compared the way it is shown).
    function changes() {
      var patch = {};
      ['slots', 'kv', 'drafting'].forEach(function (key) { if (draft[key] !== saved[key]) patch[key] = draft[key]; });
      if (!visionUnusable() && draft.vision !== saved.vision) patch.vision = draft.vision;
      if (effectiveContext(draft) !== effectiveContext(saved)) patch.context = effectiveContext(draft);
      return patch;
    }

    function dirtyRows() {
      var rowOf = { slots: 'strataSlots', kv: 'strataKv', context: 'strataContext', drafting: 'strataDraft', vision: 'strataVision' };
      return Object.keys(changes()).map(function (key) { return rowOf[key]; });
    }

    function dirty() { return dirtyRows().length > 0; }

    function statusText() {
      if (status) return status;
      return serving()
        ? jt('models.tuning.strata.servingOn', 'Serving on :{port}', { port: manager.port || 8035 })
        : jt('models.tuning.strata.startsOnLoad', 'Starts when you press Load');
    }

    // `**x**` in a translated string is bold; the rest is escaped text.
    function boldHtml(text) {
      return escapeHtml(String(text)).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    }

    function fitLineHtml() {
      var fit = fitFor(draft.slots, draft.kv);
      if (!fit) return escapeHtml(jt('models.tuning.strata.fitLineUnknown', 'This choice has not been measured on this card. Jenny starts at 32k tokens and keeps what Strata reports.'));
      return draft.slots === 1
        ? boldHtml(jt('models.tuning.strata.fitLineOne', 'With this choice each chat can hold up to **{tokens} tokens**.', { tokens: contextLabel(fit) }))
        : boldHtml(jt('models.tuning.strata.fitLineMany', 'With this choice each chat can hold up to **{tokens} tokens**, and {slots} chats are answered at once.', { tokens: contextLabel(fit), slots: draft.slots }));
    }

    // The window options for the draft pairing: the largest that fits, then the presets under the fit (and the
    // saved size when it sits between them). Unmeasured: one option, 32k.
    function contextChoice() {
      var fit = fitFor(draft.slots, draft.kv);
      if (!fit) {
        return { value: '32768', note: jt('models.tuning.strata.contextUnmeasuredNote', 'Not measured on this card yet. Jenny starts at 32k and keeps the size Strata reports.'),
          options: [{ value: '32768', label: jt('models.tuning.strata.contextUnmeasured', '32k tokens (until the first start measures this choice)') }] };
      }
      var chosen = effectiveContext(draft);
      var sizes = PRESETS.filter(function (size) { return size < fit; });
      if (chosen != null && sizes.indexOf(chosen) < 0) sizes = sizes.concat([chosen]).sort(function (a, b) { return a - b; });
      return {
        value: chosen == null ? 'max' : String(chosen),
        note: jt('models.tuning.strata.contextFollows', 'Follows your choice above, so it never asks for more than fits.'),
        options: [{ value: 'max', label: jt('models.tuning.strata.contextLargest', 'Largest that fits ({tokens} tokens)', { tokens: contextLabel(fit) }) }]
          .concat(sizes.map(function (size) { return { value: String(size), label: contextLabel(size) + ' ' + jt('models.tuning.strata.tokens', 'tokens') }; })),
      };
    }

    function optionsHtml(choice) {
      return choice.options.map(function (option) {
        return '<option value="' + escapeHtml(option.value) + '"' + (option.value === choice.value ? ' selected' : '') + '>' + escapeHtml(option.label) + '</option>';
      }).join('');
    }

    // Rows in the drawer's grammar (ctx.rowHtml / ctx.sectionHtml from renderer-model-tuning-rows.js).
    function html(ctx) {
      var c = ctx || {};
      if (!hint || typeof c.selectField !== 'function' || typeof c.toggleSwitch !== 'function' || typeof c.actionButton !== 'function'
        || typeof c.segmentedControl !== 'function' || typeof c.rowHtml !== 'function' || typeof c.sectionHtml !== 'function') return '';
      var disabled = pending || c.pending === true;
      var row = function (o) { return c.rowHtml(Object.assign({ escapeHtml: escapeHtml }, o)); };
      var choice = contextChoice();
      var draftLabel = jt('models.tuning.strata.draftLabel', 'Draft ahead (DSpark)');
      var visionLabel = jt('models.tuning.strata.visionLabel', 'Vision');
      var slotsLabel = jt('models.tuning.strata.slotsLabel', 'Chats at once');
      var kvLabel = jt('models.tuning.strata.kvLabel', 'Memory format');
      var body = '<p class="model-tuning-section-hint">' + escapeHtml(jt('models.tuning.strata.hint', 'Runs on your Strata install. These apply after Strata restarts.')) + '</p>'
        + row({
          key: 'strataSlots', label: slotsLabel, desc: jt('models.tuning.strata.slotsDesc', 'How many chats Strata answers at the same time. Jenny\'s background work (titles, notes) counts as a chat.'),
          controlHtml: c.segmentedControl({ id: 'strataSlots', ariaLabel: slotsLabel, value: String(draft.slots), disabled: disabled,
            options: SLOTS.map(function (slots) { return { value: String(slots), label: String(slots) }; }) }),
        })
        + row({
          key: 'strataKv', label: kvLabel, desc: jt('models.tuning.strata.kvDesc', 'How Strata stores what each chat remembers. Compact holds about twice as much, with little change in answers.'),
          controlHtml: c.segmentedControl({ id: 'strataKv', ariaLabel: kvLabel, value: draft.kv, disabled: disabled, options: [
            { value: 'auto', label: jt('models.tuning.strata.kv.auto', 'Standard') },
            { value: 'k8v8', label: jt('models.tuning.strata.kv.k8v8', 'Compact') },
            { value: 'k8v4', label: jt('models.tuning.strata.kv.k8v4', 'Smallest') }] }),
        })
        + '<p class="model-tuning-section-hint strata-fit-line" id="strataFitLine">' + fitLineHtml() + '</p>'
        + row({
          key: 'strataContext', label: jt('models.tuning.contextWindow', 'Context window'),
          desc: jt('models.tuning.desc.contextLength', 'How much of the chat the model can see at once.'),
          tip: jt('models.tuning.strata.contextTip', 'Never more than fits on the card for this choice: asking for more would spill into system memory.'), note: choice.note,
          controlHtml: c.selectField({ id: 'strataContext', ariaLabel: jt('models.tuning.contextWindow', 'Context window'), value: choice.value, disabled: disabled,
            options: choice.options, dataset: { 'model-tuning-strata-field': 'context' } }),
        })
        + row({
          key: 'strataDraft', label: draftLabel, labelId: 'modelTuningLabelStrataDraft', desc: jt('models.tuning.strata.draftDesc', 'May make replies faster. Off until Jenny has measured it on this card.'),
          controlHtml: c.toggleSwitch({ id: 'strataDraft', label: draftLabel, bare: true, labelledBy: 'modelTuningLabelStrataDraft', checked: draft.drafting === 'dspark', disabled: disabled }),
        })
        + row({
          key: 'strataVision', label: visionLabel, labelId: 'modelTuningLabelStrataVision', desc: jt('models.tuning.strata.visionDesc', 'Lets Inkling 2 Mini understand attached images.'),
          note: visionUnusable() ? jt('models.tuning.strata.visionUnavailable', 'The image pack did not pass its check.') : '',
          controlHtml: c.toggleSwitch({ id: 'strataVision', label: visionLabel, bare: true, labelledBy: 'modelTuningLabelStrataVision',
            checked: draft.vision && !visionUnusable(), disabled: disabled || visionUnusable() }),
        })
        + '<div class="model-tuning-section-actions" data-model-tuning-row="strataApply">'
        + c.actionButton({ id: 'apply-strata-tuning', label: pending ? jt('models.tuning.applying', 'Applying…') : jt('models.tuning.strata.apply', 'Apply Strata settings'), variant: 'secondary', size: 'sm', disabled: disabled || !dirty() })
        + '</div>';
      return c.sectionHtml(escapeHtml, 'Strata', statusText(), body, ' data-model-tuning-strata');
    }

    function discard() {
      draft = Object.assign({}, saved);
      status = '';
    }

    // A slots or memory-format click: the fit line and window options follow in place (focus and edits stay), before Apply.
    function onSegment(event) {
      var detail = event && event.detail;
      if (!detail || !hint || (detail.id !== 'strataSlots' && detail.id !== 'strataKv')) return false;
      if (detail.id === 'strataSlots' && SLOTS.indexOf(Number(detail.value)) >= 0) draft.slots = Number(detail.value);
      else if (detail.id === 'strataKv' && KV_FORMATS.indexOf(detail.value) >= 0) draft.kv = detail.value;
      var doc = windowRef.document;
      var line = doc && doc.getElementById('strataFitLine');
      var select = doc && doc.getElementById('strataContext');
      var note = doc && doc.querySelector('[data-model-tuning-row="strataContext"] [data-model-tuning-note]');
      var applyButton = doc && doc.querySelector('[data-action="apply-strata-tuning"]');
      var choice = contextChoice();
      if (line) line.innerHTML = fitLineHtml();
      if (select) { select.innerHTML = optionsHtml(choice); select.value = choice.value; }
      if (note) note.textContent = choice.note;
      if (applyButton) applyButton.disabled = pending || !dirty();
      return true;
    }

    function onChange(event) {
      var target = event && event.target;
      var field = target && typeof target.getAttribute === 'function' ? target.getAttribute('data-model-tuning-strata-field') : '';
      if (field !== 'context') return false;
      var value = String(target.value);
      var offered = contextChoice().options.some(function (option) { return option.value === value; });
      if (offered && value === 'max') draft.context = null;
      else if (offered && fitFor(draft.slots, draft.kv)) draft.context = Number(value);
      return true;
    }

    function onToggle(event) {
      var detail = event && event.detail;
      if (!detail) return false;
      if (detail.id === 'strataDraft') draft.drafting = detail.checked === true ? 'dspark' : 'off';
      else if (detail.id === 'strataVision') draft.vision = detail.checked === true;
      else return false;
      return true;
    }

    // Confirm only while a chat streams (its response would end), exactly as the llama-server and NInfer flows.
    function confirmRestart() {
      var streaming = getStreamingCount();
      if (!streaming) return Promise.resolve(true);
      if (!confirmDialog || typeof confirmDialog.confirm !== 'function') return Promise.resolve(false);
      return Promise.resolve().then(function () {
        return confirmDialog.confirm({
          title: jt('models.tuning.strata.restartConfirmTitle', 'Restart Strata?'),
          message: jtn('models.tuning.strata.restartStreamingWarning', streaming, { count: streaming },
            'A chat is still streaming. Restarting Strata will end that response. The new settings only take effect after a restart.',
            '{count} chats are still streaming. Restarting Strata will end those responses. The new settings only take effect after a restart.'),
          confirmLabel: jt('models.tuning.restartAnyway', 'Restart anyway'),
          cancelLabel: jt('models.tuning.notNow', 'Not now'),
          variant: 'danger',
        });
      }).then(function (confirmed) { return confirmed === true; }, function () { return false; });
    }

    // Save the changed keys, then (while Strata runs) restart it so the settings go live.
    function apply(render) {
      var bridge = api();
      if (pending || !hint || !bridge || typeof bridge.updateSettings !== 'function') return Promise.resolve(false);
      var patch = changes();
      if (!Object.keys(patch).length) return Promise.resolve(false);
      var paint = typeof render === 'function' ? render : function () {};
      var gen = generation;
      var restartFailed = function () {
        status = jt('models.tuning.strata.restartFailedSaved', 'Strata restart failed. The setting was saved and is not live yet.');
        return false;
      };
      pending = true;
      status = jt('models.tuning.applyingCheckingRuntime', 'Applying and checking the runtime…');
      paint();
      return Promise.resolve().then(function () { return bridge.updateSettings(patch); }).then(function (result) {
        if (gen !== generation) return false;
        if (!result || result.ok === false) {
          status = jt('models.tuning.strata.saveFailed', 'The Strata settings could not be saved.');
          return false;
        }
        saved = Object.assign({}, draft, { context: effectiveContext(draft) });
        draft = Object.assign({}, saved);
        // Strata may have started since the drawer opened: decide the restart on its state now.
        return Promise.resolve().then(function () { return bridge.getState(); }).then(function (fresh) { manager = objectOrEmpty(fresh).manager || manager; }, function () {});
      }).then(function (saveFailed) {
        if (saveFailed === false || gen !== generation) return false;
        if (!manager || (manager.state !== 'ready' && manager.state !== 'starting')) {
          status = jt('models.tuning.strata.savedNextStart', 'Setting saved. It takes effect when Strata next starts.');
          return true;
        }
        return confirmRestart().then(function (confirmed) {
          if (gen !== generation) return false;
          if (!confirmed) {
            status = jt('models.tuning.strata.savedNextRestart', 'Setting saved. The new settings will take effect on the next Strata restart.');
            return true;
          }
          status = jt('models.tuning.strata.restarting', 'Restarting Strata…');
          paint();
          return Promise.resolve().then(function () { return bridge.restart(); }).then(function (restarted) {
            if (gen !== generation) return false;
            manager = restarted && restarted.status && typeof restarted.status === 'object' ? restarted.status : manager;
            var live = Boolean(restarted && restarted.ok !== false && manager && manager.state === 'ready');
            if (!live) return restartFailed();
            status = jt('models.tuning.strata.restarted', 'Strata restarted with the new settings.');
            return true;
          }, function () { return gen !== generation ? false : restartFailed(); });
        });
      }, function () {
        if (gen !== generation) return false;
        status = jt('models.tuning.strata.saveFailed', 'The Strata settings could not be saved.');
        return false;
      }).then(function (outcome) {
        if (gen !== generation) return outcome;
        pending = false;
        paint();
        return outcome;
      });
    }

    return {
      open: open, close: close, active: active, html: html, onChange: onChange, onToggle: onToggle, onSegment: onSegment, apply: apply,
      dirty: dirty, dirtyRows: dirtyRows, discard: discard, busy: function () { return pending; }, draft: function () { return Object.assign({}, draft); },
    };
  }

  return { createStrataTuningSection: createStrataTuningSection, contextLabel: contextLabel };
});
