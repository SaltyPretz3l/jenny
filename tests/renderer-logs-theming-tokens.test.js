'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

test('Diagnostics uses the three canonical stylesheets and adaptive product tokens', () => {
  const styleNames = ['diagnostics-page.css', 'diagnostics-activity.css', 'diagnostics-performance.css'];
  const styleByName = Object.fromEntries(styleNames.map((name) => [name, fs.readFileSync(path.join(ROOT, 'styles', name), 'utf8')]));
  const styles = styleNames.map((name) => styleByName[name]).join('\n');
  const imports = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  assert.ok(imports.indexOf('diagnostics-page.css') >= 0);
  assert.ok(imports.indexOf('diagnostics-page.css') < imports.indexOf('diagnostics-activity.css'));
  assert.ok(imports.indexOf('diagnostics-activity.css') < imports.indexOf('diagnostics-performance.css'));
  assert.doesNotMatch(imports, /logs-page|settings-observability|diagnostics-health/);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b/i);
  assert.doesNotMatch(styles, /var\(--font-mono\)/);
  assert.doesNotMatch(styles, /backdrop-filter|font-family:\s*var\(--font-family-emotive\)/);
  assert.match(styles, /var\(--border-subtle\)/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /forced-colors:\s*active/);
  // The calm-icon law: no side accent bars, and layout keys off renderer data attributes, not :has().
  assert.doesNotMatch(styles, /border-(?:left|inline-start)(?:-width|-color)?:\s*(?:[2-9]|1\d)px/);
  assert.doesNotMatch(styles, /:has\(/);
  assert.doesNotMatch(styles, /!important/);
});
