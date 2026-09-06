const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');

const { OllamaProcessManager } = require('../services/backend/ollama-process-manager');

test('ollama command resolution retries after a miss and caches a later PATH hit', async () => {
  const originalExecFile = childProcess.execFile;
  let callCount = 0;
  childProcess.execFile = (_command, _args, _options, callback) => {
    callCount += 1;
    const currentCall = callCount;
    setImmediate(() => {
      if (currentCall === 1) {
        callback(new Error('not found'), '');
        return;
      }
      callback(null, 'C:\\Program Files\\Ollama\\ollama.exe\r\n');
    });
  };

  try {
    const manager = new OllamaProcessManager({
      platform: 'win32',
      stateStore: null,
      detectTrayConflictImpl: () => null,
    });

    assert.equal(await manager._resolveCommand(), null);
    assert.equal(manager._resolveCommandPromise, null);
    assert.equal(await manager._resolveCommand(), 'C:\\Program Files\\Ollama\\ollama.exe');
    assert.equal(await manager._resolveCommand(), 'C:\\Program Files\\Ollama\\ollama.exe');
    assert.equal(callCount, 2);
  } finally {
    childProcess.execFile = originalExecFile;
  }
});
