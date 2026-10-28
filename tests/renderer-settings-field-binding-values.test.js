'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { D, JSDOM, binding, descriptors, flush, harness, inventory, normalize } = require('./helpers/settings-field-binding-harness');

test('row standard: boolean title labels its bare switch and clicks write once', async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  const row = h.row(D.flag);
  assert.ok(row?.classList.contains('settings-field--row'));
  const title = row.querySelector('.settings-field-title');
  const track = row.querySelector('[data-inv-toggle]');
  assert.equal(title.tagName, 'LABEL');
  assert.equal(title.htmlFor, track.id);
  assert.equal(track.id, D.flag.controlId + 'Switch');
  assert.equal(track.getAttribute('aria-labelledby'), title.id);
  assert.equal(track.getAttribute('aria-describedby'), row.querySelector('.settings-field-help').id);
  assert.equal(row.querySelector('.inv-toggle-label'), null);
  assert.equal(row.querySelector('.settings-field-meta'), null);
  assert.equal(row.querySelector('[data-setting-revert-slot]'), null);
  let events = 0;
  h.host.addEventListener('inv-toggle-change', () => events++);
  require('../renderer/inventory/toggle-switch').initToggleHandlers(h.host);
  title.click();
  await flush();
  assert.equal(events, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.registry.read(D.flag), false);
});

const guardDescriptor = descriptors.getSettingDescriptor('unattendedGuardMinutesInput');
const capDescriptor = descriptors.getSettingDescriptor('autoApproveStreakCapInput');
function toolsHarness(initial) {
  return harness({ descriptors: [guardDescriptor, capDescriptor], initial,
    normalize: (source) => ({ unattendedGuardMinutes: 0, autoApproveStreakCap: 50, ...source }) });
}

test('row standard: guard dropdown preserves off and off-list stored values', async (t) => {
  const h = toolsHarness();
  t.after(() => h.dispose());
  const select = h.input(guardDescriptor);
  assert.equal(select.tagName, 'SELECT');
  assert.equal(select.value, '0');
  assert.equal(select.selectedOptions[0].textContent, 'Never');
  assert.equal(h.host.querySelector('[data-inv-toggle="unattendedGuardToggle"]'), null);
  h.change(guardDescriptor, '15');
  await flush();
  assert.equal(h.calls[0].unattendedGuardMinutes, 15);
  h.state.store.unattendedGuardMinutes = 45;
  binding.syncSettingRow(h.host, guardDescriptor, 45, { inventory, patchOptions: true });
  assert.equal(select.value, '45');
  assert.equal(select.selectedOptions[0].textContent, '45 min');
  assert.deepEqual([...select.options].map((o) => Number(o.value)), [0, 5, 10, 15, 30, 45, 60, 120]);
  binding.syncSettingRow(h.host, guardDescriptor, 60, { inventory, patchOptions: true });
  assert.equal(select.value, '60');
  assert.equal([...select.options].some((o) => o.value === '45'), false);
  // A plain sync (a value changed elsewhere) keeps an off-list value too.
  binding.syncSettingRow(h.host, guardDescriptor, 45, { inventory });
  assert.equal(select.value, '45');
  assert.equal(select.selectedOptions[0].textContent, '45 min');
});

test('row standard: cap empty means no limit; edits validate before writing', async (t) => {
  const h = toolsHarness({ autoApproveStreakCap: 0 });
  t.after(() => h.dispose());
  const input = h.input(capDescriptor);
  assert.equal(input.value, '');
  assert.equal(input.placeholder, 'No limit');
  assert.equal(input.disabled, false);
  for (const [shown, stored] of [['20', 20], ['', 0], ['0', 0]]) {
    h.change(capDescriptor, shown);
    await flush();
    assert.equal(h.calls.at(-1).autoApproveStreakCap, stored);
  }
  const before = h.calls.length;
  h.change(capDescriptor, '501');
  await flush();
  assert.equal(h.calls.length, before);
  assert.equal(h.row(capDescriptor).querySelector('.settings-field-error').textContent, 'Enter a whole number from 1 to 500.');
});


test('row standard: detail, sub and parent-off render through the row', (t) => {
  const dom = new JSDOM(binding.renderSettingRow(D.count, 6, { inventory, detail: 'Extra <detail>', sub: true, parentOff: true, rowClassName: 'settings-field--block' }));
  t.after(() => dom.window.close());
  const row = dom.window.document.querySelector('.settings-field');
  const detail = row.querySelector('.settings-field-detail');
  assert.equal(row.querySelectorAll('.settings-field-detail').length, 1);
  assert.equal(detail.dataset.tooltip, 'Extra <detail>');
  assert.equal(detail.getAttribute('aria-label'), 'More about Count');
  assert.ok(detail.classList.contains('inv-tooltip-pin'));
  assert.ok(row.classList.contains('settings-field--sub'));
  assert.ok(row.classList.contains('settings-field--block'));
  assert.equal(row.dataset.settingParentOff, 'true');
  assert.equal(row.querySelector('input').disabled, true);
  assert.ok([...row.querySelectorAll('[data-setting-preset], [data-setting-revert]')].every((el) => el.disabled));
  binding.setRowDisabled(dom.window.document.body, D.count, false);
  assert.equal(row.querySelector('input').hasAttribute('data-setting-unavailable'), true);
});

