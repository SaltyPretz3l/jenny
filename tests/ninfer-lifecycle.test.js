'use strict';

// Managed ninfer-serve launch (row 54 N2): exact argv, loopback-only, no
// --cors/--webui, busy port refused, /health readiness and timeout, the one
// pinned-memory retry and its C9 code, key-free PID record with
// compare-and-delete.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_DRAFT_TOKENS,
  DEFAULT_NINFER_PORT,
  NINFER_PID_FILENAME,
  buildNinferLaunchArgs,
  computeHostKvMib,
  startNinferServer,
} = require('../services/ninfer-lifecycle');
const { readPidFile, writePidFile } = require('../services/llama-server-pidfile');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');
const {
  FakeChildProcess,
  closeServer,
  getClosedPort,
  listen,
  makeUserDataDir,
} = require('./helpers/llama-server-lifecycle-fixtures');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const ARTIFACT = 'G:\\data\\engines\\ninfer\\models\\qwen3_8_27b_nvfp4.ninfer';
const BINARY = 'G:\\data\\engines\\ninfer\\ninfer-0.9.1\\ninfer-serve.exe';
const BASE_ARGS = {
  artifactPath: ARTIFACT,
  port: 8034,
  modelId: 'qwen3.8-27b-nvfp4',
  contextSize: 65536,
  hostKvMib: 4096,
};

function healthFetch({ readyAfter = 1, calls = [] } = {}) {
  let polls = 0;
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init?.headers });
      polls += 1;
      if (polls < readyAfter) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
    },
  };
}

function launchOptions(userDataPath, overrides = {}) {
  return {
    binaryPath: BINARY,
    artifactPath: ARTIFACT,
    userDataPath,
    runtimeVersion: '0.9.1',
    modelId: 'qwen3.8-27b-nvfp4',
    contextSize: 65536,
    readinessTimeoutMs: 1000,
    readinessPollIntervalMs: 1,
    portReleaseTimeoutMs: 0,
    platform: 'win32',
    spawnSyncImpl: () => ({ status: 0 }),
    isProcessAliveImpl: () => false,
    freeMemoryMib: 16384,
    ...overrides,
  };
}

test('buildNinferLaunchArgs emits the exact argv with the key last and MTP optional', () => {
  assert.deepEqual(buildNinferLaunchArgs({ ...BASE_ARGS, mtp: false }), [
    ARTIFACT, '--host', '127.0.0.1', '--port', '8034', '--model-id', 'qwen3.8-27b-nvfp4',
    '--max-context', '65536', '--max-concurrency', '1', '--host-kv-mib', '4096', '--log-level', 'info', '--vision',
  ]);
  const keyed = buildNinferLaunchArgs({ ...BASE_ARGS, hostStateSlots: 0, apiKey: 'a'.repeat(32) });
  assert.deepEqual(keyed.slice(-9), [
    '--host-state-slots', '0', '--spec', 'mtp', '--draft-tokens', String(DEFAULT_DRAFT_TOKENS), '--lm-head-draft',
    '--api-key', 'a'.repeat(32),
  ]);
  // The LM-head draft rides on MTP only, and can be turned off.
  const plainDraft = buildNinferLaunchArgs({ ...BASE_ARGS, draftTokens: 3, lmHeadDraft: false });
  assert.deepEqual(plainDraft.slice(-4), ['--spec', 'mtp', '--draft-tokens', '3']);
  assert.equal(buildNinferLaunchArgs({ ...BASE_ARGS, mtp: false, lmHeadDraft: true }).includes('--lm-head-draft'), false);
  assert.equal(buildNinferLaunchArgs(BASE_ARGS).filter((arg) => arg === '--vision').length, 1);
  assert.equal(buildNinferLaunchArgs({ ...BASE_ARGS, vision: false }).includes('--vision'), false);
  assert.throws(() => buildNinferLaunchArgs({ ...BASE_ARGS, vision: 'yes' }), { reason: 'ninfer_vision_invalid' });
  assert.equal(DEFAULT_NINFER_PORT, 8034);
  // The 262k window: an 8-bit KV cache, still before the key pair.
  const fp8 = buildNinferLaunchArgs({ ...BASE_ARGS, mtp: false, kvDtype: 'fp8', apiKey: 'a'.repeat(32) });
  assert.deepEqual(fp8.slice(-4), ['--kv-dtype', 'fp8', '--api-key', 'a'.repeat(32)]);
  assert.throws(() => buildNinferLaunchArgs({ ...BASE_ARGS, kvDtype: 'nvfp4' }), { reason: 'ninfer_kv_dtype_invalid' });
});

