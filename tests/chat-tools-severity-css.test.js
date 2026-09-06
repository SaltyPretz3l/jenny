const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readImports() {
  return readRepoFile('styles.css')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('@import'))
    .map((line) => line.match(/url\("([^"]+)"\)/)?.[1])
    .filter(Boolean);
}

test('tool block v2 + machinery stylesheets stay registered in styles.css (machinery last)', () => {
  const imports = readImports();
  assert.ok(imports.includes('./styles/chat-tool-block-v2.css'));
  assert.ok(imports.includes('./styles/chat-machinery.css'));
  // The machinery grammar must import AFTER the structural tool stylesheets so
  // its equal-specificity declarations win the cascade.
  assert.ok(
    imports.indexOf('./styles/chat-machinery.css') > imports.indexOf('./styles/chat-tool-block-v2.css'),
    'chat-machinery.css must import after chat-tool-block-v2.css'
  );
  assert.ok(
    imports.indexOf('./styles/chat-machinery.css') > imports.indexOf('./styles/chat-tools.css'),
    'chat-machinery.css must import after chat-tools.css'
  );
});

test('tool row severity accents live in the machinery grammar, sourced from --tl-status-*', () => {
  // Quiet-timeline overhaul: severity/status accent mapping moved from
  // chat-tool-block-v2.css into chat-machinery.css and derives exclusively
  // from the shared --tl-status-* aliases.
  const css = readRepoFile('styles/chat-machinery.css');

  assert.match(css, /\.tool-call-row\[data-tool-severity="danger"\][^{]*\{[^}]*var\(--tl-status-error\)/);
  assert.match(css, /\.tool-call-row\[data-tool-severity="caution"\]/);
  assert.match(css, /\.tool-call-row\[data-tool-severity="calm"\][^{]*\{[^}]*var\(--tl-status-muted\)/);
  assert.match(css, /\.tool-result-row\[data-tool-severity="danger"\]/);
  assert.match(css, /data-tool-severity="caution"\][^{]*\{[^}]*var\(--tl-status-warn\)/);

  // Unified headers use the same status-label class in both row families.
  assert.match(css, /\[data-tool-severity="danger"\] \.tool-call-status-label[^{]*\{[^}]*var\(--tl-status-error\)/);
  assert.match(css, /\[data-tool-severity="caution"\] \.tool-call-status-label[^{]*\{[^}]*var\(--tl-status-warn\)/);
});

test('v2 tool rows no longer enumerate terminal statuses per selector', () => {
  for (const relativePath of ['styles/chat-tool-block-v2.css', 'styles/chat-machinery.css']) {
    const css = readRepoFile(relativePath);
    for (const status of ['denied', 'timed_out', 'cancelled', 'interrupted', 'abandoned']) {
      assert.doesNotMatch(
        css,
        new RegExp(`\\.tool-call-row\\[data-tool-status="${status}"\\]`),
        `${relativePath} should map terminal severity via data-tool-severity, not per-status selectors`
      );
    }
  }
});

test('minimal-row path chips shrink and truncate without displacing status metadata', () => {
  const css = readRepoFile('styles/chat-machinery.css');
  const rule = css.match(/\.tool-call-row--minimal \.tool-path-chip\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(rule, /flex:\s*0 1 50%/);
  assert.match(rule, /min-width:\s*0/);
  assert.match(rule, /overflow:\s*hidden/);
  assert.match(rule, /text-overflow:\s*ellipsis/);
  assert.match(rule, /white-space:\s*nowrap/);
});

test('minimal tool rows use the shared trailing disclosure and rotate it in place', () => {
  const css = readRepoFile('styles/chat-machinery.css');
  const disclosureRule = css.match(/\.reasoning-row-caret,\s*\.tool-call-disclosure\s*\{([^}]+)\}/)?.[1] || '';
  const expandedRule = css.match(/\.tool-call-row--minimal \.tool-call-row-toggle\[aria-expanded="true"\] \.tool-call-disclosure\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(disclosureRule, /transform:\s*rotate\(45deg\)/);
  assert.match(expandedRule, /transform:\s*rotate\(-135deg\)/);
  assert.doesNotMatch(css, /tool-call-caret/);
});
