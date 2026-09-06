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

test('inventory status row CSS loads immediately after inventory primitives', () => {
  const imports = readImports();
  const inventoryIndex = imports.indexOf('./renderer/inventory/inventory.css');

  assert.notEqual(inventoryIndex, -1);
  assert.equal(imports[inventoryIndex + 1], './renderer/inventory/inventory-status-row.css');
});

test('inventory status row selectors live in their focused stylesheet', () => {
  const statusRowCss = readRepoFile('renderer/inventory/inventory-status-row.css');
  const inventoryCss = readRepoFile('renderer/inventory/inventory.css');

  for (const selector of [
    '.inv-status-row',
    '.inv-status-row--pending',
    '.inv-context-usage',
  ]) {
    assert.match(statusRowCss, new RegExp(`\\${selector}\\b`));
    assert.doesNotMatch(inventoryCss, new RegExp(`\\${selector}\\b`));
  }
});
