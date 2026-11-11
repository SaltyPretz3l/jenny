'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');
const { linkDirectory } = require('./helpers/platform-skips');
const renderPidfile = require('../services/image-engine-pidfile');
const {
  createComfyProcessOwner, buildLaunchArgs, checkIdentity, RUN_ID,
} = require('../services/comfyui-process');

test.afterEach(cleanupTrackedResources);

const OP_ID = 'img_0123456789ab';
const PORT = 51234;
const NOT_REACHED = () => new Promise(() => {});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function refused() {
  const error = new TypeError('fetch failed');
  error.cause = { code: 'ECONNREFUSED' };
  return error;
}

// What ComfyUI reports: Python's sys.argv, the main.py path then the flags.
function statsFor(args, version = '0.45.0') {
  return { system: { argv: [args[1], ...args.slice(2)], comfyui_version: version }, devices: [] };
}

function harness(t, options = {}) {
  const userDataPath = createTrackedTempDir('jenny-comfy-process-');
  const folder = path.join(userDataPath, 'portable');
  const python = path.join(folder, 'python_embeded', 'python.exe');
  const main = path.join(folder, 'ComfyUI', 'main.py');
  const comfy = { folder };
  const state = { spawns: [], child: null, killCalls: [], fetchCalls: [], logs: [], clock: 1000 };
  const children = [];
  t.after(() => { for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); } });

  const spawnImpl = (exe, args, spawnOptions) => {
    state.spawns.push({ exe, args, options: spawnOptions });
    const child = new EventEmitter();
    child.pid = options.pid ?? 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    children.push(child);
    state.child = child;
    return child;
  };
  const processTools = {
    enumerateDescendants: async () => options.snapshot ?? { ok: true, pids: [], processes: [], rootCreatedMs: null },
    killTreeWithProof: async (pid) => {
      state.killCalls.push(pid);
      state.child?.emit('exit', null, 'SIGKILL');
      return options.killResult ?? { confirmed: true, enumerated: true, pids: [pid], survivors: [] };
    },
    confirmAllGone: async (pids) => {
      state.goneCalls = [...(state.goneCalls || []), pids];
      return options.gone ?? { confirmed: true, survivors: [] };
    },
    listProcessRows: async () => ({ ok: true, rows: [] }),
    selectRootSurvivors: (input) => {
      state.selected = input;
      return options.selection ?? { ok: true, pids: [] };
    },
    terminatePids: async (pids) => { state.terminated = pids; },
  };
  const fetchImpl = async (url, init) => {
    state.fetchCalls.push(url);
    if (options.fetch) {
      const answered = await options.fetch(url, init, state);
      if (answered) return answered;
    }
    const target = new URL(url);
    if (target.pathname === '/system_stats') {
      if (state.fetchCalls.filter((call) => call.endsWith('/system_stats')).length <= (options.notReady ?? 0)) {
        return new Response('starting', { status: 503 });
      }
      const stats = statsFor(state.spawns[0].args);
      options.mutateStats?.(stats);
      return json(stats);
    }
    return json({});
  };
  const sleep = (ms) => {
    if (ms === 500) return options.snapshotAt500 ? Promise.resolve() : NOT_REACHED();
    state.clock += ms;
    return Promise.resolve();
  };
  const pidfile = { ...renderPidfile, ...options.pidfile };
  const owner = createComfyProcessOwner({
    userDataPath, spawnImpl, fetchImpl, pidfile, processTools, sleep,
    getFreePort: async () => PORT, now: () => state.clock,
    validateComfyFolder: options.validateComfyFolder
      || (() => ({ ok: true, folder, pythonPath: python, mainPath: main, modelsRoot: path.join(folder, 'ComfyUI', 'models') })),
    log: (level, event, payload) => state.logs.push([level, event, payload]),
  });
  return { owner, state, userDataPath, comfy, python, main, pidPath: renderPidfile.getImageEnginePidPath(userDataPath),
    runDir: path.join(userDataPath, 'comfyui', 'runs', OP_ID) };
}

test('buildLaunchArgs keeps the exact flag order with every path under the run directory', () => {
  const runDir = path.join('data', 'runs', OP_ID);
  assert.deepEqual(buildLaunchArgs({ mainPath: 'M/main.py', port: 8191, runDir }), [
    '-s', 'M/main.py', '--listen', '127.0.0.1', '--port', '8191', '--disable-auto-launch',
    '--user-directory', path.join(runDir, 'user'), '--output-directory', path.join(runDir, 'output'),
    '--temp-directory', path.join(runDir, 'temp'), '--input-directory', path.join(runDir, 'input'),
    '--disable-all-custom-nodes', '--disable-metadata',
  ]);
  assert.match(OP_ID, RUN_ID);
  assert.doesNotMatch('img_0123456789AB', RUN_ID);
  assert.doesNotMatch('img_0123456789abc', RUN_ID);
});

