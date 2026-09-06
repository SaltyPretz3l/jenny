'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const actionButton = require('../renderer/inventory/action-button');
const { buildFileDiffMarkup, buildFileDiffBodyMarkup } = require('../renderer/chat/renderer-file-diff-view');
const { renderDiffHunks } = require('../renderer/chat/renderer-diff-hunks-render');

const hunks = [{ oldStart: 47, oldLines: 3, newStart: 47, newLines: 4, lines: ['', ' context', '-old', '+new'] }];

function parse(html) {
  return new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
}

test('collapsed file diffs contain no line nodes and expose accessible controls', () => {
  const doc = parse(buildFileDiffMarkup({
    path: 'src/deep/example.js', diffId: 'diff:1', changeId: 'change:1', hunks,
    additions: 1, deletions: 1, languageId: 'javascript', languageDot: '#EF9F27', actionButton,
  }));
  assert.equal(doc.querySelectorAll('.diff-line').length, 0);
  assert.ok(doc.querySelector('[data-file-diff-pending]'));
  assert.equal(doc.querySelector('.file-diff-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(doc.querySelector('.file-diff-body').getAttribute('role'), 'list');
  assert.equal(doc.querySelector('.file-diff-count-remove').textContent, '−1');
  assert.equal(doc.querySelector('.file-diff-directory').textContent, 'src/deep/');
  assert.equal(doc.querySelector('.file-diff-basename').textContent, 'example.js');
  assert.equal(doc.querySelector('.file-diff-open').dataset.changeId, 'change:1');
});

test('expanded body uses one gutter, list semantics, bounded aria, and advances empty context lines', () => {
  const doc = parse(buildFileDiffBodyMarkup({ hunks, languageId: 'javascript' }));
  const rows = [...doc.querySelectorAll('.diff-line')];
  assert.equal(rows.length, 4);
  assert.equal(rows[0].classList.contains('diff-line-context'), true);
  assert.equal(rows[0].querySelector('.diff-gutter').textContent, '47');
  assert.equal(rows[1].querySelector('.diff-gutter').textContent, '48');
  assert.equal(rows[2].querySelector('.diff-gutter').textContent, '49');
  assert.equal(rows[3].querySelector('.diff-gutter').textContent, '49');
  assert.equal(rows[2].getAttribute('role'), 'listitem');
  assert.match(rows[2].getAttribute('aria-label'), /^Removed line 49:/);
  assert.match(rows[3].getAttribute('aria-label'), /^Added line 49:/);
  assert.equal(rows[0].hasAttribute('aria-label'), false);
  assert.equal(rows[0].querySelectorAll('.diff-gutter').length, 1);
});

test('counts omit when unknown, truncation replaces counts, and malformed ids remain escaped', () => {
  const contextOnly = buildFileDiffMarkup({ path: 'a.txt', diffId: 'safe', hunks: [{ oldStart: 1, newStart: 1, lines: [' only'] }], actionButton });
  assert.equal(parse(contextOnly).querySelector('.file-diff-counts'), null);
  const truncated = parse(buildFileDiffMarkup({
    path: 'x<y.py', diffId: 'diff<script>', changeId: 'change:1', truncated: true,
    additions: 9, deletions: 2, hunks, actionButton,
  }));
  assert.equal(truncated.querySelector('.file-diff-counts'), null);
  assert.equal(truncated.querySelector('.file-diff-truncated').textContent, 'too large to show inline');
  assert.equal(truncated.querySelector('.file-diff-chevron'), null);
  assert.equal(truncated.querySelector('.file-diff-basename').textContent, 'x<y.py');
});

test('valid maximum-length diff ids keep distinct aria control targets', () => {
  const prefix = 'x'.repeat(199);
  const first = parse(buildFileDiffMarkup({
    path: 'a.js', diffId: `${prefix}a`, hunks, actionButton,
  }));
  const second = parse(buildFileDiffMarkup({
    path: 'b.js', diffId: `${prefix}b`, hunks, actionButton,
  }));
  const firstControl = first.querySelector('.file-diff-toggle').getAttribute('aria-controls');
  const secondControl = second.querySelector('.file-diff-toggle').getAttribute('aria-controls');
  assert.notEqual(firstControl, secondControl);
  assert.equal(firstControl, first.querySelector('.file-diff-body').id);
  assert.equal(secondControl, second.querySelector('.file-diff-body').id);
});

test('legacy artifact hunk renderer also advances after an empty context line', () => {
  const doc = parse(renderDiffHunks(hunks, (value) => String(value)));
  const rows = [...doc.querySelectorAll('.diff-line')];
  assert.equal(rows[0].classList.contains('diff-line-context'), true);
  assert.equal(rows[1].querySelector('.diff-gutter-new').textContent, '48');
});