test('the argv can never bind beyond loopback or enable cors/webui', () => {
  assert.throws(() => buildNinferLaunchArgs({ ...BASE_ARGS, host: '0.0.0.0' }), { reason: 'ninfer_host_not_loopback' });
  assert.throws(() => buildNinferLaunchArgs({ ...BASE_ARGS, host: 'localhost' }), { reason: 'ninfer_host_not_loopback' });
  assert.throws(() => buildNinferLaunchArgs({ ...BASE_ARGS, modelId: '--cors' }), { reason: 'ninfer_model_id_invalid' });
  assert.throws(() => buildNinferLaunchArgs({ ...BASE_ARGS, artifactPath: '--webui' }), { reason: 'ninfer_forbidden_arg' });
  for (const variant of [{}, { mtp: false }, { hostStateSlots: 0 }, { apiKey: 'b'.repeat(32) }]) {
    const args = buildNinferLaunchArgs({ ...BASE_ARGS, ...variant }).map((arg) => arg.toLowerCase());
    for (const forbidden of ['0.0.0.0', '--cors', '--webui', '--webui-dir']) {
      assert.equal(args.includes(forbidden), false, `${forbidden} must never appear`);
    }
    assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1');
  }
});

test('host KV pinning is sized from free RAM: min(8192, max(0, free - 12288))', () => {
  assert.equal(computeHostKvMib(32768), 8192);
  assert.equal(computeHostKvMib(16384), 4096);
  assert.equal(computeHostKvMib(12288), 0);
  assert.equal(computeHostKvMib(1024), 0);
  assert.equal(computeHostKvMib(Number.NaN), 0);
});

test('a busy port is refused before anything is spawned', async () => {
  const userDataPath = makeUserDataDir('jenny-ninfer-busy-');
  const server = http.createServer((_request, response) => response.end('{}'));
  const baseUrl = await listen(server);
  const spawnCalls = [];
  try {
    await assert.rejects(startNinferServer(launchOptions(userDataPath, {
      port: Number(new URL(baseUrl).port),
      spawnImpl: (...call) => { spawnCalls.push(call); return new FakeChildProcess(1); },
    })), { reason: 'ninfer_port_busy' });
    assert.equal(spawnCalls.length, 0);
  } finally {
    await closeServer(server);
  }
});

test('a restart waits for the stopped predecessor to release its port', async () => {
  // Windows reports a terminated ninfer-serve as not alive before its
  // listening socket closes; the next launch must wait, not refuse.
  const userDataPath = makeUserDataDir('jenny-ninfer-release-');
  const server = http.createServer((_request, response) => response.end('{}'));
  const baseUrl = await listen(server);
  const port = Number(new URL(baseUrl).port);
  const spawnCalls = [];
  setTimeout(() => { void closeServer(server); }, 150);
  const handle = await startNinferServer(launchOptions(userDataPath, {
    port,
    portReleaseTimeoutMs: 3000,
    spawnImpl: (...call) => { spawnCalls.push(call); return new FakeChildProcess(51011); },
    ...healthFetch(),
  }));
  assert.equal(spawnCalls.length, 1);
  handle.stopSync();
});

