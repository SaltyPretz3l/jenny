'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('offline worker protocol and metadata unit contracts', { timeout: 30000 }, () => {
  const root = path.resolve(__dirname, '../..');
  const python = process.env.JENNY_TEST_PYTHON || path.join(root, '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests/worker'],
    { cwd: root, encoding: 'utf8', timeout: 25000, windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
});
