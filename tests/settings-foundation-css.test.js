'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readSettingsBarrelImports() {
  return readRepoFile('styles/settings.css')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('@import'))
    .map((line) => line.match(/url\("([^"]+)"\)/)?.[1])
    .filter(Boolean);
}

test('settings barrel imports the foundation sheet exactly once, right after layout', () => {
  const imports = readSettingsBarrelImports();
  const occurrences = imports.filter((href) => href === './settings-foundation.css');
  assert.equal(occurrences.length, 1, 'foundation sheet imported exactly once');
  const layoutIndex = imports.indexOf('./settings-layout.css');
  assert.notEqual(layoutIndex, -1, 'settings-layout.css is in the barrel');
  assert.equal(
    imports[layoutIndex + 1],
    './settings-foundation.css',
    'foundation loads immediately after layout so section sheets can override it'
  );
});

test('foundation sheet defines the shared Phase 0 primitives', () => {
  const css = readRepoFile('styles/settings-foundation.css');
  for (const selector of [
    '.settings-group',
    '.settings-group-heading',
    '.settings-group-copy',
    '.settings-group--flush',
    '.settings-subsection',
    '.settings-card-header--subsection',
    '.settings-requires-note',
  ]) {
    assert.match(css, new RegExp(`\\${selector}\\b`), `missing ${selector}`);
  }
  assert.match(css, /\.settings-badge\[data-state="live"\]/, 'badge live tone defined');
  assert.match(css, /data-badge-state="loading"/, 'badge loading->live convention defined');
});

test('foundation primitives stay flat (calm de-vibe: no gradients)', () => {
  const css = readRepoFile('styles/settings-foundation.css');
  assert.doesNotMatch(css, /linear-gradient|radial-gradient/, 'foundation primitives stay flat (no gradients)');
});

test('settings-grid sheet defines the 2026-07 redesign primitives and stays flat', () => {
  const imports = readSettingsBarrelImports();
  assert.ok(imports.includes('./settings-grid.css'), 'grid sheet is in the barrel');
  assert.ok(
    imports.indexOf('./settings-grid.css') > imports.indexOf('./settings-controls.css'),
    'grid sheet loads after the section sheets so its overrides win'
  );

  const css = readRepoFile('styles/settings-grid.css');
  assert.match(
    css,
    /\.settings-content-scroll \.settings-card\.settings-section-active\s*\{[^}]*display:\s*grid/,
    'active section card flips to grid at the same specificity settings-sections.css shows it'
  );
  assert.match(
    css,
    /\.settings-toggle-list \.inv-toggle\s*\{[^}]*flex-direction:\s*row-reverse/,
    'toggle rows read label-first via row-reverse (DOM order stays track-first)'
  );
  for (const selector of [
    '.settings-group--wide',
    '.settings-toggle-list .inv-toggle-description',
    '.settings-field-row',
    '.settings-field-description',
    '.settings-primary',
  ]) {
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
  assert.doesNotMatch(css, /linear-gradient|radial-gradient/, 'grid primitives stay flat (no gradients)');

  // 2026-07 open-sections polish: groups are typographic units, not boxes —
  // kicker heading over a hairline rule — and row labels ride the bumped
  // type step so settings read at a glance.
  assert.match(
    css,
    /\.settings-card \.settings-group,[\s\S]*?\{[^}]*background:\s*none/,
    'groups carry no box surface (open sections)'
  );
  assert.match(
    css,
    /\.settings-card \.settings-group-heading\s*\{[^}]*text-transform:\s*uppercase/,
    'group headings are kicker-style'
  );
  assert.match(
    css,
    /\.settings-toggle-list \.inv-toggle-label\s*\{[^}]*font-size:\s*var\(--font-size-card-title\)/,
    'toggle row labels use the bumped type step'
  );
});
