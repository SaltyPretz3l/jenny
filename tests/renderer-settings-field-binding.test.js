'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ALL, D, JSDOM, binding, descriptors, flush, harness, inventory, normalize } = require('./helpers/settings-field-binding-harness');

test('renderSettingRow renders each kind through its inventory primitive with the meta line', (t) => {
  const h = harness({ initial: { count: 7, mode: 'b' } });
  t.after(() => h.dispose());
  const countRow = h.row(D.count);
  assert.ok(countRow.classList.contains('settings-field--row'));
  assert.equal(countRow.querySelector('.settings-field-title').textContent, 'Count');
  assert.equal(countRow.querySelector('.settings-field-help').textContent, 'How many.');
  assert.equal(countRow.querySelector('.settings-field-meta-default'), null);
  // The revert is the glyph alone; its tooltip and accessible name say the default.
  assert.equal(countRow.querySelector('[data-setting-revert]').textContent, '↺');
  assert.equal(countRow.querySelector('[data-setting-revert]').getAttribute('title'), 'Revert to 4 items');
  assert.ok(countRow.querySelector('.settings-field-title-row [data-setting-revert-slot]'), 'the revert sits on the title line');
  assert.equal(countRow.querySelector('.settings-field-meta-modified').textContent, 'Modified');
  assert.equal(countRow.querySelector('[data-setting-revert="bindTestCount"]').getAttribute('aria-label'), 'Revert Count to 4 items');
  assert.equal(h.input(D.count).value, '7');
  assert.equal(countRow.querySelectorAll('[data-setting-preset="bindTestCount"]').length, 2);
  assert.ok(h.host.querySelector('[data-inv-toggle="bindTestFlag"]'), 'boolean rows are the toggle itself');
  assert.equal(h.host.querySelector('[data-inv-toggle="bindTestFlag"]').getAttribute('aria-checked'), 'true');
  assert.equal(h.row(D.flag).querySelector('.settings-field-meta'), null, 'no meta for a boolean');
  const group = h.host.querySelector('[data-inv-segmented="bindTestMode"]');
  assert.ok(group, 'a 2-option enum is segmented');
  assert.equal(group.querySelector('[data-value="b"]').getAttribute('aria-checked'), 'true');
  assert.equal(h.row(D.mode).querySelector('[data-setting-revert]').getAttribute('title'), 'Revert to A');
  assert.equal(h.host.querySelector('[data-inv-toggle="bindTestGuardToggle"]'), null, 'optionalInteger has no toggle');
  assert.equal(h.input(D.guard).disabled, false, 'the empty number stays enabled');
  assert.equal(h.input(D.guard).value, '');
  assert.equal(h.input(D.name).tagName, 'INPUT');
});

test('a valid edit writes the normalized value, is acknowledged, and flips the meta line', async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  assert.equal(h.row(D.count).querySelector('.settings-field-meta-modified').hidden, true);
  h.change(D.count, '6');
  assert.equal(h.row(D.count).getAttribute('data-state'), 'busy');
  assert.equal(h.input(D.count).disabled, true, 'busy disables the control');
  assert.equal(h.host.querySelector('[data-setting-preset="bindTestCount"]').disabled, true, 'busy disables the presets');
  await flush();
  assert.deepEqual(h.calls, [normalize({ count: 6 })], 'object adapters write the whole object');
  assert.equal(h.registry.read(D.count), 6);
  assert.equal(h.row(D.count).getAttribute('data-state'), null);
  assert.equal(h.input(D.count).disabled, false);
  assert.equal(h.row(D.count).getAttribute('data-modified'), 'true');
  assert.equal(h.row(D.count).querySelector('.settings-field-meta-modified').textContent, 'Modified');
  assert.ok(h.row(D.count).querySelector('[data-setting-revert="bindTestCount"]'));
  assert.equal(h.host.querySelector('[data-setting-preset-value="8"]').getAttribute('aria-pressed'), 'false');
  h.click('[data-setting-preset-value="8"]');
  await flush();
  assert.equal(h.registry.read(D.count), 8);
  assert.equal(h.host.querySelector('[data-setting-preset-value="8"]').getAttribute('aria-pressed'), 'true');
  h.click('[data-setting-revert="bindTestCount"]');
  await flush();
  assert.equal(h.registry.read(D.count), 4, 'Revert writes the default through the same adapter');
  assert.equal(h.row(D.count).getAttribute('data-modified'), null);
  assert.equal(h.calls.length, 3);
});

