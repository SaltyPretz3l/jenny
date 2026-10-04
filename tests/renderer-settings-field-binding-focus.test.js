'use strict';

// Keyboard focus and screen-reader wiring of the bound Settings rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const { D, JSDOM, binding, descriptors, flush, harness, inventory } = require('./helpers/settings-field-binding-harness');

test('a Revert hands focus to the control it reset, and a quick pick keeps it across a repaint', async (t) => {
  const h = harness({ initial: { count: 7 } });
  t.after(() => h.dispose());
  h.host.querySelector('[data-setting-revert="bindTestCount"]').focus();
  h.click('[data-setting-revert="bindTestCount"]');
  await flush();
  assert.equal(h.registry.read(D.count), 4);
  assert.equal(h.row(D.count).querySelector('[data-setting-revert]'), null, 'the Revert left with the modification');
  assert.equal(h.document.activeElement, h.input(D.count));

  h.setMode('hold');
  h.host.querySelector('[data-setting-preset-value="8"]').focus();
  h.click('[data-setting-preset-value="8"]');
  // The section repaints its rows while the write is in flight, so the focused pick is replaced.
  h.render();
  assert.equal(h.document.activeElement, h.document.body);
  h.pendingWrites[0].resolve(h.pendingWrites[0].payload);
  await flush();
  const active = h.document.activeElement;
  assert.equal(active.getAttribute('data-setting-preset'), 'bindTestCount');
  assert.equal(active.getAttribute('data-setting-preset-value'), '8');
});

test('a refused value typed in the focused field is replaced by the acknowledged value', async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  h.input(D.count).focus();
  h.change(D.count, '11');
  await flush();
  assert.deepEqual(h.calls, []);
  assert.equal(h.row(D.count).querySelector('.settings-field-error').textContent, 'Enter a whole number from 0 to 10.');
  assert.equal(h.document.activeElement, h.input(D.count));
  assert.equal(h.input(D.count).value, '4');
});

test('number, select, segmented and text rows link their help text; single controls are labelled by the title', (t) => {
  const dom = new JSDOM('<!doctype html><body></body>');
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const rows = ['autoApproveStreakCapInput', 'contextHistoryScopeSelect', 'safetyModeSelect', 'webSearchSearxngUrlField'].map((id) => descriptors.getSettingDescriptor(id));
  doc.body.innerHTML = rows.map((d) => binding.renderSettingRow(d, d.default, { inventory })).join('');
  assert.deepEqual(rows.map((d) => d.control), ['optionalNumber', 'select', 'segmented', 'text']);
  for (const d of rows) {
    const control = doc.getElementById(d.controlId) || doc.querySelector(`[data-inv-segmented="${d.controlId}"]`);
    const help = doc.getElementById(control.getAttribute('aria-describedby'));
    assert.equal(help && help.textContent, binding.resolveSettingCopy(d).description, d.id);
    const title = control.closest('.settings-field').querySelector('.settings-field-title');
    // A segmented group has no single element for a label to point at; it carries its own name.
    assert.equal(title.tagName, d.control === 'segmented' ? 'SPAN' : 'LABEL', d.id);
    if (d.control !== 'segmented') assert.equal(title.htmlFor, d.controlId, d.id);
  }
  assert.match(doc.getElementById('autoApproveStreakCapInputDescription').textContent, /Empty means no limit/);
});

test('clicking a bound number row title writes nothing', async (t) => {
  const h = harness();
  t.after(() => h.dispose());
  h.row(D.count).querySelector('.settings-field-title').click();
  await flush();
  assert.deepEqual(h.calls, []);
  assert.equal(h.input(D.count).value, '4');
});
