'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerOllamaDaemonIpcHandlers } = require('../services/main/ollama-daemon-ipc');

test('daemon stop IPC denies untrusted senders and forwards only an expected identity', async () => {
  let handler, calls = [];
  registerOllamaDaemonIpcHandlers({ handle: (_channel, fn) => { handler = fn; } }, {
    getManager: () => ({ _getOwnedPid: () => 456 }),
    authorization: { authorize: (event) => event?.trusted === true },
    stopImpl: async (options) => {
      calls.push(options);
      assert.equal(options.getOwnedPid(), 456);
      return { stopped: true, pid: options.expectedPid };
    },
  });
  assert.equal(handler({ trusted: false }, { pid: 123 }).authorized, false);
  assert.equal(calls.length, 0);
  assert.deepEqual(await handler({ trusted: true }, { pid: 123, startTime: '987', program: '/usr/bin/ollama', command: 'evil' }),
    { stopped: true, pid: 123 });
  assert.equal(calls[0].expectedStartTime, '987');
  assert.equal(calls[0].expectedProgram, '/usr/bin/ollama');
  assert.equal(calls[0].command, undefined);
});