test('a recorded orphan is reaped before the busy-port check so it cannot hold the port', async () => {
  const userDataPath = makeUserDataDir('jenny-ninfer-reap-');
  const server = http.createServer((_request, response) => response.end('{}'));
  const baseUrl = await listen(server);
  const port = Number(new URL(baseUrl).port);
  const stale = { pid: 777, command: `${BINARY} ${ARTIFACT} --host 127.0.0.1 --port ${port}` };
  writePidFile(path.join(userDataPath, NINFER_PID_FILENAME), stale.pid, { command: stale.command });
  const sync = [];
  let alive = true;
  try {
    await assert.rejects(startNinferServer(launchOptions(userDataPath, {
      port,
      spawnImpl: () => new FakeChildProcess(1),
      isProcessAliveImpl: (pid) => pid === stale.pid && alive,
      spawnSyncImpl: (file, args) => {
        sync.push(file);
        if (file === 'taskkill') { alive = false; return { status: 0 }; }
        return { status: 0, stdout: `${stale.command}
` };
      },
    })), { reason: 'ninfer_port_busy' });
  } finally {
    await closeServer(server);
  }
  // The identity query and the kill both ran before the port was declared busy.
  assert.deepEqual(sync, ['powershell.exe', 'taskkill']);
  assert.equal(fs.existsSync(path.join(userDataPath, NINFER_PID_FILENAME)), false);
});

test('a child exit that lands while a /health reply is in flight never promotes the launch', async () => {
  const userDataPath = makeUserDataDir('jenny-ninfer-inflight-');
  const port = await getClosedPort();
  const child = new FakeChildProcess(51009);
  const kills = [];
  await assert.rejects(startNinferServer(launchOptions(userDataPath, {
    port,
    spawnImpl: () => child,
    spawnSyncImpl: (file, args) => { kills.push([file, ...args]); return { status: 0 }; },
    fetchImpl: async () => {
      // The server answered, then died before the reply was read.
      child.emit('exit', 1, null);
      return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
    },
  })), { reason: 'child_exited_before_ready' });
  assert.deepEqual(kills, []);
  assert.equal(fs.existsSync(path.join(userDataPath, NINFER_PID_FILENAME)), false);
});

test('an unconfirmed stop stays retryable until the exit is confirmed', async () => {
  const userDataPath = makeUserDataDir('jenny-ninfer-stopretry-');
  const port = await getClosedPort();
  const child = new FakeChildProcess(51010);
  const kills = [];
  let alive = true;
  const handle = await startNinferServer(launchOptions(userDataPath, {
    port,
    spawnImpl: () => child,
    isProcessAliveImpl: () => alive,
    spawnSyncImpl: (file, args) => { kills.push([file, ...args]); return { status: 0 }; },
    ...healthFetch(),
  }));
  assert.deepEqual(await handle.stop({ timeoutMs: 500 }), { confirmed: false });
  assert.equal(kills.length, 1);
  assert.equal(fs.existsSync(path.join(userDataPath, NINFER_PID_FILENAME)), true);
  // Still alive: the retry kills again instead of claiming success.
  assert.deepEqual(await handle.stop({ timeoutMs: 500 }), { confirmed: false });
  assert.equal(kills.length, 2);
  alive = false;
  assert.deepEqual(await handle.stop({ timeoutMs: 500 }), { confirmed: true });
  assert.equal(fs.existsSync(path.join(userDataPath, NINFER_PID_FILENAME)), false);
  handle.stopSync();
  assert.equal(kills.length, 2);
});

