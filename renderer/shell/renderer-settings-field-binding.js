/**
 * renderer/shell/renderer-settings-field-binding.js
 *
 * The DOM and persistence side of a Settings descriptor (contract §4-§6):
 *   - render:  renderSettingRow / renderSettingControl / buildSettingMetaHtml
 *   - read:    readControlValue (change, inv-toggle-change, inv-segmented-change, preset click)
 *   - sync:    syncSettingRow patches a rendered row in place (never a focused input)
 *   - persist: an adapter registry with one coordinator per persisted object
 *   - bind:    bindSettingFields wires delegated listeners for a set of descriptors
 *
 * Adapter contract (one per persisted object, registered by its section):
 *   { id, mode: 'patch'|'object', optimistic, read(), normalize(obj), write(payload),
 *     ack(result, payload, composed) -> acknowledged object (throws on mismatch),
 *     apply(next, keys), onError?(error, keys), onSettled?(ok) }
 * The coordinator merges queued field writes into one write built from the
 * acknowledged baseline, fences generations (an older acknowledgement never
 * overwrites a newer request), rolls back only the keys of a failed batch, and
 * treats a missing bridge or an undefined result as a rejection.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-settings-field-descriptors.js'), require('./renderer-settings-field-copy.js'));
    return;
  }
  root.rendererSettingsFieldBinding = factory(root.rendererSettingsFieldDescriptors, root.rendererSettingsFieldCopy);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (descriptorsModule, fieldCopyModule) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const descriptors = descriptorsModule || {};

  function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
  function noop() {}
  function describeError(error) {
    return error && typeof error.message === 'string' && error.message ? error.message : String(error);
  }
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  /* Inventory builders resolve from an explicit `inventory` option, the
   * composed globalThis.inventory, the per-module global, or require(). A
   * module that exports an object (toggle-switch) unwraps to its builder;
   * `helper` asks for an imperative companion (setChecked, setFieldError). */
  function inventoryCandidates(name, explicit) {
    const globalName = 'inventory' + name[0].toUpperCase() + name.slice(1);
    const list = [explicit && explicit[name], globalThis.inventory && globalThis.inventory[name], globalThis[globalName]];
    if (typeof require === 'function') {
      try { list.push(require('../inventory/' + name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()))); } catch (_error) { /* not resolvable here */ }
    }
    return list.filter(Boolean);
  }
  function inventoryFn(name, explicit) {
    for (const candidate of inventoryCandidates(name, explicit)) {
      if (typeof candidate === 'function') return candidate;
      if (typeof candidate[name] === 'function') return candidate[name];
    }
    return null;
  }
  function inventoryHelper(name, helper, explicit) {
    for (const candidate of inventoryCandidates(name, explicit)) {
      if (typeof candidate[helper] === 'function') return candidate[helper];
      if (candidate[name] && typeof candidate[name][helper] === 'function') return candidate[name][helper];
    }
    return null;
  }

  // ── dotted keys ──────────────────────────────────────────────────────────
  function getPath(source, key) {
    return String(key).split('.').reduce((acc, part) => (isRecord(acc) ? acc[part] : undefined), source);
  }
  function setPath(target, key, value) {
    const parts = String(key).split('.');
    let cursor = target;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!isRecord(cursor[parts[i]])) cursor[parts[i]] = {};
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
    return target;
  }
  function clone(value) { return JSON.parse(JSON.stringify(value == null ? {} : value)); }
  function topKey(key) { return String(key).split('.')[0]; }

  // ── copy ─────────────────────────────────────────────────────────────────
  function resolveSettingCopy(descriptor) {
    if (isRecord(descriptor.copy)) return descriptor.copy;
    const id = String(descriptor.copy).slice('field-copy:'.length);
    const copy = fieldCopyModule && typeof fieldCopyModule.getSettingsFieldCopy === 'function' ? fieldCopyModule.getSettingsFieldCopy(id) : null;
    return copy || { label: descriptor.id, description: '', keywords: [] };
  }

  // ── coordinator ──────────────────────────────────────────────────────────
  function createObjectCoordinator(adapter, options) {
    const log = options && typeof options.log === 'function' ? options.log : noop;
    const mode = adapter.mode === 'patch' ? 'patch' : 'object';
    let baseline = null;
    let pending = [];
    let inFlight = null;

    function compose(base, entries) {
      const next = clone(base);
      entries.forEach((entry) => setPath(next, entry.key, entry.value));
      return adapter.normalize(next);
    }
    function current() {
      if (!inFlight && !pending.length) return adapter.normalize(adapter.read());
      return compose(baseline, (inFlight ? inFlight.batch : []).concat(pending));
    }
    // phase.settled is false for the optimistic apply of a new edit.
    function applyState(keys, settled) {
      try {
        adapter.apply(compose(baseline, (inFlight ? inFlight.batch : []).concat(pending)), keys, { settled });
      } catch (error) {
        log(`settings adapter "${adapter.id}" apply failed: ${describeError(error)}`);
      }
    }
    function flush() {
      if (inFlight || !pending.length) return;
      const batch = pending;
      pending = [];
      const composed = compose(baseline, batch);
      const keys = batch.map((entry) => entry.key);
      let payload = composed;
      if (mode === 'patch') {
        payload = {};
        keys.forEach((key) => { payload[topKey(key)] = composed[topKey(key)]; });
      }
      let result;
      try {
        result = adapter.write(payload, composed);
      } catch (error) {
        result = Promise.reject(error);
      }
      const hook = (name, ...args) => {
        if (typeof adapter[name] !== 'function') return;
        try { adapter[name](...args); } catch (error) { log(`settings adapter "${adapter.id}" ${name} failed: ${describeError(error)}`); }
      };
      inFlight = { batch, promise: null };
      inFlight.promise = Promise.resolve(result)
        .then((ack) => {
          if (ack === undefined) throw new Error(jt('settings.chatUi.confirmError', 'The saved setting could not be confirmed.'));
          return adapter.normalize(adapter.ack(ack, payload, composed));
        })
        .then((accepted) => {
          baseline = accepted;
          inFlight = null;
          applyState(keys, true);
          batch.forEach((entry) => entry.resolve(baseline));
          hook('onSettled', true, keys);
        }, (error) => {
          inFlight = null;
          applyState(keys, true);
          log(`settings adapter "${adapter.id}" write failed: ${describeError(error)}`);
          batch.forEach((entry) => entry.reject(error));
          hook('onError', error, keys);
          hook('onSettled', false, keys);
        })
        .then(flush);
    }
    function write(key, value) {
      if (!inFlight && !pending.length) baseline = adapter.normalize(adapter.read());
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      promise.catch(noop);
      pending.push({ key, value, resolve, reject });
      if (adapter.optimistic !== false) applyState([key], false);
      flush();
      return promise;
    }
    return { write, current, isBusy: () => Boolean(inFlight) || pending.length > 0 };
  }

  // ── registry ─────────────────────────────────────────────────────────────
  // Sections that bind per Settings open (Notifications, Home, Editor) keep one
  // registry per app state across bind generations: a write still in flight
  // from the previous binding settles against the baseline the new binding
  // writes from, and its callbacks reach the current binding through `live`.
  const SHARED_REGISTRIES = new WeakMap(); // app state -> { registry, live: { [adapterId]: {} } }
  function sharedRegistryFor(state, adapterId) {
    let entry = SHARED_REGISTRIES.get(state);
    if (!entry) {
      entry = { registry: createSettingsAdapterRegistry(), live: {} };
      SHARED_REGISTRIES.set(state, entry);
    }
    entry.live[adapterId] ||= {};
    return { registry: entry.registry, live: entry.live[adapterId] };
  }
  function createSettingsAdapterRegistry(options) {
    const log = options && typeof options.log === 'function' ? options.log : noop;
    const entries = new Map();
    function register(adapter) {
      if (!isRecord(adapter) || !adapter.id) throw new TypeError('registry.register(adapter): adapter.id is required');
      ['read', 'normalize', 'write', 'ack', 'apply'].forEach((name) => {
        if (typeof adapter[name] !== 'function') throw new TypeError(`registry.register("${adapter.id}"): adapter.${name} must be a function`);
      });
      const entry = { adapter, coordinator: createObjectCoordinator(adapter, { log }) };
      entries.set(adapter.id, entry);
      return entry.coordinator;
    }
    function entryFor(descriptor) {
      const entry = entries.get(descriptor.adapterId);
      if (!entry) throw new Error(`settings adapter "${descriptor.adapterId}" is not registered`);
      return entry;
    }
    function read(descriptor) {
      return descriptors.normalizeSettingValue(descriptor, getPath(entryFor(descriptor).coordinator.current(), descriptor.key));
    }
    function write(descriptor, value) {
      return entryFor(descriptor).coordinator.write(descriptor.key, value);
    }
    function revert(descriptor) {
      return write(descriptor, descriptor.default);
    }
    return { register, has: (id) => entries.has(id), get: (id) => (entries.get(id) || {}).adapter || null, read, write, revert };
  }

  // ── render ───────────────────────────────────────────────────────────────
  function optionsFor(descriptor, opts) {
    if (Array.isArray(descriptor.options)) return descriptor.options;
    const source = opts && opts.optionSources && String(descriptor.options).startsWith('source:')
      ? opts.optionSources[String(descriptor.options).slice('source:'.length)]
      : null;
    if (typeof source === 'function') return source();
    if (Array.isArray(source)) return source;
    return descriptors.resolveSettingOptions(descriptor) || [];
  }

  function buildPresetPillsHtml(descriptor, value, opts) {
    const presets = Array.isArray(descriptor.presentation.presets) ? descriptor.presentation.presets : [];
    const actionButton = inventoryFn('actionButton', opts && opts.inventory);
    if (!presets.length || !actionButton) return '';
    const copy = resolveSettingCopy(descriptor);
    let html = '<div class="settings-tuning-presets settings-field-picks" role="group" aria-label="' + escapeHtml(jt('settings.advanced.quickPicksFor', 'Quick picks for {label}', { label: copy.label })) + '">';
    presets.forEach((preset) => {
      const pressed = value != null && Number(preset.value) === Number(value);
      html += actionButton({
        id: 'settingPreset-' + descriptor.id + '-' + String(preset.value).replace(/[^0-9a-zA-Z]/g, '_'),
        label: preset.label, ariaLabel: copy.label + ': ' + preset.label, variant: 'ghost', size: 'sm',
        disabled: Boolean(opts && (opts.disabled === true || opts.parentOff === true)),
        title: jt('settings.advanced.presetTitle', '{label} preset: {preset}', { label: copy.label, preset: preset.label }),
        className: 'settings-tuning-preset' + (pressed ? ' is-pressed' : ''),
        dataset: { 'setting-preset': descriptor.id, 'setting-preset-value': String(preset.value), 'setting-preset-pressed': pressed ? 'true' : 'false' },
      });
    });
    return html + '</div>';
  }

  /* The per-field Revert: empty unless the value differs from its default. It
   * shows only the ↺ glyph; its tooltip and accessible name say the default. */
  function revertDefault(descriptor, opts) {
    return descriptors.describeSettingDefaultValue(descriptor, opts && opts.liveDefault) || '';
  }

  function buildSettingRevertHtml(descriptor, value, opts) {
    const actionButton = inventoryFn('actionButton', opts && opts.inventory);
    const shown = revertDefault(descriptor, opts);
    if (!actionButton || !shown || !descriptors.isSettingModified(descriptor, value, opts && opts.liveDefault)) return '';
    return actionButton({
      id: 'settingRevert-' + descriptor.id, plain: true, className: 'settings-field-reset',
      label: '↺',
      ariaLabel: jt('settings.field.revertAriaTo', 'Revert {label} to {value}', { label: resolveSettingCopy(descriptor).label, value: shown }),
      title: jt('settings.field.revertTitleTo', 'Revert to {value}', { value: shown }),
      dataset: { 'setting-revert': descriptor.id, 'setting-revert-default': shown },
      disabled: Boolean(opts && opts.disabled === true),
    });
  }

  function buildSettingMetaHtml(descriptor, value, opts) {
    if (!descriptors.describeSettingDefaultValue(descriptor, opts && opts.liveDefault)) return '';
    const modified = descriptors.isSettingModified(descriptor, value, opts && opts.liveDefault);
    return '<span class="settings-field-meta"><span class="settings-field-meta-modified"' + (modified ? '' : ' hidden') + '>'
      + escapeHtml(jt('settings.field.modified', 'Modified')) + '</span></span>';
  }

  function choiceOptions(descriptor, value) {
    const p = descriptor.presentation;
    const choices = p.choices.slice();
    if (value != null && value !== descriptor.offValue && !choices.some((choice) => choice.value === value)) {
      // A descriptor that words its choices (the pause length) words this one the same way.
      choices.push({ value, label: typeof p.choiceLabel === 'function' ? p.choiceLabel(value) : String(value) + (p.unit ? ' ' + p.unit : '') });
      choices.sort((a, b) => a.value - b.value);
    }
    return [{ value: descriptor.offValue, label: p.offLabel }].concat(choices);
  }

  function displayNumber(descriptor, value) {
    return Number((value / descriptor.presentation.scale).toFixed(6));
  }
  // The display rounds to six decimals, so a stored whole number off the unit's grid
  // (65537 bytes shown as 64.000977 KB) comes back within that error: it is that number.
  function storedNumber(descriptor, shown) {
    const scale = descriptor.presentation.scale;
    const stored = Number(shown) * scale;
    const nearest = Math.round(stored);
    return descriptor.kind !== 'decimal' && Math.abs(stored - nearest) <= scale * 0.5e-6 ? nearest : Number(stored.toFixed(6));
  }

  // The switch of a row: named by the row title, described by the row help when there is one.
  // `toggleId` is the id its change event reports, when that is not a DOM-safe token.
  function bareSwitchHtml(inv, controlId, o) {
    const toggleSwitch = inventoryFn('toggleSwitch', inv);
    return toggleSwitch ? toggleSwitch({ id: o.toggleId || controlId, bare: true, domId: controlId + 'Switch', labelledBy: controlId + 'Title',
      describedBy: o.describedBy || '', checked: o.checked === true, disabled: o.disabled === true }) : '';
  }

  function renderSettingControl(descriptor, value, opts) {
    const o = opts || {};
    const inv = o.inventory;
    const copy = resolveSettingCopy(descriptor);
    const disabled = o.disabled === true || o.parentOff === true;
    const v = descriptor.validation;
    // Only a row renders the help paragraph (renderSettingRow passes it), so only then is it pointed at.
    // A row that holds several controls names its own help element.
    const describedBy = o.describedBy || (o.help ? descriptor.controlId + 'Description' : '');
    switch (descriptor.control) {
      case 'toggle': {
        const help = o.help === undefined ? (o.description === undefined ? copy.description : o.description) : o.help;
        return bareSwitchHtml(inv, descriptor.controlId, { describedBy: o.describedBy || (help ? descriptor.controlId + 'Description' : ''), checked: value === true, disabled });
      }
      case 'segmented': {
        const segmentedControl = inventoryFn('segmentedControl', inv);
        return segmentedControl ? segmentedControl({ id: descriptor.controlId, ariaLabel: copy.label, describedBy, value, options: optionsFor(descriptor, o), disabled }) : '';
      }
      case 'choice':
      case 'select': {
        const selectField = inventoryFn('selectField', inv);
        return selectField ? selectField({ id: descriptor.controlId, ariaLabel: copy.label, value, options: descriptor.control === 'choice' ? choiceOptions(descriptor, value) : optionsFor(descriptor, o), disabled, className: o.className, describedBy }) : '';
      }
      case 'number':
      case 'optionalNumber': {
        const numberInput = inventoryFn('numberInput', inv);
        if (!numberInput) return '';
        const off = descriptor.control === 'optionalNumber' && value === descriptor.offValue;
        const scale = descriptor.presentation.scale;
        const html = numberInput({ id: descriptor.controlId, ariaLabel: copy.label, value: off ? '' : (value == null ? value : displayNumber(descriptor, value)),
          allowEmpty: descriptor.control === 'optionalNumber' || v.allowEmpty === true, placeholder: descriptor.presentation.offLabel,
          min: v.min == null ? v.min : displayNumber(descriptor, v.min), max: v.max == null ? v.max : displayNumber(descriptor, v.max),
          step: Number(((v.step || 1) / scale).toFixed(6)), suffix: descriptor.presentation.unit, disabled, describedBy, dataset: { 'setting-input': descriptor.id } });
        return '<span class="settings-field-number">' + html + buildPresetPillsHtml(descriptor, value, o) + '</span>';
      }
      default: {
        const textField = inventoryFn('textField', inv);
        return textField ? textField({ id: descriptor.controlId, ariaLabel: copy.label, describedBy, value: value == null ? '' : String(value), placeholder: o.placeholder, disabled, multiline: o.multiline === true, maxLength: v.maxLength, dataset: o.dataset }) : '';
      }
    }
  }

  function renderToggleRow(opts) {
    const o = opts || {};
    const settingsField = inventoryFn('settingsField', o.inventory);
    const control = bareSwitchHtml(o.inventory, o.controlId, { toggleId: o.toggleId, describedBy: o.help ? o.controlId + 'Description' : '',
      checked: o.checked === true, disabled: o.disabled === true || o.parentOff === true });
    if (!settingsField || !control) return '';
    // `controlPrefixHtml` sits before the switch (the sandbox row's Retry); `error` fills the row's alert line.
    return settingsField({ id: o.id, label: o.label, help: o.help, labelFor: o.controlId + 'Switch', titleId: o.controlId + 'Title', helpId: o.controlId + 'Description',
      detail: o.detail, detailLabel: jt('settings.field.detailAria', 'More about {label}', { label: o.label }), variant: 'row', error: o.error,
      className: [o.rowClassName, o.sub === true ? 'settings-field--sub' : ''].filter(Boolean).join(' '),
      controlHtml: (o.controlPrefixHtml || '') + control,
      dataset: Object.assign({ 'setting-id': o.id }, o.parentOff === true ? { 'setting-parent-off': 'true' } : {}) });
  }

  function renderSettingRow(descriptor, value, opts) {
    const o = opts || {};
    const copy = resolveSettingCopy(descriptor);
    const help = o.help === undefined ? (o.description === undefined ? copy.description : o.description) : o.help;
    const detail = o.detail === undefined ? copy.detail : o.detail;
    if (descriptor.control === 'toggle') return renderToggleRow(Object.assign({}, o, { id: descriptor.id, controlId: descriptor.controlId, label: copy.label, help, detail, checked: value === true }));
    const control = renderSettingControl(descriptor, value, Object.assign({}, o, { help }));
    const settingsField = inventoryFn('settingsField', o.inventory);
    if (!settingsField) return control;
    // The title labels a single control; a segmented group has no one element to point at.
    return settingsField({ id: descriptor.id, label: copy.label, help, helpId: descriptor.controlId + 'Description', labelFor: descriptor.control === 'segmented' ? '' : descriptor.controlId,
      detail, detailLabel: jt('settings.field.detailAria', 'More about {label}', { label: copy.label }),
      metaHtml: buildSettingMetaHtml(descriptor, value, o), variant: 'row',
      className: [o.rowClassName, o.sub === true ? 'settings-field--sub' : ''].filter(Boolean).join(' '),
      revertSlot: true, revertHtml: buildSettingRevertHtml(descriptor, value, Object.assign({}, o, { disabled: o.disabled === true || o.parentOff === true })),
      controlHtml: control, dataset: Object.assign({ 'setting-id': descriptor.id }, o.parentOff === true ? { 'setting-parent-off': 'true' } : {}) });
  }

  // ── read ─────────────────────────────────────────────────────────────────
  function coerceOption(descriptor, raw) {
    const options = descriptors.resolveSettingOptions(descriptor);
    if (!options) return raw;
    const match = options.find((option) => String(option.value) === String(raw));
    return match ? match.value : raw;
  }
  function parseNumber(descriptor, raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (text === '') return descriptor.control === 'optionalNumber' ? descriptor.offValue : (descriptor.validation.allowEmpty ? null : NaN);
    const n = Number(text);
    return descriptor.kind === 'decimal' ? n : (Number.isInteger(n) ? n : NaN);
  }

  /* Returns { value } when the event edits this descriptor, else null. */
  function readControlValue(descriptor, event) {
    const type = event && event.type;
    const detail = (event && event.detail) || {};
    const target = event && event.target;
    if (type === 'inv-toggle-change') {
      return detail.id === descriptor.controlId ? { value: detail.checked === true } : null;
    }
    if (type === 'inv-segmented-change') {
      return detail.id === descriptor.controlId ? { value: coerceOption(descriptor, detail.value) } : null;
    }
    if (type === 'change' && target && target.id === descriptor.controlId) {
      if (descriptor.control === 'select') return { value: coerceOption(descriptor, target.value) };
      if (descriptor.control === 'choice') return { value: parseNumber(descriptor, target.value) };
      if (descriptor.control === 'number' || descriptor.control === 'optionalNumber') {
        const raw = String(target.value == null ? '' : target.value).trim();
        return { value: parseNumber(descriptor, raw === '' ? '' : storedNumber(descriptor, raw)) };
      }
      return { value: String(target.value == null ? '' : target.value) };
    }
    if (type === 'click' && target && typeof target.closest === 'function') {
      const preset = target.closest('[data-setting-preset="' + descriptor.id + '"]');
      if (preset) return { value: parseNumber(descriptor, preset.getAttribute('data-setting-preset-value')) };
    }
    return null;
  }

  // ── sync ─────────────────────────────────────────────────────────────────
  function controlElements(container, descriptor) {
    const els = [];
    const q = (selector) => container.querySelector(selector);
    const track = q('[data-inv-toggle="' + descriptor.controlId + '"]');
    if (track) els.push(track);
    const byId = container.querySelector('#' + descriptor.controlId.replace(/([^\w-])/g, '\\$1'));
    if (byId && byId !== track) els.push(byId);
    const group = q('[data-inv-segmented="' + descriptor.controlId + '"]');
    if (group) els.push(...group.querySelectorAll('.inv-segmented-option'));
    els.push(...container.querySelectorAll('[data-setting-preset="' + descriptor.id + '"], [data-setting-revert="' + descriptor.id + '"]'));
    return els;
  }
  function isFocused(el) {
    const doc = el && el.ownerDocument;
    return Boolean(doc) && doc.activeElement === el;
  }

  function syncSettingRow(container, descriptor, value, opts) {
    if (!container || typeof container.querySelector !== 'function') return;
    const q = (selector) => container.querySelector(selector);
    const setChecked = inventoryHelper('toggleSwitch', 'setChecked', opts && opts.inventory);
    const track = q('[data-inv-toggle="' + descriptor.controlId + '"]');
    if (track && setChecked) setChecked(track, value === true);
    const group = q('[data-inv-segmented="' + descriptor.controlId + '"]');
    if (group) {
      const buttons = Array.from(group.querySelectorAll('.inv-segmented-option'));
      const current = String(value == null ? '' : value);
      const matched = buttons.some((button) => button.getAttribute('data-value') === current);
      buttons.forEach((button) => {
        const on = button.getAttribute('data-value') === current;
        button.setAttribute('aria-checked', on ? 'true' : 'false');
        button.classList.toggle('inv-segmented-option--on', on);
        // The roving tab stop follows the selection, so a rolled-back choice does not keep it.
        if (matched) button.setAttribute('tabindex', on ? '0' : '-1');
      });
      // So does focus that sits inside the group.
      const stray = matched ? buttons.find((button) => isFocused(button) && button.getAttribute('aria-checked') !== 'true') : null;
      const chosen = stray ? buttons.find((button) => button.getAttribute('aria-checked') === 'true') : null;
      if (chosen && !chosen.disabled) chosen.focus({ preventScroll: true });
    }
    const input = descriptor.control === 'toggle' ? null : q('#' + descriptor.controlId.replace(/([^\w-])/g, '\\$1'));
    // A runtime option list (theme bundles gain "Custom", installed models change)
    // is rewritten inside the live select, so the node a caller holds survives.
    // So is a choice whose value, set elsewhere, has no option yet.
    const listed = (v) => Array.prototype.some.call(input.options, (option) => option.value === String(v));
    const patchOptions = input && input.options && ((opts && opts.patchOptions === true && ['select', 'choice'].includes(descriptor.control))
      || (descriptor.control === 'choice' && value != null && !listed(value)));
    if (patchOptions) {
      const options = descriptor.control === 'choice' ? choiceOptions(descriptor, value) : optionsFor(descriptor, opts);
      const selectField = inventoryFn('selectField', opts && opts.inventory);
      const signature = (list, read) => Array.prototype.map.call(list, read).join('\u0001');
      if (options.length && selectField && typeof selectField.optionsMarkup === 'function'
        && signature(options, (o) => String(o.value) + '\u0000' + String(o.label == null ? o.value : o.label)) !== signature(input.options, (o) => o.value + '\u0000' + o.textContent)) {
        input.innerHTML = selectField.optionsMarkup(options, value);
      }
    }
    // A background sync never rewrites what the person is typing; a settled
    // edit (opts.force) always reconciles the field with the acknowledged value.
    if (input && 'value' in input && (!isFocused(input) || (opts && opts.force === true))) {
      const off = descriptor.control === 'optionalNumber' && value === descriptor.offValue;
      input.value = value == null || off ? '' : String(['number', 'optionalNumber'].includes(descriptor.control) ? displayNumber(descriptor, value) : value);
    }
    container.querySelectorAll('[data-setting-preset="' + descriptor.id + '"]').forEach((pill) => {
      const pressed = value != null && Number(pill.getAttribute('data-setting-preset-value')) === Number(value);
      pill.classList.toggle('is-pressed', pressed);
      pill.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    });
    const slot = q('[data-setting-revert-slot="' + descriptor.id + '"]');
    if (slot) {
      // A rebuilt Revert takes the lock its control holds (busy, unavailable or rendered disabled).
      const lead = controlElements(container, descriptor)[0];
      const html = buildSettingRevertHtml(descriptor, value, opts);
      const kept = slot.querySelector('[data-setting-revert]');
      // A Revert that still names the same default is kept: a poll must not take it from under keyboard focus.
      if (kept && html && kept.getAttribute('data-setting-revert-default') === revertDefault(descriptor, opts)) {
        if (!kept.hasAttribute('data-setting-busy') && !kept.hasAttribute('data-setting-unavailable')) kept.disabled = Boolean(opts && opts.disabled === true);
      } else if (kept || html) {
        slot.innerHTML = html;
      }
      const revert = slot.querySelector('[data-setting-revert]');
      if (revert && lead && lead.disabled && !lead.hasAttribute('data-setting-revert')) {
        ['data-setting-busy', 'data-setting-unavailable'].forEach((name) => { if (lead.hasAttribute(name)) revert.setAttribute(name, ''); });
        revert.disabled = true;
      }
    }
    const row = slot ? slot.closest('.settings-field') : q('[data-settings-field="' + descriptor.id + '"]');
    if (row) {
      const setFieldModified = inventoryHelper('settingsField', 'setFieldModified', opts && opts.inventory);
      if (setFieldModified) setFieldModified(row, Boolean(row.querySelector('[data-setting-revert]')));
    }
  }

  /* Mounted rows: the page keeps an empty [data-setting-mount="<id>"] host. The
   * first call renders the row; every later call patches it in place (value,
   * option list, meta), so the control node is created once and never replaced. */
  function mountSettingRow(mount, descriptor, value, opts) {
    if (!mount || typeof mount.querySelector !== 'function') return;
    if (!mount.firstElementChild) mount.innerHTML = renderSettingRow(descriptor, value, opts);
    else syncSettingRow(mount, descriptor, value, Object.assign({}, opts, { patchOptions: true }));
    if (opts && (typeof opts.disabled === 'boolean' || typeof opts.parentOff === 'boolean')) {
      const row = mount.querySelector('.settings-field');
      if (row && typeof opts.parentOff === 'boolean') {
        if (opts.parentOff) row.setAttribute('data-setting-parent-off', 'true');
        else row.removeAttribute('data-setting-parent-off');
      }
      setRowDisabled(mount, descriptor, opts.disabled === true || opts.parentOff === true);
    }
  }

  /* Availability (the section cannot be edited right now) covers the control,
   * its presets and its Revert; a write in flight keeps its own busy lock. */
  function setRowDisabled(container, descriptor, disabled) {
    const lead = controlElements(container, descriptor)[0];
    disabled = disabled || Boolean(lead && lead.closest('[data-setting-parent-off]'));
    const setSwitchDisabled = inventoryHelper('toggleSwitch', 'setDisabled');
    controlElements(container, descriptor).forEach((el) => {
      el.toggleAttribute('data-setting-unavailable', disabled);
      // A switch's dimmed look and aria state follow availability; the busy lock below only blocks input.
      if (setSwitchDisabled && el.hasAttribute('data-inv-toggle')) setSwitchDisabled(el, disabled);
      el.disabled = disabled || el.hasAttribute('data-setting-busy');
    });
    const group = container.querySelector('[data-inv-segmented="' + descriptor.controlId + '"]');
    if (group) {
      // The disabled options already dim; the group class on top would dim them twice.
      group.classList.remove('inv-segmented--disabled');
      if (disabled) group.setAttribute('aria-disabled', 'true'); else group.removeAttribute('aria-disabled');
    }
  }

  /* Busy disables the control, its presets and its Revert. Only elements this
   * call disabled are re-enabled, so an availability restriction (or a row
   * re-rendered mid-flight) is never lifted by the settle. */
  function setRowBusy(container, descriptor, busy, opts) {
    if (!container || typeof container.querySelector !== 'function') return;
    const row = container.querySelector('[data-settings-field="' + descriptor.id + '"]');
    const setFieldBusy = inventoryHelper('settingsField', 'setFieldBusy', opts && opts.inventory);
    if (row && setFieldBusy) setFieldBusy(row, busy);
    controlElements(container, descriptor).forEach((el) => {
      if (busy) {
        if (el.disabled) return;
        el.setAttribute('data-setting-busy', '');
        el.disabled = true;
      } else if (el.hasAttribute('data-setting-busy')) {
        el.removeAttribute('data-setting-busy');
        el.disabled = el.hasAttribute('data-setting-unavailable');
      }
    });
  }

  // ── bind ─────────────────────────────────────────────────────────────────
  // container -> field list -> teardown of the binding that paints its reasons.
  const errorPainters = new WeakMap();

  function bindSettingFields(options) {
    const o = options || {};
    const container = o.container;
    const registry = o.registry;
    const list = Array.isArray(o.descriptors) ? o.descriptors : (Array.isArray(o.ids) ? o.ids.map((id) => descriptors.getSettingDescriptor(id)).filter(Boolean) : []);
    if (!container || typeof container.addEventListener !== 'function' || !registry || typeof o.registerListener !== 'function' || !list.length) return null;
    const onError = typeof o.onError === 'function' ? o.onError : noop;
    const onApplied = typeof o.onApplied === 'function' ? o.onApplied : noop;
    const byControl = new Map();
    list.forEach((d) => {
      byControl.set(d.controlId, d);
    });
    const setFieldError = inventoryHelper('settingsField', 'setFieldError', o.inventory);
    const setToggleError = inventoryHelper('toggleSwitch', 'setError', o.inventory);

    // The reason stays on its row (a switch shows it under its help text) until
    // the next edit of that field. Sections rebuild their rows on every render,
    // so while a reason is showing an observer paints it onto the new nodes.
    const errors = new Map(); // descriptor id -> reason
    let observer = null;
    let disposed = false;
    // Returns the element that carries the reason, or null when the field is not on the page.
    function paintError(d) {
      const message = errors.get(d.id) || '';
      const row = container.querySelector('[data-settings-field="' + d.id + '"]');
      if (row && setFieldError) {
        const slot = row.querySelector('.settings-field-error');
        if ((slot && !slot.hidden ? slot.textContent : '') !== message) setFieldError(row, message || null);
        return row;
      }
      const track = container.querySelector('[data-inv-toggle="' + d.controlId + '"]');
      const wrapper = track && setToggleError ? track.closest('.inv-toggle') : null;
      if (!wrapper) return null;
      const line = wrapper.querySelector('.inv-toggle-error');
      if ((line ? line.textContent : '') !== message) setToggleError(track, message || null);
      return wrapper;
    }
    // A save can settle after the person left the page (a feature save waits for
    // the engine, the title-bar switch lives outside Settings): the reason counts
    // as shown only in the active view and the active Settings card.
    function onScreen(el) {
      if (!el || el.closest('[hidden]')) return false;
      // What a closed disclosure holds is not on screen; its summary is.
      for (let fold = el.closest('details'); fold; fold = fold.parentElement && fold.parentElement.closest('details')) {
        const summary = fold.querySelector('summary');
        if (!fold.open && !(summary && summary.parentElement === fold && summary.contains(el))) return false;
      }
      const view = el.closest('.main-view');
      const card = el.closest('.settings-card');
      return (!view || view.classList.contains('active-view')) && (!card || card.classList.contains('settings-section-active'));
    }
    function watchErrors() {
      const view = container.ownerDocument && container.ownerDocument.defaultView;
      if (!errors.size || disposed) {
        if (observer) observer.disconnect();
        observer = null;
      } else if (!observer && view && typeof view.MutationObserver === 'function') {
        observer = new view.MutationObserver(() => list.forEach((d) => { if (errors.has(d.id)) paintError(d); }));
        observer.observe(container, { childList: true, subtree: true });
      }
    }
    function showError(d, error) {
      // A write that settles after its binding is gone is reported, never painted.
      if (disposed) {
        onError(d, error, { inline: false });
        return;
      }
      // Stored the way the primitives show it (trimmed), or a repaint would never see it as painted.
      errors.set(d.id, String(describeError(error) || '').trim() || jt('settings.chatUi.confirmError', 'The saved setting could not be confirmed.'));
      // inline: the person can see the reason where they made the change, so the handler need not toast it.
      onError(d, error, { inline: onScreen(paintError(d)) });
      // Painted again after the handler: a section may repaint its rows there.
      paintError(d);
      watchErrors();
    }
    function clearError(d) {
      if (disposed) return;
      errors.delete(d.id);
      paintError(d);
      watchErrors();
    }
    // Teardown: the reasons this binding painted leave with it, and its observer stops.
    // It runs when the listener signal aborts and when the same fields are bound again
    // on the same container, so a replaced binding never paints over its successor.
    function dispose() {
      if (disposed) return;
      const shown = list.filter((d) => errors.has(d.id));
      errors.clear();
      shown.forEach(paintError);
      disposed = true;
      watchErrors();
    }
    const painterKey = list.map((d) => d.id).join('\u0001');
    const painters = errorPainters.get(container) || new Map();
    errorPainters.set(container, painters);
    if (painters.has(painterKey)) painters.get(painterKey)();
    painters.set(painterKey, dispose);
    const signal = o.listenerOptions && o.listenerOptions.signal;
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', dispose, { once: true });
    const inFlight = new Map(); // descriptor id -> writes in flight
    function markBusy(d, delta) {
      const count = Math.max(0, (inFlight.get(d.id) || 0) + delta);
      if (count) inFlight.set(d.id, count); else inFlight.delete(d.id);
      setRowBusy(container, d, count > 0, o);
    }
    // Every write in flight, not only the edited field: a section that re-renders
    // its rows on apply replaced the busy nodes of the pending siblings too.
    function reapplyBusy() {
      list.forEach((entry) => { if (inFlight.has(entry.id)) setRowBusy(container, entry, true, o); });
    }
    function sync(d, settled) {
      let value;
      try { value = registry.read(d); } catch (_error) { return; }
      syncSettingRow(container, d, value, settled ? Object.assign({}, o, { force: true }) : o);
      // A re-rendered row comes back without its busy state; a write still in flight puts it back.
      if (inFlight.has(d.id)) setRowBusy(container, d, true, o);
    }
    // Busy disables the focused control, which drops focus to the page, and an
    // apply may repaint the row. Focus is remembered by selector (a segmented
    // group by its chosen option) and handed back on settle unless the person moved on.
    function focusedSelector(d) {
      let el = controlElements(container, d).find(isFocused);
      if (!el) return '';
      // A successful Revert removes itself, so focus goes to the control it reset.
      if (el.hasAttribute('data-setting-revert')) el = controlElements(container, d)[0];
      if (el.classList.contains('inv-segmented-option')) return '[data-inv-segmented="' + d.controlId + '"] .inv-segmented-option[aria-checked="true"]';
      // Quick picks carry no DOM id; a repainted pick is found by its value.
      if (el.hasAttribute('data-setting-preset')) return '[data-setting-preset="' + d.id + '"][data-setting-preset-value="' + el.getAttribute('data-setting-preset-value') + '"]';
      return el.id ? '#' + el.id.replace(/([^\w-])/g, '\\$1') : '';
    }
    function restoreFocus(selector) {
      const active = container.ownerDocument && container.ownerDocument.activeElement;
      if (!selector || (active && active !== container.ownerDocument.body && active.isConnected && !active.disabled)) return;
      const el = container.querySelector(selector);
      if (el && !el.disabled) el.focus({ preventScroll: true });
    }
    function commit(d, value) {
      const check = descriptors.validateSettingValue(d, value);
      if (!check.ok) {
        showError(d, new Error(check.error));
        // Forced: the refused text must not stay in the field the person is still in.
        sync(d, true);
        return Promise.resolve();
      }
      clearError(d);
      const focused = focusedSelector(d);
      markBusy(d, 1);
      let written;
      try { written = registry.write(d, check.value); } catch (error) { written = Promise.reject(error); }
      // An optimistic apply may have re-rendered the rows synchronously: busy again on the new nodes.
      reapplyBusy();
      return written.then(() => {
        markBusy(d, -1);
        sync(d, true);
        reapplyBusy();
        onApplied(d, check.value);
        restoreFocus(focused);
      }, (error) => {
        markBusy(d, -1);
        sync(d, true);
        reapplyBusy();
        showError(d, error);
        restoreFocus(focused);
      });
    }
    function descriptorFor(event) {
      const detail = event.detail || {};
      if (event.type === 'inv-toggle-change' || event.type === 'inv-segmented-change') return byControl.get(String(detail.id || '')) || null;
      if (event.type === 'change') return event.target && byControl.get(String(event.target.id || '')) || null;
      if (event.type === 'click' && event.target && typeof event.target.closest === 'function') {
        const hit = event.target.closest('[data-setting-revert],[data-setting-preset]');
        if (!hit) return null;
        const id = hit.getAttribute('data-setting-revert') || hit.getAttribute('data-setting-preset');
        return list.find((d) => d.id === id) || null;
      }
      return null;
    }
    function handle(event) {
      const d = descriptorFor(event);
      if (!d) return;
      if (event.type === 'click' && event.target.closest('[data-setting-revert="' + d.id + '"]')) {
        void commit(d, d.default);
        return;
      }
      const read = readControlValue(d, event);
      if (read) void commit(d, read.value);
    }
    ['inv-toggle-change', 'inv-segmented-change', 'change', 'click'].forEach((type) => o.registerListener(container, type, handle, o.listenerOptions));
    return { descriptors: list, sync: (id) => { const d = id ? list.find((entry) => entry.id === id) : null; (d ? [d] : list).forEach((entry) => sync(entry)); }, commit, dispose };
  }

  return {
    createObjectCoordinator,
    createSettingsAdapterRegistry,
    sharedRegistryFor,
    resolveSettingCopy,
    renderSettingControl,
    renderSettingRow,
    renderToggleRow,
    buildSettingMetaHtml,
    buildSettingRevertHtml,
    readControlValue,
    syncSettingRow,
    mountSettingRow,
    setRowDisabled,
    setRowBusy,
    bindSettingFields,
    getPath,
    setPath,
  };
});
