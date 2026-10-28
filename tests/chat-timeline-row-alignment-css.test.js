'use strict';

// Timeline row alignment pass (2026-10-20): each pin below names a measured
// misalignment the rule fixes, so a later edit that undoes one fails here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const ruleBody = (css, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] || '';
};

test('the commentary kicker takes no flex-gap slot in its row', () => {
  // An inline span is still a flex item in the .chat-row column and took a
  // row-gap slot, dropping commentary text 8px below other rows.
  assert.match(ruleBody(read('styles/chat-commentary-v2.css'), '.chat-commentary-kicker'), /display:\s*contents/);
});

test('narrow chat does not indent the first child wrapper off the root rail', () => {
  const css = read('styles/chat-media-queries.css');
  const narrow = css.slice(css.indexOf('@media (max-width: 700px)'));
  assert.match(ruleBody(narrow, '.chat-view .chat-thread-children[data-thread-depth="1"]'), /padding-inline-start:\s*0/);
});

test('row node dots centre on a per-kind first line, not a fixed top', () => {
  const css = read('styles/chat-thread-rail.css');
  assert.match(css, /top:\s*calc\(var\(--row-dot-center, calc\(var\(--tl-row-h\) \/ 2\)\) - var\(--thread-dot-size\) \/ 2\)/);
  for (const kind of ['assistant_text', 'batch', 'recap', 'approval_gap']) {
    assert.match(css, new RegExp(`\\.chat-row\\[data-row-kind="${kind}"\\][^{]*\\{\\s*(?:/\\*[^*]*\\*/\\s*)?--row-dot-center:`), kind);
  }
  // The retired tool_step approval side bar never matched a rendered row.
  assert.doesNotMatch(css, /data-row-kind="tool_step"/);
});

test('approval cards hang their dot and mark on the tool row dot axis', () => {
  const tools = read('styles/chat-tools.css');
  assert.match(tools, /--approval-text-inset:\s*calc\(2 \* var\(--space-3\) \+ var\(--tl-dot-size\)\)/);
  assert.match(ruleBody(tools, '.approval-gap-row .tool-approval-block'), /padding-inline-start:\s*var\(--approval-text-inset\)/);
  assert.match(ruleBody(tools, '.approval-gap-row .tool-approval-kicker'), /margin-inline-start:\s*calc\(-1 \* \(var\(--tl-dot-size\) \+ var\(--space-3\)\)\)/);
  const markers = read('styles/chat-tool-markers.css');
  assert.match(ruleBody(markers, '.approval-gap-row > .tool-approval-receipt--resolved > .tool-approval-receipt-mark'), /flex-basis:\s*var\(--approval-text-inset\)/);
});

test('narrow tool rows keep the name ahead of the path chip', () => {
  const css = read('styles/chat-machinery.css');
  assert.match(ruleBody(css, '.tool-call-row--minimal .tool-call-name'), /max-width:\s*max\(40%, 6em\)/);
  assert.match(ruleBody(css, '.tool-call-row--minimal .tool-call-main'), /overflow:\s*hidden/);
});
