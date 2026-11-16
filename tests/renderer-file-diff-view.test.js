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
  assert.equal(truncated.querySelector('.file-diff-truncated').textContent, 'not shown', 'no reason given: the plain fallback');
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
  const doc = parse(renderDiffHunks(hunks, (value) => String(value), { languageId: 'javascript' }));
  const rows = [...doc.querySelectorAll('.diff-line')];
  assert.equal(rows[0].classList.contains('diff-line-context'), true);
  assert.equal(rows[1].querySelector('.diff-gutter-new').textContent, '48');
  for (const content of doc.querySelectorAll('.diff-content')) {
    assert.equal(content.hasAttribute('data-code-highlight-line'), true);
    assert.equal(content.dataset.languageId, 'javascript');
  }

  const derived = parse(renderDiffHunks([{ ...hunks[0], path: 'src/example.ts' }], (value) => String(value)));
  assert.equal(derived.querySelector('.diff-content').dataset.languageId, 'typescript');
});

// Row 59 checkpoint 2 opt-ins (the working-tree Changes page): default markup is covered above and must not move.
test('stacked layout strips the folder slash and tags the row; the default markup keeps it', () => {
  const stacked = parse(buildFileDiffMarkup({ path: 'src/deep/example.js', diffId: 'd1', stacked: true, hunks, actionButton }));
  assert.ok(stacked.querySelector('.file-diff').classList.contains('file-diff--stacked'));
  assert.equal(stacked.querySelector('.file-diff-directory').textContent, 'src/deep');
  assert.equal(stacked.querySelector('.file-diff-basename').textContent, 'example.js');
  const plain = parse(buildFileDiffMarkup({ path: 'src/deep/example.js', diffId: 'd1', hunks, actionButton }));
  assert.equal(plain.querySelector('.file-diff').classList.contains('file-diff--stacked'), false);
  assert.equal(plain.querySelector('.file-diff-directory').textContent, 'src/deep/');
  assert.equal(plain.querySelector('.file-diff-note'), null);
});

test('notes render escaped between the path and the counts', () => {
  const doc = parse(buildFileDiffMarkup({ path: 'a.txt', diffId: 'd1', hunks, additions: 3, deletions: 0, notes: ['new', '<b>untracked</b>', ''], actionButton }));
  const note = doc.querySelector('.file-diff-note');
  assert.equal(note.textContent, 'new · <b>untracked</b>');
  assert.equal(note.querySelector('b'), null);
  assert.equal(note.nextElementSibling.className, 'file-diff-counts');
});