test('an invalid edit is rejected with the field error and never written', async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  h.change(D.count, '11');
  await flush();
  assert.deepEqual(h.calls, []);
  assert.equal(h.row(D.count).getAttribute('data-state'), 'error');
  assert.equal(h.row(D.count).querySelector('.settings-field-error').textContent, 'Enter a whole number from 0 to 10.');
  assert.equal(h.input(D.count).value, '4', 'the control keeps the last acknowledged value');
  h.change(D.name, 'toolong');
  await flush();
  assert.equal(h.row(D.name).querySelector('.settings-field-error').textContent, 'Keep it under 5 characters.');
  assert.deepEqual(h.calls, []);
  h.change(D.count, '3');
  await flush();
  assert.equal(h.row(D.count).getAttribute('data-state'), null, 'a valid edit clears the error');
  assert.equal(h.registry.read(D.count), 3);
});

test('a failed write rolls the field back, shows the error inline and leaves the control enabled', async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  h.setMode('reject');
  h.change(D.count, '9');
  assert.equal(h.registry.read(D.count), 9, 'optimistic while in flight');
  await flush();
  assert.equal(h.registry.read(D.count), 4);
  assert.equal(h.input(D.count).value, '4');
  assert.equal(h.input(D.count).disabled, false);
  assert.equal(h.row(D.count).getAttribute('data-state'), 'error');
  assert.equal(h.row(D.count).querySelector('.settings-field-error').textContent, 'disk full');
  assert.deepEqual(h.errors.map((e) => e.message), ['disk full', 'disk full'], 'adapter.onError and the binding onError both hear it');
  assert.equal(h.errors[1].inline, true);

  h.setMode('undefined');
  h.change(D.count, '2');
  await flush();
  assert.equal(h.registry.read(D.count), 4, 'an undefined result is never success');
  h.setMode('throw');
  h.toggle('bindTestFlag', false);
  await flush();
  assert.equal(h.registry.read(D.flag), true, 'a missing bridge rejects and rolls back');
  assert.equal(h.host.querySelector('[data-inv-toggle="bindTestFlag"]').getAttribute('aria-checked'), 'true');
  assert.equal(h.errors[h.errors.length - 1].inline, true, 'a switch shows its reason under itself');
  h.setMode('mismatch');
  h.change(D.count, '5');
  await flush();
  assert.equal(h.registry.read(D.count), 4, 'an acknowledgement that differs is a failure');
});

test('decisive scenario: two fields of one object, one write fails, the other survives; older acks never win', async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  h.setMode('hold');
  h.change(D.count, '6');
  h.toggle('bindTestFlag', false);
  assert.equal(h.pendingWrites.length, 1, 'one write in flight; the second field waits');
  assert.equal(h.registry.read(D.count), 6);
  assert.equal(h.registry.read(D.flag), false, 'both show optimistically');
  h.pendingWrites[0].reject(new Error('count refused'));
  await flush();
  assert.equal(h.registry.read(D.count), 4, 'the failed field rolled back');
  assert.equal(h.registry.read(D.flag), false, 'the queued field kept its edit');
  assert.equal(h.pendingWrites.length, 2, 'and was written from the acknowledged baseline');
  assert.deepEqual(h.pendingWrites[1].payload, normalize({ count: 4, nested: { flag: false } }));
  h.pendingWrites[1].resolve(h.pendingWrites[1].payload);
  await flush();
  assert.equal(h.registry.read(D.flag), false);
  assert.equal(h.host.querySelector('[data-inv-toggle="bindTestFlag"]').getAttribute('aria-checked'), 'false');
  assert.equal(h.row(D.count).querySelector('.settings-field-error').textContent, 'count refused');

  // Generation fencing: a stale acknowledgement carrying an older value never
  // overwrites the newer request that is still queued behind it.
  h.change(D.count, '1');
  h.change(D.count, '2');
  assert.equal(h.pendingWrites.length, 3);
  h.pendingWrites[2].resolve(h.pendingWrites[2].payload);
  await flush();
  assert.equal(h.registry.read(D.count), 2, 'the newer request still shows');
  assert.equal(h.pendingWrites.length, 4);
  assert.equal(h.pendingWrites[3].payload.count, 2);
  h.pendingWrites[3].resolve(h.pendingWrites[3].payload);
  await flush();
  assert.equal(h.registry.read(D.count), 2);
  assert.equal(h.input(D.count).value, '2');
});

