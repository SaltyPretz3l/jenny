'use strict';

// Managed Strata server launch (row 200 S2 step 4): exact argv with the key
// last, loopback and --offline only, STRATA_*/PYTHON* stripped from the child
// env, readiness on the ready file's pid plus /health loaded, busy port
// refused, stale ready files removed, the key never outside argv, the engine
// process confirmed gone on stop, and an unconfirmed stop kept retryable.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_STRATA_PORT,
  STRATA_PID_FILENAME,
  buildChildEnv,
  buildStrataLaunchArgs,
  reapRecordedStrataServer,
  startStrataServer,
} = require('../services/strata-lifecycle');
const { readPidFile, writePidFile } = require('../services/llama-server-pidfile');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');
const {
  FakeChildProcess, closeServer, getClosedPort, listen, makeUserDataDir,
} = require('./helpers/llama-server-lifecycle-fixtures');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const KEY = 'c'.repeat(32);
const ENGINE_EXE = 'C:\\Strata\\components\\shapes\\inkling2\\engine\\0.1.67-windows-x86_64-cuda-cuda13\\strata-inkling.exe';

function fixture(prefix = 'strata-life-') {
  const userDataPath = makeUserDataDir(prefix);
  const root = path.join(userDataPath, 'StrataRoot');
  const install = {
    root,
    terminalDir: path.join(root, 'terminal', '0.1.67'),
    pythonExe: path.join(root, 'terminal', '0.1.67', 'python', 'python.exe'),
    version: '0.1.67',
  };
  const config = {
    exe: ENGINE_EXE,
    cwd: install.terminalDir,
    tokenizer: path.join(root, 'tok'),
    model_name: 'inkling-2-mini-sq-20',
    args: ['--native', path.join(root, 'p.strata'), '--max-context', '114432'],
    drafting: 'off',
    aliases: ['inkling-2-mini'],
    log: path.join(userDataPath, 'strata', 'logs', 'strata-server.log'),
  };
  return { userDataPath, install, config };
}

// A fake child that writes Strata's ready file the way the server does.
function readySpawn({ pid = 4100, readyPid = pid, boundPort = null, spawned = [], lines = [] } = {}) {
  return async (command, args, options) => {
    const child = new FakeChildProcess(pid);
    child.kill = () => { child.killed = true; };
    spawned.push({ command, args, options, child });
    const readyPath = args[args.indexOf('--ready-file') + 1];
    const port = Number(args[args.indexOf('--port') + 1]);
    setImmediate(() => {
      for (const line of lines) child.stdout.emit('data', `${line}\n`);
      fs.writeFileSync(readyPath, JSON.stringify({
        schema_version: 1, pid: readyPid, bound_port: boundPort ?? port, model_id: 'inkling-2-mini-sq-20', api_state: 'ready',
      }));
    });
    return child;
  };
}

function strataFetch({ calls = [], loaded = true } = {}) {
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers, body: init.body });
      if (String(url).endsWith('/health')) {
        return { ok: true, status: 200, json: async () => ({ status: 'ok', loaded, max_context: 114432, images: true, model: 'inkling-2-mini-sq-20' }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  };
}

async function options(f, overrides = {}) {
  return {
    install: f.install,
    config: f.config,
    userDataPath: f.userDataPath,
    port: await getClosedPort(),
    readinessTimeoutMs: 2_000,
    readinessPollIntervalMs: 5,
    portReleaseTimeoutMs: 0,
    platform: 'win32',
    env: {},
    spawnSyncImpl: () => ({ status: 0 }),
    isProcessAliveImpl: () => false,
    listChildrenImpl: async () => [{ pid: 4200, commandLine: `"${ENGINE_EXE}" --serve` }],
    ...overrides,
  };
}

test('buildStrataLaunchArgs emits the exact argv with the key last', () => {
  const args = buildStrataLaunchArgs({ configPath: 'C:\\u\\c.json', readyPath: 'C:\\u\\r.json', port: 8035, slots: 4, apiKey: KEY });
  assert.deepEqual(args, [
    '-m', 'serve.server', '--engine', 'strata', '--config', 'C:\\u\\c.json', '--host', '127.0.0.1', '--port', '8035',
    '--parallel', '4', '--offline', '--ready-file', 'C:\\u\\r.json', '--api-key', KEY,
  ]);
  assert.equal(DEFAULT_STRATA_PORT, 8035);
  for (const forbidden of ['--lazy', '--idle-unload', '--access', '--no-api-key', '0.0.0.0', '--data-dir']) {
    assert.equal(args.includes(forbidden), false, `${forbidden} must never appear`);
  }
  assert.throws(() => buildStrataLaunchArgs({ configPath: 'C:\\u\\c.json', readyPath: 'C:\\u\\r.json', slots: 3 }), { reason: 'strata_slots_invalid' });
  assert.throws(() => buildStrataLaunchArgs({ configPath: 'rel.json', readyPath: 'C:\\u\\r.json' }), { reason: 'strata_config_path_invalid' });
  assert.throws(() => buildStrataLaunchArgs({ configPath: 'C:\\u\\--lazy', readyPath: 'C:\\u\\r.json', apiKey: 'short' }), { reason: 'strata_api_key_invalid' });
});

test('the child env drops every STRATA_* and PYTHON* variable and sets only UTF-8 and no user site', () => {
  const env = buildChildEnv({
    PATH: 'C:\\Windows', STRATA_API_KEY: 'x', STRATA_KEEP_LEFTOVERS: '1', strata_inkling_effort: 'max',
    PYTHONPATH: 'C:\\evil', PYTHONHOME: 'C:\\py', LOCALAPPDATA: 'C:\\L',
  });
  assert.equal(env.PATH, 'C:\\Windows');
  assert.equal(env.LOCALAPPDATA, 'C:\\L');
  for (const key of Object.keys(env)) assert.equal(/^STRATA_/i.test(key), false, key);
  assert.equal(env.PYTHONPATH, undefined);
  assert.equal(env.PYTHONHOME, undefined);
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.PYTHONNOUSERSITE, '1');
});

