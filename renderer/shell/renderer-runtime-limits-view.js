/* renderer/shell/renderer-runtime-limits-view.js - Settings › Developer › Runtime limits.
 *
 * One settings row per limit: label and the shared "Default: {n} · Modified ·
 * ↺ Revert" meta line on the left, the number field on the right, and, when
 * this machine caps the value lower, "capped at {n} by this machine" under
 * it. A change applies at once (the controller writes it). The form is built
 * once and patched in place, so a poll never resets a field being typed in.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/action-button'), require('../inventory/number-input'), require('../inventory/settings-field'));
  } else root.rendererRuntimeLimitsView = factory(root.inventoryActionButton, root.inventoryNumberInput, root.inventorySettingsField);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (button, numberInput, settingsField) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback
    || function (key, fallback, params) { return String(fallback).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match); };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const locale = () => { try { return globalThis.jennyI18n?.tag?.() || undefined; } catch (_error) { return undefined; } };
  const number = (value) => { try { return new Intl.NumberFormat(locale()).format(value); } catch (_error) { return String(value); } };
  // Fallback ranges when a (hosted, paged) snapshot carries no limit_defaults.
  const RANGES = { runnable_turns: [1, 16], inference_requests: [1, 64], descendants: [0, 512], descendant_depth: [0, 8],
    tool_operations: [1, 64], native_processes: [1, 64], tests: [1, 16] };

  // Every configured_limits key, in reading order, with a plain label.
  function fields() {
    return [
      { group: 'local', key: 'runnable_turns', label: jt('runtime.limits.localChats', 'Local chats running at once') },
      { group: 'cloud', key: 'runnable_turns', label: jt('runtime.limits.cloudChats', 'Cloud chats running at once') },
      { group: 'local', key: 'inference_requests', label: jt('runtime.limits.localRequests', 'Local model requests at once') },
      { group: 'cloud', key: 'inference_requests', label: jt('runtime.limits.cloudRequests', 'Cloud model requests at once') },
      { group: 'local', key: 'descendants', label: jt('runtime.limits.localSubagents', 'Subagents per local chat') },
      { group: 'cloud', key: 'descendants', label: jt('runtime.limits.cloudSubagents', 'Subagents per cloud chat') },
      { group: 'local', key: 'descendant_depth', label: jt('runtime.limits.localDepth', 'Subagent depth, local chats') },
      { group: 'cloud', key: 'descendant_depth', label: jt('runtime.limits.cloudDepth', 'Subagent depth, cloud chats') },
      { group: 'resources', key: 'tool_operations', label: jt('runtime.limits.toolOperations', 'Tool operations at once') },
      { group: 'resources', key: 'native_processes', label: jt('runtime.limits.programs', 'Programs at once') },
      { group: 'resources', key: 'tests', label: jt('runtime.limits.tests', 'Test runs at once') },
    ].map(entry => ({ ...entry, draftKey: `limit_${entry.group}_${entry.key}` }));
  }
  function labels() {
    return {
      title: jt('runtime.limits.title', 'Runtime limits'),
      copy: jt('runtime.limits.copy', 'How much Jenny runs at once. Lower limits apply to new work; running work keeps what it has until it finishes.'),
      loading: jt('runtime.limits.loading', 'Loading limits…'),
      unavailable: jt('runtime.limits.unavailable', 'Limits are unavailable right now. Jenny retries on her own.'),
      readOnly: jt('runtime.limits.readOnly', 'Limits are read-only in this window.'),
      reset: jt('runtime.limits.reset', 'Reset to defaults'),
      failed: jt('runtime.limits.failed', "Limits weren't saved. They changed elsewhere or were refused; review and save again."),
    };
  }
  function range(snapshot, key) {
    const known = snapshot?.limit_defaults?.ranges?.[key];
    return known ? [known.min, known.max] : RANGES[key];
  }
  function configuredValue(snapshot, entry) {
    return entry.group === 'resources' ? snapshot?.resources?.configured_limits?.[entry.key]
      : snapshot?.lanes?.configured_limits?.[entry.group]?.[entry.key];
  }
  function effectiveValue(snapshot, entry) {
    return entry.group === 'resources' ? snapshot?.resources?.effective_limits?.[entry.key]
      : snapshot?.lanes?.effective_limits?.[entry.group]?.[entry.key];
  }
  function defaultValue(snapshot, entry) {
    return snapshot?.limit_defaults?.defaults?.[entry.group]?.[entry.key];
  }
  // Configured differs from the runtime's own default: the row reads Modified.
  function isModified(snapshot, entry) {
    const configured = configuredValue(snapshot, entry);
    const fallback = defaultValue(snapshot, entry);
    return Number.isInteger(configured) && Number.isInteger(fallback) && configured !== fallback;
  }
  // Whole numbers inside the backend's range; anything else is a field error.
  function validate(entry, raw, snapshot) {
    const text = String(raw ?? '').trim();
    const [min, max] = range(snapshot, entry.key);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < min || Number(text) > max) {
      return { ok: false, error: jt('runtime.limits.fieldError', 'Enter a whole number from {min} to {max}.', { min: number(min), max: number(max) }) };
    }
    return { ok: true, value: Number(text) };
  }
  // Machine state, not a default: shown only when this machine caps the value lower.
  function note(snapshot, entry) {
    const configured = configuredValue(snapshot, entry);
    const effective = effectiveValue(snapshot, entry);
    if (Number.isInteger(effective) && Number.isInteger(configured) && effective < configured) {
      return { text: jt('runtime.limits.capped', 'capped at {n} by this machine', { n: number(effective) }), capped: true };
    }
    return { text: '', capped: false };
  }
  // The shared meta line; update() fills the default and shows Modified.
  function metaHtml() {
    return '<span class="settings-field-meta"><span class="settings-field-meta-default"></span>'
      + '<span class="settings-field-meta-modified" hidden>' + escape(jt('settings.field.modified', 'Modified')) + '</span></span>';
  }
  // The Revert sits to the right of the field; hidden, it keeps its place (see .limits-row in settings-runs.css).
  function revertHtml(entry, id) {
    return button({ id: 'limits-revert', plain: true, className: 'settings-field-reset', label: jt('settings.field.revert', '↺ Revert'),
      ariaLabel: jt('settings.field.revertAria', 'Revert {label} to its default', { label: entry.label }),
      title: jt('settings.field.revertTitle', 'Revert to default'),
      dataset: { 'setting-revert': id, 'focus-key': `${entry.draftKey}:revert` } });
  }

  function limitLineHtml(entry, ariaLabel) {
    return '<span class="settings-field-number">' + numberInput({ id: 'runtime_' + entry.draftKey,
      ariaLabel, step: 1, disabled: true, dataset: { draft: entry.draftKey, 'focus-key': entry.draftKey } }) + '</span>';
  }

  function createLimitLines(host) {
    const list = fields();
    const l = labels();
    function update(model) {
      const snapshot = model.snapshot;
      const status = host.closest('.settings-card')?.querySelector('[data-limits-status]');
      const text = !model.loaded ? l.loading : !snapshot ? l.unavailable : snapshot.read_only ? l.readOnly : '';
      if (status) { if (status.textContent !== text) status.textContent = text; status.hidden = !text; }
      for (const entry of list) {
        const id = 'runtime_' + entry.draftKey;
        const line = host.querySelector('[data-limits-line="' + id + '"]');
        if (!line) continue;
        const row = line.closest('.settings-field');
        const input = line.querySelector('input');
        const writing = Boolean(model.limitWrites?.[entry.draftKey]);
        const locked = Boolean(!snapshot || model.busy || snapshot.read_only || snapshot.closing || writing);
        const value = snapshot ? String(model.draft?.[entry.draftKey] ?? configuredValue(snapshot, entry) ?? '') : '';
        if (!snapshot || model.limitRestore?.[entry.draftKey] || (host.ownerDocument.activeElement !== input && !writing)) {
          if (input.value !== value) input.value = value;
        }
        const [min, max] = range(snapshot, entry.key);
        input.min = min;
        input.max = max;
        input.disabled = locked;
        if (writing) input.setAttribute('aria-busy', 'true'); else input.removeAttribute('aria-busy');
        const slot = line.querySelector('[data-setting-revert-slot]');
        const fallback = defaultValue(snapshot, entry);
        const revertTo = isModified(snapshot, entry) ? jt('settings.field.revertTo', '↺ {value}', { value: number(fallback) }) : '';
        const revert = slot.querySelector('[data-setting-revert]');
        if (revert && revert.textContent === revertTo) revert.disabled = locked;
        else slot.innerHTML = revertTo ? button({ id: 'limits-revert', plain: true,
          className: 'settings-field-reset', label: revertTo,
          ariaLabel: jt('settings.field.revertAria', 'Revert {label} to its default', { label: input.getAttribute('aria-label') }),
          title: jt('settings.field.revertTitle', 'Revert to default'), disabled: locked,
          dataset: { 'setting-revert': id, 'focus-key': entry.draftKey + ':revert' } }) : '';
        const noteNode = host.querySelector('[data-limits-note="' + entry.draftKey + '"]');
        const info = note(snapshot, entry);
        if (noteNode.textContent !== info.text) noteNode.textContent = info.text;
        noteNode.hidden = !info.text;
        const error = model.limitErrors?.[entry.draftKey] || '';
        const errorNode = row.querySelector('.settings-field-error');
        errorNode.id = row.getAttribute('data-settings-field') + '_error';
        const helpNode = row.querySelector('.settings-field-help[id]');
        input.setAttribute('aria-describedby', (helpNode ? helpNode.id + ' ' : '') + noteNode.id + ' ' + errorNode.id);
        settingsField.setFieldModified(row, Boolean(row.querySelector('[data-setting-revert]')));
        const rowKeys = [...row.querySelectorAll('[data-draft]')].map(node => node.dataset.draft);
        const rowError = rowKeys.map(key => model.limitErrors?.[key]).filter(Boolean).join(' ');
        // The row's reason is an alert: it is set when it changes, not on every poll.
        if ((errorNode.hidden ? '' : errorNode.textContent) !== rowError) settingsField.setFieldError(row, rowError);
        settingsField.setFieldBusy(row, rowKeys.some(key => model.limitWrites?.[key]));
        if (error) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
      }
      host.dispatchEvent(new host.ownerDocument.defaultView.CustomEvent('limits-lines-updated', { bubbles: true }));
    }
    function focusKey(key) {
      const target = [...host.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === key);
      target?.focus({ preventScroll: true });
      return Boolean(target);
    }
    return { update, focusKey, dispose() {} };
  }

  function createLimitsView(host) {
    const l = labels();
    const list = fields();
    host.innerHTML = '<div class="settings-card-header"><h3>' + escape(l.title) + '</h3></div>'
      + '<p class="settings-copy">' + escape(l.copy) + '</p>'
      + '<p class="settings-note runs-status" data-limits-status role="status" aria-live="polite"></p>'
      + '<div class="limits-grid" data-limits-grid hidden></div>'
      + '<div class="settings-actions limits-actions" data-limits-actions hidden>'
      + button({ id: 'limits-reset', label: l.reset, variant: 'ghost', dataset: { 'focus-key': 'limits-reset' } }) + '</div>';
    const grid = host.querySelector('[data-limits-grid]');
    let built = false;
    function build(model) {
      grid.innerHTML = list.map(entry => {
        const [min, max] = range(model.snapshot, entry.key);
        const id = `runtime_${entry.draftKey}`;
        return settingsField({ id, label: entry.label, variant: 'row', className: 'limits-row', dataset: { limit: entry.draftKey },
          metaHtml: metaHtml(),
          controlHtml: numberInput({ id, ariaLabel: entry.label, min, max, step: 1, value: configuredValue(model.snapshot, entry),
            dataset: { draft: entry.draftKey, 'focus-key': entry.draftKey }, className: 'limits-field' })
            + revertHtml(entry, id)
            + '<span class="limits-note" data-limits-note id="' + id + '_note"></span>' });
      }).join('');
      for (const entry of list) {
        const id = `runtime_${entry.draftKey}`;
        const error = grid.querySelector(`[data-limit="${entry.draftKey}"] .settings-field-error`);
        error.id = `${id}_error`;
        error.setAttribute('data-limits-error', '');
        grid.querySelector(`[data-draft="${entry.draftKey}"]`).setAttribute('aria-describedby', `${id}_note ${id}_error`);
      }
      built = true;
    }
    function update(model) {
      const snapshot = model.snapshot;
      const status = host.querySelector('[data-limits-status]');
      const statusText = !model.loaded ? l.loading : !snapshot ? l.unavailable : snapshot.read_only ? l.readOnly : '';
      if (status.textContent !== statusText) status.textContent = statusText;
      status.hidden = !statusText;
      const actions = host.querySelector('[data-limits-actions]');
      grid.hidden = !snapshot;
      actions.hidden = !snapshot;
      if (!snapshot) return;
      if (!built) build(model);
      const locked = Boolean(model.busy || snapshot.read_only || snapshot.closing);
      const doc = host.ownerDocument;
      for (const entry of list) {
        const row = grid.querySelector(`[data-limit="${entry.draftKey}"]`);
        const input = row.querySelector('input');
        const writing = Boolean(model.limitWrites?.[entry.draftKey]);
        const value = String(model.draft[entry.draftKey] ?? configuredValue(snapshot, entry) ?? '');
        // Never rewrite a field the person is in or one being written, unless
        // a refused write asks for the configured value back.
        const restore = Boolean(model.limitRestore?.[entry.draftKey]);
        if ((restore || (doc.activeElement !== input && !writing)) && input.value !== value) input.value = value;
        if (input.disabled !== (locked || writing)) input.disabled = locked || writing;
        if (writing) input.setAttribute('aria-busy', 'true'); else input.removeAttribute('aria-busy');
        const info = note(snapshot, entry);
        const noteNode = row.querySelector('[data-limits-note]');
        if (noteNode.textContent !== info.text) noteNode.textContent = info.text;
        noteNode.classList.toggle('limits-note--capped', info.capped);
        const fallback = defaultValue(snapshot, entry);
        const defaultText = Number.isInteger(fallback) ? jt('settings.field.default', 'Default: {value}', { value: number(fallback) }) : '';
        const defaultNode = row.querySelector('.settings-field-meta-default');
        if (defaultNode.textContent !== defaultText) defaultNode.textContent = defaultText;
        settingsField.setFieldModified(row, isModified(snapshot, entry));
        row.querySelector('[data-setting-revert]').disabled = locked || writing;
        const error = model.limitErrors?.[entry.draftKey] || '';
        settingsField.setFieldError(row, error);
        settingsField.setFieldBusy(row, writing);
        if (error) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
      }
      const reset = actions.querySelector('[data-action="limits-reset"]');
      const writing = Object.keys(model.limitWrites || {}).length > 0;
      reset.disabled = locked || writing || !list.some(entry => isModified(snapshot, entry));
      if (model.limitsResetArmed) reset.setAttribute('aria-pressed', 'true'); else reset.removeAttribute('aria-pressed');
      reset.classList.toggle('btn--danger', Boolean(model.limitsResetArmed));
    }
    function focusKey(key) {
      const target = [...host.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === key);
      target?.focus({ preventScroll: true });
      return Boolean(target);
    }
    return { update, focusKey, dispose() {} };
  }

  return { createLimitsView, createLimitLines, limitLineHtml, fields, labels, validate, configuredValue, defaultValue, isModified, note };
});
