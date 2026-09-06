'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_COMPONENT_BYTES,
  pipeAddress,
  restrictedHostSpawnOptions,
  RestrictedHostProcessSupervisor,
} = require('../../../services/plugins/restricted-host/process-supervisor');

test('process supervisor rejects empty and oversized components before runtime resolution', async () => {
  let resolved = false;
  const supervisor = new RestrictedHostProcessSupervisor({
    resolveRuntime: async () => { resolved = true; throw new Error('must not resolve'); },
  });
  assert.deepEqual(await supervisor.start({}, Buffer.alloc(0)), {
    ok: false, reason: 'restricted_host_start_invalid',
  });
  assert.deepEqual(await supervisor.start({}, Buffer.alloc(MAX_COMPONENT_BYTES + 1)), {
    ok: false, reason: 'restricted_host_start_invalid',
  });
  assert.equal(resolved, false);
  await supervisor.dispose();
});

test('platform socket addresses match the host namespace mapping', () => {
  assert.equal(pipeAddress('jenny-plugin-test', 'win32'), '\\\\.\\pipe\\jenny-plugin-test');
  assert.equal(pipeAddress('jenny-plugin-test', 'linux'), '\0jenny-plugin-test');
  assert.equal(pipeAddress('jenny-plugin-test', 'darwin'), '/tmp/jenny-plugin-test');
});

test('an already-aborted startup is refused before runtime resolution', async () => {
  const abort = new AbortController();
  abort.abort();
  let resolved = false;
  const supervisor = new RestrictedHostProcessSupervisor({
    resolveRuntime: async () => { resolved = true; return { ok: false }; },
  });
  assert.deepEqual(await supervisor.start({}, Buffer.from('component'), {
    signal: abort.signal,
  }), { ok: false, reason: 'restricted_host_start_invalid' });
  assert.equal(resolved, false);
  await supervisor.dispose();
});

test('helper launch inherits no plugin/user environment and has no inherited stdio', () => {
  const options = restrictedHostSpawnOptions('win32', {
    SystemRoot: 'C:\\Windows',
    CANARY_SECRET: 'CANARY_SECRET_PLACEHOLDER_do-not-inherit',
    PATH: 'C:\\sensitive\\bin',
  });
  assert.deepEqual(options.env, { SystemRoot: 'C:\\Windows' });
  assert.deepEqual(options.stdio, ['ignore', 'ignore', 'pipe']);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(JSON.stringify(options).includes('CANARY_SECRET_PLACEHOLDER'), false);
});

test('process supervisor degrades when the packaged runtime is unavailable', async () => {
  const supervisor = new RestrictedHostProcessSupervisor({
    resolveRuntime: async () => ({ ok: false, reason: 'restricted_host_runtime_missing' }),
    crashCircuit: { isOpen: () => false },
  });
  assert.deepEqual(await supervisor.start({}, Buffer.from('component')), {
    ok: false, reason: 'restricted_host_runtime_missing',
  });
  await supervisor.dispose();
});
