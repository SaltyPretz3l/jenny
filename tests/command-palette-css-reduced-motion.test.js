// UIUX-030: the command palette's list scroller forces `scroll-behavior:
// smooth` unconditionally. JSDOM does not evaluate @media query matching
// against real CSSOM the way a browser does, so this is a stylesheet
// text/AST contract test (same technique as
// tests/markdown-css-reduced-motion.test.js): assert styles/command-palette.css
// gates `.command-palette-list`'s scroll-behavior under
// `@media (prefers-reduced-motion: reduce)`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS_PATH = path.join(__dirname, '..', 'styles', 'command-palette.css');

function readCss() {
  return fs.readFileSync(CSS_PATH, 'utf8');
}

function extractReducedMotionBlocks(css) {
  const blocks = [];
  const re = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  let match;
  while ((match = re.exec(css))) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    blocks.push(css.slice(start, i - 1));
  }
  return blocks;
}

test('command-palette.css unconditionally sets scroll-behavior: smooth on .command-palette-list', () => {
  const css = readCss();
  const ruleMatch = css.match(/\.command-palette-list\s*\{([^}]*)\}/);
  assert.ok(ruleMatch, 'expected a base .command-palette-list rule');
  assert.match(ruleMatch[1], /scroll-behavior:\s*smooth\s*;/, 'the base rule should still request smooth scrolling by default');
});

test('command-palette.css contains a prefers-reduced-motion: reduce block', () => {
  const css = readCss();
  const blocks = extractReducedMotionBlocks(css);
  assert.ok(blocks.length >= 1, 'expected at least one @media (prefers-reduced-motion: reduce) block');
});

test('reduced-motion block sets scroll-behavior: auto for .command-palette-list', () => {
  const css = readCss();
  const blocks = extractReducedMotionBlocks(css);
  assert.ok(blocks.length >= 1, 'expected a reduced-motion block to inspect');
  const combined = blocks.join('\n');
  const ruleMatch = combined.match(/\.command-palette-list\s*\{([^}]*)\}/);
  assert.ok(ruleMatch, `expected a reduced-motion override for .command-palette-list\nblock contents:\n${combined}`);
  assert.match(ruleMatch[1], /scroll-behavior:\s*auto\s*;/, `expected scroll-behavior: auto under reduced motion, got: ${ruleMatch[1]}`);
});