test('an expandable row with a supplied body is open before it has hunks and escapes nothing it was handed as trusted markup', () => {
  const closed = parse(buildFileDiffMarkup({ path: 'a.txt', diffId: 'd1', expandable: true, actionButton }));
  assert.equal(closed.querySelector('.file-diff-toggle').getAttribute('aria-expanded'), 'false');
  assert.ok(closed.querySelector('[data-file-diff-pending]'), 'a lazy row is closed with a pending body');
  const open = parse(buildFileDiffMarkup({ path: 'a.txt', diffId: 'd1', expandable: true, expanded: true, bodyHtml: '<div role="listitem" class="note">Loading</div>', actionButton }));
  assert.equal(open.querySelector('.file-diff-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(open.querySelector('.file-diff-body .note').textContent, 'Loading');
  assert.ok(open.querySelector('[data-file-diff-materialized]'));
  // Truncation still wins over the opt-in.
  const truncated = parse(buildFileDiffMarkup({ path: 'a.txt', diffId: 'd1', expandable: true, truncated: true, actionButton }));
  assert.equal(truncated.querySelector('.file-diff-chevron'), null);
});

test('an open button can carry its own dataset and label without a change id', () => {
  const doc = parse(buildFileDiffMarkup({ path: 'a.txt', diffId: 'd1', hunks, openDataset: { 'changes-wt-open': 'a.txt' }, openLabel: 'Open a.txt in Workspace', actionButton }));
  const open = doc.querySelector('.file-diff-open');
  assert.equal(open.dataset.changesWtOpen, 'a.txt');
  assert.equal(open.getAttribute('aria-label'), 'Open a.txt in Workspace');
  assert.equal(open.hasAttribute('data-jenny-open-change-diff'), false);
  const none = parse(buildFileDiffMarkup({ path: 'a.txt', diffId: 'd1', hunks, actionButton }));
  assert.equal(none.querySelector('.file-diff-open'), null, 'no change id and no opt-in: still no button');
});

test('annotations sit under their new-side line; lines the hunks miss lead the body', () => {
  const doc = parse(buildFileDiffBodyMarkup({
    hunks,
    annotations: [
      { line: 49, severity: 'high', html: '<p class="note">on new</p>' },
      { line: 47, severity: 'bad value!', html: '<p class="note">on context</p>' },
      { line: 400, severity: 'low', html: '<p>far</p>', unplacedHtml: '<p class="note">outside</p>' },
      { line: 0, html: '<p>ignored</p>' },
    ],
  }));
  const rows = [...doc.body.querySelectorAll('.diff-line, .diff-annotation')];
  assert.equal(rows[0].textContent, 'outside');
  assert.ok(rows[0].classList.contains('diff-annotation--unplaced'));
  const contextRow = doc.querySelector('.diff-line-context');
  assert.equal(contextRow.getAttribute('data-review-severity'), 'medium', 'an unknown severity reads as medium');
  assert.equal(contextRow.nextElementSibling.textContent, 'on context');
  const added = doc.querySelector('.diff-line-add');
  assert.equal(added.getAttribute('data-review-severity'), 'high');
  assert.equal(added.nextElementSibling.textContent, 'on new');
  // The removed line shares the number 49 on the old side and gets nothing.
  assert.equal(doc.querySelector('.diff-line-remove').hasAttribute('data-review-severity'), false);
  assert.equal(doc.body.textContent.includes('ignored'), false);
});

test('both diff renderers stamp each row with the line numbers of the sides it has', () => {
  const lines = (doc) => [...doc.querySelectorAll('.diff-line')]
    .map((row) => [row.getAttribute('data-old-line'), row.getAttribute('data-new-line')]);
  const meta = [{ ...hunks[0], lines: [...hunks[0].lines, '\\ No newline at end of file'] }];
  const expected = [['47', '47'], ['48', '48'], ['49', null], [null, '49'], [null, null]];
  assert.deepEqual(lines(parse(buildFileDiffBodyMarkup({ hunks: meta, languageId: 'javascript' }))), expected);
  assert.deepEqual(lines(parse(renderDiffHunks(meta))), expected);
});

// Chat tool diff block: gap labels, word marks, created files, real reasons, text open, bare single file.
const markedText = (row) => [...row.querySelectorAll('mark.diff-word')].map((mark) => mark.textContent);

test('a gap between hunks says how many lines it hides; adjacent hunks keep the bare gap', () => {
  const doc = parse(buildFileDiffBodyMarkup({ hunks: [
    { oldStart: 41, oldLines: 7, newStart: 41, newLines: 7, lines: [' a'] },
    { oldStart: 72, oldLines: 3, newStart: 72, newLines: 3, lines: [' b'] },
  ] }));
  const gap = doc.querySelector('.diff-gap');
  assert.equal(gap.querySelector('.diff-gap-label').textContent, '24 unchanged lines');
  assert.equal(gap.querySelector('.diff-gutter').textContent, '⋯');
  assert.equal(gap.hasAttribute('aria-hidden'), false, 'a labelled gap is read');
  const one = parse(buildFileDiffBodyMarkup({ hunks: [
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a'] },
    { oldStart: 4, oldLines: 1, newStart: 4, newLines: 1, lines: [' b'] },
  ] }));
  assert.equal(one.querySelector('.diff-gap-label').textContent, '1 unchanged line');
  const adjacent = parse(buildFileDiffBodyMarkup({ hunks: [
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a'] },
    { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: [' b'] },
  ] }));
  assert.equal(adjacent.querySelector('.diff-gap-label'), null);
  assert.equal(adjacent.querySelector('.diff-gap').getAttribute('aria-hidden'), 'true');
});

test('an isolated removed/added pair marks the changed span on both lines and keeps token classes', () => {
  const lines = ['-    const label = session.title || \'Untitled\';', '+    const label = session.title || jt(\'x\', \'New chat\');'];
  const doc = parse(buildFileDiffBodyMarkup({ hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }] }));
  const [removed, added] = [...doc.querySelectorAll('.diff-line')];
  assert.deepEqual(markedText(removed), ['\'Untitled\'']);
  assert.deepEqual(markedText(added), ['jt(\'x\', \'New chat\')']);
  assert.equal(removed.getAttribute('aria-label').startsWith('Removed line 1:'), true);
  // With a highlighter the mark splits a token and both halves keep its class.
  const highlight = (text) => [{ text, cls: 'tok-string' }];
  const hl = parse(buildFileDiffBodyMarkup({ hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-hello world', '+hello there'] }], highlight }));
  const first = hl.querySelector('.diff-line-remove .diff-content');
  assert.equal(first.textContent, 'hello world');
  assert.deepEqual(markedText(hl.querySelector('.diff-line-remove')), ['world']);
  assert.equal(first.querySelector('mark.diff-word .tok-string').textContent, 'world');
  assert.equal(first.querySelector('.tok-string').textContent, 'hello ');
});

test('runs, rewrites, long lines and empty spans get no word marks', () => {
  const marks = (lines) => parse(buildFileDiffBodyMarkup({ hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines }] })).querySelectorAll('mark.diff-word').length;
  assert.equal(marks(['-a one', '-b two', '+a won', '+b too']), 0, 'two minus two plus is a run');
  assert.equal(marks(['-abc', '+xyz']), 0, 'a full rewrite');
  const long = 'x'.repeat(501);
  assert.equal(marks([`-${long}a`, `+${long}b`]), 0, 'over 500 characters');
  assert.equal(marks(['-same line', '+same line']), 0, 'no changed span');
  assert.equal(marks(['-keep this prefix A', '+keep this prefix']), 1, 'a pure deletion marks only the side with a span');
});

test('a created file whose lines are all additions renders as plain code', () => {
  const created = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+one', '+two'] }];
  const body = (extra) => buildFileDiffMarkup({ path: 'a.txt', diffId: 'd1', hunks: created, expanded: true, actionButton, ...extra });
  assert.ok(parse(body({ status: 'created' })).querySelector('.file-diff-body').classList.contains('file-diff-body--new-file'));
  assert.equal(parse(body({ status: 'modified' })).querySelector('.file-diff-body--new-file'), null);
  const mixed = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] }];
  assert.equal(parse(buildFileDiffMarkup({ path: 'a.txt', diffId: 'd1', hunks: mixed, expanded: true, status: 'created', actionButton })).querySelector('.file-diff-body--new-file'), null);
});

