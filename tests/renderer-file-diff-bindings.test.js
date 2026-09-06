'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const actionButton = require('../renderer/inventory/action-button');
const view = require('../renderer/chat/renderer-file-diff-view');
const bindings = require('../renderer/chat/renderer-file-diff-bindings');

function mount(diffId, expanded = false) {
  const html = view.buildFileDiffMarkup({
    path: 'src/a.js', diffId, hunks: [{ oldStart: 1, newStart: 1, lines: ['+added'] }],
    expanded, actionButton,
  });
  const doc = new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
  return { doc, row: doc.querySelector('.file-diff'), toggle: doc.querySelector('[data-file-diff-toggle]') };
}

test.beforeEach(() => bindings.disposeFileDiffBindings());
test.after(() => bindings.disposeFileDiffBindings());

test('first expansion materializes only the body and remount state stays expanded', () => {
  const first = mount('diff:1');
  bindings.registerFileDiffContext({
    diffId: 'diff:1', sessionId: 'session-a',
    materialize: () => view.buildFileDiffBodyMarkup({ hunks: [{ oldStart: 1, newStart: 1, lines: ['+added'] }] }),
  });
  assert.equal(bindings.toggleFileDiff(first.toggle), true);
  assert.ok(first.row.querySelector('[data-file-diff-materialized] .diff-line'));
  assert.equal(bindings.getFileDiffExpanded('diff:1'), true);

  const remount = mount('diff:1', bindings.getFileDiffExpanded('diff:1'));
  assert.ok(remount.row.querySelector('.diff-line'));
  assert.equal(remount.row.dataset.expanded, 'true');
});

test('expansion overrides distinguish untouched defaults from explicit user choices', () => {
  bindings.registerFileDiffContext({
    diffId: 'default-open', sessionId: 'session-default', expanded: true, materialize: () => '',
  });
  assert.equal(bindings.getFileDiffExpansionOverride('default-open'), undefined);
  assert.equal(bindings.getFileDiffExpanded('default-open'), true);

  bindings.setFileDiffExpanded('default-open', false);
  assert.equal(bindings.getFileDiffExpansionOverride('default-open'), false);
  bindings.setFileDiffExpanded('default-open', true);
  assert.equal(bindings.getFileDiffExpansionOverride('default-open'), true);

  assert.equal(bindings.clearFileDiffSession('session-default'), 1);
  assert.equal(bindings.getFileDiffExpansionOverride('default-open'), undefined);
});

test('session cleanup is isolated and oldest entries evict first', () => {
  bindings.registerFileDiffContext({ diffId: 'a', sessionId: 'session-a', materialize: () => '' });
  bindings.registerFileDiffContext({ diffId: 'b', sessionId: 'session-b', materialize: () => '' });
  bindings.setFileDiffExpanded('a', true);
  bindings.setFileDiffExpanded('b', true);
  assert.equal(bindings.clearFileDiffSession('session-a'), 1);
  assert.equal(bindings.getFileDiffExpanded('a'), false);
  assert.equal(bindings.getFileDiffExpanded('b'), true);

  bindings.disposeFileDiffBindings();
  bindings.setFileDiffExpanded('oldest', true);
  for (let index = 0; index < bindings.MAX_ENTRIES; index += 1) {
    bindings.registerFileDiffContext({ diffId: `new-${index}`, sessionId: 's', materialize: () => '' });
  }
  assert.equal(bindings.getFileDiffExpanded('oldest'), false);
});

test('missing materialization context stays collapsed and warns once', () => {
  const { row, toggle } = mount('missing');
  const logs = [];
  const options = { appendClientLog: (...args) => logs.push(args) };
  assert.equal(bindings.toggleFileDiff(toggle, options), false);
  assert.equal(bindings.toggleFileDiff(toggle, options), false);
  assert.equal(row.dataset.expanded, 'false');
  assert.equal(row.querySelector('.file-diff-body').hidden, true);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'WARN');
  assert.equal(logs[0][1], 'chat.file_diff_materialization_skipped');
});