test('a ready launch spawns the Terminal Python in the Terminal folder, writes the config and a key-free record', async () => {
  const f = fixture();
  const spawned = [];
  const logs = [];
  const { fetchImpl, calls } = strataFetch();
  const handle = await startStrataServer({
    ...(await options(f)), spawnImpl: readySpawn({ spawned }), fetchImpl, slots: 2,
    logger: (level, event, details) => logs.push({ level, event, details }),
  });
  const [{ command, args, options: spawnOptions }] = spawned;
  assert.equal(command, f.install.pythonExe);
  assert.equal(spawnOptions.cwd, f.install.terminalDir);
  assert.equal(args[args.indexOf('--parallel') + 1], '2');
  const configPath = args[args.indexOf('--config') + 1];
  assert.equal(path.dirname(configPath), path.join(f.userDataPath, 'strata', 'run'));
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), f.config);
  const readyPath = args[args.indexOf('--ready-file') + 1];
  assert.match(path.basename(readyPath), /^ready-[0-9a-f]{16}\.json$/);
  assert.equal(handle.baseUrl, `http://127.0.0.1:${handle.port}/v1`);
  assert.equal(handle.contextSize, 114432);
  assert.equal(handle.vision, true);
  assert.equal(handle.modelId, 'inkling-2-mini-sq-20');
  assert.equal(handle.getEnginePid(), 4200);
  assert.match(handle.apiKey, /^[0-9a-f]{32}$/);
  assert.equal(args.at(-2), '--api-key');
  assert.equal(args.at(-1), handle.apiKey);
  assert.ok(calls.some((call) => call.url.endsWith('/health') && call.headers.Authorization === `Bearer ${handle.apiKey}`));
  const record = readPidFile(path.join(f.userDataPath, STRATA_PID_FILENAME));
  assert.equal(record.pid, 4100);
  assert.ok(!record.command.includes(handle.apiKey));
  assert.ok(!record.command.includes('--api-key'));
  assert.ok(!JSON.stringify(logs).includes(handle.apiKey));
  assert.ok(!fs.readFileSync(configPath, 'utf8').includes(handle.apiKey));
  assert.equal((await handle.stop()).confirmed, true);
});

test('the key never appears outside argv, even when the server echoes it', async () => {
  const f = fixture();
  const logs = [];
  const handle = await startStrataServer({
    ...(await options(f)),
    retainedApiKey: KEY,
    spawnImpl: readySpawn({ lines: [`[strata] serving with key ${KEY} at ${f.install.terminalDir}`] }),
    fetchImpl: strataFetch().fetchImpl,
    logger: (level, event, details) => logs.push({ level, event, details }),
  });
  assert.equal(handle.apiKey, KEY);
  await new Promise((resolve) => setImmediate(resolve));
  const text = JSON.stringify(logs);
  assert.ok(!text.includes(KEY), 'the key is redacted from server output');
  assert.ok(text.includes('[key]'));
  assert.ok(text.includes('[strata terminal]'), 'the owner folder is redacted');
  const record = fs.readFileSync(path.join(f.userDataPath, STRATA_PID_FILENAME), 'utf8');
  assert.ok(!record.includes(KEY));
  await handle.stop();
});

