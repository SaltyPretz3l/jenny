'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('invalid streaming observation reports a failing exit code', () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/observe/streaming-soak.js'), '--chars=invalid'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /could not complete/);
});
