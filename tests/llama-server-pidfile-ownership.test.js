'use strict';

// Every launch shares one pid record (`llama-server.pid` under userData). A
// launch may clear it only while it still names that launch's child: the
// acceleration fallback relaunches the moment the accelerated attempt is
// killed, and the killed child's 'exit' can land after the retry wrote its own
// record. Deleting the retry's record leaves the running server unreapable if
// Jenny's main process dies (the next boot's reapStalePidFile finds nothing).
// A child that already exited is never killed either: Node reaped it, so its
// pid may already belong to another process.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const lifecycle = require('../services/llama-server-lifecycle');
const { forceKillProcessTreeSync } = require('../services/backend/sidecar-shutdown');
const { clearOwnedPidFile } = require('../services/llama-server-pidfile');
const { createLlamaServerManager } = require('../services/main/llama-server-manager');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');
const {
  FakeChildProcess,
  closeServer,
  getClosedPort,
  listen,
  makeUserDataDir,
  startReadyFakeServer,
  writeIdentityPidFile,
} = require('./helpers/llama-server-lifecycle-fixtures');

const { PID_FILENAME, clearPidFile, readPidFile, startLlamaServer } = lifecycle;

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const FOREIGN_RECORD = Object.freeze({
  pid: 46099,
  command: 'llama-server.exe -m other.gguf',
  startedAt: '2026-09-18T00:00:00.000Z',
});
const MTP_ACCELERATION = Object.freeze({
  mode: 'mtp',
  reason: 'verified',
  drafter: 'mtp-model.gguf',
  extraArgs: ['--spec-type', 'draft-mtp'],
  vramHeadroomMb: 0,
});
const TYPE_142 = "E gguf_init_from_reader: tensor 'output.weight' has invalid ggml type 142. should be in [0, 43)";

const recordedPid = (userDataPath) => readPidFile(path.join(userDataPath, PID_FILENAME)).pid;

// Never ready (unless `serving`), so the accelerated attempt times out; the
// model list answers the retry's readiness poll but never the reuse probe's
// alias, so nothing is mistaken for a server to reuse.
async function startScriptedServer() {
  const script = { serving: false };
  const server = http.createServer((_request, response) => {
    if (!script.serving) {
      response.statusCode = 503;
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'served-by-the-retry' }] }));
  });
  const baseUrl = await listen(server);
  return { server, script, port: Number(new URL(baseUrl).port) };
}

function launchOptions(userDataPath, overrides) {
  return {
    modelTag: 'qwen3:0.5b',
    binaryPath: path.join(userDataPath, 'llama-server.exe'),
    modelPath: path.join(userDataPath, 'model.gguf'),
    userDataPath,
    readinessPollIntervalMs: 1,
    platform: 'win32',
    spawnSyncImpl: () => ({ status: 0 }),
    isProcessAliveImpl: () => false,
    ...overrides,
  };
}

// A Linux launch whose kills are recorded, never sent: process.kill throws
// ESRCH, as a kill of a pid Node already reaped does.
async function launchOnLinux({ stderrLines = [], exits = true, readinessTimeoutMs = 5000 } = {}) {
  const userDataPath = makeUserDataDir('jenny-pidfile-linux-kill-');
  const child = new FakeChildProcess(46051);
  const kills = [];
  const realKill = process.kill;
  process.kill = (pid, signal) => {
    kills.push([pid, signal]);
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH', syscall: 'kill' });
  };
  try {
    const error = await startLlamaServer(launchOptions(userDataPath, {
      binaryPath: path.join(userDataPath, 'llama-server'),
      runtimeSource: 'bundled',
      port: await getClosedPort(),
      readinessTimeoutMs,
      platform: 'linux',
      spawnImpl: () => {
        if (exits) {
          setImmediate(() => {
            for (const line of stderrLines) child.stderr.emit('data', `${line}\n`);
            child.emit('exit', 1, null);
            child.stderr.emit('end');
          });
        }
        return child;
      },
    })).then(() => null, (rejection) => rejection);
    return { error, kills, userDataPath };
  } finally {
    process.kill = realKill;
  }
}

test('clearOwnedPidFile removes only a record naming that pid', () => {
  const dir = makeUserDataDir('jenny-pidfile-owned-clear-');
  const pidPath = path.join(dir, PID_FILENAME);

  writeIdentityPidFile(dir, { ...FOREIGN_RECORD, pid: 7002 });
  const foreign = fs.readFileSync(pidPath, 'utf8');
  clearOwnedPidFile(pidPath, 7001);
  assert.equal(fs.readFileSync(pidPath, 'utf8'), foreign, 'another launch\'s record is kept byte for byte');

  for (const pid of [undefined, null, 0, -7002, '7002', 7002.5, { pid: 7002 }]) {
    clearOwnedPidFile(pidPath, pid);
    assert.equal(fs.existsSync(pidPath), true, `no positive integer pid owns nothing: ${JSON.stringify(pid)}`);
  }

  clearOwnedPidFile(pidPath, 7002);
  assert.equal(fs.existsSync(pidPath), false, 'the owner clears its own record');
  clearOwnedPidFile(pidPath, 7002);
  assert.equal(fs.existsSync(pidPath), false, 'a missing record is not an error');

  fs.writeFileSync(pidPath, 'not json', 'utf8');
  clearOwnedPidFile(pidPath, 7002);
  assert.equal(fs.existsSync(pidPath), true, 'an unreadable record is left for the boot reaper');
  clearPidFile(pidPath);
  assert.equal(fs.existsSync(pidPath), false, 'clearPidFile stays unconditional (the reaper and shutdown)');
});

