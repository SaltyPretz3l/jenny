const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-tools.css'), 'utf8');

test('interactive recap keeps its keyboard focus ring', () => {
  const focusVisibleRule = css
    .match(/\.interactive-recap-row:focus-visible\s*\{[\s\S]*?\}/)?.[0] || '';
  const pointerFocusRule = css
    .match(/\.interactive-recap-row:focus:not\(:focus-visible\)\s*\{[\s\S]*?\}/)?.[0] || '';

  assert.match(focusVisibleRule, /outline:\s*2px solid var\(--focus-outline\);/);
  assert.match(pointerFocusRule, /outline:\s*none;/);
  assert.doesNotMatch(css, /\.interactive-recap-row:focus\s*\{/);
});

// Owner gate 2026-09-20: a failed workspace_present result row side-scrolled
// the narrow IDE chat dock. Tool rows are bounded by their column and every
// value surface wraps at any point.
test('tool rows never widen the chat panel: block values wrap and rows clip', () => {
  const v2 = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-tool-block-v2.css'), 'utf8');
  const machinery = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-machinery.css'), 'utf8');

  const rowRule = v2.match(/\.tool-call-row,\s*\.tool-result-row\s*\{[^}]*\}/)?.[0] || '';
  assert.match(rowRule, /min-width:\s*0;/);
  assert.match(rowRule, /max-width:\s*100%;/);
  assert.match(rowRule, /overflow-x:\s*clip;/);
  assert.match(v2, /\.tool-call-section\s*\{[^}]*min-width:\s*0;/);

  const preRule = css.match(/\.tool-kv-pre\s*\{[^}]*\}/)?.[0] || '';
  assert.match(preRule, /white-space:\s*pre-wrap;/);
  assert.match(preRule, /overflow-wrap:\s*anywhere;/);
  assert.doesNotMatch(preRule, /white-space:\s*pre;/);

  const valueRule = css.match(/\.tool-kv-value\s*\{[^}]*\}/)?.[0] || '';
  assert.match(valueRule, /overflow-wrap:\s*anywhere;/);
  const metaRule = css.match(/\.tool-kv-meta\s*\{[^}]*\}/)?.[0] || '';
  assert.match(metaRule, /text-overflow:\s*ellipsis;/);
  const gridRule = css.match(/\.tool-kv-grid\s*\{[^}]*\}/)?.[0] || '';
  assert.match(gridRule, /max-width:\s*100%;/);

  const outputRule = machinery.match(/\.tool-call-input,\s*\.tool-call-output\s*\{[^}]*\}/)?.[0] || '';
  assert.match(outputRule, /overflow-wrap:\s*anywhere;/);
});