test('checkIdentity accepts only the argv this owner launched', () => {
  const runDir = path.join('data', 'runs', OP_ID);
  const args = buildLaunchArgs({ mainPath: 'M/main.py', port: PORT, runDir });
  const stats = (argv) => ({ system: { argv } });
  const ctx = { runDir, port: PORT, opId: OP_ID, platform: process.platform };
  assert.equal(checkIdentity(stats([args[1], ...args.slice(2)]), ctx), true);
  const withoutNonce = args.map((arg) => arg.replace(OP_ID, 'img_ffffffffffff'));
  assert.equal(checkIdentity(stats(withoutNonce.slice(1)), ctx), false, 'missing nonce');
  assert.equal(checkIdentity(stats(args.slice(1)), { ...ctx, port: PORT + 1 }), false, 'wrong port');
  assert.equal(checkIdentity(stats(['main.py', '--port', String(PORT), '--user-directory']), ctx), false, 'flag last');
  assert.equal(checkIdentity(stats('not an array'), ctx), false);
  assert.equal(checkIdentity({}, ctx), false);
  assert.equal(checkIdentity(null, ctx), false);
  assert.equal(checkIdentity(stats([...args.slice(1), 7]), ctx), false, 'non-string element');
  const other = path.join('data', 'runs', 'img_aaaaaaaaaaaa');
  assert.equal(checkIdentity(stats(buildLaunchArgs({ mainPath: 'M/main.py', port: PORT, runDir: other }).slice(1)), ctx), false);
  assert.equal(checkIdentity(stats(args.slice(1)), { ...ctx, opId: 'img_aaaaaaaaaaaa' }), false);
  const duplicated = [...args.slice(1), '--user-directory', path.join('elsewhere', OP_ID, 'user')];
  assert.equal(checkIdentity(stats(duplicated), ctx), false, 'a repeated flag is ambiguous');
  if (process.platform === 'win32') {
    const slashed = args.slice(1).map((arg) => (arg.startsWith('--') ? arg : arg.replaceAll('\\', '/').toUpperCase()));
    assert.equal(checkIdentity(stats(slashed), ctx), true, 'case and separators are not significant on Windows');
  }
});

test('a server whose argv lacks the run id is refused and its tree is killed (red run)', async (t) => {
  const h = harness(t, { mutateStats: (stats) => { stats.system.argv = stats.system.argv.map((arg) => arg.replace(OP_ID, 'img_ffffffffffff')); } });
  const result = await h.owner.start({ comfy: h.comfy, opId: OP_ID });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'image_comfyui_not_ours');
  assert.deepEqual(h.state.killCalls, [4242]);
  assert.equal(renderPidfile.readRenderRecord(h.pidPath), null, 'a proven-dead tree leaves no record');
  assert.equal(fs.existsSync(h.runDir), false);
});

