'use strict';

// Shared harness for the settings field binding tests: five descriptors on one
// persisted object, a fake adapter with switchable outcomes, and a jsdom host.
const { JSDOM } = require('jsdom');

const descriptors = require('../../renderer/shell/renderer-settings-field-descriptors.js');
const binding = require('../../renderer/shell/renderer-settings-field-binding.js');
const inventory = {
  toggleSwitch: require('../../renderer/inventory/toggle-switch.js').toggleSwitch,
  segmentedControl: require('../../renderer/inventory/segmented-control.js'),
  selectField: require('../../renderer/inventory/select-field.js'),
  numberInput: require('../../renderer/inventory/number-input.js'),
  textField: require('../../renderer/inventory/text-field.js'),
  actionButton: require('../../renderer/inventory/action-button.js'),
  settingsField: require('../../renderer/inventory/settings-field.js'),
};

// One persisted object shared by five test descriptors (contract §5: one
// adapter per persisted object, a coordinator that merges field writes).
const D = {
  count: descriptors.defineSettingDescriptor({ id: 'bindTestCount', sectionId: 'tools', kind: 'integer', default: 4, adapterId: 'bindTest', key: 'count', validation: { min: 0, max: 10, step: 1 }, presentation: { unit: 'items', presets: [{ value: 2, label: 'Two' }, { value: 8, label: 'Eight' }] }, copy: { label: 'Count', description: 'How many.' } }),
  flag: descriptors.defineSettingDescriptor({ id: 'bindTestFlag', sectionId: 'tools', kind: 'boolean', default: true, adapterId: 'bindTest', key: 'nested.flag', copy: { label: 'Flag', description: 'A switch.' } }),
  mode: descriptors.defineSettingDescriptor({ id: 'bindTestMode', sectionId: 'tools', kind: 'enum', default: 'a', adapterId: 'bindTest', key: 'mode', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], copy: { label: 'Mode', description: 'Pick one.' } }),
  name: descriptors.defineSettingDescriptor({ id: 'bindTestName', sectionId: 'tools', kind: 'text', default: '', adapterId: 'bindTest', key: 'name', validation: { maxLength: 5 }, copy: { label: 'Name', description: 'Short.' } }),
  guard: descriptors.defineSettingDescriptor({ id: 'bindTestGuard', sectionId: 'tools', kind: 'optionalInteger', default: 0, offValue: 0, adapterId: 'bindTest', key: 'guard', validation: { min: 1, max: 60, step: 1 }, copy: { label: 'Guard', description: 'Minutes.' } }),
};
const ALL = Object.values(D);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function normalize(source) {
  const s = source && typeof source === 'object' ? source : {};
  return {
    count: Number.isInteger(s.count) && s.count >= 0 && s.count <= 10 ? s.count : 4,
    nested: { flag: typeof s.nested?.flag === 'boolean' ? s.nested.flag : true },
    mode: s.mode === 'b' ? 'b' : 'a',
    name: typeof s.name === 'string' ? s.name : '',
    guard: Number.isInteger(s.guard) && s.guard >= 0 && s.guard <= 60 ? s.guard : 0,
  };
}

function harness(options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const { document } = dom.window;
  const host = document.getElementById('host');
  const fields = options.descriptors || ALL;
  const normalizeStore = options.normalize || normalize;
  const state = { store: normalizeStore(options.initial) };
  const calls = [];
  const errors = [];
  const applied = [];
  let mode = 'ok';
  let rejectMessage = 'disk full';
  const inv = options.inventory || inventory;
  const abort = new dom.window.AbortController();
  const pendingWrites = [];
  const adapter = {
    id: fields[0].adapterId,
    mode: options.mode || 'object',
    optimistic: options.optimistic !== false,
    read: () => state.store,
    normalize: normalizeStore,
    write(payload) {
      calls.push(JSON.parse(JSON.stringify(payload)));
      if (mode === 'throw') throw new Error('bridge missing');
      if (mode === 'reject') return Promise.reject(new Error(rejectMessage));
      if (mode === 'undefined') return Promise.resolve(undefined);
      if (mode === 'hold') return new Promise((resolve, reject) => pendingWrites.push({ payload, resolve, reject }));
      if (mode === 'mismatch') return Promise.resolve({ ...payload, count: 9 });
      return Promise.resolve(payload);
    },
    ack(result, payload) {
      for (const key of Object.keys(payload)) {
        if (JSON.stringify(result[key]) !== JSON.stringify(payload[key])) throw new Error('not confirmed');
      }
      return result;
    },
    apply(next, keys) { state.store = next; applied.push(keys.slice()); },
    onError(error, keys) { errors.push({ message: error.message, keys: keys.slice() }); },
  };
  const registry = binding.createSettingsAdapterRegistry();
  registry.register(adapter);
  const render = () => {
    host.innerHTML = fields.map((d) => binding.renderSettingRow(d, registry.read(d), { inventory })).join('');
  };
  render();
  let listeners = [];
  const bind = (extra) => binding.bindSettingFields({
    container: host, descriptors: fields, registry, inventory: inv,
    registerListener: (target, type, handler, opts) => { target.addEventListener(type, handler, opts); listeners.push([target, type, handler]); },
    onError: (d, error, meta) => errors.push({ field: d.id, message: error.message, inline: meta.inline }),
    ...extra,
  });
  const controller = bind(options.signal ? { listenerOptions: { signal: abort.signal } } : null);
  return {
    dom, window: dom.window, document, host, state, calls, errors, applied, registry, controller, pendingWrites, render,
    setMode: (next) => { mode = next; },
    setRejectMessage: (next) => { rejectMessage = next; },
    abort: () => abort.abort(),
    // A section rebinds: the old listeners go away and the same rows get a fresh binding.
    rebind() { listeners.forEach(([target, type, handler]) => target.removeEventListener(type, handler)); listeners = []; return bind(); },
    input: (d) => document.getElementById(d.controlId),
    row: (d) => host.querySelector(`[data-settings-field="${d.id}"]`),
    change(d, value) {
      const el = document.getElementById(d.controlId);
      el.value = value;
      el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    },
    toggle(id, checked) {
      host.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', { bubbles: true, detail: { id, checked } }));
    },
    click(selector) {
      host.querySelector(selector).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    },
    dispose() { listeners.forEach(([target, type, handler]) => target.removeEventListener(type, handler)); dom.window.close(); },
  };
}

module.exports = { ALL, D, JSDOM, binding, descriptors, flush, harness, inventory, normalize };
