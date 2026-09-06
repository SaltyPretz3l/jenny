const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readSettingsImports() {
  return readRepoFile('styles/settings.css')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('@import'))
    .map((line) => line.match(/url\("([^"]+)"\)/)?.[1])
    .filter(Boolean);
}

test('settings attachment and popover CSS loads after settings controls', () => {
  const imports = readSettingsImports();
  const controlsIndex = imports.indexOf('./settings-controls.css');

  assert.notEqual(controlsIndex, -1);
  assert.equal(imports[controlsIndex + 1], './settings-attachments-popover.css');
});

test('settings attachment and popover selectors live in their focused stylesheet', () => {
  const focusedCss = readRepoFile('styles/settings-attachments-popover.css');
  const controlsCss = readRepoFile('styles/settings-controls.css');

  for (const selector of [
    '.attachment-chip',
    '.message-attachment-card',
    '.composer-popover',
  ]) {
    assert.match(focusedCss, new RegExp(`\\${selector}\\b`));
    assert.doesNotMatch(controlsCss, new RegExp(`\\${selector}\\b`));
  }
});
