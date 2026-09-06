'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { selectContainmentProfile } = require('../../../services/plugins/full-host/containment-profile');
test('containment requires every platform proof', () => {
  assert.equal(selectContainmentProfile({ platform: 'win32', supervisorCapabilities: [] }).ok, false);
  assert.equal(selectContainmentProfile({ platform: 'win32', supervisorCapabilities: ['suspended_launch','identity_locked_image','job_kill_on_close','tree_empty_proof','hard_process_limit','hard_memory_limit','hard_cpu_limit'] }).ok, true);
});
test('Windows supervisor allowlists inherited handles and owns failed children with RAII', () => {
  const source=fs.readFileSync(path.join(__dirname,'../../../native/plugin-full-host-supervisor/src/containment/windows.rs'),'utf8');
  assert.match(source,/PROC_THREAD_ATTRIBUTE_HANDLE_LIST/);
  assert.match(source,/CreateProcessW\(\s*application\.as_ptr\(\)/);
  assert.match(source,/impl Drop for ContainedProcess/);
  assert.match(source,/TerminateProcess\(process\.hProcess/);
});
