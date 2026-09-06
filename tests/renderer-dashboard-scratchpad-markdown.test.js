'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const md = require('../renderer/features/renderer-dashboard-scratchpad-markdown.js');
const actionButton = require('../renderer/inventory/action-button.js');
const textField = require('../renderer/inventory/text-field.js');

const renderDeps = { actionButton, escapeHtml: textField.escapeHtml };

test('parseLines classifies checklist, heading, bullet, blank, and text lines', () => {
  const items = md.parseLines('# Title\n- [ ] todo\n- [x] done\n- plain bullet\n\nhello');
  assert.deepEqual(items.map((i) => i.type), ['heading', 'check', 'check', 'bullet', 'blank', 'text']);
  assert.equal(items[0].level, 1);
  assert.equal(items[1].checked, false);
  assert.equal(items[1].label, 'todo');
  assert.equal(items[2].checked, true);
  assert.equal(items[2].label, 'done');
  assert.equal(items[3].text, 'plain bullet');
  assert.equal(items[5].text, 'hello');
  // Each line remembers its source index so a toggle can target it exactly.
  assert.deepEqual(items.map((i) => i.lineIndex), [0, 1, 2, 3, 4, 5]);
});

test('parseLines accepts uppercase [X] as checked', () => {
  assert.equal(md.parseLines('- [X] done')[0].checked, true);
});

test('toggleChecklistLine flips only the targeted line and preserves the rest byte-for-byte', () => {
  const text = 'intro\n- [ ] a\n- [x] b\noutro';
  assert.equal(md.toggleChecklistLine(text, 1), 'intro\n- [x] a\n- [x] b\noutro');
  assert.equal(md.toggleChecklistLine(text, 2), 'intro\n- [ ] a\n- [ ] b\noutro');
});

test('toggleChecklistLine is a no-op on a non-checklist line or out-of-range index', () => {
  const text = 'plain\n- [ ] a';
  assert.equal(md.toggleChecklistLine(text, 0), text); // not a checklist line
  assert.equal(md.toggleChecklistLine(text, 9), text); // out of range
  assert.equal(md.toggleChecklistLine(text, -1), text);
  assert.equal(md.toggleChecklistLine(text, 'x'), text);
});

test('toggleChecklistLine preserves the * bullet style and indentation', () => {
  assert.equal(md.toggleChecklistLine('  * [ ] x', 0), '  * [x] x');
});

test('toggleChecklistLine keeps an empty-label checklist line valid', () => {
  assert.equal(md.toggleChecklistLine('- [ ] ', 0), '- [x]');
  assert.equal(md.toggleChecklistLine('- [x]', 0), '- [ ]');
});

test('renderPreviewHtml escapes injected HTML so a payload renders inert (no live element)', () => {
  const html = md.renderPreviewHtml('- [ ] <img src=x onerror=alert(1)>\n<script>boom</script>', renderDeps);
  assert.ok(!/<img/i.test(html), 'no live <img> element');
  assert.ok(!/<script>/i.test(html), 'no live <script> element');
  assert.ok(/&lt;img/i.test(html), 'the payload survives only as escaped text');
  assert.ok(/&lt;script&gt;/i.test(html), 'the script tag survives only as escaped text');
});

test('renderPreviewHtml emits a checkbox button carrying its source lineIndex + state', () => {
  const html = md.renderPreviewHtml('first\n- [x] done', renderDeps);
  assert.match(html, /data-scratchpad-check="1"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /title="Mark done not done"/);
  assert.match(html, /☑/);
});

test('renderPreviewHtml shows an empty-state for a blank note', () => {
  assert.match(md.renderPreviewHtml('\n\n', renderDeps), /Nothing to preview/);
});

test('renderPreviewHtml degrades to inert escaped text when no action-button is injected', () => {
  const html = md.renderPreviewHtml('- [ ] <b>x</b>', { escapeHtml: textField.escapeHtml });
  assert.ok(!/<button/i.test(html), 'no raw button when the primitive is missing');
  assert.ok(/&lt;b&gt;/i.test(html), 'label still escaped');
});