test('patch-mode adapters send only the batch keys and apply after acknowledgement when not optimistic', async (t) => {
  const h = harness({ mode: 'patch', optimistic: false });
  t.after(() => h.dispose());
  h.change(D.name, 'abc');
  assert.equal(h.state.store.name, '', 'nothing applied before the ack');
  assert.equal(h.registry.read(D.name), 'abc', 'the requested value is what the control shows meanwhile');
  assert.deepEqual(h.applied, []);
  await flush();
  assert.deepEqual(h.calls, [{ name: 'abc' }]);
  assert.equal(h.registry.read(D.name), 'abc');
  assert.deepEqual(h.applied, [['name']]);
});

test('optionalInteger: clearing writes Off and busy never lifts a restriction', async (t) => {
  const h = harness({ initial: { guard: 15 } });
  t.after(() => h.dispose());
  assert.equal(h.input(D.guard).value, '15');
  h.change(D.guard, '');
  await flush();
  assert.equal(h.registry.read(D.guard), 0);
  assert.equal(h.input(D.guard).disabled, false);
  assert.equal(h.input(D.guard).value, '');
  h.change(D.guard, '30');
  await flush();
  assert.equal(h.registry.read(D.guard), 30);
  binding.setRowDisabled(h.host, D.guard, true);
  binding.setRowBusy(h.host, D.guard, true, { inventory });
  binding.setRowBusy(h.host, D.guard, false, { inventory });
  assert.equal(h.input(D.guard).disabled, true);
});

test('a switch row dims and announces only what availability says, not the write lock', (t) => {
  const h = harness();
  t.after(() => h.dispose());
  const track = h.host.querySelector('[data-inv-toggle="bindTestFlag"]');
  const label = track.closest('label.inv-toggle');
  const shown = () => [track.disabled, track.getAttribute('aria-disabled'), label.getAttribute('aria-disabled'), label.classList.contains('inv-toggle--disabled')];
  binding.setRowDisabled(h.host, D.flag, true);
  assert.deepEqual(shown(), [true, 'true', 'true', true]);
  binding.setRowDisabled(h.host, D.flag, false);
  assert.deepEqual(shown(), [false, null, null, false]);
  binding.setRowBusy(h.host, D.flag, true, { inventory });
  binding.setRowDisabled(h.host, D.flag, false);
  assert.deepEqual(shown(), [true, null, null, false], 'a write in flight stays locked without the dimmed look');
});

test('readControlValue ignores events that belong to other controls', () => {
  const dom = new JSDOM('<body><input id="other"></body>');
  const target = dom.window.document.getElementById('other');
  assert.equal(binding.readControlValue(D.count, { type: 'change', target }), null);
  assert.equal(binding.readControlValue(D.flag, { type: 'inv-toggle-change', detail: { id: 'someoneElse', checked: true } }), null);
  assert.deepEqual(binding.readControlValue(D.mode, { type: 'inv-segmented-change', detail: { id: 'bindTestMode', value: 'b' } }), { value: 'b' });
  assert.deepEqual(binding.readControlValue(D.count, { type: 'change', target: { id: 'bindTestCount', value: ' 7 ' } }), { value: 7 });
  assert.ok(Number.isNaN(binding.readControlValue(D.count, { type: 'change', target: { id: 'bindTestCount', value: '7.5' } }).value));
  dom.window.close();
});

test('the registry rejects unregistered owners and malformed adapters', () => {
  const registry = binding.createSettingsAdapterRegistry();
  assert.throws(() => registry.read(D.count), /not registered/);
  assert.throws(() => registry.register({ id: 'x', read() {} }), /normalize/);
  assert.equal(binding.bindSettingFields({ container: null }), null);
});

test('busy survives an optimistic re-render and lifts only when the last write for the field settles', async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  // Sections that re-render their rows on apply (Notifications) replace the busy nodes.
  const render = () => { h.host.innerHTML = ALL.map((d) => binding.renderSettingRow(d, h.registry.read(d), { inventory })).join(''); };
  const adapter = h.registry.get('bindTest');
  const apply = adapter.apply;
  adapter.apply = (next, keys) => { apply(next, keys); render(); };
  h.setMode('hold');
  h.change(D.count, '6');
  assert.equal(h.input(D.count).disabled, true, 'busy again on the re-rendered node');
  assert.equal(h.input(D.count).hasAttribute('data-setting-busy'), true);
  h.change(D.count, '7');
  assert.equal(h.pendingWrites.length, 1, 'the second edit queues behind the first');
  h.pendingWrites[0].resolve(h.pendingWrites[0].payload);
  await flush();
  assert.equal(h.pendingWrites.length, 2);
  assert.equal(h.input(D.count).disabled, true, 'the queued write keeps the field busy');
  h.pendingWrites[1].resolve(h.pendingWrites[1].payload);
  await flush();
  assert.equal(h.input(D.count).disabled, false);
  assert.equal(h.input(D.count).value, '7');
});

