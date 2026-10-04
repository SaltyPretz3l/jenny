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

test('submit wire requires a valid project input root', () => {
  const { validateRequest, validateCommand } = require('../../services/execution/worker-protocol');
  const id = '11111111-1111-4111-8111-111111111111';
  const request = { schema_version: 1, request_id: id, operation: 'submit', incarnation: id,
    job_id: id, command: 'true', cwd: '.', timeout_seconds: 1 };
  assert.throws(() => validateRequest(request), /worker_request_keys_invalid/);
  assert.equal(validateCommand({ command: 'true' }).inputRoot, '.');
  assert.equal(validateRequest({ ...request, input_root: 'projects/a' }).input_root, 'projects/a');
  for (const inputRoot of ['..', 'a/../b', '/abs', 'a\\b', '', 'c:x']) {
    assert.throws(() => validateRequest({ ...request, input_root: inputRoot }));
    assert.throws(() => validateCommand({ command: 'true', inputRoot }), /sandbox_input_root_invalid/);
  }
});
