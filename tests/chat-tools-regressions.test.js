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
