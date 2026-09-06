const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const CSS_PATH = path.join(__dirname, '..', 'styles', 'chat-a11y-v2.css');

function readCss() {
  return fs.readFileSync(CSS_PATH, 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractRuleBody(css, selector) {
  const match = css.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected rule for ${selector}`);
  return match[1];
}

function extractReducedMotionBlock(css) {
  const marker = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  const match = marker.exec(css);
  assert.ok(match, 'expected a prefers-reduced-motion: reduce block');

  const start = match.index + match[0].length;
  let depth = 1;
  let index = start;
  while (index < css.length && depth > 0) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    index += 1;
  }

  assert.equal(depth, 0, 'expected the reduced-motion block to close');
  assert.equal(marker.exec(css), null, 'expected one reduced-motion block');
  return css.slice(start, index - 1);
}

test('chat accessibility stylesheet contains no known corruption or BOM', () => {
  const css = readCss();

  assert.notEqual(css.charCodeAt(0), 0xfeff, 'stylesheet must not start with a UTF-8 BOM');
  assert.match(css, /^\/\* styles\/chat-a11y-v2\.css/);
  assert.doesNotMatch(css, /focus-aisible|aar\(|aiew|chat-a11y-a2\.css/);
});

test('chat entries restore the keyboard-only focus ring with valid var() declarations', () => {
  const css = readCss();
  const focusBody = extractRuleBody(css, '.chat-entry:focus-visible');
  const pointerFocusBody = extractRuleBody(css, '.chat-entry:focus:not(:focus-visible)');

  assert.match(focusBody, /outline:\s*2px solid var\(--focus-outline,\s*#4cc7ff\)\s*;/);
  assert.match(focusBody, /outline-offset:\s*2px\s*;/);
  assert.match(focusBody, /border-radius:\s*var\(--radius-3,\s*12px\)\s*;/);
  assert.match(pointerFocusBody, /outline:\s*none\s*;/);
});

test('chat entries retain transcript scroll margin', () => {
  const css = readCss();
  const entryBody = extractRuleBody(css, '.chat-entry');

  assert.match(entryBody, /scroll-margin-block:\s*var\(--space-4,\s*16px\)\s*;/);
});

test('reduced motion disables the chat focus transition', () => {
  const reducedMotionBlock = extractReducedMotionBlock(readCss());
  const focusBody = extractRuleBody(reducedMotionBlock, '.chat-entry:focus-visible');

  assert.match(focusBody, /transition:\s*none\s*;/);
});
