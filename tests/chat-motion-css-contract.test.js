'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stylesDir = path.join(__dirname, '..', 'styles');

function readStyle(name) {
  return fs.readFileSync(path.join(stylesDir, name), 'utf8');
}

function blockFor(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `expected a "${selector} {" block`);
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

test('pending approval liveness belongs to the kicker dot', () => {
  const css = readStyle('chat-tool-markers.css');
  const sectionStart = css.indexOf('Approval-gap row visual distinction');
  const sectionEnd = css.indexOf('Approval batch banner', sectionStart);
  assert.notEqual(sectionStart, -1);
  assert.notEqual(sectionEnd, -1);
  const section = css.slice(sectionStart, sectionEnd);
  const selector = '.approval-gap-row[data-approval-status="pending"] .tool-approval-kicker-dot';

  assert.doesNotMatch(section, /border-(left|inline-start)/);
  assert.doesNotMatch(section, /approval-gap-pulse/);
  assert.match(blockFor(section, selector), /animation:\s*approval-kicker-breathe var\(--motion-duration-pulse\)/);

  const reducedMotion = section.slice(section.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(blockFor(reducedMotion, selector), /animation:\s*none/);
});

test('streaming reasoning has no tail dim mask', () => {
  for (const name of ['chat-machinery.css', 'chat-media-queries.css', 'foundation.css']) {
    const css = readStyle(name);
    assert.doesNotMatch(css, /streaming-tail-fade-mask/, name);
    assert.doesNotMatch(css, /\.reasoning-row-panel-body\s*\{\s*mask-image/, name);
  }
});

test('the jump-to-latest host enters briefly and honors reduced motion', () => {
  const css = readStyle('chat-composer-meta-affordances.css');
  const selector = '.composer-wayfinder-host:not([hidden])';
  assert.match(blockFor(css, selector), /animation:\s*chat-wayfinder-enter var\(--motion-duration-fast\)/);

  const reducedMotion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(blockFor(reducedMotion, selector), /animation:\s*none/);
});