test('managed spawn keys the launch, polls /health with the key, records a key-free pid command', async () => {
  const userDataPath = makeUserDataDir('jenny-ninfer-ready-');
  const port = await getClosedPort();
  const child = new FakeChildProcess(51001);
  const spawnCalls = [];
  const exits = [];
  const logs = [];
  const { fetchImpl, calls } = healthFetch({ readyAfter: 3 });
  process.env.JENNY_NINFER_TEST_SECRET = 'must-not-reach-ninfer';
  const handle = await startNinferServer(launchOptions(userDataPath, {
    port,
    fetchImpl,
    onExit: (info) => exits.push(info),
    logger: (level, event, details) => logs.push({ level, event, details }),
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args: [...args], options });
      return child;
    },
  }));
  delete process.env.JENNY_NINFER_TEST_SECRET;

  assert.match(handle.apiKey, /^[0-9a-f]{32}$/);
  assert.equal(handle.baseUrl, `http://127.0.0.1:${port}/v1`);
  assert.equal(handle.pid, 51001);
  assert.equal(handle.mtp, true);
  assert.equal(handle.hostKvMib, 4096);
  assert.equal(spawnCalls.length, 1);
  const { command, args, options } = spawnCalls[0];
  assert.equal(command, BINARY);
  assert.deepEqual(args.slice(-2), ['--api-key', handle.apiKey]);
  assert.equal(args[0], ARTIFACT);
  assert.equal(options.windowsHide, true);
  assert.equal(options.cwd, path.dirname(BINARY));
  assert.equal(Object.getPrototypeOf(options.env), null);
  assert.equal(options.env.JENNY_NINFER_TEST_SECRET, undefined);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, `http://127.0.0.1:${port}/health`);
  assert.deepEqual(calls[0].headers, { Authorization: `Bearer ${handle.apiKey}` });
  // The pid record is the argv without the key pair and still names the launch.
  const record = readPidFile(path.join(userDataPath, NINFER_PID_FILENAME));
  assert.equal(record.pid, 51001);
  assert.equal(record.command.includes(handle.apiKey), false);
  assert.equal(record.command.includes('--api-key'), false);
  assert.equal(record.command, `${BINARY} ${args.slice(0, -2).join(' ')}`);
  // Nothing logged carries the key or the argv.
  assert.equal(JSON.stringify(logs).includes(handle.apiKey), false);
  assert.equal(JSON.stringify(logs).includes('--api-key'), false);
  assert.equal(logs.some((entry) => entry.event === 'ninfer.server.spawn' && entry.details.port === port), true);

  child.emit('exit', 137, null);
  assert.deepEqual(exits, [{ pid: 51001, code: 137, signal: '' }]);
  assert.equal(fs.existsSync(path.join(userDataPath, NINFER_PID_FILENAME)), false);
  assert.deepEqual(await handle.stop(), { confirmed: true });
});

test('a child exit clears only its own pid record (compare-and-delete)', async () => {
  const userDataPath = makeUserDataDir('jenny-ninfer-cad-');
  const port = await getClosedPort();
  const child = new FakeChildProcess(51002);
  const handle = await startNinferServer(launchOptions(userDataPath, {
    port, fetchImpl: healthFetch().fetchImpl, spawnImpl: () => child,
  }));
  const pidPath = path.join(userDataPath, NINFER_PID_FILENAME);
  // A newer launch overwrote the record; the old child's late exit must not remove it.
  fs.writeFileSync(pidPath, JSON.stringify({ pid: 51999, command: 'other', startedAt: 'x' }), 'utf8');
  child.emit('exit', 0, null);
  assert.equal(readPidFile(pidPath).pid, 51999);
  await handle.stop();
  assert.equal(readPidFile(pidPath).pid, 51999);
});

test('readiness timeout force-kills the child and clears the record', async () => {
  const userDataPath = makeUserDataDir('jenny-ninfer-timeout-');
  const port = await getClosedPort();
  const child = new FakeChildProcess(51003);
  const kills = [];
  await assert.rejects(startNinferServer(launchOptions(userDataPath, {
    port,
    readinessTimeoutMs: 30,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    spawnImpl: () => child,
    spawnSyncImpl: (file, args) => { kills.push([file, ...args]); return { status: 0 }; },
  })), { reason: 'ninfer_readiness_timeout' });
  assert.deepEqual(kills, [['taskkill', '/PID', '51003', '/T', '/F']]);
  assert.equal(fs.existsSync(path.join(userDataPath, NINFER_PID_FILENAME)), false);
});

function pinnedMemoryChild(pid) {
  const child = new FakeChildProcess(pid);
  // The first readiness poll sees the exit; stderr already carried the reason.
  setImmediate(() => {
    child.stderr.emit('data', '[error] cudaMallocHost failed: cudaErrorMemoryAllocation: out of memory\n');
    child.emit('exit', 1, null);
  });
  return child;
}

