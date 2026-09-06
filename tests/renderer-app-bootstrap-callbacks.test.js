const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

test('renderer app wires appendClientLog callbacks through lazy wrappers', () => {
  const appSource = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  const directCallbackLines = appSource
    .split(/\r?\n/)
    .map((line, index) => ({ lineNumber: index + 1, text: line.trim() }))
    .filter(({ text }) => /(^|[{,\s])appendClientLog\s*,/.test(text));

  assert.deepEqual(
    directCallbackLines,
    [],
    'appendClientLog callback wiring should use appendClientLog: (...a) => appendClientLog(...a) so bootstrap construction cannot touch a later lexical binding'
  );
});
