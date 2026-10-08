'use strict';

// Ollama runners left behind when Jenny's `ollama serve` died with the app
// (gate sitting 2026-10-07: the app died mid-shutdown, Node's job object took
// `ollama serve` down, and its lib\ollama\llama-server.exe runner kept ~10 GB
// of VRAM). Windows runners must be discoverable, and a dead recorded root's
// surviving runners are reaped on the next start or stop.
const test = require('node:test');
const assert = require('node:assert/strict');

const { OllamaProcessManager } = require('../services/backend/ollama-process-manager');
const { listWindowsOllamaRunnersSync } = require('../services/backend/ollama-orphan-runners');

const ROOT = 25776;
const OLLAMA_DIR = 'C:\\Users\\me\\AppData\\Local\\Programs\\Ollama';

function windowsListing() {
  return [
    { ProcessId: 6864, ParentProcessId: ROOT, Name: 'llama-server.exe', ExecutablePath: `${OLLAMA_DIR}\\lib\\ollama\\llama-server.exe` },
    { ProcessId: 7000, ParentProcessId: ROOT, Name: 'ollama.exe', ExecutablePath: `${OLLAMA_DIR}\\ollama.exe` },
    // Jenny's own managed llama-server: same image name, not Ollama's runner.
    { ProcessId: 7100, ParentProcessId: ROOT, Name: 'llama-server.exe', ExecutablePath: 'G:\\engines\\llama.cpp\\llama-server.exe' },
    // A runner of somebody else's Ollama.
    { ProcessId: 7200, ParentProcessId: 4242, Name: 'llama-server.exe', ExecutablePath: `${OLLAMA_DIR}\\lib\\ollama\\llama-server.exe` },
  ];
}

test('the Windows runner listing includes Ollama\'s bundled llama-server, not another llama-server', () => {
  const calls = [];
  const entries = listWindowsOllamaRunnersSync({
    execFileSyncImpl: (file, args) => { calls.push([file, args.at(-1)]); return JSON.stringify(windowsListing()); },
  });
  assert.equal(calls.length, 1, 'one query');
  assert.match(calls[0][1], /llama-server\.exe/);
  assert.deepEqual(entries.map((entry) => entry.pid).sort(), [6864, 7000, 7200]);
  assert.deepEqual(entries.find((entry) => entry.pid === 6864), {
    pid: 6864, parentPid: ROOT, name: 'llama-server.exe', executablePath: `${OLLAMA_DIR}\\lib\\ollama\\llama-server.exe`,
  });
});

test('a failing Windows runner query degrades to an empty listing', () => {
  const entries = listWindowsOllamaRunnersSync({ execFileSyncImpl: () => { throw new Error('no powershell'); } });
  assert.deepEqual(entries, []);
});

function staleRootManager({ killCalls, deletes, logs }) {
  const entries = windowsListing().map((record) => ({
    pid: record.ProcessId, parentPid: record.ParentProcessId, name: record.Name, executablePath: record.ExecutablePath,
  })).filter((entry) => entry.pid !== 7100);
  return new OllamaProcessManager({
    platform: 'win32',
    stateStore: {
      read: () => ({ pid: ROOT, app_owned: true, command: `${OLLAMA_DIR}\\ollama.exe`, startedAt: '2026-10-07T18:55:00.000Z' }),
      write: () => {},
      delete: () => deletes.push(ROOT),
    },
    logger: (level, event, details) => logs.push({ level, event, details }),
    isProcessAliveImpl: () => false, // the recorded root died with the app
    killProcessTreeImpl: async (pid, options = {}) => { killCalls.push({ pid, force: Boolean(options.force) }); },
    listOllamaRunnerProcessesImpl: () => entries,
    forceKillAnyRemainingLocalOllamaSyncImpl: () => { throw new Error('a dead root must not authorize a sweep'); },
    clearOwnedOllamaStateImpl: () => {},
    detectTrayConflictImpl: () => null,
  });
}

test('stop() reaps the surviving runners of a dead recorded root, and only those', async () => {
  const killCalls = [], deletes = [], logs = [];
  const manager = staleRootManager({ killCalls, deletes, logs });
  await manager.stop();
  assert.deepEqual(killCalls.map((call) => call.pid).sort(), [6864, 7000]);
  assert.ok(killCalls.every((call) => call.force));
  assert.deepEqual(deletes, [ROOT], 'the stale record is still cleared');
  assert.ok(logs.some((entry) => entry.event === 'ollama.killing_orphaned_runner' && entry.details.pid === 6864));
});

test('start() reaps a dead recorded root\'s runners before it clears the record', async () => {
  const killCalls = [], deletes = [], logs = [];
  const manager = staleRootManager({ killCalls, deletes, logs });
  manager._isRunning = async () => true; // an external server answers: start() stops after the stale check
  await manager.start();
  assert.deepEqual(killCalls.map((call) => call.pid).sort(), [6864, 7000]);
  assert.deepEqual(deletes, [ROOT]);
});

test('stop({ scope: any_local }) reaps a dead recorded root\'s runners without a wider sweep', async () => {
  const killCalls = [], deletes = [], logs = [];
  const manager = staleRootManager({ killCalls, deletes, logs });
  manager._isRunning = async () => false;
  await manager.stop({ scope: 'any_local' });
  assert.deepEqual(killCalls.map((call) => call.pid).sort(), [6864, 7000]);
});