test('row standard: scaled number shows display units and saves stored units', async (t) => {
  const d = descriptors.defineSettingDescriptor({ id: 'scaledSeconds', sectionId: 'tools', adapterId: 'scaled', key: 'seconds', kind: 'integer', default: 3600,
    validation: { min: 60, max: 7200, step: 60 }, presentation: { scale: 60, unit: 'min', presets: [{ value: 5400, label: '90' }] }, copy: { label: 'Time', detail: 'Timing detail.' } });
  const h = harness({ descriptors: [d], normalize: (s) => ({ seconds: 3600, ...s }) });
  t.after(() => h.dispose());
  assert.equal(h.input(d).value, '60');
  assert.equal(h.input(d).min, '1');
  assert.equal(h.input(d).step, '1');
  assert.equal(h.row(d).querySelector('[data-setting-revert-slot]').innerHTML, '');
  assert.equal(h.row(d).querySelector('.settings-field-detail').dataset.tooltip, 'Timing detail.');
  h.change(d, '90');
  await flush();
  assert.equal(h.calls[0].seconds, 5400);
  assert.equal(h.row(d).querySelector('[data-setting-revert]').getAttribute('title'), 'Revert to 60 min');
  assert.equal(h.row(d).querySelector('.settings-field-meta-modified').hidden, false);
  assert.ok(h.row(d).querySelector('.settings-field-number > .settings-field-picks'));
  h.click('[data-setting-revert]');
  await flush();
  assert.equal(h.row(d).querySelector('[data-setting-revert-slot]').innerHTML, '');
  assert.equal(h.row(d).querySelector('.settings-field-meta-modified').hidden, true);
  h.click('[data-setting-preset-value="5400"]');
  await flush();
  assert.equal(h.calls.at(-1).seconds, 5400, 'picks stay in stored units');
});

test('row standard: either descriptor revert marks a shared row modified', (t) => {
  const html = inventory.settingsField({ id: 'shared', label: 'Shared', variant: 'row', metaHtml: binding.buildSettingMetaHtml(D.count, 4, { inventory }),
    controlHtml: '<span data-setting-revert-slot="bindTestCount"></span><span data-setting-revert-slot="bindTestMode"></span>' });
  const dom = new JSDOM('<body>' + html + '</body>');
  t.after(() => dom.window.close());
  const host = dom.window.document.body;
  const row = host.querySelector('.settings-field');
  binding.syncSettingRow(host, D.count, 6, { inventory });
  binding.syncSettingRow(host, D.mode, 'a', { inventory });
  assert.equal(row.dataset.modified, 'true');
  binding.syncSettingRow(host, D.mode, 'b', { inventory });
  binding.syncSettingRow(host, D.count, 4, { inventory });
  assert.equal(row.dataset.modified, 'true');
  assert.equal(row.querySelector('.settings-field-meta-modified').hidden, false);
  binding.syncSettingRow(host, D.mode, 'a', { inventory });
  assert.equal(row.hasAttribute('data-modified'), false);
  assert.equal(row.querySelector('.settings-field-meta-modified').hidden, true);
});

test('a stored value off the unit grid survives being shown and typed back', () => {
  const d = descriptors.defineSettingDescriptor({ id: 'scaledBytes', sectionId: 'tools', adapterId: 'scaled', key: 'bytes', kind: 'integer', default: 65536,
    validation: { min: 1024, max: 1048576 }, presentation: { scale: 1024, unit: 'KB' }, copy: { label: 'Size' } });
  const dom = new JSDOM('<body>' + binding.renderSettingRow(d, 65537, { inventory }) + '</body>');
  const input = dom.window.document.querySelector('#scaledBytes');
  const read = () => binding.readControlValue(d, { type: 'change', target: input }).value;
  assert.equal(input.value, '64.000977');
  assert.equal(read(), 65537, 'the rounded display is still the stored number');
  input.value = '64.5';
  assert.equal(read(), 66048);
  input.value = '64.0004';
  assert.ok(Number.isNaN(read()), 'a fraction of a byte is still refused');
  dom.window.close();
});

test('a background sync keeps the Revert a person has focused', () => {
  const dom = new JSDOM('<!doctype html><body><div data-setting-mount="bindTestMode"></div></body>');
  const mount = dom.window.document.querySelector('[data-setting-mount]');
  binding.mountSettingRow(mount, D.mode, 'b', { inventory });
  const revert = mount.querySelector('[data-setting-revert]');
  revert.focus();
  binding.mountSettingRow(mount, D.mode, 'b', { inventory });
  assert.equal(mount.querySelector('[data-setting-revert]'), revert, 'the same node survives a poll');
  assert.equal(dom.window.document.activeElement, revert);
  binding.mountSettingRow(mount, D.mode, 'a', { inventory });
  assert.equal(mount.querySelector('[data-setting-revert]'), null, 'it still leaves with the modification');
  dom.window.close();
});
