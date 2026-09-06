const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'ide-view.css'), 'utf8');

test('narrow IDE shells with an open secondary sidebar collapse to one column', () => {
  const responsiveOpenRule = css.match(
    /\.ide-shell\[data-secondary-open="true"\],\s*\.ide-shell\[data-rail-side="left"\]\[data-secondary-open="true"\]\s*\{([\s\S]*?)\}/
  )?.[1] || '';

  assert.match(responsiveOpenRule, /grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(responsiveOpenRule, /grid-template-areas:\s*"main" "secondary" "rail";/);
});