test('a summary-only row gives the real reason', () => {
  const reason = (truncationReason) => parse(buildFileDiffMarkup({ path: 'a.bin', diffId: 'd1', truncated: true, truncationReason, actionButton })).querySelector('.file-diff-truncated').textContent;
  assert.equal(reason('binary'), 'binary file');
  assert.equal(reason('line_limit'), 'too long to show here');
  assert.equal(reason('hunk_limit'), 'too long to show here');
  assert.equal(reason('byte_limit'), 'too long to show here');
  assert.equal(reason('decode_error'), 'not text');
  assert.equal(reason('diff_generation_failed'), 'diff unavailable');
  assert.equal(reason('preimage_unavailable'), 'earlier version unavailable');
  assert.equal(reason('time_limit'), 'took too long to compare');
  assert.equal(reason('whatever'), 'not shown');
  assert.equal(reason(undefined), 'not shown');
  const noted = parse(buildFileDiffMarkup({ path: 'a.env', diffId: 'd1', truncated: true, truncationReason: 'binary', note: 'contents not shown', actionButton }));
  assert.equal(noted.querySelector('.file-diff-truncated').textContent, 'contents not shown');
});

test('openStyle text renders the open control as the word Open; the default keeps the glyph', () => {
  const text = parse(buildFileDiffMarkup({ path: 'a.txt', diffId: 'd1', changeId: 'c1', hunks, openStyle: 'text', actionButton })).querySelector('.file-diff-open');
  assert.equal(text.textContent, 'Open');
  assert.ok(text.classList.contains('file-diff-open--text'));
  assert.equal(text.getAttribute('aria-label'), 'Open in editor');
  assert.equal(text.getAttribute('title'), 'Open in editor');
  assert.equal(text.dataset.changeId, 'c1');
  const custom = parse(buildFileDiffMarkup({ path: 'a.txt', diffId: 'd1', hunks, openStyle: 'text', openDataset: { 'changes-wt-open': 'a.txt' }, openLabel: 'Open a.txt', actionButton })).querySelector('.file-diff-open');
  assert.equal(custom.textContent, 'Open');
  assert.equal(custom.getAttribute('aria-label'), 'Open a.txt');
  const glyph = parse(buildFileDiffMarkup({ path: 'a.txt', diffId: 'd1', changeId: 'c1', hunks, actionButton })).querySelector('.file-diff-open');
  assert.ok(glyph.querySelector('svg'));
  assert.equal(glyph.classList.contains('file-diff-open--text'), false);
});

