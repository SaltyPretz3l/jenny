'use strict';

// UIUX-004 (UI_UX_COMPREHENSIVE_AUDIT_2026-07-12.md) responsive/legibility CSS contract.
//
// Pins the pieces of the minimum-window remediation that live in CSS:
//  - Diagnostics Activity collapses its list/detail layout and restacks rows.
//  - The composer must derive its width from its grid column, never from the
//    viewport (a 100vw-based width overflows the column when the artifact
//    review rail is open at narrow window widths).
//  - The narrow-layout ladder the lowered window floor exposes (Logs 980/760,
//    Chat 700) must keep existing so the floor change stays meaningful.

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

test('Diagnostics Activity uses bounded opaque console and detail surfaces', () => {
  const css = readStyle('diagnostics-activity.css');
  assert.match(blockFor(css, '.diagnostics-activity-console'), /background:\s*var\(--surface-input-background-strong\)/);
  assert.match(blockFor(css, '.logs-detail-panel'), /background:\s*var\(--surface-input-background-strong\)/);
});

test('composer width never derives from the viewport', () => {
  const composer = readStyle('chat-composer.css');
  const wrapBlock = blockFor(composer, '.composer-wrap');
  assert.ok(
    !/100vw/.test(wrapBlock),
    'base .composer-wrap sizing must be column-relative (no 100vw): a viewport-derived width overflows the grid column when the artifact rail is open'
  );

  const media = readStyle('chat-media-queries.css');
  // Any .composer-wrap rule inside media queries must not size via 100vw either.
  const composerRules = media.split('.composer-wrap').slice(1).map((chunk) => chunk.slice(0, chunk.indexOf('}')));
  for (const rule of composerRules) {
    assert.ok(
      !/width:\s*[^;]*100vw/.test(rule),
      `media-query .composer-wrap width must not use 100vw (found: ${rule.trim().slice(0, 120)})`
    );
  }
});

test('narrow-layout breakpoint ladder stays intact for the lowered window floor', () => {
  const diagnostics = readStyle('diagnostics-activity.css');
  assert.match(diagnostics, /@media \(max-width: 1240px\)/, 'Diagnostics list/detail collapse breakpoint must exist');
  assert.match(diagnostics, /@media \(max-width: 720px\)[\s\S]*\.log-entry-message\s*\{[\s\S]*grid-column:\s*1 \/ -1;/, 'Diagnostics messages must restack below row metadata');

  const media = readStyle('chat-media-queries.css');
  assert.match(media, /@media \(max-width: 700px\)/, 'Chat narrow-collapse breakpoint (700) must exist');
});
