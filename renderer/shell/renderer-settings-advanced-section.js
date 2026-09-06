/* renderer/shell/renderer-settings-advanced-section.js
 *
 * Settings -> Developer -> Advanced: the global engine-tuning surface.
 *
 * Every row is generated from renderer/shared/engine-tuning-schema.js rather
 * than hand-written, and every interaction is served by FOUR delegated
 * listeners bound to stable containers - not ~28 hand-wired handlers. The
 * containers outlive the innerHTML swap that a profile switch performs, which
 * is what keeps the delegation valid (same trick bindSkills uses).
 *
 * "Modified" is exactly `hasOwnProperty(values, key)`: the config normalizer
 * drops any value equal to the sidecar default, so an override is present in
 * the map if and only if the user actually set one. No diffing.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.rendererSettingsAdvancedSection = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence) {
  'use strict';

  var RESET_ARM_TIMEOUT_MS = 5000;

  function hasOwn(value, key) {
    return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function formatUnit(unit) {
    return unit ? ' ' + unit : '';
  }

  /* The default sits on the title line (see buildMetaMarkup), so the help text
   * can stay a plain description. */
  function describeField(field) {
    return String(field.help || '');
  }

  function describeDefault(field) {
    return field.default != null
      ? 'Default ' + field.default + formatUnit(field.unit)
      : 'Auto = engine decides';
  }

  function createAdvancedTuningSection(deps) {
    var options = deps || {};
    var inventory = options.inventory || null;
    var getBridge = typeof options.getBridge === 'function' ? options.getBridge : function () {
      return null;
    };
    var onStatus = typeof options.onStatus === 'function' ? options.onStatus : function () {};

    var scope = 'local';
    var lastState = { values: {}, fields: [], groups: [], pending: false, activeStream: false };
    var armedReset = '';
    var armTimer = null;
    var inFlight = false;
    // The section instance is cached across Settings rebinds, so disposal is a
    // generation bump (not a one-shot latch): a rebind's fresh refresh mints a
    // new token, while the old binding's timer/response tokens go stale.
    var lifecycleGate = asyncFence.createGenerationGate();

    function inv(name) {
      return inventory && typeof inventory[name] === 'function' ? inventory[name] : null;
    }

    function fieldsForScope() {
      var fields = Array.isArray(lastState.fields) ? lastState.fields : [];
      return fields.filter(function (field) {
        return field.scope === scope || field.scope === 'shared';
      });
    }

    function isModified(field) {
      return hasOwn(lastState.values, field.key);
    }

    function buildRowMarkup(field) {
      var settingsField = inv('settingsField');
      var numberInput = inv('numberInput');
      if (!settingsField || !numberInput) return '';
      var modified = isModified(field);
      var control = numberInput({
        id: 'advancedTuning-' + field.key,
        min: field.min,
        max: field.max,
        step: field.step,
        value: modified ? lastState.values[field.key] : field.default,
        // A field with no sidecar default has to be able to show "unset";
        // inventing a number would read as a value the user chose.
        allowEmpty: field.default == null,
        placeholder: field.default == null ? 'Auto' : String(field.default),
        suffix: field.unit,
        ariaLabel: field.label,
        dataset: { 'tuning-input': field.key },
      });
      // Default, "Modified", and the revert live on the title line in the text
      // column (the same .settings-field-reset affordance Appearance uses), so
      // the control column keeps its geometry whether or not a field is modified.
      var metaMarkup = '<span class="settings-field-meta">'
        + '<span class="settings-field-meta-default">' + escapeHtml(describeDefault(field)) + '</span>';
      var actionButton = inv('actionButton');
      if (modified) {
        metaMarkup += '<span class="settings-field-meta-modified">Modified</span>';
        if (actionButton) {
          metaMarkup += actionButton({
            id: 'advancedTuningReset-' + field.key,
            label: '\u21BA Revert',
            plain: true,
            className: 'settings-field-reset',
            ariaLabel: 'Revert ' + field.label + ' to its default',
            title: 'Revert to default',
            dataset: { 'tuning-reset': field.key },
          });
        }
      }
      metaMarkup += '</span>';
      return settingsField({
        id: 'advancedTuningField-' + field.key,
        label: field.label,
        help: describeField(field),
        metaHtml: metaMarkup,
        variant: 'row',
        controlHtml: '<div class="settings-tuning-control">'
          + '<div class="settings-tuning-control-row">' + control + '</div>'
          + buildPresetsMarkup(field)
          + '</div>',
        dataset: { 'tuning-key': field.key },
      });
    }

    /* Quick picks: one inventory action button per schema preset. The pick
     * matching the EFFECTIVE value (override, else default) is pressed, so a
     * default field shows which pick it already sits on. The builder has no
     * aria-pressed slot, so render() stamps it from data-tuning-preset-pressed
     * right after the innerHTML swap. */
    function buildPresetsMarkup(field) {
      var presets = Array.isArray(field.presets) ? field.presets : [];
      var actionButton = inv('actionButton');
      if (!presets.length || !actionButton) return '';
      var effective = isModified(field) ? Number(lastState.values[field.key]) : field.default;
      var html = '<div class="settings-tuning-presets" role="group" aria-label="'
        + escapeHtml('Quick picks for ' + field.label) + '">';
      for (var i = 0; i < presets.length; i += 1) {
        var preset = presets[i];
        var pressed = effective != null && Number(preset.value) === Number(effective);
        html += actionButton({
          id: 'advancedTuningPreset-' + field.key + '-' + String(preset.value).replace(/[^0-9a-zA-Z]/g, '_'),
          label: preset.label,
          ariaLabel: field.label + ': ' + preset.label,
          title: field.label + ' preset: ' + preset.label,
          variant: 'ghost',
          size: 'sm',
          className: 'settings-tuning-preset' + (pressed ? ' is-pressed' : ''),
          dataset: {
            'tuning-preset': field.key,
            'tuning-preset-value': String(preset.value),
            'tuning-preset-pressed': pressed ? 'true' : 'false',
          },
        });
      }
      return html + '</div>';
    }

    function stampPresetPressedState(host) {
      if (!host || typeof host.querySelectorAll !== 'function') return;
      var picks = host.querySelectorAll('[data-tuning-preset]');
      for (var i = 0; i < picks.length; i += 1) {
        picks[i].setAttribute('aria-pressed', picks[i].getAttribute('data-tuning-preset-pressed') === 'true' ? 'true' : 'false');
      }
    }

    function buildFieldsMarkup() {
      var groups = Array.isArray(lastState.groups) ? lastState.groups : [];
      var fields = fieldsForScope();
      if (!fields.length) return '<p class="settings-copy">No tunable settings for this profile.</p>';
      var html = '';
      for (var g = 0; g < groups.length; g += 1) {
        var group = groups[g];
        var groupFields = fields.filter(function (field) {
          return field.group === group.id;
        });
        if (!groupFields.length) continue;
        var headingId = 'advancedTuningGroup-' + group.id;
        html += '<div class="settings-group settings-group--wide" role="group" aria-labelledby="'
          + escapeHtml(headingId) + '">'
          + '<h4 class="settings-group-heading" id="' + escapeHtml(headingId) + '">'
          + escapeHtml(group.label) + '</h4>'
          + (group.help ? '<p class="settings-group-copy">' + escapeHtml(group.help) + '</p>' : '');
        for (var f = 0; f < groupFields.length; f += 1) {
          html += buildRowMarkup(groupFields[f]);
        }
        html += '</div>';
      }
      return html;
    }

    function buildProfileMarkup() {
      var segmented = inv('segmentedControl');
      if (!segmented) return '';
      return segmented({
        id: 'advancedTuningProfile',
        ariaLabel: 'Tuning profile',
        value: scope,
        options: [
          { value: 'local', label: 'Local' },
          { value: 'cloud', label: 'Cloud' },
        ],
      });
    }

    function buildActionsMarkup() {
      var actionButton = inv('actionButton');
      if (!actionButton) return '';
      var anyModified = fieldsForScope().some(isModified);
      if (!anyModified) return '';
      var armed = armedReset === 'section';
      // Two-step on purpose: this can change every field on the pane and forces
      // a sidecar reinitialise.
      return actionButton({
        id: 'advancedTuningResetAll',
        label: armed
          ? 'Confirm: reset every ' + paneLabel() + ' setting to default'
          : 'Reset ' + paneLabel() + ' settings to defaults',
        ariaLabel: (armed ? 'Confirm reset of ' : 'Reset ') + 'every setting on the '
          + paneLabel() + ' pane, including the shared ones, to its default',
        title: (armed ? 'Confirm reset of ' : 'Reset ') + 'every setting on the '
          + paneLabel() + ' pane, including the shared ones, to its default',
        variant: armed ? 'danger' : 'secondary',
        dataset: { 'tuning-reset-all': armed ? 'confirm' : 'arm' },
      });
    }

    function paneLabel() {
      return scope === 'cloud' ? 'Cloud' : 'Local';
    }

    function statusMessage() {
      if (lastState.activeStream) {
        return { tone: 'warning', text: 'Finish the current reply before changing engine limits.' };
      }
      var count = fieldsForScope().filter(isModified).length;
      if (!count) {
        return { tone: 'default', text: 'All settings are at their engine defaults.' };
      }
      return {
        tone: 'pending',
        text: count + (count === 1 ? ' setting differs' : ' settings differ') + ' from the defaults.',
      };
    }

    function render(dom) {
      var target = dom || {};
      if (target.advancedTuningProfileSwitch) {
        target.advancedTuningProfileSwitch.innerHTML = buildProfileMarkup();
      }
      if (target.advancedTuningFields) {
        target.advancedTuningFields.innerHTML = buildFieldsMarkup();
        stampPresetPressedState(target.advancedTuningFields);
        var disabled = Boolean(lastState.activeStream || lastState.pending);
        var inputs = target.advancedTuningFields.querySelectorAll('input, button');
        for (var i = 0; i < inputs.length; i += 1) {
          inputs[i].disabled = disabled;
        }
      }
      if (target.advancedTuningActions) {
        target.advancedTuningActions.innerHTML = buildActionsMarkup();
      }
      if (target.advancedTuningStatus) {
        var status = statusMessage();
        var statusRow = inv('statusRow');
        target.advancedTuningStatus.innerHTML = statusRow
          ? statusRow({ tone: status.tone, message: status.text })
          : escapeHtml(status.text);
      }
      onStatus(statusMessage());
    }

    function setState(nextState, dom) {
      var source = nextState && typeof nextState === 'object' ? nextState : {};
      lastState = {
        values: source.values && typeof source.values === 'object' ? source.values : {},
        fields: Array.isArray(source.fields) ? source.fields : lastState.fields,
        groups: Array.isArray(source.groups) ? source.groups : lastState.groups,
        pending: Boolean(source.pending),
        activeStream: Boolean(source.activeStream),
      };
      render(dom);
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

    async function refresh(dom) {
      var bridge = getBridge();
      if (!bridge || typeof bridge.getState !== 'function') return;
      var refreshToken = lifecycleGate.capture();
      try {
        var payload = await bridge.getState();
        if (!lifecycleGate.isCurrent(refreshToken)) return;
        setState(payload, dom);
      } catch (_error) {
        if (!lifecycleGate.isCurrent(refreshToken)) return;
        onStatus({ tone: 'danger', text: 'Could not read engine settings.' });
      }
    }

    function dispose() {
      lifecycleGate.bump();
      clearArm();
    }

    function setControlsDisabled(dom, disabled) {
      var host = dom && dom.advancedTuningFields;
      if (!host || typeof host.querySelectorAll !== 'function') return;
      var controls = host.querySelectorAll('input, button');
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
      setControlsDisabled(dom, true);
      var settingsField = inv('settingsField');
      var row = fieldKey && settingsField && typeof settingsField.findField === 'function'
        ? settingsField.findField(dom.advancedTuningFields, 'advancedTuningField-' + fieldKey)
        : null;
      if (row && typeof settingsField.setFieldBusy === 'function') {
        settingsField.setFieldBusy(row, true);
      }
      try {
        var result = await invoke();
        var status = result && result.status;
        if (result && result.state) setState(result.state, dom);
        else await refresh(dom);
        if (status === 'applied' && result && result.reason === 'deferred') {
          onStatus({ tone: 'success', text: 'Saved. The engine is not running right now, so this applies the next time it starts.' });
        }
        if (status && status !== 'applied') {
          var message = describeFailure(result);
          var freshRow = fieldKey && settingsField && typeof settingsField.findField === 'function'
            ? settingsField.findField(dom.advancedTuningFields, 'advancedTuningField-' + fieldKey)
            : null;
          if (freshRow && typeof settingsField.setFieldError === 'function') {
            settingsField.setFieldError(freshRow, message);
          }
          onStatus({ tone: 'danger', text: message });
        }
      } catch (_error) {
        onStatus({ tone: 'danger', text: 'Engine settings update failed.' });
      } finally {
        inFlight = false;
        // The result path re-renders (and so re-derives disabled from state);
        // the throw path does not, so release the controls explicitly.
        setControlsDisabled(dom, Boolean(lastState.activeStream || lastState.pending));
      }
    }

    function describeFailure(result) {
      var reason = result && result.reason ? String(result.reason) : '';
      if (reason === 'active_stream') return 'Finish the current reply first.';
      if (reason === 'invalid_value') return 'That value is outside the allowed range.';
      if (reason === 'invalid_field') return 'That setting is not recognized.';
      if (reason === 'update_in_progress') return 'Another change is still applying.';
      if (result && result.status === 'rolled_back') {
        return 'The engine rejected that value, so the previous setting was restored.';
      }
      if (result && result.status === 'degraded') {
        return 'The change could not be applied or undone. Restart Jenny to resync.';
      }
      return 'Engine settings update failed.';
    }

    /* FOUR delegated listeners for the whole surface. */
    function bind(dom, registerSectionListener) {
      var target = dom || {};

      registerSectionListener(target.advancedTuningFields, 'change', function (event) {
        var input = event.target && event.target.closest
          ? event.target.closest('[data-tuning-input]')
          : null;
        if (!input) return;
        var key = input.getAttribute('data-tuning-input');
        var raw = input.value;
        clearArm();
        submit(target, function () {
          var bridge = getBridge();
          if (!bridge || typeof bridge.update !== 'function') {
            return { status: 'rejected', reason: 'bridge_unavailable' };
          }
          return bridge.update({ key: key, value: raw === '' ? null : Number(raw) });
        }, key);
      });

      registerSectionListener(target.advancedTuningFields, 'click', function (event) {
        var closest = event.target && event.target.closest ? event.target.closest.bind(event.target) : null;
        if (!closest) return;
        var preset = closest('[data-tuning-preset]');
        if (preset) {
          var presetKey = preset.getAttribute('data-tuning-preset');
          var presetValue = Number(preset.getAttribute('data-tuning-preset-value'));
          if (!Number.isFinite(presetValue)) return;
          clearArm();
          submit(target, function () {
            var bridge = getBridge();
            if (!bridge || typeof bridge.update !== 'function') {
              return { status: 'rejected', reason: 'bridge_unavailable' };
            }
            return bridge.update({ key: presetKey, value: presetValue });
          }, presetKey);
          return;
        }
        var button = closest('[data-tuning-reset]');
        if (!button) return;
        var key = button.getAttribute('data-tuning-reset');
        clearArm();
        submit(target, function () {
          var bridge = getBridge();
          if (!bridge || typeof bridge.update !== 'function') {
            return { status: 'rejected', reason: 'bridge_unavailable' };
          }
          return bridge.update({ key: key, value: null });
        }, key);
      });

      registerSectionListener(target.advancedTuningProfileSwitch, 'inv-segmented-change', function (event) {
        var detail = (event && event.detail) || {};
        var nextScope = detail.value === 'cloud' ? 'cloud' : 'local';
        if (nextScope === scope) return;
        scope = nextScope;
        clearArm();
        render(target);
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
        submit(target, function () {
          var bridge = getBridge();
          if (!bridge || typeof bridge.reset !== 'function') {
            return { status: 'rejected', reason: 'bridge_unavailable' };
          }
          return bridge.reset({ scope: scope });
        }, '');
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
