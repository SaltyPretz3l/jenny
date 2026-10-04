'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ALL, D, binding, flush, harness, inventory } = require('./helpers/settings-field-binding-harness');

// The reason a failed save shows where the change was made: when it counts as
// shown, how it survives a repaint, and when its painter is torn down.

test('a switch that could not be saved shows the reason under it until its next edit, across a repaint', async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  const track = () => h.host.querySelector('[data-inv-toggle="bindTestFlag"]');
  const line = () => h.row(D.flag).querySelector('.settings-field-error');
  h.setMode('reject');
  h.toggle('bindTestFlag', false);
  await flush();
  assert.equal(track().getAttribute('aria-checked'), 'true', 'the switch flips back');
  assert.equal(line().textContent, 'disk full');
  assert.equal(line().hidden, false);
  assert.equal(line().getAttribute('role'), 'alert', 'the reason is announced');
  assert.equal(h.host.querySelector('.inv-toggle-error'), null, 'the reason appears only on the row');
  assert.deepEqual(h.errors.filter((entry) => entry.field === 'bindTestFlag'), [{ field: 'bindTestFlag', message: 'disk full', inline: true }],
    'the handler is told the reason is on the page');

  // The section rebuilds its rows (every Settings render does): the reason is still there.
  h.host.innerHTML = ALL.map((d) => binding.renderSettingRow(d, h.registry.read(d), { inventory })).join('');
  await flush();
  assert.equal(line().textContent, 'disk full');

  h.setMode('ok');
  h.toggle('bindTestFlag', false);
  await flush();
  assert.equal(line().hidden, true, 'a saved edit clears it');
  h.host.innerHTML = ALL.map((d) => binding.renderSettingRow(d, h.registry.read(d), { inventory })).join('');
  await flush();
  assert.equal(line().hidden, true);
});

test('a reason inside a closed disclosure does not count as shown, so the handler still reports it', async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  const fold = h.document.createElement('details');
  fold.innerHTML = '<summary>More</summary>';
  [...h.host.children].forEach((child) => fold.appendChild(child));
  h.host.appendChild(fold);
  h.setMode('reject');
  h.change(D.count, '9');
  await flush();
  assert.equal(h.row(D.count).querySelector('.settings-field-error').textContent, 'disk full', 'the reason is on the row');
  assert.equal(h.errors.at(-1).inline, false, 'but nobody can see it while the disclosure is closed');
  h.toggle('bindTestFlag', false);
  await flush();
  assert.equal(h.errors.at(-1).inline, false, 'the same for a switch');

  fold.open = true;
  h.change(D.count, '8');
  await flush();
  assert.equal(h.errors.at(-1).inline, true, 'open, the row reason is on screen');
});

test('a reason with stray whitespace is painted once: a repaint settles instead of rewriting forever', async (t) => {
  let writes = 0;
  const realField = inventory.settingsField;
  const counted = Object.assign((opts) => realField(opts), realField, {
    setFieldError(row, message) {
      writes += 1;
      if (writes > 12) throw new Error('setFieldError is being rewritten in a loop');
      return realField.setFieldError(row, message);
    },
  });
  const h = harness({ inventory: { ...inventory, settingsField: counted } });
  t.after(() => h.dispose());
  h.setMode('reject');
  h.setRejectMessage('  disk full  ');
  h.change(D.count, '9');
  await flush();
  assert.equal(h.row(D.count).querySelector('.settings-field-error').textContent, 'disk full');
  const before = writes;
  h.render();
  await flush();
  await flush();
  assert.equal(h.row(D.count).querySelector('.settings-field-error').textContent, 'disk full', 'the repaint puts the reason back');
  assert.ok(writes - before <= 2, `the repaint wrote the reason ${writes - before} time(s)`);

  h.setRejectMessage('   ');
  h.change(D.count, '8');
  await flush();
  assert.notEqual(h.row(D.count).querySelector('.settings-field-error').textContent, '', 'a blank reason still says something');
  assert.equal(h.row(D.count).getAttribute('data-state'), 'error');
});

test('a rebind takes over: the replaced binding\'s reason is dropped and never painted again', async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  const line = () => h.row(D.flag).querySelector('.settings-field-error');
  h.setMode('reject');
  h.toggle('bindTestFlag', false);
  await flush();
  assert.equal(line().textContent, 'disk full');

  h.rebind();
  assert.equal(line().hidden, true, 'the old reason leaves with the binding that showed it');
  h.setMode('ok');
  h.toggle('bindTestFlag', false);
  await flush();
  h.render();
  await flush();
  assert.equal(line().hidden, true, 'the replaced binding does not repaint its reason onto the saved switch');

  // A second failure under the new binding shows once and stays put.
  h.setMode('reject');
  h.setRejectMessage('second failure');
  h.toggle('bindTestFlag', true);
  await flush();
  h.render();
  await flush();
  assert.equal(line().textContent, 'second failure');
});

test('an aborted binding stops painting, and a write that settles afterwards is reported, not painted', async (t) => {
  const h = harness({ signal: true });
  t.after(() => h.dispose());
  const slot = () => h.row(D.count).querySelector('.settings-field-error');
  h.setMode('reject');
  h.change(D.count, '9');
  await flush();
  assert.equal(slot().textContent, 'disk full');

  h.setMode('hold');
  void h.controller.commit(D.count, 7);
  h.abort();
  assert.equal(slot().hidden, true, 'abort clears what the binding painted');
  h.render();
  await flush();
  assert.equal(slot().hidden, true, 'and it does not come back on a repaint');
  h.pendingWrites[0].reject(new Error('late failure'));
  await flush();
  assert.equal(slot().hidden, true, 'a late failure is not painted by a disposed binding');
  assert.deepEqual(h.errors.at(-1), { field: 'bindTestCount', message: 'late failure', inline: false }, 'it is still reported');
});
