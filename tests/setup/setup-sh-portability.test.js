'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('setup.sh expands USER_ARGS only in the bash 3.2-safe guarded form', () => {
  const lines = read('setup.sh').split('\n');
  const uses = lines.filter((line) => line.includes('USER_ARGS[@]') && !line.includes('USER_ARGS+='));
  assert.ok(uses.length >= 3, 'expected the parse check and both exec lines');
  for (const line of uses) {
    // An empty array under `set -u` aborts on bash < 4.4 unless guarded.
    const bare = line.replace(/\$\{USER_ARGS\[@\]\+"\$\{USER_ARGS\[@\]\}"\}/g, '');
    assert.ok(!bare.includes('USER_ARGS[@]'), `unguarded expansion: ${line.trim()}`);
  }
});

test('server/setup.js prompts contain no mis-decoded UTF-8 sequences', () => {
  assert.ok(!read('server', 'setup.js').includes('â€'));
});
