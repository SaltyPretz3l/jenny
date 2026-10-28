'use strict';

// Security review 2026-10-25 item 8: bare-name launches never resolve from the cwd.
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findOnPath, pathLookupCommand } = require('../services/backend/executable-on-path');
const { DockerLauncher } = require('../services/execution/docker-launcher');
const { OllamaProcessManager } = require('../services/backend/ollama-process-manager');

const OWNER_ID = 'a'.repeat(32);

async function withTempDirs(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-exe-on-path-'));
  const cwdDir = path.join(root, 'cwd');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(cwdDir);
  fs.mkdirSync(binDir);
  const previousCwd = process.cwd();
  process.chdir(cwdDir);
  try {
    return await run({ root, cwdDir, binDir });
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('findOnPath skips the cwd and relative PATH entries and only takes .com/.exe on Windows', async () => {
  await withTempDirs(({ cwdDir, binDir }) => {
    fs.writeFileSync(path.join(cwdDir, 'docker.exe'), '');
    const env = { PATH: ['.', 'cwd', binDir].join(';') };
    fs.writeFileSync(path.join(binDir, 'docker'), '');
    fs.writeFileSync(path.join(binDir, 'docker.cmd'), '');
    assert.equal(findOnPath('docker', { env, platform: 'win32' }), null);
    fs.writeFileSync(path.join(binDir, 'docker.exe'), '');
    assert.equal(findOnPath('docker', { env, platform: 'win32' }), path.win32.join(binDir, 'docker.exe'));
  });
});

test('Ollama detection runs the PATH-scoped lookup, not a bare where', async () => {
  const { lookupOllamaPath } = require('../services/ollama-detection');
  const spawned = [];
  const spawnImpl = (command, args) => { spawned.push([command, args]); throw new Error('stop'); };
  assert.equal(await lookupOllamaPath({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, spawnImpl }), '');
  assert.deepEqual(spawned[0], ['C:\\Windows\\System32\\where.exe', ['$PATH:ollama']]);
});

test('pathLookupCommand scopes where.exe to PATH by absolute System32 path', () => {
  assert.deepEqual(pathLookupCommand('ollama', { env: { SystemRoot: 'D:\\Win' }, platform: 'win32' }),
    ['D:\\Win\\System32\\where.exe', ['$PATH:ollama']]);
  assert.deepEqual(pathLookupCommand('ollama', { env: {}, platform: 'linux' }), ['which', ['ollama']]);
});

test('DockerLauncher on Windows resolves docker on PATH, never a cwd copy', async () => {
  await withTempDirs(async ({ root, cwdDir, binDir }) => {
    fs.writeFileSync(path.join(cwdDir, 'docker.exe'), '');
    const spawned = [];
    const spawnImpl = (command) => { spawned.push(command); throw new Error('stop'); };
    const env = { ProgramFiles: path.join(root, 'no-program-files'), PATH: binDir };

    const missing = new DockerLauncher({ ownerId: OWNER_ID, platform: 'win32', env, spawnImpl });
    assert.equal(missing.command, null);
    await assert.rejects(missing._run(['version'], { endpoint: false }), /docker_missing/u);
    assert.deepEqual(spawned, []);

    fs.writeFileSync(path.join(binDir, 'docker.exe'), '');
    const found = new DockerLauncher({ ownerId: OWNER_ID, platform: 'win32', env, spawnImpl });
    assert.equal(found.command, path.win32.join(binDir, 'docker.exe'));
  });
});

test('Ollama command lookup on Windows runs System32 where.exe scoped to PATH', async () => {
  const originalExecFile = childProcess.execFile;
  const calls = [];
  childProcess.execFile = (command, args, _options, callback) => {
    calls.push([command, args]);
    setImmediate(() => callback(null, 'C:\\Program Files\\Ollama\\ollama.exe\r\n'));
  };
  try {
    const manager = new OllamaProcessManager({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      stateStore: null,
      detectTrayConflictImpl: () => null,
    });
    assert.equal(await manager._resolveCommand(), 'C:\\Program Files\\Ollama\\ollama.exe');
    assert.deepEqual(calls, [['C:\\Windows\\System32\\where.exe', ['$PATH:ollama']]]);
  } finally {
    childProcess.execFile = originalExecFile;
  }
});
