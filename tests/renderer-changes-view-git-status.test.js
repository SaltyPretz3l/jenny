'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createChangesView } = require('../renderer/features/renderer-changes-view');

function change(path, overrides = {}) {
  return {
    changeId: `c-${path}`,
    turnId: 't1',
    toolCallId: 'call_1',
    toolName: 'edit_file',
    path,
    fileKey: `ws:${path}`,
    status: 'modified',
    callOutcome: 'succeeded',
    scripted: false,
    sensitive: false,
    afterHash: 'sha256:aa',
    hashKind: 'diff_input_text',
    hunks: [],
    ...overrides,
  };
}

function button(options) {
  const [name, value] = Object.entries(options.dataset || {})[0] || ['x', ''];
  return `<button data-${name}="${value}">${options.label}</button>`;
}

function setup(overrides = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="mount"></div></body>');
  const mountEl = dom.window.document.getElementById('mount');
  const opened = [];
  const view = createChangesView({
    host: 'dock',
    getSessionId: () => 's1',
    getTurnViewModels: () => [{ turnId: 't1', user: { content: 'First' }, toolCalls: [] }],
    buildLedger: () => ({ changes: [change('a.js'), change('b.js'), change('c.js')], notices: [] }),
    getTurnTime: () => 1000,
    formatTime: () => '2:41 PM',
    actionButton: button,
    renderDiffBody: () => '',
    openChangeDiff: (c) => { opened.push(c.path); return true; },
    ...overrides,
  });
  view.mount(mountEl);
  return { dom, mountEl, view, opened };
}

const rowFor = (mountEl, path) => Array.from(mountEl.querySelectorAll('.changes-history-file'))
  .find((el) => el.querySelector('.changes-history-path').textContent === path);

const gitAction = (mountEl) => mountEl.querySelector('[data-changes-open-git]');

test('without the git deps the rows carry no git markup', () => {
  const { mountEl } = setup();
  assert.equal(gitAction(mountEl), null);
  assert.doesNotMatch(mountEl.textContent, /Not committed yet|Committed|Open in Git/);
});

test('a changed file reads Not committed yet; a clean or unknown one says nothing about git', () => {
  // Git listing no entry also covers ignored, discarded and past-the-cap files, so "committed" is never claimed.
  const states = { 'a.js': 'changed', 'b.js': 'clean', 'c.js': null };
  const { mountEl } = setup({ getGitState: (path) => states[path], openInGit: () => {} });
  assert.match(rowFor(mountEl, 'a.js').textContent, /Not committed yet/);
  for (const path of ['b.js', 'c.js']) {
    assert.doesNotMatch(rowFor(mountEl, path).textContent, /ommitted/);
    assert.equal(rowFor(mountEl, path).querySelector('.changes-history-note'), null);
  }
});

test('Open in Git sits with the turn actions, outside the file listbox, and names the first uncommitted file', () => {
  const states = { 'a.js': 'clean', 'b.js': 'changed', 'c.js': 'changed' };
  const { mountEl } = setup({ getGitState: (path) => states[path], openInGit: () => {} });
  const open = gitAction(mountEl);
  assert.equal(open.textContent, 'Open in Git');
  assert.equal(open.getAttribute('data-changes-open-git'), 'b.js');
  assert.equal(open.closest('[role="option"]'), null, 'no control inside an option');
  assert.ok(open.closest('.changes-history-turn-head'), 'beside the turn title');
  assert.equal(mountEl.querySelectorAll('[data-changes-open-git]').length, 1);
});

test('Open in Git needs both an uncommitted file and the openInGit dep', () => {
  assert.equal(gitAction(setup({ getGitState: () => 'clean', openInGit: () => {} }).mountEl), null);
  const noDep = setup({ getGitState: () => 'changed' }).mountEl;
  assert.equal(gitAction(noDep), null);
  assert.match(rowFor(noDep, 'a.js').textContent, /Not committed yet/, 'the note still shows');
});

test('git notes share the file note markup and sit beside the existing note', () => {
  const { mountEl } = setup({
    buildLedger: () => ({ changes: [change('a.js', { status: 'created' })], notices: [] }),
    getGitState: () => 'changed',
  });
  const notes = Array.from(rowFor(mountEl, 'a.js').querySelectorAll('.changes-history-note')).map((el) => el.textContent);
  assert.deepEqual(notes, ['new', 'Not committed yet']);
});

test('an undone file shows no git note and is never the Open in Git target', () => {
  const undoController = {
    canUndoTurn: () => true,
    getUndoStates: () => ({ t1: { status: 'applied', files: { 'a.js': 'undone' } } }),
  };
  const { mountEl } = setup({ undoController, getGitState: () => 'changed', openInGit: () => {} });
  const undone = rowFor(mountEl, 'a.js');
  assert.match(undone.textContent, /undone/);
  assert.doesNotMatch(undone.textContent, /Not committed yet/);
  assert.equal(gitAction(mountEl).getAttribute('data-changes-open-git'), 'b.js');
});

test('clicking Open in Git calls openInGit with the path and does not open a diff', () => {
  const calls = [];
  const { dom, mountEl, opened } = setup({ getGitState: () => 'changed', openInGit: (path) => calls.push(path) });
  gitAction(mountEl).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(calls, ['a.js']);
  assert.deepEqual(opened, []);
  assert.equal(mountEl.querySelector('[aria-selected="true"]'), null);
});

test('a subscribeGit notification re-renders with the new state; unmount and dispose unsubscribe', () => {
  let state = 'changed';
  const listeners = new Set();
  let unsubscribed = 0;
  const { mountEl, view } = setup({
    getGitState: () => state,
    openInGit: () => {},
    subscribeGit: (listener) => {
      listeners.add(listener);
      return () => { unsubscribed += 1; listeners.delete(listener); };
    },
  });
  assert.equal(listeners.size, 1);
  assert.match(rowFor(mountEl, 'a.js').textContent, /Not committed yet/);
  state = 'clean';
  for (const listener of listeners) listener();
  assert.doesNotMatch(rowFor(mountEl, 'a.js').textContent, /Not committed yet/);
  assert.equal(gitAction(mountEl), null);
  view.mount(mountEl);
  assert.equal(listeners.size, 1, 'mounting the same element again does not subscribe twice');
  view.unmount();
  assert.equal(unsubscribed, 1);
  assert.equal(listeners.size, 0);
  view.mount(mountEl);
  assert.equal(listeners.size, 1, 'a remount subscribes again');
  view.dispose();
  assert.equal(unsubscribed, 2, 'dispose releases the subscription');
  assert.equal(listeners.size, 0);
});

test('the turn action reads Undo Jenny\'s change…', () => {
  const undoController = { canUndoTurn: () => true, getUndoStates: () => ({}) };
  const { mountEl } = setup({ undoController });
  assert.equal(mountEl.querySelector('[data-changes-undo="t1"]').textContent, 'Undo Jenny\'s change…');
});