test('a pinned-memory failure relaunches once with host pinning disabled', async () => {
  const userDataPath = makeUserDataDir('jenny-ninfer-pinned-ok-');
  const port = await getClosedPort();
  const spawnCalls = [];
  const logs = [];
  const second = new FakeChildProcess(51005);
  let serving = false;
  const handle = await startNinferServer(launchOptions(userDataPath, {
    port,
    // The first child dies before it ever answers; only the retry serves.
    fetchImpl: async () => {
      if (!serving) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
    },
    logger: (level, event, details) => logs.push({ level, event, details }),
    spawnImpl: (_command, args) => {
      spawnCalls.push([...args]);
      if (spawnCalls.length === 1) return pinnedMemoryChild(51004);
      serving = true;
      return second;
    },
  }));
  assert.equal(spawnCalls.length, 2);
  assert.equal(handle.vision, true);
  for (const args of spawnCalls) assert.equal(args.filter((arg) => arg === '--vision').length, 1);
  assert.equal(spawnCalls[0][spawnCalls[0].indexOf('--host-kv-mib') + 1], '4096');
  assert.equal(spawnCalls[0].includes('--host-state-slots'), false);
  assert.equal(spawnCalls[1][spawnCalls[1].indexOf('--host-kv-mib') + 1], '0');
  assert.equal(spawnCalls[1][spawnCalls[1].indexOf('--host-state-slots') + 1], '0');
  assert.deepEqual(spawnCalls[0].slice(-2), spawnCalls[1].slice(-2), 'the retry keeps the same key');
  assert.equal(handle.pid, 51005);
  assert.equal(handle.hostKvMib, 0);
  assert.equal(handle.hostStateSlots, 0);
  assert.equal(logs.some((entry) => entry.event === 'ninfer.server.pinned_memory_retry'), true);
  assert.deepEqual(await handle.stop(), { confirmed: true });
});

test('a second pinned-memory failure surfaces ninfer_host_memory with the attempted size (C9)', async () => {
  const userDataPath = makeUserDataDir('jenny-ninfer-pinned-fail-');
  const port = await getClosedPort();
  let launches = 0;
  await assert.rejects(startNinferServer(launchOptions(userDataPath, {
    port,
    freeMemoryMib: 20480,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    spawnImpl: () => pinnedMemoryChild(51010 + launches++),
  })), (error) => error.reason === 'ninfer_host_memory' && error.pinnedGb === 9.2);
  assert.equal(launches, 2);
  assert.equal(fs.existsSync(path.join(userDataPath, NINFER_PID_FILENAME)), false);
});

test('an unrelated early exit is not retried', async () => {
  const userDataPath = makeUserDataDir('jenny-ninfer-early-exit-');
  const port = await getClosedPort();
  let launches = 0;
  await assert.rejects(startNinferServer(launchOptions(userDataPath, {
    port,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    spawnImpl: () => {
      launches += 1;
      const child = new FakeChildProcess(51020);
      setImmediate(() => {
        child.stderr.emit('data', 'artifact format v2 is not supported\n');
        child.emit('exit', 1, null);
      });
      return child;
    },
  })), { reason: 'child_exited_before_ready' });
  assert.equal(launches, 1);
});

test('fail-closed inputs: no userData, bad retained key, non-loopback never spawn', async () => {
  const userDataPath = makeUserDataDir('jenny-ninfer-inputs-');
  let spawned = 0;
  const spawnImpl = () => { spawned += 1; return new FakeChildProcess(1); };
  await assert.rejects(startNinferServer(launchOptions('', { spawnImpl })), { reason: 'ninfer_user_data_path_required' });
  await assert.rejects(startNinferServer(launchOptions(userDataPath, { spawnImpl, retainedApiKey: 'short' })), { reason: 'ninfer_retained_key_invalid' });
  await assert.rejects(startNinferServer(launchOptions(userDataPath, { spawnImpl, modelId: 'bad id' })), { reason: 'ninfer_model_id_invalid' });
  assert.equal(spawned, 0);
});
