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

test('widget token defaults load after foundation before palette overrides', () => {
  const imports = readImports();

  assert.deepEqual(imports.slice(0, 4), [
    './styles/foundation.css',
    './styles/foundation-widget-tokens.css',
    './styles/motion.css',
    './styles/palette-paper.css',
  ]);
});

test('widget token defaults live in their focused token stylesheet', () => {
  const tokenCss = readRepoFile('styles/foundation-widget-tokens.css');
  const foundationCss = readRepoFile('styles/foundation.css');

  for (const token of [
    '--widget-button-primary-bg',
    '--widget-tool-success-color',
  ]) {
    assert.match(tokenCss, new RegExp(`${token}:`));
    assert.doesNotMatch(foundationCss, new RegExp(`${token}:`));
  }
});
