// Static-text guards for styles/chat-commentary-v2.css. jsdom getComputedStyle
// does not resolve @import'd cascade, so we assert the load-bearing rules by
// source text instead of computed style.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(
  path.join(__dirname, '..', 'styles', 'chat-commentary-v2.css'),
  'utf8',
);

test('commentary/intermediate prose is de-emphasized via text color, never opacity', () => {
  assert.match(
    css,
    /\[data-assistant-phase="commentary"\][^{]*\.chat-bubble-markdown[^{]*,[\s\S]*?\[data-assistant-phase="intermediate"\][^{]*\.chat-bubble-markdown\s*\{[^}]*color:\s*var\(--text-secondary\)/,
  );
  // Opacity-based dimming is explicitly avoided (washes out links/code/media).
  assert.doesNotMatch(css, /opacity\s*:/);
});

test('code/pre inside commentary stays readable (exempted to primary foreground)', () => {
  assert.match(css, /:is\(pre,\s*code\)\s*\{\s*color:\s*var\(--text-primary\)/);
});

test('final_answer keeps full emphasis', () => {
  assert.match(
    css,
    /\[data-assistant-phase="final_answer"\][^{]*\.chat-bubble-markdown\s*\{[^}]*color:\s*inherit/,
  );
});

test('the stylesheet is imported into the styles barrel', () => {
  const barrel = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(barrel, /@import url\("\.\/styles\/chat-commentary-v2\.css"\)/);
});