test('a ready file naming another pid is refused and the child is killed', async () => {
  const f = fixture();
  const killed = [];
  await assert.rejects(startStrataServer({
    ...(await options(f)),
    spawnImpl: readySpawn({ pid: 4100, readyPid: 9999 }),
    fetchImpl: strataFetch().fetchImpl,
    spawnSyncImpl: (cmd, args) => { killed.push(args); return { status: 0 }; },
  }), { reason: 'strata_ready_pid_mismatch' });
  assert.ok(killed.some((args) => args.includes('4100') && args.includes('/T')), 'the owned pid is tree-killed');
  assert.deepEqual(fs.readdirSync(path.join(f.userDataPath, 'strata', 'run')).filter((n) => n.startsWith('ready-')), []);
});

test('a busy port is refused, never adopted', async () => {
  const f = fixture();
  const server = http.createServer((_req, res) => res.end('{}'));
  const baseUrl = await listen(server);
  try {
    let spawnedAny = false;
    await assert.rejects(startStrataServer({
      ...(await options(f)), port: Number(new URL(baseUrl).port),
      spawnImpl: async () => { spawnedAny = true; return new FakeChildProcess(1); },
      fetchImpl: strataFetch().fetchImpl,
    }), { reason: 'strata_port_busy' });
    assert.equal(spawnedAny, false);
  } finally {
    await closeServer(server);
  }
});