test('a force-killed launch\'s late exit leaves the next launch\'s record', async () => {
  const userDataPath = makeUserDataDir('jenny-pidfile-late-exit-');
  const first = new FakeChildProcess(46001);
  await assert.rejects(startLlamaServer(launchOptions(userDataPath, {
    port: await getClosedPort(),
    readinessTimeoutMs: 50,
    spawnImpl: () => first,
  })), /llama_server_readiness_timeout/);
  assert.equal(recordedPid(userDataPath), 0, 'the timed-out launch cleared its own record');

  const second = new FakeChildProcess(46002);
  const { handle, server } = await startReadyFakeServer({ userDataPath, child: second, logs: [] });
  try {
    assert.equal(recordedPid(userDataPath), 46002);
    first.emit('exit', 1, null);
    assert.equal(recordedPid(userDataPath), 46002, 'the first child\'s exit must not delete the running server\'s record');
    second.emit('exit', 0, null);
    assert.equal(recordedPid(userDataPath), 0, 'the running server\'s own exit still clears it');
    assert.deepEqual(await handle.stop(), { confirmed: true });
  } finally {
    await closeServer(server);
  }
});

test('an accelerated launch that times out and falls back keeps the retry reapable after the first child exits', async () => {
  const userDataPath = makeUserDataDir('jenny-pidfile-mtp-fallback-');
  const binaryPath = path.join(userDataPath, 'llama-server.exe');
  fs.writeFileSync(binaryPath, '');
  const { server, script, port } = await startScriptedServer();
  const children = [];
  const logs = [];
  const manager = createLlamaServerManager({
    userDataPath,
    rootDir: userDataPath,
    processRef: {
      env: { JENNY_LLAMA_SERVER_PORT: String(port), JENNY_LLAMA_SERVER_BINARY: binaryPath },
      resourcesPath: '',
    },
    lifecycle: {
      ...lifecycle,
      startLlamaServer: (options) => lifecycle.startLlamaServer({
        ...options,
        // The drafted attempt must time out; the retry gets room on a busy host.
        readinessTimeoutMs: children.length === 0 ? 150 : 10_000,
        readinessPollIntervalMs: 5,
        platform: 'win32',
        spawnSyncImpl: () => ({ status: 0 }),
        isProcessAliveImpl: () => false,
        spawnImpl: () => {
          const child = new FakeChildProcess(46011 + children.length);
          children.push(child);
          // The drafted (MTP) attempt never serves; the unaccelerated retry does.
          script.serving = children.length === 2;
          return child;
        },
      }),
    },
    resolveLaunchAccelerationImpl: () => MTP_ACCELERATION,
    log: (level, event, details) => logs.push({ level, event, details }),
  });
  try {
    const status = await manager.ensureRunning({
      modelTag: 'qwen3:0.5b',
      modelPath: path.join(userDataPath, 'model.gguf'),
    });
    assert.equal(status.state, 'ready', JSON.stringify(status));
    assert.equal(status.pid, 46012);
    assert.equal(status.accelerationMode, 'off');
    assert.ok(logs.some((entry) => entry.event === 'llama.server.acceleration_fallback'));
    assert.equal(recordedPid(userDataPath), 46012);

    children[0].emit('exit', 1, null);
    assert.equal(recordedPid(userDataPath), 46012, 'the retry keeps its pid record, so a dead main process leaves it reapable');
    assert.equal(manager.getStatus().state, 'ready');
    assert.equal(manager.getStatus().pid, 46012);
  } finally {
    await manager.stop();
    await closeServer(server);
  }
});

test('the killed attempt\'s late exit does not hide the retry dying before the manager recorded it', async () => {
  const userDataPath = makeUserDataDir('jenny-pidfile-early-exit-');
  const binaryPath = path.join(userDataPath, 'llama-server.exe');
  fs.writeFileSync(binaryPath, '');
  let attempts = 0;
  const manager = createLlamaServerManager({
    userDataPath,
    rootDir: userDataPath,
    processRef: {
      env: { JENNY_LLAMA_SERVER_PORT: String(await getClosedPort()), JENNY_LLAMA_SERVER_BINARY: binaryPath },
      resourcesPath: '',
    },
    lifecycle: {
      ...lifecycle,
      startLlamaServer: async (options) => {
        attempts += 1;
        if (attempts === 1) throw new Error('llama_server_readiness_timeout');
        // The retry answered readiness and then died, and then the killed
        // accelerated attempt's exit landed, all before launch() looked.
        options.onExit({ pid: 46062, code: 1, signal: null });
        options.onExit({ pid: 46061, code: 1, signal: null });
        return {
          pid: 46062,
          baseUrl: 'http://127.0.0.1:1/v1',
          reused: false,
          mmproj: '',
          apiKey: 'test-key',
          stop: async () => ({ confirmed: true }),
          stopSync: () => {},
        };
      },
    },
    resolveLaunchAccelerationImpl: () => MTP_ACCELERATION,
  });
  const status = await manager.ensureRunning({
    modelTag: 'qwen3:0.5b',
    modelPath: path.join(userDataPath, 'model.gguf'),
  });
  assert.equal(status.state, 'stopped', JSON.stringify(status));
  assert.equal(status.lastError, 'llama_server_exited:1');
});

