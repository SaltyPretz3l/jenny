'use strict';

// Shared fakes for the setup orchestrator tests: a recording UI, a child that
// closes on the next tick, and capture/deps defaults that satisfy the
// prerequisites on macOS.

const { EventEmitter } = require('events');

function makeUi() {
  const log = [];
  const rec = (kind) => (text) => log.push([kind, text]);
  return {
    log,
    heading: rec('heading'),
    step: rec('step'),
    ok: rec('ok'),
    skip: rec('skip'),
    warn: rec('warn'),
    fail: rec('fail'),
    info: rec('info'),
    progress: (label, percent) => log.push(['progress', label, percent]),
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}
function autoCloseSpawn(code) {
  return () => {
    const child = fakeChild();
    process.nextTick(() => child.emit('close', code));
    return child;
  };
}

function isVenvCommand(command) {
  return String(command || '').replaceAll('\\', '/').includes('/.venv/');
}

// A capture-run that satisfies prereqs on macOS and lets per-test overrides
// tweak the model-show / pip results.
function makeRunCapture({ modelShowStatus = 0, pipStatus = 0, pythonFound = true } = {}) {
  return (cmd, args = []) => {
    const joined = args.join(' ');
    if (joined.includes('--version')) {
      if (isVenvCommand(cmd)) {
        return joined.includes('-m pip')
          ? { status: 0, stdout: 'pip 24.3.1' }
          : { status: 0, stdout: 'Python 3.11.9' };
      }
      if (cmd === 'npm' || cmd === 'npm.cmd') return { status: 0, stdout: '10.9.2' };
      if (cmd === 'git') return { status: 0, stdout: 'git version 2.45.0' };
      if ((cmd === 'python3.11' || cmd === 'python3') && pythonFound) {
        return { status: 0, stdout: 'Python 3.11.9' };
      }
      return { status: 127, stdout: '', stderr: '' };
    }
    if (cmd === 'ollama' && args[0] === 'show') return { status: modelShowStatus };
    if (cmd === 'which' || cmd === 'where') return { status: 0, stdout: 'ollama\n' };
    if (joined.includes('pip install -e')) return { status: pipStatus, stderr: pipStatus ? 'pip boom' : '' };
    return { status: 0, stdout: '' };
  };
}

function baseDeps(overrides = {}) {
  return {
    runCapture: makeRunCapture(),
    runStreaming: async () => ({ status: 0 }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.30.10' }) }),
    spawnImpl: autoCloseSpawn(0),
    fileExists: () => true,
    sleepImpl: async () => {},
    promptYesNo: async () => true,
    rename: () => {},
    // A quarantine prune must never list or delete in the real checkout.
    readdir: () => [],
    rm: () => { throw new Error('unexpected rm'); },
    ...overrides,
  };
}

module.exports = { autoCloseSpawn, baseDeps, fakeChild, isVenvCommand, makeRunCapture, makeUi };