test('stale ready files from earlier launches are removed before the start', async () => {
  const f = fixture();
  const runDir = path.join(f.userDataPath, 'strata', 'run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'ready-0123456789abcdef.json'), '{"pid":1}');
  fs.writeFileSync(path.join(runDir, 'keep.txt'), 'x');
  const handle = await startStrataServer({ ...(await options(f)), spawnImpl: readySpawn(), fetchImpl: strataFetch().fetchImpl });
  const names = fs.readdirSync(runDir);
  assert.equal(names.includes('ready-0123456789abcdef.json'), false);
  assert.equal(names.includes('keep.txt'), true);
  await handle.stop();
});

test('a server that is up but still loading is not ready until /health says loaded', async () => {
  const f = fixture();
  let polls = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/health')) {
      polls += 1;
      return { ok: true, status: 200, json: async () => ({ status: 'ok', loaded: polls >= 3, max_context: polls >= 3 ? 114432 : 0 }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const handle = await startStrataServer({ ...(await options(f)), spawnImpl: readySpawn(), fetchImpl });
  assert.ok(polls >= 3);
  assert.equal(handle.contextSize, 114432);
  await handle.stop();
});

test('stop unloads with the key, kills the server, and confirms the engine is gone', async () => {
  const f = fixture();
  const { fetchImpl, calls } = strataFetch();
  const alive = new Set([4100, 4200]);
  const killed = [];
  const handle = await startStrataServer({
    ...(await options(f)), spawnImpl: readySpawn(), fetchImpl,
    isProcessAliveImpl: (pid) => alive.has(pid),
    spawnSyncImpl: (cmd, args) => {
      // `/T` on the server reaches its direct child, the engine (plan F22).
      if (cmd === 'taskkill') { killed.push(Number(args[1])); alive.clear(); return { status: 0 }; }
      return { status: 0, stdout: `"${ENGINE_EXE}" --serve` };
    },
  });
  const result = await handle.stop({ timeoutMs: 500 });
  assert.equal(result.confirmed, true);
  const unload = calls.find((call) => call.url.includes('/unload?wait=1'));
  assert.equal(unload.method, 'POST');
  assert.equal(unload.headers.Authorization, `Bearer ${handle.apiKey}`);
  assert.equal(unload.headers['Content-Type'], 'application/json');
  assert.deepEqual(killed, [4100], 'the tree kill of the server took the engine with it');
  assert.equal(readPidFile(path.join(f.userDataPath, STRATA_PID_FILENAME)).pid, 0, 'the record is cleared');
});

test('an engine that outlives its server is killed by pid only while its command line names the engine', async () => {
  const f = fixture();
  const alive = new Set([4200]);
  const killed = [];
  const handle = await startStrataServer({
    ...(await options(f)), spawnImpl: readySpawn(), fetchImpl: strataFetch().fetchImpl,
    isProcessAliveImpl: (pid) => alive.has(pid),
    spawnSyncImpl: (cmd, args) => {
      if (cmd === 'taskkill') { killed.push(Number(args[1])); alive.delete(Number(args[1])); return { status: 0 }; }
      return { status: 0, stdout: `"${ENGINE_EXE}" --serve` };
    },
  });
  assert.equal((await handle.stop({ timeoutMs: 500 })).confirmed, true);
  assert.deepEqual(killed, [4200]);

  const g = fixture();
  const recycled = [];
  const other = await startStrataServer({
    ...(await options(g)), spawnImpl: readySpawn(), fetchImpl: strataFetch().fetchImpl,
    isProcessAliveImpl: (pid) => pid === 4200,
    spawnSyncImpl: (cmd, args) => {
      if (cmd === 'taskkill') { recycled.push(Number(args[1])); return { status: 0 }; }
      return { status: 0, stdout: 'C:\\Windows\\notepad.exe' };
    },
  });
  assert.equal((await other.stop({ timeoutMs: 500 })).confirmed, true, 'a recycled pid is not ours');
  assert.deepEqual(recycled, []);
});

test('an unconfirmed stop keeps the record and stays retryable', async () => {
  const f = fixture();
  const handle = await startStrataServer({
    ...(await options(f)), spawnImpl: readySpawn(), fetchImpl: strataFetch().fetchImpl,
    isProcessAliveImpl: () => true,
  });
  const first = await handle.stop({ timeoutMs: 500 });
  assert.equal(first.confirmed, false);
  assert.equal(readPidFile(path.join(f.userDataPath, STRATA_PID_FILENAME)).pid, 4100);
  const second = await handle.stop({ timeoutMs: 500 });
  assert.equal(second.confirmed, false, 'still unconfirmed, still not settled');
});

test('a server Windows blocks reports strata_blocked_by_windows', async () => {
  const f = fixture();
  const spawnImpl = async () => {
    const child = new FakeChildProcess(4300);
    setImmediate(() => {
      child.stderr.emit('data', 'RuntimeError: Windows blocked the Strata engine (strata-inkling.exe): Smart App Control ...\n');
      child.emit('exit', 1, null);
    });
    return child;
  };
  await assert.rejects(startStrataServer({ ...(await options(f)), spawnImpl, fetchImpl: strataFetch().fetchImpl }),
    { reason: 'strata_blocked_by_windows' });
});

test('an early exit names the exit code', async () => {
  const f = fixture();
  const spawnImpl = async () => {
    const child = new FakeChildProcess(4400);
    setImmediate(() => child.emit('exit', 2, null));
    return child;
  };
  await assert.rejects(startStrataServer({ ...(await options(f)), spawnImpl, fetchImpl: strataFetch().fetchImpl }),
    { reason: 'strata_exited:2' });
});

test('server progress lines feed the engine-activity heartbeat, throttled', async () => {
  const f = fixture();
  let beats = 0;
  const handle = await startStrataServer({
    ...(await options(f)),
    spawnImpl: readySpawn({ lines: [
      '[strata] reading the prompt: 8,192 of 28,826 tokens, 1 s so far',
      '[strata] reading the prompt: 15,360 of 28,826 tokens, 2 s so far',
      'ready: http://127.0.0.1:8035/v1',
    ] }),
    fetchImpl: strataFetch().fetchImpl,
    onEngineActivity: () => { beats += 1; },
  });
  assert.equal(beats, 1);
  await handle.stop();
});

test('fail-closed inputs touch nothing', async () => {
  const f = fixture();
  const base = await options(f);
  await assert.rejects(startStrataServer({ ...base, install: null }), { reason: 'strata_install_missing' });
  await assert.rejects(startStrataServer({ ...base, config: { ...f.config, exe: 'component:strata-inkling' } }), { reason: 'strata_config_missing' });
  await assert.rejects(startStrataServer({ ...base, userDataPath: '' }), { reason: 'strata_user_data_path_required' });
  await assert.rejects(startStrataServer({ ...base, retainedApiKey: 'nope' }), { reason: 'strata_retained_key_invalid' });
  await assert.rejects(startStrataServer({ ...base, slots: 8 }), { reason: 'strata_slots_invalid' });
  assert.equal(fs.existsSync(path.join(f.userDataPath, 'strata')), false);
});

test('the boot reap ends a recorded server only after the identity check', () => {
  const f = fixture();
  const pidPath = path.join(f.userDataPath, STRATA_PID_FILENAME);
  writePidFile(pidPath, 5100, { command: `${f.install.pythonExe} -m serve.server --engine strata` });
  const killed = [];
  const alive = new Set([5100]);
  const result = reapRecordedStrataServer({
    userDataPath: f.userDataPath, platform: 'win32',
    isProcessAliveImpl: (pid) => alive.has(pid),
    spawnSyncImpl: (cmd, args) => {
      if (cmd === 'taskkill') { killed.push(Number(args[1])); alive.delete(Number(args[1])); return { status: 0 }; }
      return { status: 0, stdout: `"${f.install.pythonExe}" -m serve.server --engine strata --config x --api-key ${KEY}` };
    },
  });
  assert.equal(result.reaped, true);
  assert.deepEqual(killed, [5100]);

  writePidFile(pidPath, 5200, { command: `${f.install.pythonExe} -m serve.server --engine strata` });
  const spared = [];
  reapRecordedStrataServer({
    userDataPath: f.userDataPath, platform: 'win32', isProcessAliveImpl: () => true,
    spawnSyncImpl: (cmd, args) => (cmd === 'taskkill' ? (spared.push(args), { status: 0 }) : { status: 0, stdout: 'C:\\other.exe' }),
  });
  assert.deepEqual(spared, [], 'a pid now running something else is never killed');
});