test('every other per-launch clear leaves a record that names another launch', async () => {
  // The readiness timeout's force kill. The timeout is logged right before the
  // kill, so another launch's record lands after this launch wrote its own.
  const timeoutDir = makeUserDataDir('jenny-pidfile-timeout-kill-');
  await assert.rejects(startLlamaServer(launchOptions(timeoutDir, {
    port: await getClosedPort(),
    readinessTimeoutMs: 30,
    spawnImpl: () => new FakeChildProcess(46021),
    logger: (_level, event) => {
      if (event === 'llama.server.readiness_timeout') {
        assert.equal(recordedPid(timeoutDir), 46021, 'precondition: this launch wrote its record');
        writeIdentityPidFile(timeoutDir, FOREIGN_RECORD);
      }
    },
  })), /llama_server_readiness_timeout/);
  assert.equal(recordedPid(timeoutDir), 46099, 'the timeout kill cleared a record it did not own');

  // stop() and stopSync() on a handle whose child already exited.
  for (const [label, stopCall] of [
    ['stop', (handle) => handle.stop()],
    ['stopSync', (handle) => handle.stopSync()],
  ]) {
    const dir = makeUserDataDir(`jenny-pidfile-${label.toLowerCase()}-`);
    const child = new FakeChildProcess(label === 'stop' ? 46031 : 46041);
    const { handle, server } = await startReadyFakeServer({ userDataPath: dir, child, logs: [] });
    try {
      child.emit('exit', 0, null);
      assert.equal(recordedPid(dir), 0, `${label}: the child's own exit cleared its record`);
      writeIdentityPidFile(dir, FOREIGN_RECORD);
      await stopCall(handle);
      assert.equal(recordedPid(dir), 46099, `${label} cleared a record it did not own`);
    } finally {
      await closeServer(server);
    }
  }
});

test('stop()\'s graceful wait clears only its own record', async () => {
  const userDataPath = makeUserDataDir('jenny-pidfile-stop-wait-');
  let probes = 0;
  const server = http.createServer((_request, response) => {
    probes += 1;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(probes === 1 ? { ok: true } : { object: 'list', data: [{ id: 'qwen3:0.5b' }] }));
  });
  const baseUrl = await listen(server);
  const child = new FakeChildProcess(46071);
  let killed = false;
  child.kill = () => { killed = true; };
  try {
    const handle = await startLlamaServer(launchOptions(userDataPath, {
      port: Number(new URL(baseUrl).port),
      spawnImpl: () => child,
      // Alive until the graceful kill; its 'exit' never arrives.
      isProcessAliveImpl: () => !killed,
    }));
    assert.equal(recordedPid(userDataPath), 46071);
    writeIdentityPidFile(userDataPath, FOREIGN_RECORD);
    assert.deepEqual(await handle.stop({ timeoutMs: 1000 }), { confirmed: true });
    assert.equal(recordedPid(userDataPath), 46099, 'the graceful wait cleared a record it did not own');
  } finally {
    await closeServer(server);
  }
});

test('a child that exits before it is ready is never killed, and its own error stands', async () => {
  const unreadable = await launchOnLinux({ stderrLines: [TYPE_142] });
  assert.equal(unreadable.error?.message, 'llama_server_model_unsupported:bundled');
  assert.deepEqual(unreadable.kills, [], 'a reaped pid may already belong to another process');

  const early = await launchOnLinux();
  assert.equal(early.error?.message, 'child_exited_before_ready');
  assert.deepEqual(early.kills, []);

  // A kill that finds the child gone (it went between the timeout and the
  // kill) never replaces the launch's own error, and the record is cleared.
  const timedOut = await launchOnLinux({ exits: false, readinessTimeoutMs: 30 });
  assert.equal(timedOut.error?.message, 'llama_server_readiness_timeout');
  assert.deepEqual(timedOut.kills, [[46051, 'SIGKILL']]);
  assert.equal(recordedPid(timedOut.userDataPath), 0);
});

test('a POSIX force kill counts a process that is already gone as killed, and nothing else', () => {
  const realKill = process.kill;
  const failWith = (code) => () => { throw Object.assign(new Error(`kill ${code}`), { code }); };
  try {
    process.kill = failWith('ESRCH');
    assert.deepEqual(forceKillProcessTreeSync(46081, { platform: 'linux' }), { status: 0 });
    process.kill = failWith('EPERM');
    assert.throws(() => forceKillProcessTreeSync(46081, { platform: 'linux' }), /kill EPERM/);
  } finally {
    process.kill = realKill;
  }
});
