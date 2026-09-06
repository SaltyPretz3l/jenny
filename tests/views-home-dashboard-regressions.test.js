const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'views-home-dashboard.css'), 'utf8');

test('rail Scratchpad reset outranks the later general resize rule', () => {
  const resetSelector = '.home-dashboard-rail .dashboard-scratchpad .inv-text-field-control';
  const resetRule = css.match(
    /\.home-dashboard-rail \.dashboard-scratchpad \.inv-text-field-control\s*\{([\s\S]*?)\}/
  )?.[1] || '';
  const generalSelector = '.dashboard-scratchpad .inv-text-field-control';
  const generalRule = css.match(
    /(?:^|\n)\.dashboard-scratchpad \.inv-text-field-control\s*\{([\s\S]*?)\}/
  )?.[1] || '';

  assert.match(resetRule, /resize:\s*none;/);
  assert.match(generalRule, /resize:\s*vertical;/);
  assert.ok(css.indexOf(resetSelector) < css.indexOf(generalSelector), 'fixture keeps the later competing rule');
  assert.ok(
    (resetSelector.match(/\./g) || []).length > (generalSelector.match(/\./g) || []).length,
    'the earlier reset needs greater class specificity than the later rule'
  );
});
