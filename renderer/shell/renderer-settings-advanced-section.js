/* Settings -> Developer -> Limits & budgets. Stable rows share two persistence paths. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'), require('./renderer-settings-field-binding'), require('./renderer-settings-field-descriptors'), require('./renderer-runtime-limits-view'));
    return;
  }
  root.rendererSettingsAdvancedSection = factory(root.rendererAsyncFence, root.rendererSettingsFieldBinding, root.rendererSettingsFieldDescriptors, null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence, fieldBinding, fieldDescriptors, limitsView) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var RESET_ARM_TIMEOUT_MS = 5000;
  var STREAM_RECHECK_MS = 3000;
  var FIELD_ID_PREFIX = 'advancedTuningField-';

  // The page's rows live in the descriptors module, so the search stubs read the same labels and help.
  var PAGE_GROUPS = fieldDescriptors.LIMITS_PAGE_GROUPS;

  // The engine keys this page shows. A stored key with no row here (the spend cap) is not the page's to count.
  var PAGE_TUNING_KEYS = Object.freeze(PAGE_GROUPS.reduce(function (keys, group) {
    group.rows.forEach(function (row) {
      row.lines.forEach(function (line) { if (line.tuning) keys.push(line.tuning); });
    });
    return keys;
  }, []));

  function hasOwn(value, key) {
    return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
  }

  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  function fieldKeyOf(descriptorId) {
    return String(descriptorId || '').slice(FIELD_ID_PREFIX.length);
  }

  function createAdvancedTuningSection(deps) {
    var options = deps || {};
    var inventory = options.inventory || null;
    var getBridge = typeof options.getBridge === 'function' ? options.getBridge : function () {
      return null;
    };
    var onStatus = typeof options.onStatus === 'function' ? options.onStatus : function () {};

    var statusOverride = null;
    var builtHost = null;
    var lastState = { values: {}, fields: [], groups: [], pending: false, activeStream: false };
    var armedReset = '';
    var armTimer = null;
    var streamRecheckTimer = null;
    var inFlight = false;
    var painted = new WeakMap(); // node -> the markup last written into it
    var foldErrors = new Set(); // rows inside the fold that already showed their error
    // The section instance is cached across Settings rebinds, so disposal is a
    // generation bump (not a one-shot latch): a rebind's fresh refresh mints a
    // new token, while the old binding's timer/response tokens go stale.
    var lifecycleGate = asyncFence.createGenerationGate();

    function inv(name) {
      return inventory && typeof inventory[name] === 'function' ? inventory[name] : null;
    }

    function isModified(field) {
      return hasOwn(lastState.values, field.key);
    }

    // The skeleton is built before the engine state arrives and shows schema defaults,
    // so the engine lines stay locked until the state has loaded.
    function engineLocked() {
      return Boolean(!lastState.fields.length || lastState.activeStream || lastState.pending || inFlight);
    }

    function rowOf(dom, key) {
      var host = dom && dom.advancedTuningFields;
      var input = key && host && typeof host.querySelector === 'function' ? host.querySelector('[data-tuning-input="' + key + '"]') : null;
      return input ? input.closest('.settings-field') : null;
    }

    function buildRowMarkup(row) {
      var label = row.label;
      var view = limitsView || globalThis.rendererRuntimeLimitsView;
      // One help line serves every control of the row.
      var helpId = 'limitsRow-' + row.id + '-help';
      var controls = row.lines.map(function (line) {
        var id = line.tuning ? FIELD_ID_PREFIX + line.tuning : 'runtime_' + line.limit;
        var side = line.side === 'both' ? jt('settings.limits.side.both', 'Both')
          : line.side === 'cloud' ? jt('settings.limits.side.cloud', 'Cloud') : jt('settings.limits.side.local', 'Local');
        var control;
        if (line.tuning) {
          var descriptor = fieldDescriptors.getSettingDescriptor(id);
          control = fieldBinding.renderSettingControl(descriptor, descriptor.default, { inventory: inventory, describedBy: helpId });
        } else {
          if (!view) return '';
          var entry = view.fields().find(function (item) { return item.draftKey === line.limit; });
          control = view.limitLineHtml(entry, label + ', ' + side);
        }
        return '<span class="settings-field-stack-line" data-limits-line="' + id + '">'
          + '<span class="settings-field-revert-slot" data-setting-revert-slot="' + id + '"></span>'
          + '<span class="settings-field-side">' + escapeHtml(side) + '</span>' + control + '</span>'
          + (line.limit ? '<span class="settings-field-note" data-limits-note="' + line.limit + '" id="' + id + '_note" hidden></span>' : '');
      }).join('');
      if (!controls) return '';
      return inventory.settingsField({
        id: 'limitsRow-' + row.id, variant: 'row', className: 'settings-field--stack', label: label,
        help: row.help, helpId: helpId,
        metaHtml: '<span class="settings-field-meta"><span class="settings-field-meta-modified" hidden>'
          + escapeHtml(jt('settings.field.modified', 'Modified')) + '</span></span>',
        controlHtml: '<span class="settings-field-stack">' + controls + '</span>',
      });
    }

    function buildFieldsMarkup() {
      return PAGE_GROUPS.map(function (group) {
        var label = escapeHtml(group.label);
        var rows = group.rows.map(buildRowMarkup).join('');
        if (group.id === 'rare') {
          return '<details class="settings-fold" data-limits-fold><summary>' + label
            + '<span class="settings-fold-count" hidden></span></summary>' + rows + '</details>';
        }
        return '<div class="settings-group" role="group" aria-labelledby="limitsGroup-' + group.id
          + '" data-limits-group="' + group.id + '"><h4 class="settings-group-heading" id="limitsGroup-'
          + group.id + '">' + label + '</h4>' + rows + '</div>';
      }).join('');
    }

    function buildActionsMarkup() {
      var actionButton = inv('actionButton');
      if (!actionButton) return '';
      var anyModified = builtHost && builtHost.querySelector('.settings-field:not([hidden]) [data-setting-revert]');
      if (!anyModified) return '';
      var armed = armedReset === 'section';
      // Two steps because this resets every limit on the page.
      return actionButton({
        id: 'advancedTuningResetAll',
        label: armed
          ? jt('settings.limits.resetPageConfirm', 'Confirm: reset every limit on this page')
          : jt('settings.limits.resetPage', 'Reset this page'),
        disabled: Boolean(lastState.activeStream || lastState.pending || inFlight),
        variant: armed ? 'danger' : 'secondary',
        dataset: { 'tuning-reset-all': armed ? 'confirm' : 'arm' },
      });
    }

    function statusMessage() {
      if (lastState.activeStream) {
        return { tone: 'warning', text: jt('settings.advanced.finishReplyBeforeChanging', 'Finish the current reply before changing engine limits.') };
      }
      if (lastState.pending || inFlight) {
        return { tone: 'pending', text: describeFailure({ reason: 'update_in_progress' }) };
      }
      return statusOverride || { tone: 'default', text: '' };
    }

    // Written only when it changed: a limits poll runs this, and a rewrite would
    // drop keyboard focus from the button and announce the status again.
    function writeMarkup(node, markup) {
      if (!node || painted.get(node) === markup) return;
      var held = node.contains(node.ownerDocument.activeElement);
      node.innerHTML = markup;
      painted.set(node, markup);
      if (held) node.querySelector('button:not([disabled])')?.focus({ preventScroll: true });
    }

    function renderPageState(target) {
      writeMarkup(target.advancedTuningActions, buildActionsMarkup());
      if (builtHost) {
        var engine = typeof options.getEngineType === 'function' ? options.getEngineType() : '';
        var ollamaRow = builtHost.querySelector('[data-settings-field="limitsRow-ollamaRequest"]');
        if (ollamaRow) ollamaRow.hidden = Boolean(engine && engine !== 'ollama');
        var fold = builtHost.querySelector('[data-limits-fold]');
        if (fold) {
          // A refused row is not left inside the closed fold. It opens when a row turns to an
          // error, not on every repaint: a person may close it again while the error stays.
          var refused = Array.from(fold.querySelectorAll('.settings-field[data-state="error"]'));
          if (refused.some(function (row) { return !foldErrors.has(row); })) fold.open = true;
          foldErrors = new Set(refused);
        }
      }
      var countNode = builtHost && builtHost.querySelector('.settings-fold-count');
      if (countNode) {
        var count = Array.from(builtHost.querySelectorAll('[data-limits-fold] .settings-field')).filter(function (row) {
          return Boolean(row.querySelector('[data-setting-revert]'));
        }).length;
        var countText = count ? jt('settings.limits.foldModified', '{count} modified', { count: count }) : '';
        if (countNode.textContent !== countText) countNode.textContent = countText;
        countNode.hidden = !count;
      }
      var status = statusMessage();
      if (target.advancedTuningStatus) {
        var statusRow = inv('statusRow');
        writeMarkup(target.advancedTuningStatus, status.text
          ? (statusRow ? statusRow({ tone: status.tone, message: status.text }) : escapeHtml(status.text)) : '');
        target.advancedTuningStatus.hidden = !status.text;
      }
      onStatus(status);
    }

    // forceKey: the engine line whose edit just settled or was refused. Its field takes the
    // acknowledged value even while it has focus; every other focused field is left alone.
    function render(dom, forceKey) {
      var target = dom || {};
      var host = target.advancedTuningFields;
      if (host) {
        if (builtHost !== host) {
          host.innerHTML = buildFieldsMarkup();
          builtHost = host;
          host.querySelectorAll('[data-setting-input^="advancedTuningField-"]').forEach(function (input) {
            input.setAttribute('data-tuning-input', fieldKeyOf(input.getAttribute('data-setting-input')));
          });
        }
        lastState.fields.forEach(function (field) {
          var descriptor = fieldDescriptors.getSettingDescriptor(FIELD_ID_PREFIX + field.key);
          if (!descriptor) return;
          var value = isModified(field) ? lastState.values[field.key] : field.default;
          fieldBinding.syncSettingRow(host, descriptor, value, { liveDefault: field.default, inventory: inventory, force: field.key === forceKey });
        });
        setControlsDisabled(target, engineLocked());
      }
      renderPageState(target);
    }

    function setState(nextState, dom, forceKey) {
      var source = nextState && typeof nextState === 'object' ? nextState : {};
      lastState = {
        values: source.values && typeof source.values === 'object' ? source.values : {},
        fields: Array.isArray(source.fields) ? source.fields : lastState.fields,
        groups: Array.isArray(source.groups) ? source.groups : lastState.groups,
        pending: Boolean(source.pending),
        activeStream: Boolean(source.activeStream),
      };
      render(dom, forceKey);
      scheduleStreamRecheck(dom);
    }

    // A reply in progress locks the engine lines, and nothing pushes its end
    // here: re-read while that lock holds, so the page unlocks once the reply
    // is done instead of staying locked until restart (SW1-2 / F14).
    function scheduleStreamRecheck(dom) {
      if (streamRecheckTimer || !lastState.activeStream) return;
      var recheckToken = lifecycleGate.capture();
      streamRecheckTimer = setTimeout(function () {
        streamRecheckTimer = null;
        if (!lifecycleGate.isCurrent(recheckToken)) return;
        if (inFlight) scheduleStreamRecheck(dom);
        else void refresh(dom);
      }, STREAM_RECHECK_MS);
      if (typeof streamRecheckTimer?.unref === 'function') streamRecheckTimer.unref();
    }

    function clearArm() {
      armedReset = '';
      if (armTimer) {
        clearTimeout(armTimer);
        armTimer = null;
      }
    }

    function armSectionReset(dom) {
      armedReset = 'section';
      if (armTimer) clearTimeout(armTimer);
      var armToken = lifecycleGate.capture();
      armTimer = setTimeout(function () {
        if (!lifecycleGate.isCurrent(armToken)) return;
        clearArm();
        render(dom);
      }, RESET_ARM_TIMEOUT_MS);
      render(dom);
    }

    async function refresh(dom, forceKey) {
      render(dom);
      var bridge = getBridge();
      if (!bridge || typeof bridge.getState !== 'function') {
        // Nothing can load the engine lines: they stay locked, and the page says why.
        if (!lastState.fields.length) {
          statusOverride = { tone: 'danger', text: jt('settings.advanced.readFailed', 'Could not read engine settings.') };
          renderPageState(dom || {});
        }
        return;
      }
      var refreshToken = lifecycleGate.capture();
      try {
        var payload = await bridge.getState();
        if (!lifecycleGate.isCurrent(refreshToken)) return;
        setState(payload, dom, forceKey);
      } catch (_error) {
        if (!lifecycleGate.isCurrent(refreshToken)) return;
        statusOverride = { tone: 'danger', text: jt('settings.advanced.readFailed', 'Could not read engine settings.') };
        renderPageState(dom);
        // A failed read keeps the last reply lock, so keep re-checking it.
        scheduleStreamRecheck(dom);
      }
    }

    function dispose() {
      lifecycleGate.bump();
      clearArm();
      if (streamRecheckTimer) {
        clearTimeout(streamRecheckTimer);
        streamRecheckTimer = null;
      }
    }

    function setControlsDisabled(dom, disabled) {
      var host = dom && dom.advancedTuningFields;
      if (!host || typeof host.querySelectorAll !== 'function') return;
      var controls = host.querySelectorAll('[data-tuning-input], [data-setting-preset^="advancedTuningField-"], [data-setting-revert^="advancedTuningField-"]');
      for (var i = 0; i < controls.length; i += 1) {
        controls[i].disabled = disabled;
      }
    }

    /* One call site for every mutation so the in-flight guard, the failure
     * surfacing, and the re-render cannot drift apart between handlers.
     * While one change is applying (a sidecar refresh - seconds, not ms) every
     * other control is disabled, so a second edit cannot be typed into a row
     * that the post-apply re-render would silently revert; if one slips through
     * anyway (keyboard, programmatic), say so instead of dropping it. */
    async function submit(dom, invoke, fieldKey) {
      if (inFlight) {
        onStatus({ tone: 'warning', text: describeFailure({ reason: 'update_in_progress' }) });
        return;
      }
      inFlight = true;
      statusOverride = null;
      var host = dom.advancedTuningFields;
      var doc = host && host.ownerDocument;
      // Locking the lines takes focus from the control that was used. It is remembered here
      // (a quick pick as itself, Revert and the field as the line's field) and handed back
      // when the change has settled, unless the person moved on.
      var used = doc && host.contains(doc.activeElement) ? doc.activeElement : null;
      var pick = used && used.closest('[data-setting-preset]');
      var refocus = pick
        ? '[data-setting-preset="' + pick.getAttribute('data-setting-preset') + '"][data-setting-preset-value="' + pick.getAttribute('data-setting-preset-value') + '"]'
        : (used && fieldKey ? '[data-tuning-input="' + fieldKey + '"]' : '');
      renderPageState(dom);
      setControlsDisabled(dom, true);
      var settingsField = inventory && inventory.settingsField;
      var row = settingsField ? rowOf(dom, fieldKey) : null;
      if (row) {
        settingsField.setFieldError(row, '');
        settingsField.setFieldBusy(row, true);
      }
      try {
        var result = await invoke();
        var status = result && result.status;
        if (result && result.state) setState(result.state, dom, fieldKey);
        else await refresh(dom, fieldKey);
        if (status === 'applied' && result && result.reason === 'deferred') {
          statusOverride = { tone: 'success', text: jt('settings.advanced.savedForNextStart', 'Saved. The engine is not running right now, so this applies the next time it starts.') };
        }
        if (status === 'applied' && !fieldKey && settingsField && host) {
          // A page reset that went through leaves no engine line refused.
          host.querySelectorAll('.settings-field[data-state="error"]').forEach(function (refused) {
            if (refused.querySelector('[data-tuning-input]')) settingsField.setFieldError(refused, '');
          });
        }
        if (status && status !== 'applied') {
          var message = describeFailure(result);
          if (row) settingsField.setFieldError(row, message);
          statusOverride = { tone: 'danger', text: message };
        }
      } catch (_error) {
        statusOverride = { tone: 'danger', text: jt('settings.advanced.updateFailed', 'Engine settings update failed.') };
        if (row) settingsField.setFieldError(row, statusOverride.text);
      } finally {
        inFlight = false;
        // The result path re-renders (and so re-derives disabled from state);
        // the throw path does not, so release the controls explicitly.
        if (row) settingsField.setFieldBusy(row, false);
        setControlsDisabled(dom, engineLocked());
        renderPageState(dom);
        var now = doc && doc.activeElement;
        if (refocus && (!now || now === doc.body || !now.isConnected || now.disabled)) {
          var back = host.querySelector(refocus);
          if (back && !back.disabled) back.focus({ preventScroll: true });
        }
      }
    }

    function describeFailure(result) {
      var reason = result && result.reason ? String(result.reason) : '';
      if (reason === 'active_stream') return jt('settings.advanced.finishCurrentReply', 'Finish the current reply first.');
      if (reason === 'invalid_value') return jt('settings.advanced.valueOutOfRange', 'That value is outside the allowed range.');
      if (reason === 'invalid_field') return jt('settings.advanced.unrecognizedSetting', 'That setting is not recognized.');
      if (reason === 'update_in_progress') return jt('settings.advanced.updateInProgress', 'Another change is still applying.');
      if (result && result.status === 'rolled_back') {
        return jt('settings.advanced.rejectedRestored', 'The engine rejected that value, so the previous setting was restored.');
      }
      if (result && result.status === 'degraded') {
        return jt('settings.advanced.applyUndoFailed', 'The change could not be applied or undone. Restart Jenny to resync.');
      }
      return jt('settings.advanced.updateFailed', 'Engine settings update failed.');
    }

    /* FOUR delegated listeners for the whole surface. */
    function bind(dom, registerSectionListener) {
      var target = dom || {};
      render(target);

      function updateKey(key, value) {
        clearArm();
        submit(target, function () {
          var bridge = getBridge();
          if (!bridge || typeof bridge.update !== 'function') {
            return { status: 'rejected', reason: 'bridge_unavailable' };
          }
          return bridge.update({ key: key, value: value });
        }, key);
      }

      registerSectionListener(target.advancedTuningFields, 'change', function (event) {
        var input = event.target && event.target.closest
          ? event.target.closest('[data-tuning-input]')
          : null;
        if (!input) return;
        var key = input.getAttribute('data-tuning-input');
        var descriptor = fieldDescriptors.getSettingDescriptor(FIELD_ID_PREFIX + key);
        var read = fieldBinding.readControlValue(descriptor, event);
        if (!read) return;
        clearArm();
        // An empty field means "no override" only where the setting allows it. Anything
        // that is not a number in range is refused here: it must never clear an override.
        var unset = read.value === null && !(input.validity && input.validity.badInput);
        var checked = unset ? { ok: true } : fieldDescriptors.validateSettingValue(descriptor, read.value);
        var row = input.closest('.settings-field');
        var setFieldError = inventory && inventory.settingsField && inventory.settingsField.setFieldError;
        if (!checked.ok) {
          if (row && setFieldError) setFieldError(row, checked.error);
          // The refused text does not stay behind: the field shows the acknowledged value again,
          // also when Enter committed it and it still has focus.
          render(target, key);
          return;
        }
        updateKey(key, unset ? null : read.value);
      });

      registerSectionListener(target.advancedTuningFields, 'click', function (event) {
        var closest = event.target && event.target.closest ? event.target.closest.bind(event.target) : null;
        if (!closest) return;
        var preset = closest('[data-setting-preset]');
        if (preset && preset.getAttribute('data-setting-preset').startsWith(FIELD_ID_PREFIX)) {
          var presetValue = Number(preset.getAttribute('data-setting-preset-value'));
          if (Number.isFinite(presetValue)) updateKey(fieldKeyOf(preset.getAttribute('data-setting-preset')), presetValue);
          return;
        }
        var button = closest('[data-setting-revert]');
        if (!button || !button.getAttribute('data-setting-revert').startsWith(FIELD_ID_PREFIX)) return;
        updateKey(fieldKeyOf(button.getAttribute('data-setting-revert')), null);
      });

      registerSectionListener(target.advancedTuningFields, 'limits-lines-updated', function () {
        renderPageState(target);
      });

      registerSectionListener(target.advancedTuningActions, 'click', function (event) {
        var button = event.target && event.target.closest
          ? event.target.closest('[data-tuning-reset-all]')
          : null;
        if (!button) return;
        if (button.getAttribute('data-tuning-reset-all') === 'arm') {
          armSectionReset(target);
          return;
        }
        clearArm();
        var limitsSaved = true;
        submit(target, async function () {
          if (typeof options.resetLimitsToDefaults === 'function') limitsSaved = (await options.resetLimitsToDefaults()) === true;
          // Only the keys this page shows: a stored value with no row here is not a reason to reset the engine.
          if (!lastState.fields.some(function (field) { return PAGE_TUNING_KEYS.indexOf(field.key) !== -1 && isModified(field); })) return { status: 'applied' };
          var bridge = getBridge();
          if (!bridge || typeof bridge.reset !== 'function') {
            return { status: 'rejected', reason: 'bridge_unavailable' };
          }
          return bridge.reset();
        }, '').then(function () {
          // A refused limits half outranks the engine half's "saved" line; an engine failure keeps its own message.
          if (limitsSaved || (statusOverride && statusOverride.tone === 'danger')) return;
          statusOverride = { tone: 'danger', text: jt('runtime.limits.failed', "Limits weren't saved. They changed elsewhere or were refused; review and save again.") };
          renderPageState(target);
        });
      });
    }

    return {
      bind: bind,
      render: render,
      refresh: refresh,
      setState: setState,
      isModified: isModified,
      describeFailure: describeFailure,
      dispose: dispose,
    };
  }

  return {
    createAdvancedTuningSection: createAdvancedTuningSection,
  };
});
