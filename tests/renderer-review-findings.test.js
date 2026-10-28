'use strict';

// Row 64: inline review findings. The chat block parses report_findings output, renders one list,
// and its document delegate toggles rows, sends Fix messages and opens Show in diff.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const findings = require('../renderer/chat/renderer-review-findings');
const { escapeHtml } = require('../renderer/shared/string-utils');

const OUTPUT = JSON.stringify({
  kind: 'review_findings',
  version: 1,
  scope: 'working tree vs HEAD',
  summary: '',
  counts: { high: 2, medium: 1, low: 0 },
  findings: [
    { index: 1, severity: 'high', title: 'subtotal skips the first item', body: 'The loop starts at 1.', file: 'src/cart.js', line: 7, end_line: 7,
      excerpt: { start: 6, lines: ['  let total = 0;', '  for (let i = 1; i < items.length; i++) {', '    total += items[i].price;'] } },
    { index: 2, severity: 'high', title: 'totalIn <reads> rates early', body: 'fetchRates is not awaited.', file: 'src/cart.js', line: 22, end_line: 22, excerpt: null },
    { index: 3, severity: 'medium', title: 'Empty cart divides by zero', body: '', file: '', line: 0, end_line: 0, excerpt: null },
  ],
  dropped: 0,
  note: 'Shown to the user as a list.',
});

function render(options = {}) {
  const parsed = findings.parseReviewFindings(OUTPUT);
  return findings.buildReviewFindingsBlockMarkup(parsed, { escapeHtml, toolCallId: 'call-1', sessionId: 'sess-1', ...options });
}

function mount(html) {
  const dom = new JSDOM(`<body><div data-chat-node="chatTimeline">${html}</div></body>`);
  return dom.window.document;
}

test.beforeEach(() => findings.resetForTests());

test('parseReviewFindings accepts the tool payload and rejects anything else', () => {
  const parsed = findings.parseReviewFindings(OUTPUT);
  assert.equal(parsed.scope, 'working tree vs HEAD');
  assert.equal(parsed.findings.length, 3);
  assert.deepEqual(parsed.findings[0].excerpt.lines.length, 3);
  assert.equal(parsed.findings[2].line, 0);
  assert.equal(findings.parseReviewFindings('not json'), null);
  assert.equal(findings.parseReviewFindings('{"kind":"other"}'), null);
  assert.equal(findings.parseReviewFindings(JSON.stringify({ kind: 'review_findings', findings: [{ title: '' }] })), null);
  // Unknown severities read as medium; a line without a file is dropped.
  const loose = findings.parseReviewFindings(JSON.stringify({ kind: 'review_findings', findings: [{ title: 'x', severity: 'urgent', line: 4 }] }));
  assert.equal(loose.findings[0].severity, 'medium');
  assert.equal(loose.findings[0].line, 0);
});

test('the block shows counts, one row per finding, the first open, and escapes model text', () => {
  const doc = mount(render());
  const block = doc.querySelector('section[data-review-findings]');
  assert.ok(block);
  assert.match(block.querySelector('.review-findings-count').textContent, /3 findings/);
  assert.equal(block.querySelector('.review-findings-meta').textContent, '2 high · 1 medium · working tree vs HEAD');
  const rows = block.querySelectorAll('[data-review-finding]');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].getAttribute('data-open'), 'true');
  assert.equal(rows[1].getAttribute('data-open'), 'false');
  assert.equal(rows[1].querySelector('.review-finding-body').hidden, true);
  assert.equal(rows[1].querySelector('.review-finding-title').textContent, 'totalIn <reads> rates early');
  assert.equal(block.innerHTML.includes('<reads>'), false);
  // The location is the shared chat path chip; a finding without a file has none and no Show in diff.
  const chip = rows[0].querySelector('[data-chat-path-open]');
  assert.equal(chip.getAttribute('data-chat-path-open'), 'src/cart.js');
  assert.equal(chip.getAttribute('data-chat-path-line'), '7');
  assert.equal(chip.textContent, 'cart.js:7');
  assert.equal(rows[2].querySelector('[data-chat-path-open]'), null);
  assert.equal(rows[2].querySelector('[data-review-finding-action="show-diff"]'), null);
  // A file without a line has its chip but no Show in diff (no line to put the comment on).
  const fileOnly = mount(findings.buildReviewFindingsBlockMarkup(findings.parseReviewFindings(JSON.stringify({
    kind: 'review_findings', findings: [{ index: 1, severity: 'low', title: 'Whole file', file: 'src/cart.js', line: 0 }],
  })), { escapeHtml, toolCallId: 'call-2', sessionId: 'sess-1' }));
  assert.ok(fileOnly.querySelector('[data-chat-path-open="src/cart.js"]'));
  assert.equal(fileOnly.querySelector('[data-review-finding-action="show-diff"]'), null);
  // The excerpt marks the finding's own line.
  const target = rows[0].querySelector('.review-finding-excerpt .is-target');
  assert.match(target.textContent, /^7\s/);
  assert.ok(block.querySelector('[data-review-finding-action="fix-all"]'));
});

test('a toggle opens a finding in place and the choice survives a re-render', () => {
  const doc = mount(render());
  const entry = findings.createReviewFindingsEntry({ documentRef: doc, windowRef: doc.defaultView });
  entry.bind();
  const second = doc.querySelectorAll('[data-review-finding]')[1];
  second.querySelector('[data-review-finding-action="toggle"]').click();
  assert.equal(second.getAttribute('data-open'), 'true');
  assert.equal(second.querySelector('.review-finding-body').hidden, false);
  doc.querySelectorAll('[data-review-finding]')[0].querySelector('[data-review-finding-action="toggle"]').click();
  const again = mount(render());
  const rows = again.querySelectorAll('[data-review-finding]');
  assert.equal(rows[0].getAttribute('data-open'), 'false');
  assert.equal(rows[1].getAttribute('data-open'), 'true');
  entry.dispose();
});

