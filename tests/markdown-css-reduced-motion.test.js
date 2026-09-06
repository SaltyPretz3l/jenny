// A4: mermaid transitions must respect prefers-reduced-motion.
// JSDOM does not evaluate @media query matching against real CSSOM the way
// a browser does, so this is a stylesheet text/AST contract test: assert
// styles/markdown.css contains a single `prefers-reduced-motion: reduce`
// block whose body sets `transition: none` for the four mermaid selectors
// the audit flagged (preview iframe, viewport svg, control button, chevron).
// The control-fade transition (already gated via var(--motion-duration-regular))
// is deliberately excluded — it is already zeroed under reduced motion.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS_PATH = path.join(__dirname, '..', 'styles', 'markdown.css');

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

const MERMAID_TRANSITION_NONE_SELECTORS = [
  ':is(.chat-bubble-markdown, .tool-result-body) .markdown-mermaid-preview iframe',
  ':is(.chat-bubble-markdown, .tool-result-body) .mermaid-viewport svg',
  ':is(.chat-bubble-markdown, .tool-result-body) .mermaid-control-btn',
  ':is(.chat-bubble-markdown, .tool-result-body) .markdown-mermaid-toggle-icon::before',
];

test('markdown.css contains a prefers-reduced-motion: reduce block', () => {
  const css = readCss();
  const blocks = extractReducedMotionBlocks(css);
  assert.ok(blocks.length >= 1, 'expected at least one @media (prefers-reduced-motion: reduce) block');
});

test('reduced-motion block sets transition: none for all four mermaid selectors', () => {
  const css = readCss();
  const blocks = extractReducedMotionBlocks(css);
  assert.ok(blocks.length >= 1, 'expected a reduced-motion block to inspect');
  const combined = blocks.join('\n');

  for (const selector of MERMAID_TRANSITION_NONE_SELECTORS) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ruleRe = new RegExp(escaped + '\\s*\\{([^}]*)\\}');
    const ruleMatch = combined.match(ruleRe);
    assert.ok(ruleMatch, `expected reduced-motion rule for selector: ${selector}\nblock contents:\n${combined}`);
    assert.match(ruleMatch[1], /transition:\s*none\s*;/, `expected transition: none for ${selector}, got: ${ruleMatch[1]}`);
    assert.doesNotMatch(ruleMatch[1], /transform\s*:/, `must not override transform for ${selector} (end-states must survive): ${ruleMatch[1]}`);
  }
});

test('reduced-motion block does not touch the already-gated mermaid-controls opacity fade', () => {
  const css = readCss();
  const blocks = extractReducedMotionBlocks(css);
  const combined = blocks.join('\n');
  assert.doesNotMatch(
    combined,
    /\.mermaid-controls\s*\{/,
    'the control-fade opacity transition is already zeroed via var(--motion-duration-regular); reduced-motion block must not duplicate/override it'
  );
});