test('a background sync leaves a focused input alone; a settled edit always reconciles it', async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  const input = h.input(D.count);
  input.focus();
  input.value = '9';
  binding.syncSettingRow(h.host, D.count, 4, { inventory });
  assert.equal(input.value, '9', 'typing in progress is never overwritten by a poll');
  binding.syncSettingRow(h.host, D.count, 4, { inventory, force: true });
  assert.equal(input.value, '4', 'a settled edit reconciles even while focused');
  h.setMode('reject');
  input.focus();
  h.change(D.count, '9');
  await flush();
  assert.equal(input.value, '4', 'a refused write rolls the focused field back to the acknowledged value');
  assert.equal(h.row(D.count).getAttribute('data-state'), 'error');
});

test('a re-render caused by another field\'s optimistic apply keeps every pending sibling busy', async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  const render = () => { h.host.innerHTML = ALL.map((d) => binding.renderSettingRow(d, h.registry.read(d), { inventory })).join(''); };
  const adapter = h.registry.get('bindTest');
  const apply = adapter.apply;
  adapter.apply = (next, keys) => { apply(next, keys); render(); };
  h.setMode('hold');
  h.change(D.count, '6');
  h.change(D.name, 'abc');
  assert.equal(h.pendingWrites.length, 1);
  assert.equal(h.input(D.count).disabled, true, 'the first field stays busy after the sibling re-rendered it');
  assert.equal(h.input(D.name).disabled, true);
  h.pendingWrites[0].resolve(h.pendingWrites[0].payload);
  await flush();
  assert.equal(h.input(D.count).disabled, false, 'settled');
  assert.equal(h.input(D.name).disabled, true, 'still in flight after the sibling settled and re-rendered');
  h.pendingWrites[1].resolve(h.pendingWrites[1].payload);
  await flush();
  assert.equal(h.input(D.name).disabled, false);
});

test('a refused segmented choice rolls back its selection and its tab stop', async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  const group = h.host.querySelector('[data-inv-segmented="bindTestMode"]');
  const option = (value) => group.querySelector(`[data-value="${value}"]`);
  h.setMode('reject');
  inventory.segmentedControl.select(group, 'b');
  assert.equal(option('b').getAttribute('aria-checked'), 'true', 'the click marks the option at once');
  await flush();
  assert.equal(option('a').getAttribute('aria-checked'), 'true');
  assert.equal(option('b').getAttribute('aria-checked'), 'false');
  assert.equal(option('a').getAttribute('tabindex'), '0', 'the tab stop returns with the selection');
  assert.equal(option('b').getAttribute('tabindex'), '-1');
  assert.equal(option('b').disabled, false, 'and the control is usable again');
});

test('a mounted row follows availability, and a settling write never lifts it', () => {
  const dom = new JSDOM('<!doctype html><body><div data-setting-mount="bindTestMode"></div></body>');
  const mount = dom.window.document.querySelector('[data-setting-mount]');
  const options = () => [...mount.querySelectorAll('.inv-segmented-option')];
  const group = () => mount.querySelector('[data-inv-segmented="bindTestMode"]');
  const revert = () => mount.querySelector('[data-setting-revert="bindTestMode"]');

  binding.mountSettingRow(mount, D.mode, 'b', { inventory, disabled: true });
  const first = group();
  assert.equal(first.getAttribute('aria-disabled'), 'true');
  assert.equal(first.classList.contains('inv-segmented--disabled'), false, 'dimmed once, by its disabled options');
  assert.ok(options().every((el) => el.disabled), 'no option can be chosen while unavailable');
  assert.equal(revert().disabled, true, 'Revert is unavailable too');

  binding.mountSettingRow(mount, D.mode, 'b', { inventory, disabled: false });
  assert.equal(group(), first, 'the row is patched in place');
  assert.equal(first.hasAttribute('aria-disabled'), false);
  assert.ok(options().every((el) => !el.disabled));
  assert.equal(revert().disabled, false);

  // A write in flight, then the section becomes unavailable before it settles.
  binding.setRowBusy(mount, D.mode, true, { inventory });
  binding.mountSettingRow(mount, D.mode, 'b', { inventory, disabled: true });
  binding.setRowBusy(mount, D.mode, false, { inventory });
  assert.ok(options().every((el) => el.disabled), 'the settle leaves the availability restriction in place');
  binding.mountSettingRow(mount, D.mode, 'b', { inventory, disabled: false });
  assert.ok(options().every((el) => !el.disabled));
  dom.window.close();
});

