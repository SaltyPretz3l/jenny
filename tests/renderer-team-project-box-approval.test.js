'use strict';

// new-test-file: the project box had no own file; concurrent wave owns the conversation tests.
// The Team approval card shows the exact change a write_file or edit_file asks for (row 175 F5, owner decision D10).

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const box = require('../renderer/team/renderer-team-project-box');

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