test('Fix sends one message naming the finding, then the row reads Sent to Jenny', async () => {
  const doc = mount(render());
  const sent = [];
  const entry = findings.createReviewFindingsEntry({
    documentRef: doc,
    windowRef: doc.defaultView,
    getHost: () => ({ startPromptSend: async (message, options) => { sent.push({ message, options }); return { streamId: 's1' }; } }),
  });
  const row = doc.querySelector('[data-review-finding]');
  const block = doc.querySelector('section[data-review-findings]');
  assert.equal(await entry.sendFix(block, 1), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /Fix this finding from your review/);
  assert.match(sent[0].message, /\[High\] subtotal skips the first item \(src\/cart\.js:7\)/);
  assert.match(sent[0].message, /The loop starts at 1\./);
  assert.deepEqual(sent[0].options, { sessionIdOverride: 'sess-1', preserveComposerDraft: true });
  assert.equal(row.getAttribute('data-sent'), 'true');
  assert.equal(row.querySelector('.review-finding-actions').textContent, 'Sent to Jenny');
  // A second Fix on the same finding sends nothing; Fix all sends only the rest.
  assert.equal(await entry.sendFix(block, 1), false);
  assert.equal(await entry.sendFix(block, 0), true);
  assert.match(sent[1].message, /Fix these 2 findings/);
  assert.doesNotMatch(sent[1].message, /subtotal skips/);
  assert.equal(doc.querySelector('[data-review-finding-action="fix-all"]'), null);
  // The sent state is kept for the renderer session.
  const again = mount(render());
  assert.equal(again.querySelector('[data-review-finding-action="fix-all"]'), null);
  assert.equal(again.querySelector('[data-review-finding]').getAttribute('data-sent'), 'true');
});

test('a rejected send leaves the finding unsent and says why', async () => {
  const doc = mount(render());
  const toasts = [];
  const entry = findings.createReviewFindingsEntry({
    documentRef: doc,
    windowRef: doc.defaultView,
    getHost: () => ({ startPromptSend: async () => ({ rejected: true, reason: 'busy' }) }),
    showToastMessage: (message) => toasts.push(message),
  });
  assert.equal(await entry.sendFix(doc.querySelector('section[data-review-findings]'), 1), false);
  assert.equal(doc.querySelector('[data-review-finding]').getAttribute('data-sent'), 'false');
  assert.equal(toasts.length, 1);
});

test('Show in diff opens Changes for the session with every finding and the focused one', () => {
  const doc = mount(render());
  const calls = [];
  const entry = findings.createReviewFindingsEntry({
    documentRef: doc,
    windowRef: doc.defaultView,
    getWorkspaceDetail: () => ({ open: (request) => { calls.push(request); return true; } }),
  });
  entry.bind();
  doc.querySelectorAll('[data-review-finding]')[1].querySelector('[data-review-finding-action="show-diff"]').click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].surface, 'changes');
  assert.equal(calls[0].ownerSessionId, 'sess-1');
  assert.equal(calls[0].reviewFindings.toolCallId, 'call-1');
  assert.equal(calls[0].reviewFindings.focusIndex, 2);
  assert.deepEqual(calls[0].reviewFindings.findings.map((item) => [item.index, item.file, item.line, item.severity]), [
    [1, 'src/cart.js', 7, 'high'], [2, 'src/cart.js', 22, 'high'], [3, '', 0, 'medium'],
  ]);
  assert.equal(calls[0].reviewFindings.findings[1].title, 'totalIn <reads> rates early');
  entry.dispose();
});

test('the diff comment carries Fix only, marks focus, and names a line outside the diff', async () => {
  const parsed = findings.parseReviewFindings(OUTPUT);
  const html = findings.buildDiffCommentMarkup(parsed.findings[0], { escapeHtml, sessionId: 'sess-1', toolCallId: 'call-1', focus: true });
  const outside = findings.buildDiffCommentMarkup(parsed.findings[1], { escapeHtml, sessionId: 'sess-1', toolCallId: 'call-1', unplaced: true });
  const doc = mount(`<aside>${html}${outside}</aside>`);
  const comment = doc.querySelector('.review-diff-comment');
  assert.equal(comment.getAttribute('data-review-focus'), 'true');
  assert.ok(comment.querySelector('[data-review-finding-action="fix"]'));
  assert.equal(comment.querySelector('[data-review-finding-action="show-diff"]'), null);
  assert.match(doc.querySelectorAll('.review-diff-comment')[1].textContent, /Line 22, outside the changed lines/);
  // Fix from the diff reads the finding from the comment when the chat block is not in this document.
  const sent = [];
  const entry = findings.createReviewFindingsEntry({
    documentRef: doc,
    windowRef: doc.defaultView,
    getHost: () => ({ startPromptSend: async (message) => { sent.push(message); return {}; } }),
  });
  assert.equal(await entry.sendFix(comment, 1), true);
  assert.match(sent[0], /subtotal skips the first item \(src\/cart\.js:7\)/);
  assert.equal(comment.querySelector('.review-finding-actions').textContent, 'Sent to Jenny');
});

test('buildFixMessage lists several findings in order', () => {
  const parsed = findings.parseReviewFindings(OUTPUT);
  const message = findings.buildFixMessage(parsed.findings);
  assert.match(message, /^Fix these 3 findings from your review:/);
  assert.match(message, /1\. \[High\] subtotal skips the first item \(src\/cart\.js:7\)/);
  assert.match(message, /3\. \[Medium\] Empty cart divides by zero\n/);
});
