'use strict';

// new-test-file: renderer-approval-block.test.js sits at 594 lines, so these cases would push it past the 600-line cap.
// The computer tool's approval card (row 196, C2): written from the app's own reading of the program
// grant, never from the model's input, one-off only, and decided alone. A request whose details did not
// arrive intact has no Allow button.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { escapeHtml } = require('../renderer/shared/string-utils');
const { renderApprovalBlock } = require('../renderer/chat/renderer-approval-block');

const grant = (extra = {}) => ({ schema_version: 1, kind: 'grant', program_name: 'Notepad', program_path: 'C:\\Windows\\notepad.exe', view_only: false, ...extra });

function render(computerApproval, extra = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>');
  const root = dom.window.document.getElementById('root');
  root.innerHTML = renderApprovalBlock({
    toolCallId: 'call_1', approvalId: 'approval_1', toolName: 'computer', displayToolName: 'computer', mode: 'inline', computerApproval, ...extra,
  }, { escapeHtml });
  return root;
}

const text = (root, selector) => root.querySelector(selector)?.textContent ?? null;
const facts = (root) => [...root.querySelectorAll('.tool-approval-fact')].map((node) => node.textContent);

const VIEW = 'View only: Jenny can see this window but cannot click or type in it.';
const CASES = [
  ['open, control', { kind: 'open' }, 'Start Notepad and let Jenny use it in this chat?',
    'Jenny will start this program, see its window, and click and type in it until the chat ends.', ['Computer', 'Starts a program', 'Until the chat ends'], 'Allow in this chat'],
  ['open, view only', { kind: 'open', view_only: true }, 'Start Notepad and let Jenny see it in this chat?',
    VIEW, ['Computer', 'Starts a program', 'View only'], 'Allow viewing'],
  ['grant, control', { kind: 'grant' }, 'Let Jenny use Notepad in this chat?',
    "Jenny will see this program's window, and click and type in it until the chat ends.", ['Computer', 'Until the chat ends'], 'Allow in this chat'],
  ['grant, view only', { kind: 'grant', view_only: true }, 'Let Jenny see Notepad in this chat?',
    VIEW, ['Computer', 'View only', 'Until the chat ends'], 'Allow viewing'],
  ['file dialog', { kind: 'file_dialog' }, 'Let Jenny use the Open and Save dialog in Notepad?',
    'From that dialog Jenny can open or save any file Notepad can reach. Jenny asks once for each program in this chat.', ['Computer', 'File dialog', 'Until the chat ends'], 'Allow in this chat'],
];

for (const [label, extra, prompt, consequence, chips, allow] of CASES) {
  test(`computer card: ${label}`, () => {
    const root = render(grant(extra), { purpose: 'Open the notes', reason: 'the model says so', facts: [{ kind: 'x', label: 'Raw input fact' }] });
    assert.equal(text(root, '.tool-approval-prompt'), prompt);
    assert.equal(root.querySelector('.tool-approval-prompt').getAttribute('data-approval-intent'), 'derived');
    assert.equal(text(root, '.tool-approval-consequence'), consequence);
    assert.deepEqual(facts(root), chips);
    assert.equal(text(root, '.tool-approval-command'), 'C:\\Windows\\notepad.exe');
    const allowButton = root.querySelector('[data-approval-scope="once"]');
    assert.equal(allowButton.textContent, allow);
    assert.equal(allowButton.getAttribute('title'), allow);
    assert.equal(allowButton.getAttribute('aria-label'), allow);
    assert.ok(root.querySelector('[data-action="deny"]'));
    assert.equal(root.querySelector('[data-approval-scope="always"]'), null);
    assert.equal(root.querySelector('.tool-approval-intent-source'), null);
    assert.equal(root.querySelector('.approval-gap-row').getAttribute('data-approval-exact'), 'true');
  });
}

test('computer card: the program name and path are escaped', () => {
  const root = render(grant({ program_name: '<b>Evil</b>', program_path: 'C:\\<img src=x>\\a.exe' }));
  assert.equal(text(root, '.tool-approval-prompt'), 'Let Jenny use <b>Evil</b> in this chat?');
  assert.equal(root.querySelector('b'), null);
  assert.equal(root.querySelector('img'), null);
  assert.equal(text(root, '.tool-approval-command'), 'C:\\<img src=x>\\a.exe');
});

const INVALID = [
  ['no payload', undefined],
  ['wrong schema version', grant({ schema_version: 2 })],
  ['unknown kind', grant({ kind: 'drag' })],
  ['control character in the name', grant({ program_name: 'Note\u0007pad' })],
  ['bidi control in the name', grant({ program_name: 'Note\u202Epad' })],
  ['empty name', grant({ program_name: '' })],
  ['name over 120 characters', grant({ program_name: 'a'.repeat(121) })],
  ['path over 512 characters', grant({ program_path: 'C:\\' + 'a'.repeat(510) })],
  ['empty path', grant({ program_path: '' })],
  ['view_only not a boolean', grant({ view_only: 'false' })],
  ['file dialog with view_only true', grant({ kind: 'file_dialog', view_only: true })],
  ['an array', []],
];

for (const [label, value] of INVALID) {
  test(`computer card withholds Allow: ${label}`, () => {
    const root = render(value, { purpose: 'Open the notes', commandText: '{"action":"click"}' });
    assert.equal(root.querySelector('.tool-approve-btn'), null);
    assert.equal(root.querySelector('[data-approval-scope]'), null);
    assert.ok(root.querySelector('[data-action="deny"]'));
    assert.equal(text(root, '[data-approval-computer-unavailable]'), "The details of this step can't be shown, so it can't be approved. Deny it.");
    assert.equal(root.querySelector('.tool-approval-command'), null);
    assert.notEqual(text(root, '.tool-approval-prompt'), 'Open the notes');
  });
}

test('computer card accepts the bounds exactly', () => {
  const root = render(grant({ program_name: 'a'.repeat(120), program_path: 'C:\\' + 'a'.repeat(509) }));
  assert.ok(root.querySelector('[data-approval-scope="once"]'));
});

test('another tool keeps its generic card', () => {
  const root = render(grant(), { toolName: 'read_file', displayToolName: 'read_file', prompt: 'Approve read?' });
  assert.equal(text(root, '.tool-approval-prompt'), 'Approve read?');
  assert.ok(root.querySelector('[data-approval-scope="always"]'));
});