test('start launches headless on the chosen loopback port and returns a plain server description', async (t) => {
  const previous = process.env.PYTHONPATH;
  process.env.PYTHONPATH = 'C:\\leaky\\site';
  t.after(() => { if (previous === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = previous; });
  const h = harness(t, { notReady: 2 });
  const result = await h.owner.start({ comfy: { ...h.comfy, pythonPath: 'C:\\evil\\python.exe' }, opId: OP_ID });
  assert.equal(result.ok, true);
  const { server } = result;
  assert.equal(server.baseUrl, `http://127.0.0.1:${PORT}`);
  assert.equal(server.port, PORT);
  assert.equal(server.pid, 4242);
  assert.equal(server.opId, OP_ID);
  assert.equal(server.runDir, h.runDir);
  assert.equal(server.outputDir, path.join(h.runDir, 'output'));
  assert.equal(server.comfyuiVersion, '0.45.0');
  assert.equal(typeof server.readyMs, 'number');
  assert.equal('child' in server, false);
  for (const sub of ['user', 'output', 'temp', 'input']) assert.ok(fs.statSync(path.join(h.runDir, sub)).isDirectory());
  const [spawned] = h.state.spawns;
  assert.equal(spawned.exe, h.python, 'the interpreter comes from the validated folder');
  assert.deepEqual(spawned.args, buildLaunchArgs({ mainPath: h.main, port: PORT, runDir: h.runDir }));
  assert.equal(spawned.options.shell, false);
  assert.equal(spawned.options.windowsHide, true);
  assert.equal(spawned.options.detached, false);
  assert.equal(spawned.options.cwd, h.comfy.folder);
  assert.deepEqual(spawned.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(Object.keys(spawned.options.env).some((key) => /^PYTHON/i.test(key)), false);
  assert.equal(h.state.fetchCalls.filter((url) => url.endsWith('/system_stats')).length, 3);
  assert.ok(h.state.fetchCalls.every((url) => url.startsWith(`http://127.0.0.1:${PORT}/`)));
  const record = renderPidfile.readRenderRecord(h.pidPath);
  assert.equal(record.opId, OP_ID);
  assert.equal(record.pid, 4242);
  assert.equal(record.exePath, h.python);
  assert.ok(Number.isFinite(record.treeSince));
  assert.ok(h.state.logs.some(([, event]) => event === 'comfyui.started'));
  assert.deepEqual(await h.owner.stop(server), { confirmed: true });
});

test('start refuses a bad run id or an invalid ComfyUI folder without spawning', async (t) => {
  const h = harness(t);
  assert.deepEqual(await h.owner.start({ comfy: h.comfy, opId: '../../evil' }),
    { ok: false, reason: 'image_comfyui_missing', stderrTail: [] });
  const bad = harness(t, { validateComfyFolder: () => ({ ok: false, reason: 'comfyui_folder_invalid' }) });
  const result = await bad.owner.start({ comfy: bad.comfy, opId: OP_ID });
  assert.equal(result.reason, 'image_comfyui_missing');
  assert.equal(bad.state.spawns.length, 0);
  const real = createComfyProcessOwner({ userDataPath: createTrackedTempDir('jenny-comfy-real-') });
  const missing = await real.start({ comfy: { folder: path.join(h.userDataPath, 'nowhere') }, opId: OP_ID });
  assert.equal(missing.reason, 'image_comfyui_missing');
  assert.equal(h.state.spawns.length, 0);
});

test('a child that exits during readiness fails the start with a sanitized tail', async (t) => {
  const h = harness(t, { fetch: async (url, init, state) => {
    state.child.stderr.write('Traceback in C:\\Users\\x\\file.py line 3\u001b[0m\nplain line\n');
    state.child.emit('exit', 1, null);
    throw refused();
  } });
  const result = await h.owner.start({ comfy: h.comfy, opId: OP_ID });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'image_comfyui_start_failed');
  assert.equal(result.detail, 'exited');
  assert.ok(result.stderrTail.includes('Traceback in <path> line 3'), JSON.stringify(result.stderrTail));
  assert.ok(result.stderrTail.every((line) => !line.includes('C:\\Users')));
  assert.equal(h.state.killCalls.length, 0, 'an exited root takes the survivor path, not a kill');
  assert.ok(h.state.selected, 'survivors of the exited root were selected');
  assert.equal(renderPidfile.readRenderRecord(h.pidPath), null);
});

test('the tail keeps the last 20 lines within 4096 bytes', async (t) => {
  const h = harness(t, { fetch: async (url, init, state) => {
    for (let index = 0; index < 60; index += 1) state.child.stdout.write(`line ${index} ${'x'.repeat(300)}\n`);
    state.child.emit('exit', 1, null);
    throw refused();
  } });
  const result = await h.owner.start({ comfy: h.comfy, opId: OP_ID });
  assert.ok(result.stderrTail.length <= 20 && result.stderrTail.length > 0);
  assert.ok(Buffer.byteLength(result.stderrTail.join('\n')) <= 4096);
  assert.match(result.stderrTail.at(-1), /^line 59 /);
});

test('a server that never becomes ready is stopped with proof after the timeout', async (t) => {
  const h = harness(t, { notReady: Infinity });
  const result = await h.owner.start({ comfy: h.comfy, opId: OP_ID, readyTimeoutMs: 1000 });
  assert.equal(result.reason, 'image_comfyui_start_failed');
  assert.equal(result.detail, 'ready_timeout');
  assert.deepEqual(h.state.killCalls, [4242]);
  assert.equal(renderPidfile.readRenderRecord(h.pidPath), null);
  assert.equal(fs.existsSync(h.runDir), false);
});

test('an unconfirmed stop after a failed start reports cleanup pending and keeps the record', async (t) => {
  const h = harness(t, { notReady: Infinity,
    killResult: { confirmed: false, enumerated: true, pids: [4242, 77], survivors: [77] } });
  const result = await h.owner.start({ comfy: h.comfy, opId: OP_ID, readyTimeoutMs: 500 });
  assert.equal(result.reason, 'image_engine_cleanup_pending');
  const record = renderPidfile.readRenderRecord(h.pidPath);
  assert.equal(record.opId, OP_ID);
  assert.deepEqual(record.tree.survivors.map((entry) => entry.pid), [77]);
  assert.ok(fs.existsSync(h.runDir));
});

test('abort during readiness cancels and stops the child', async (t) => {
  const controller = new AbortController();
  const h = harness(t, { notReady: Infinity, fetch: async (url, init, state) => {
    if (state.fetchCalls.length === 2) controller.abort();
  } });
  const result = await h.owner.start({ comfy: h.comfy, opId: OP_ID, abortSignal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'image_cancelled');
  assert.deepEqual(h.state.killCalls, [4242]);
  assert.equal(fs.existsSync(h.runDir), false);
});

test('an already aborted start never spawns and leaves no run directory', async (t) => {
  const controller = new AbortController();
  controller.abort();
  const h = harness(t);
  const result = await h.owner.start({ comfy: h.comfy, opId: OP_ID, abortSignal: controller.signal });
  assert.equal(result.reason, 'image_cancelled');
  assert.equal(h.state.spawns.length, 0);
  assert.equal(fs.existsSync(h.runDir), false);
});

test('a spawn that throws fails the start without leaving a run directory', async (t) => {
  const h = harness(t);
  const owner = createComfyProcessOwner({
    userDataPath: h.userDataPath, spawnImpl: () => { throw new Error('ENOENT C:\\secret\\python.exe'); },
    getFreePort: async () => PORT, validateComfyFolder: () => ({ ok: true, folder: h.comfy.folder, pythonPath: h.python, mainPath: h.main }),
  });
  const result = await owner.start({ comfy: h.comfy, opId: OP_ID });
  assert.equal(result.reason, 'image_comfyui_start_failed');
  assert.equal(result.detail, 'spawn_failed');
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(fs.existsSync(h.runDir), false);
});

test('a render record that cannot be written kills the child', async (t) => {
  const h = harness(t, { pidfile: { writeRenderRecord: () => { throw new Error('disk full'); } } });
  const result = await h.owner.start({ comfy: h.comfy, opId: OP_ID });
  assert.equal(result.reason, 'image_engine_launch_unrecorded');
  assert.deepEqual(h.state.killCalls, [4242]);
  assert.equal(fs.existsSync(h.pidPath), false);
  assert.equal(h.state.fetchCalls.length, 0, 'no readiness poll without a record');
});

for (const level of ['comfyui', 'runs']) {
  test(`a linked ${level} directory is refused before any spawn`, (t) => {
    const h = harness(t);
    const elsewhere = createTrackedTempDir('jenny-comfy-elsewhere-');
    if (level === 'comfyui') linkDirectory(elsewhere, path.join(h.userDataPath, 'comfyui'));
    else {
      fs.mkdirSync(path.join(h.userDataPath, 'comfyui'));
      linkDirectory(elsewhere, path.join(h.userDataPath, 'comfyui', 'runs'));
    }
    return h.owner.start({ comfy: h.comfy, opId: OP_ID }).then((result) => {
      assert.equal(result.reason, 'image_comfyui_start_failed');
      assert.equal(result.detail, 'run_dir_unsafe');
      assert.equal(h.state.spawns.length, 0);
      assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was written through the link');
    });
  });
}

test('stop clears the record, removes the run directory and returns the same result when repeated', async (t) => {
  const h = harness(t);
  const { server } = await h.owner.start({ comfy: h.comfy, opId: OP_ID });
  const first = h.owner.stop(server);
  const second = h.owner.stop(server);
  assert.equal(first, second, 'concurrent calls share one promise');
  assert.deepEqual(await first, { confirmed: true });
  assert.deepEqual(await h.owner.stop(server), { confirmed: true });
  assert.deepEqual(h.state.killCalls, [4242], 'a single kill');
  assert.equal(renderPidfile.readRenderRecord(h.pidPath), null);
  assert.equal(fs.existsSync(h.runDir), false);
  assert.ok(h.state.logs.some(([, event, payload]) => event === 'comfyui.stopped' && payload.confirmed === true));
});

test('an unproven tree keeps the record with its evidence and the run directory', async (t) => {
  const h = harness(t, { killResult: { confirmed: false, enumerated: true, pids: [4242, 88], survivors: [88] } });
  const { server } = await h.owner.start({ comfy: h.comfy, opId: OP_ID });
  const first = await h.owner.stop(server);
  assert.deepEqual(first, { confirmed: false });
  assert.deepEqual(await h.owner.stop(server), { confirmed: false });
  assert.deepEqual(h.state.killCalls, [4242]);
  const record = renderPidfile.readRenderRecord(h.pidPath);
  assert.equal(record.opId, OP_ID);
  assert.deepEqual(record.tree.survivors.map((entry) => entry.pid), [88]);
  assert.ok(fs.existsSync(h.runDir));
  assert.ok(h.state.logs.some(([, event]) => event === 'comfyui.stop_unconfirmed'));
});

test('a snapshot descendant that survives the kill sends stop down the survivor path', async (t) => {
  const snapshot = { ok: true, pids: [5001], processes: [{ pid: 5001, createdMs: 2000 }], rootCreatedMs: 1500 };
  const h = harness(t, { snapshotAt500: true, snapshot, gone: { confirmed: false, survivors: [5001] }, selection: { ok: true, pids: [5001] } });
  const { server } = await h.owner.start({ comfy: h.comfy, opId: OP_ID });
  assert.deepEqual(await h.owner.stop(server), { confirmed: false }, 'the reap proof uses the same fake and stays unconfirmed');
  assert.equal(h.state.selected.rootPid, 4242);
  assert.deepEqual(h.state.terminated, [5001]);
  const record = renderPidfile.readRenderRecord(h.pidPath);
  assert.deepEqual(record.tree.processes, [{ pid: 5001, createdMs: 2000 }]);
});

test('stop after the root exited reaps survivors with the early snapshot', async (t) => {
  const snapshot = { ok: true, pids: [5001], processes: [{ pid: 5001, createdMs: 2000 }], rootCreatedMs: 1500 };
  const h = harness(t, { snapshotAt500: true, snapshot, selection: { ok: true, pids: [5001] } });
  const { server } = await h.owner.start({ comfy: h.comfy, opId: OP_ID });
  h.state.child.emit('exit', 0, null);
  assert.deepEqual(await h.owner.stop(server), { confirmed: true });
  assert.deepEqual(h.state.killCalls, [], 'the exited root pid is never a kill target');
  assert.equal(h.state.selected.rootPid, 4242);
  assert.deepEqual(h.state.selected.snapshot, snapshot);
  assert.deepEqual(h.state.terminated, [5001]);
  assert.equal(renderPidfile.readRenderRecord(h.pidPath), null);
  assert.equal(fs.existsSync(h.runDir), false);
});

test('an unprovable survivor selection after root exit stays unconfirmed', async (t) => {
  const h = harness(t, { selection: { ok: false, pids: [] } });
  const { server } = await h.owner.start({ comfy: h.comfy, opId: OP_ID });
  h.state.child.emit('exit', 0, null);
  assert.deepEqual(await h.owner.stop(server), { confirmed: false });
  const record = renderPidfile.readRenderRecord(h.pidPath);
  assert.equal(record.opId, OP_ID);
  assert.ok(record.tree, 'the window evidence is retained so the next reconcile can prove it');
});

test('stop of an unknown server is unconfirmed and never throws', async (t) => {
  const h = harness(t);
  assert.deepEqual(await h.owner.stop({ opId: OP_ID, pid: 4242 }), { confirmed: false });
  assert.deepEqual(await h.owner.stop(null), { confirmed: false });
  assert.deepEqual(h.state.killCalls, []);
});

test('missingNodes reports empty and absent node types, and null when the server is unreachable', async (t) => {
  const answers = {
    '/object_info/KSampler': { KSampler: { input: { required: {} } } },
    '/object_info/Gone': {},
    '/object_info/Odd%20Node': { Other: {} },
  };
  const h = harness(t, { fetch: async (url) => {
    const { pathname } = new URL(url);
    if (pathname === '/object_info/Broken') return new Response('nope', { status: 500 });
    return Object.hasOwn(answers, pathname) ? json(answers[pathname]) : undefined;
  } });
  const { server } = await h.owner.start({ comfy: h.comfy, opId: OP_ID });
  assert.deepEqual(await h.owner.missingNodes(server, ['KSampler', 'Gone', 'Odd Node', 'Broken']), ['Gone', 'Odd Node', 'Broken']);
  assert.deepEqual(await h.owner.missingNodes(server, []), []);
  assert.equal(h.state.fetchCalls.some((url) => url.endsWith('/object_info/Odd%20Node')), true);
  assert.equal(await h.owner.missingNodes({ opId: 'img_aaaaaaaaaaaa', port: 8188 }, ['KSampler']), null, 'a server this owner did not start is not asked');
  assert.equal(h.state.fetchCalls.some((url) => url.includes(':8188')), false);
  const offline = harness(t, { fetch: async (url, init, state) => { if (state.ready) throw refused(); } });
  const started = await offline.owner.start({ comfy: offline.comfy, opId: OP_ID });
  offline.state.ready = true;
  assert.equal(await offline.owner.missingNodes(started.server, ['A', 'B']), null);
});

test('loaderValues reads the model list of a loader input', async (t) => {
  const info = { UNETLoader: { input: { required: { unet_name: [['a/one.safetensors', 'b\\two.safetensors', 7], {}] } } },
    VAELoader: { input: { optional: { vae_name: ['COMBO', { options: ['x.safetensors'] }] } } },
    CLIPLoader: { input: { required: { clip_name: [] } } } };
  const h = harness(t, { fetch: async (url) => {
    const match = new URL(url).pathname.match(/^\/object_info\/(.+)$/);
    return match ? json(Object.hasOwn(info, match[1]) ? { [match[1]]: info[match[1]] } : {}) : undefined;
  } });
  const { server } = await h.owner.start({ comfy: h.comfy, opId: OP_ID });
  assert.deepEqual(await h.owner.loaderValues(server, 'UNETLoader', 'unet_name'), ['a/one.safetensors', 'b\\two.safetensors']);
  assert.deepEqual(await h.owner.loaderValues(server, 'VAELoader', 'vae_name'), ['x.safetensors']);
  assert.equal(await h.owner.loaderValues(server, 'CLIPLoader', 'clip_name'), null);
  assert.equal(await h.owner.loaderValues(server, 'Missing', 'x'), null);
  assert.equal(await h.owner.loaderValues(server, 'UNETLoader', 'nope'), null);
  assert.equal(await h.owner.loaderValues(server, 'UNETLoader', '__proto__'), null);
});

test('a lookup that times out makes missingNodes unknown rather than reporting the node missing', async (t) => {
  const h = harness(t, { fetch: async (url) => {
    const { pathname } = new URL(url);
    if (pathname === '/object_info/Slow') throw new DOMException('timed out', 'TimeoutError');
    if (pathname === '/object_info/KSampler') return json({ KSampler: { input: { required: {} } } });
    return undefined;
  } });
  const { server } = await h.owner.start({ comfy: h.comfy, opId: OP_ID });
  assert.equal(await h.owner.missingNodes(server, ['KSampler', 'Slow']), null);
});

test('an existing render record refuses the launch before any spawn and is left untouched', async (t) => {
  const h = harness(t);
  renderPidfile.writeRenderRecord(h.pidPath, { pid: 999999, exePath: path.join(h.userDataPath, 'old', 'sd-cli.exe'), opId: 'img_aaaaaaaaaaaa',
    output: path.join(h.userDataPath, 'image-engine-scratch', 'img_aaaaaaaaaaaa.png'), startedAt: 1, treeSince: 1 },
  { isProcessAliveImpl: () => false });
  const before = fs.readFileSync(h.pidPath, 'utf8');
  const result = await h.owner.start({ comfy: h.comfy, opId: OP_ID });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'image_engine_cleanup_pending');
  assert.deepEqual(h.state.spawns, []);
  assert.equal(fs.readFileSync(h.pidPath, 'utf8'), before);
});

test('start sweeps run directories orphaned by an earlier crash or quit-time kill', async (t) => {
  const h = harness(t);
  const runs = path.join(h.userDataPath, 'comfyui', 'runs');
  const orphan = path.join(runs, 'img_aaaaaaaaaaaa');
  fs.mkdirSync(path.join(orphan, 'output'), { recursive: true });
  fs.writeFileSync(path.join(orphan, 'output', 'jenny_00001_.png'), 'old');
  const foreign = path.join(runs, 'keep-me');
  fs.mkdirSync(foreign, { recursive: true });
  const result = await h.owner.start({ comfy: h.comfy, opId: OP_ID });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(foreign), true, 'only run-id names are swept');
  assert.equal(fs.existsSync(h.runDir), true);
});
