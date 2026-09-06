'use strict';

// spec-first: Darkroom palette CSS token contract. Tier P0.
// jsdom cannot compute CSS custom-property *values*, so these oracles parse the CSS
// file text for token presence (the same technique the shipping palette tests use).
// The actual matte/lavender *appearance* is MANUAL VERIFY, by design.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PALETTE_FILE = path.join(__dirname, '..', 'styles', 'palette-darkroom.css');
function readPalette() {
  return fs.readFileSync(PALETTE_FILE, 'utf8');
}

// Mandatory shared-semantics tokens enforced for every shipping palette CSS file
// (mirrors tests/appearance-utils.test.js so darkroom goes red BEFORE registration).
const SHARED_SEMANTIC_TOKENS = [
  '--widget-face-glow-color',
  '--widget-face-aura-primary',
  '--widget-face-aura-secondary',
  '--widget-face-shine-color',
  '--surface-composer-signal-background',
  '--widget-composer-signal-border',
  '--artifact-surface-focus-ring',
  /* --mermaid-node-label-* retired from the mandatory set (Artifact WS1):
   * Mermaid node colors are formula-derived from the palette accent in
   * renderer-mermaid-theme-utils.js; the tokens remain optional overrides. */
  '--settings-shell-accent',
  '--settings-shell-nav-bg',
  '--settings-shell-masthead-bg',
  '--settings-shell-panel-bg',
  '--settings-shell-field-bg',
  '--mat-live-accent',
];

test('S3 (Architecture, P0): darkroom declares every mandatory shared-semantics token', () => {
  // SPEC: S3 — the file satisfies the shared-palette-semantics gate (presence-only oracle;
  //   token *values* are MANUAL VERIFY).
  // RED-BECAUSE: the scaffold CSS declares none of them.
  const css = readPalette();
  for (const token of SHARED_SEMANTIC_TOKENS) {
    assert.match(css, new RegExp(`${token}:\\s*[^;]+;`), `palette-darkroom.css must declare ${token}`);
  }
  // UIUX-039: peripheral-garden's token surface was removed with the preset
  // (no bound controller ever consumed it) — assert absence, not presence.
  assert.doesNotMatch(
    css,
    /--widget-peripheral-garden-/,
    'palette-darkroom.css must not carry orphaned peripheral-garden tokens (UIUX-039, preset removed)'
  );
  // mat-live-border must be tinted from the live accent (matches the shipping contract).
  assert.match(
    css,
    /--mat-live-border:\s*color-mix\(in srgb,\s*[^;]+var\(--border-subtle\)\s*\);/,
    'palette-darkroom.css must tint --mat-live-border from the live accent'
  );
});

test('S9 (Experience, P1): darkroom declares all 8 Monaco --syntax-* tokens as bare hex', () => {
  // SPEC: S9 — the Monaco theme bridge reads --syntax-* via getComputedStyle and strips '#';
  //   the tokens must be bare hex (not color-mix/var chains).
  const css = readPalette();
  for (const name of ['keyword', 'string', 'comment', 'number', 'function', 'type', 'variable', 'constant']) {
    assert.match(
      css,
      new RegExp(`--syntax-${name}:\\s*#[0-9a-fA-F]{3,8};`),
      `--syntax-${name} must be a bare hex value for the Monaco bridge`
    );
  }
});

test('S10 (Experience, P1): quiet curtain inherits the synchronous darkroom semantic palette', () => {
  const overlayCss = fs.readFileSync(path.join(__dirname, '..', 'styles', 'startup-overlay.css'), 'utf8');
  assert.match(overlayCss, /--startup-bg:\s*var\(--bg-base\)/);
  assert.match(overlayCss, /--startup-mark-dot:\s*var\(--accent-cyan\)/);
  assert.match(overlayCss, /--startup-rule-fill:\s*var\(--accent-cyan\)/);
  assert.doesNotMatch(overlayCss, /startup-comet/);
});
