const test = require('node:test');
const assert = require('node:assert/strict');
const { createLedgerBridge } = require('../services/backend/owned-process-ledger-bridge');
test('ledger helper uses selected sidecar launch and bounded structured stdin', () => {
  let call;
  const bridge = createLedgerBridge({ file: '/profile/owned.json', command: '/bin/jenny-sidecar', args: [],
    cwd: '/app', platform: 'linux', spawnSyncImpl: (...args) => { call = args; return { status: 0, stdout: '{"ok":true}' }; } });
  assert.equal(bridge.run({ operation: 'retain', key: 'op_test', expected: {} }).ok, true);
  assert.equal(call[0], '/bin/jenny-sidecar');
  assert.deepEqual(call[1], ['--owned-process-ledger-helper']);
  assert.equal(JSON.parse(call[2].input).path, '/profile/owned.json');
  assert.equal(call[2].timeout, 3500);
  assert.equal(call[2].env.OPENAI_API_KEY, undefined);
});
test('Windows never invokes the ledger helper', () => {
  const bridge = createLedgerBridge({ platform: 'win32', spawnSyncImpl: () => { throw Error('must not spawn'); } });
  assert.equal(bridge.prepare(42), null);
  assert.equal(bridge.recover(), null);
});
test('helper failures warn and do not throw', () => {
  const logs = [];
  const bridge = createLedgerBridge({ file: '/profile/owned.json', command: '/sidecar', args: [], platform: 'linux',
    spawnSyncImpl: () => ({ status: 1 }), logger: (...args) => logs.push(args) });
  assert.equal(bridge.run({ operation: 'retain' }).ok, false);
  assert.equal(logs[0][1], 'runtime.owned_ledger.write_failed');
});


test('helper timeout consumes only the remaining sweep budget', () => {
  const timeouts = [];
  const bridge = createLedgerBridge({ file: '/profile/owned.json', command: '/sidecar', args: [], platform: 'linux',
    spawnSyncImpl: (command, args, options) => { timeouts.push(options.timeout); return { status: 1 }; } });
  bridge.run({ operation: 'retain' }, 700);
  bridge.run({ operation: 'retain' }, 0);
  assert.deepEqual(timeouts, [700]);
});