test('a Revert that appears while the row is locked is locked with it', () => {
  const dom = new JSDOM('<!doctype html><body><div data-setting-mount="bindTestMode"></div></body>');
  const mount = dom.window.document.querySelector('[data-setting-mount]');
  const revert = () => mount.querySelector('[data-setting-revert="bindTestMode"]');

  // Busy: a background render patches the meta line while the save is in flight.
  binding.mountSettingRow(mount, D.mode, 'a', { inventory });
  assert.equal(revert(), null, 'the default value has no Revert');
  binding.setRowBusy(mount, D.mode, true, { inventory });
  binding.mountSettingRow(mount, D.mode, 'b', { inventory });
  assert.equal(revert().disabled, true, 'busy covers the new Revert');
  binding.setRowBusy(mount, D.mode, false, { inventory });
  assert.equal(revert().disabled, false, 'and the settle releases it');

  // Rendered unavailable from the start.
  const html = binding.renderSettingRow(D.mode, 'b', { inventory, disabled: true });
  mount.innerHTML = html;
  assert.equal(revert().disabled, true, 'a row rendered disabled cannot be reverted');
  dom.window.close();
});

test('the control that had focus when its write began gets it back on settle, unless the person moved on', async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  h.setMode('hold');
  const input = h.input(D.count);
  // A browser drops focus from a control that becomes disabled; jsdom keeps it, so move it off by hand.
  const dropFocus = () => {
    const other = h.document.body.appendChild(h.document.createElement('button'));
    other.focus();
    other.blur();
    other.remove();
  };
  input.focus();
  h.change(D.count, '6');
  assert.equal(input.disabled, true);
  dropFocus();
  assert.equal(h.document.activeElement, h.document.body);
  h.pendingWrites[0].resolve(h.pendingWrites[0].payload);
  await flush();
  assert.equal(h.document.activeElement, input, 'focus returns to the edited control');

  input.focus();
  h.change(D.count, '7');
  dropFocus();
  h.input(D.name).focus();
  h.pendingWrites[1].resolve(h.pendingWrites[1].payload);
  await flush();
  assert.equal(h.document.activeElement, h.input(D.name), 'focus the person moved elsewhere is not taken back');
});

test('an arrow-key choice keeps focus on the chosen option across its save, and on the restored one after a refusal', async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  inventory.segmentedControl.initSegmentedHandlers(h.document);
  const group = h.host.querySelector('[data-inv-segmented="bindTestMode"]');
  const option = (value) => group.querySelector(`[data-value="${value}"]`);
  const arrow = (from, key) => from.dispatchEvent(new h.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const dropFocus = () => {
    const other = h.document.body.appendChild(h.document.createElement('button'));
    other.focus();
    other.blur();
    other.remove();
  };

  h.setMode('hold');
  option('a').focus();
  arrow(option('a'), 'ArrowRight');
  assert.equal(option('b').disabled, true, 'the row locks while the save is in flight');
  dropFocus();
  h.pendingWrites[0].resolve(h.pendingWrites[0].payload);
  await flush();
  assert.equal(option('b').getAttribute('aria-checked'), 'true');
  assert.equal(h.document.activeElement, option('b'), 'focus is on the chosen option, so the next arrow continues from it');

  h.setMode('reject');
  arrow(option('b'), 'ArrowLeft');
  await flush();
  assert.equal(option('b').getAttribute('aria-checked'), 'true', 'the refused choice rolled back');
  assert.equal(h.document.activeElement, option('b'), 'and focus went back with the selection');
});

test('focus comes back to the chosen option when the save repainted the row', async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  inventory.segmentedControl.initSegmentedHandlers(h.document);
  const option = (value) => h.host.querySelector(`[data-inv-segmented="bindTestMode"] [data-value="${value}"]`);
  h.setMode('hold');
  const first = option('a');
  first.focus();
  first.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  // A section that rebuilds its rows on apply: the focused node is gone.
  h.host.innerHTML = ALL.map((d) => binding.renderSettingRow(d, h.registry.read(d), { inventory })).join('');
  assert.equal(h.document.activeElement, h.document.body);
  h.pendingWrites[0].resolve(h.pendingWrites[0].payload);
  await flush();
  assert.notEqual(option('b'), null);
  assert.equal(h.document.activeElement, option('b'));
});


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