test('a bare single-file diff is the body plus one open link, with no head', () => {
  const bare = parse(buildFileDiffMarkup({ path: 'src/a.js', diffId: 'd1', changeId: 'change:1', hunks, bare: true, status: 'modified', actionButton }));
  assert.equal(bare.querySelector('.file-diff-head'), null);
  const row = bare.querySelector('.file-diff');
  assert.ok(row.classList.contains('file-diff--bare'));
  assert.equal(row.dataset.expanded, 'true');
  assert.equal(row.dataset.diffId, 'd1');
  assert.ok(row.querySelector('.file-diff-body[data-file-diff-materialized] .diff-line'));
  const link = row.querySelector('.file-diff-foot .file-diff-open--text');
  assert.equal(link.textContent, 'Open diff in editor');
  assert.equal(link.dataset.changeId, 'change:1');
  assert.ok(link.hasAttribute('data-jenny-open-change-diff'));
  const noId = parse(buildFileDiffMarkup({ path: 'src/a.js', diffId: 'd1', hunks, bare: true, actionButton }));
  assert.equal(noId.querySelector('.file-diff-foot'), null, 'no change id: no link');
  const created = parse(buildFileDiffMarkup({ path: 'a.txt', diffId: 'd1', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+x'] }], bare: true, status: 'created', actionButton }));
  assert.ok(created.querySelector('.file-diff-body').classList.contains('file-diff-body--new-file'));
  const truncated = parse(buildFileDiffMarkup({ path: 'a.bin', diffId: 'd1', changeId: 'c1', bare: true, truncated: true, truncationReason: 'binary', hunks, actionButton }));
  assert.ok(truncated.querySelector('.file-diff-head'), 'a summary-only row keeps its head');
  assert.equal(truncated.querySelector('.file-diff--bare'), null);
  assert.equal(truncated.querySelector('.file-diff-truncated').textContent, 'binary file');
});

test('the expandable toggle carries both labels so the bindings can follow state', () => {
  const toggle = parse(buildFileDiffMarkup({ path: 'a/b.js', diffId: 'd1', hunks, actionButton })).querySelector('.file-diff-toggle');
  assert.equal(toggle.getAttribute('aria-label'), 'Show diff for a/b.js');
  assert.equal(toggle.dataset.labelShow, 'Show diff for a/b.js');
  assert.equal(toggle.dataset.labelHide, 'Hide diff for a/b.js');
  assert.equal(toggle.dataset.titleShow, 'Show diff');
  assert.equal(toggle.dataset.titleHide, 'Hide diff');
});

test('review edge cases: no-newline created files, whole emoji at mark edges, and gaps after a zero-length hunk', () => {
  const noNewline = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+only line', '\\ No newline at end of file'] }];
  const created = buildFileDiffBodyMarkup({ hunks: noNewline, status: 'created' });
  const createdRow = buildFileDiffMarkup({ path: 'a.txt', diffId: 'd-nl', status: 'created', expanded: true, actionButton, hunks: noNewline });
  assert.ok(created.includes('only line'));
  assert.match(createdRow, /file-diff-body--new-file/);

  const emoji = parse(buildFileDiffBodyMarkup({ hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-say \u{1F600} now', '+say \u{1F601} now'] }] }));
  const marked = [...emoji.querySelectorAll('mark.diff-word')].map((node) => node.textContent);
  assert.deepEqual(marked, ['\u{1F600}', '\u{1F601}'], 'each mark holds a whole emoji');

  const gap = buildFileDiffBodyMarkup({ hunks: [
    { oldStart: 10, oldLines: 0, newStart: 10, newLines: 1, lines: ['+a'] },
    { oldStart: 30, oldLines: 1, newStart: 31, newLines: 1, lines: [' b'] },
  ] });
  assert.doesNotMatch(gap, /diff-gap-label/, 'no count without the earlier hunk\'s old-side length');
});
