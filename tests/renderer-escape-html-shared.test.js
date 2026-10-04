'use strict';

// One canonical renderer escapeHtml (renderer/shared/string-utils.js) with
// `value == null ? '' : String(value)` semantics: 0 and false are real values
// and must reach the markup. Forty local copies used `String(value || '')`,
// which silently rendered both as an empty string.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { escapeHtml } = require('../renderer/shared/string-utils');
const inventoryCheckbox = require('../renderer/inventory/checkbox');
const inventoryNumberInput = require('../renderer/inventory/number-input');
const inventoryActionButton = require('../renderer/inventory/action-button');

test('canonical escapeHtml keeps 0 and false and drops only null/undefined', () => {
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(false), 'false');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('a tool-result checkbox row carries exit code 0 and truncated=false into its data attributes', () => {
  const html = inventoryCheckbox.checkbox({
    id: 'tool-result-select',
    label: 'Select result',
    dataset: { 'tool-exit-code': 0, 'tool-truncated': false },
  });
  assert.match(html, /data-tool-exit-code="0"/);
  assert.match(html, /data-tool-truncated="false"/);
});

test('a number input seeded from a tool result keeps 0 and false in its data attributes', () => {
  const html = inventoryNumberInput({
    id: 'tool-result-retries',
    label: 'Retries',
    value: 0,
    min: 0,
    max: 5,
    dataset: { 'result-count': 0, 'result-cached': false },
  });
  assert.match(html, /data-result-count="0"/);
  assert.match(html, /data-result-cached="false"/);
  assert.match(html, /value="0"/);
});

test('the uninstall-window action button keeps its local escaper with the same semantics', () => {
  const html = inventoryActionButton({
    id: 'message-retry',
    label: 'Retry',
    dataset: { 'message-index': 0, 'message-pinned': false },
  });
  assert.match(html, /data-message-index="0"/);
  assert.match(html, /data-message-pinned="false"/);
});

test('renderer escapeHtml copies stay limited to files that cannot reach string-utils', () => {
  const allowed = new Set([
    'renderer/shared/string-utils.js', // the canonical helper
    // Load before renderer/shared/string-utils.js in index.html.
    'renderer/shared/markdown-raw-html-policy.js',
    'renderer/shared/markdown-utils.js',
    // uninstall.html loads these without string-utils.
    'renderer/inventory/action-button.js',
    'renderer/inventory/progress-bar.js',
    'renderer/inventory/text-field.js',
    'renderer/inventory/toggle-switch.js',
    'renderer/uninstall/renderer-uninstall-assistant.js',
  ]);
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && /function escapeHtml/.test(fs.readFileSync(full, 'utf8'))) {
        found.push(path.relative(ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(ROOT, 'renderer'));
  const unexpected = found.filter((file) => !allowed.has(file));
  assert.deepEqual(unexpected, [], `resolve escapeHtml from stringUtils instead of a local copy: ${unexpected.join(', ')}`);
  assert.ok(found.includes('renderer/shared/string-utils.js'), 'the walk must see the canonical helper');
});
