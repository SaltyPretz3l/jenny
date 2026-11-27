'use strict';

// new-test-file: the project box had no own file; concurrent wave owns the conversation tests.
// The Team approval card shows the exact change a write_file or edit_file asks for (row 175 F5, owner decision D10).

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const box = require('../renderer/team/renderer-team-project-box');

// The caret is built by the shared button primitive.
globalThis.inventory = { ...(globalThis.inventory || {}), actionButton: require('../renderer/inventory/action-button') };

const SHA = 'a'.repeat(64);
const EXACT = {
  schema_version: 1,
  fields: [{ name: 'file_path', text: 'notes/a.md' }, { name: 'content', text: 'hello\nworld' }],
  bytes: 40,
  sha256: SHA,
};
const BASE = { approval_id: 'approval_1', call_id: 'call_1', tool_name: 'write_file', summary: 'Write notes/a.md' };
const STATE = { role: 'writer', planMode: false, projectName: 'Plans', prompter: 'Ada', busy: false, note: '' };

function draw(entry, state = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const html = box.cardHtml(entry, { ...STATE, ...state });
    const holder = dom.window.document.createElement('div');
    holder.innerHTML = html;
    return holder;
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

test('a writer sees the exact fields and Allow once', () => {
  const card = draw({ ...BASE, exact_approval: EXACT });
  const fields = [...card.querySelectorAll('[data-approval-exact-field]')];
  assert.deepEqual(fields.map((el) => el.getAttribute('data-approval-exact-field')), ['file_path', 'content']);
  assert.match(fields[1].textContent, /hello\s*world/);
  assert.ok(card.querySelector('.tool-approve-btn[data-approval-scope="once"]'));
  assert.ok(card.querySelector('.tool-deny-btn'));
});

test('a reader sees the exact fields and no Allow or Deny', () => {
  const card = draw({ ...BASE, exact_approval: EXACT }, { role: 'reader' });
  assert.equal(card.querySelectorAll('[data-approval-exact-field]').length, 2);
  assert.equal(card.querySelector('.tool-approve-btn'), null);
  assert.equal(card.querySelector('.tool-deny-btn'), null);
  assert.equal(card.querySelector('.tool-approval-actions'), null);
});

test('a too-large presentation shows its note and withholds Allow', () => {
  const card = draw({ ...BASE, exact_approval: { schema_version: 1, too_large: true, bytes: 99999, limit_bytes: 32768 } });
  assert.equal(card.querySelectorAll('[data-approval-exact-field]').length, 0);
  assert.equal(card.querySelector('.tool-approve-btn'), null);
  assert.ok(card.querySelector('.tool-deny-btn'), 'Deny stays');
});

test('a write whose presentation is missing (null) fails closed: no Allow, Deny stays', () => {
  const card = draw({ ...BASE, exact_approval: null });
  assert.equal(card.querySelector('.tool-approve-btn'), null);
  assert.ok(card.querySelector('.tool-deny-btn'), 'Deny stays');
});

test('an older host sends no exact_approval: today\'s summary card stays, with Allow', () => {
  const card = draw(BASE);
  assert.equal(card.querySelectorAll('[data-approval-exact-field]').length, 0);
  assert.match(card.querySelector('.tool-approval-prompt').textContent, /Write notes\/a\.md/);
  assert.ok(card.querySelector('.tool-approve-btn[data-approval-scope="once"]'));
});

test('field text stays inert: markup is escaped', () => {
  const evil = { ...EXACT, fields: [{ name: 'content', text: '<img src=x onerror=alert(1)>' }] };
  const card = draw({ ...BASE, exact_approval: evil });
  assert.equal(card.querySelector('img'), null);
  assert.match(card.querySelector('[data-approval-exact-field]').textContent, /<img src=x onerror=alert\(1\)>/);
});

test('D1: an admin card has one Allow beside a caret, then Deny; the always choice and its note are in the caret menu', () => {
  const card = draw({ ...BASE, tool_name: 'edit_file', exact_approval: EXACT }, { role: 'admin' });
  const buttons = [...card.querySelectorAll('.tool-approval-actions button')];
  const caret = card.querySelector('.tool-approve-caret');
  assert.equal(buttons.filter((b) => b !== caret).length, 2, 'Allow and Deny');
  assert.equal(buttons.filter((b) => b === caret).length, 1, 'plus one caret');
  assert.equal(card.querySelector('.tool-approve-btn[data-approval-scope="once"]').textContent, 'Allow');
  assert.equal(card.querySelector('.tool-approve-split > .tool-approve-btn[data-approval-scope="once"] + .tool-approve-caret'), caret, 'the caret joins Allow');
  assert.equal(card.querySelector('[data-approval-scope="always"]'), null, 'no always button in the row');
  assert.equal(card.querySelector('.tool-approval-scope-note'), null, 'the note moved into the menu');
  assert.equal(caret.getAttribute('aria-label'), 'More ways to allow');
  assert.equal(caret.getAttribute('aria-haspopup'), 'menu');
  assert.equal(caret.getAttribute('aria-expanded'), 'false');
  assert.equal(caret.getAttribute('data-action'), 'more');
  assert.equal(caret.dataset.teamMore, 'rule');
  assert.equal(caret.dataset.teamMoreLabel, 'Always allow edits in this project');
  assert.match(caret.dataset.teamMoreNote, /^Always allow saves a rule for edit_file in this project, for everyone’s turns\./);
  assert.match(card.querySelector('.tool-approval-who').textContent, /Ada’s turn asked/);
});

test('D1: a writer card has the same shape; the menu item asks an admin', () => {
  const caret = draw({ ...BASE, tool_name: 'edit_file', exact_approval: EXACT }).querySelector('.tool-approve-caret');
  assert.equal(caret.dataset.teamMore, 'ask');
  assert.equal(caret.dataset.teamMoreLabel, 'Allow once and ask an admin for always');
  assert.match(caret.dataset.teamMoreNote, /^Ask for always lets the turn go on now/);
});

test('D1: no caret without an always choice (Plan mode, paused, a reader, another tool, the too-large card); the button still reads Allow', () => {
  const cases = [[{ ...BASE, exact_approval: EXACT }, { planMode: true }], [{ ...BASE, exact_approval: EXACT }, { paused: true }],
    [{ ...BASE, tool_name: 'run_command' }, {}], [{ ...BASE, exact_approval: EXACT }, { role: 'reader' }]];
  for (const [entry, state] of cases) {
    const card = draw(entry, state);
    assert.equal(card.querySelector('.tool-approve-caret'), null, JSON.stringify(state));
    assert.equal(card.querySelector('.tool-approve-split'), null);
    const once = card.querySelector('.tool-approve-btn[data-approval-scope="once"]');
    if (once) assert.equal(once.textContent, 'Allow');
  }
});

test('D1: a busy card greys the caret too', () => {
  const caret = draw({ ...BASE, tool_name: 'edit_file', exact_approval: EXACT }, { busy: true }).querySelector('.tool-approve-caret');
  assert.equal(caret.disabled, true);
});
