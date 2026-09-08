const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('ollama command resolution prefers and caches the managed linux binary', async () => {
  const originalExecFile = childProcess.execFile;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-command-'));
  const xdgDataHome = tempDir.replaceAll('\\', '/');
  const managedBinary = path.posix.join(xdgDataHome, 'jenny', 'ollama', 'bin', 'ollama');
  fs.mkdirSync(path.dirname(managedBinary), { recursive: true });
  fs.writeFileSync(managedBinary, '');
  let callCount = 0;
  childProcess.execFile = (_command, _args, _options, callback) => {
    callCount += 1;
    setImmediate(() => callback(new Error('not found'), ''));
  };

  try {
    const manager = new OllamaProcessManager({
      platform: 'linux',
      env: { XDG_DATA_HOME: xdgDataHome },
      stateStore: null,
      detectTrayConflictImpl: () => null,
    });

    assert.equal(await manager._resolveCommand(), managedBinary);
    assert.equal(await manager._resolveCommand(), managedBinary);
    assert.equal(callCount, 0);
  } finally {
    childProcess.execFile = originalExecFile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('ollama command resolution falls through to which when no managed linux binary exists', async () => {
  const originalExecFile = childProcess.execFile;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-command-miss-'));
  let callCount = 0;
  childProcess.execFile = (command, args, _options, callback) => {
    callCount += 1;
    assert.equal(command, 'which');
    assert.deepEqual(args, ['ollama']);
    setImmediate(() => callback(null, '/usr/bin/ollama\n'));
  };

  try {
    const manager = new OllamaProcessManager({
      platform: 'linux',
      env: { XDG_DATA_HOME: tempDir.replaceAll('\\', '/') },
      stateStore: null,
      detectTrayConflictImpl: () => null,
    });

    assert.equal(await manager._resolveCommand(), '/usr/bin/ollama');
    assert.equal(callCount, 1);
  } finally {
    childProcess.execFile = originalExecFile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('ollama command resolution re-probes after stop so a managed linux install replaces a system hit', async () => {
  const originalExecFile = childProcess.execFile;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-command-'));
  const xdgDataHome = tempDir.replaceAll('\\', '/');
  const managedBinary = path.posix.join(xdgDataHome, 'jenny', 'ollama', 'bin', 'ollama');
  let callCount = 0;
  childProcess.execFile = (_command, _args, _options, callback) => {
    callCount += 1;
    setImmediate(() => callback(null, '/usr/bin/ollama\n'));
  };

  try {
    const manager = new OllamaProcessManager({
      platform: 'linux',
      env: { XDG_DATA_HOME: xdgDataHome },
      stateStore: null,
      detectTrayConflictImpl: () => null,
    });
    manager._isRunning = async () => false;

    assert.equal(await manager._resolveCommand(), '/usr/bin/ollama');
    assert.equal(await manager._resolveCommand(), '/usr/bin/ollama');
    assert.equal(callCount, 1);

    fs.mkdirSync(path.dirname(managedBinary), { recursive: true });
    fs.writeFileSync(managedBinary, '');
    assert.equal(await manager._resolveCommand(), '/usr/bin/ollama', 'the cache still names the system binary');

    await manager.stop();
    assert.equal(manager._resolveCommandPromise, null);
    assert.equal(await manager._resolveCommand(), managedBinary);
    assert.equal(callCount, 1, 'the managed binary wins without another which lookup');
  } finally {
    childProcess.execFile = originalExecFile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
