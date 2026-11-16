'use strict';

// new-test-file: row 142's chooser module and its three IPC channels are a new
// surface (services/main/llama-server-runtime-choice.js and
// llama-server-runtime-ipc-handlers.js); llama-server-runtime.test.js covers
// the pure launch-order helpers.
//
// The automatic build: which trusted builds count, which one a model gets,
// that the launch and the relaunch check agree, and that paths never cross IPC.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createRuntimeChooser } = require('../services/main/llama-server-runtime-choice');
const { createLlamaServerManager } = require('../services/main/llama-server-manager');
const { createRuntimePickRegistry } = require('../services/main/llama-server-runtime');
const { registerLlamaServerRuntimeIpcHandlers } = require('../services/main/llama-server-runtime-ipc-handlers');
const { getBridgeChannel } = require('../services/ipc-contract');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const TAG = 'lfm3-omni-2b-uncensored.f16';
const KEY = 'lfm3-omni-2b-uncensored-f16';

// A folder tree of fake builds. `reads` names the architectures each build's
// library "carries"; the injected arch answer reads it, so the tests do not
// depend on the Windows-only 'no' of the real library scan.
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-choice-'));
  trackDirectory(root);
  const reads = new Map();
  const builds = new Map();
  const make = (rel, build, archs) => {
    const file = path.join(root, rel, EXE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    reads.set(file.toLowerCase(), archs);
    builds.set(file.toLowerCase(), build);
    return file;
  };
  const model = path.join(root, 'models', 'LFM3-Omni-2B-Uncensored.f16.gguf');
  fs.mkdirSync(path.dirname(model), { recursive: true });
  fs.writeFileSync(model, '');
  const archSupportImpl = (binaryPath, architecture) => {
    const archs = reads.get(String(binaryPath).toLowerCase());
    if (!archs || !architecture) return 'unknown';
    if (archs === 'unknown') return 'unknown';
    return archs.includes(architecture) ? 'yes' : 'no';
  };
  const validateCalls = [];
  const validateImpl = async (candidate) => {
    validateCalls.push(candidate);
    const build = builds.get(String(candidate).toLowerCase());
    return build ? { ok: true, build } : { ok: false, reason: 'runtime_probe_failed' };
  };
  return { root, make, model, archSupportImpl, validateImpl, validateCalls, builds };
}

function chooserFor(tree, { managed = {}, bundled = '', enabled = true, userDataPath = '', architecture = 'lfm3' } = {}) {
  const state = { managed, enabled };
  const chooser = createRuntimeChooser({
    userDataPath: () => userDataPath,
    getManaged: () => state.managed,
    resolveBundledPath: () => bundled,
    isEnabled: () => state.enabled,
    readArchitecture: () => architecture,
    validateImpl: tree.validateImpl,
    archSupportImpl: tree.archSupportImpl,
  });
  return { chooser, state };
}

test('the newest trusted build that reads the architecture wins only when the bundled build cannot', async () => {
  const tree = makeTree();
  const bundled = tree.make('bundled', 11513, ['lfm2']);
  const b12098 = tree.make('runtimes/llama-b12098-cuda13.4', 12098, ['lfm2', 'lfm3']);
  tree.make('runtimes/llama-b11900', 11900, ['lfm3']);
  tree.make('runtimes/llama-b13000-old-arch', 13000, ['lfm2']);
  const { chooser } = chooserFor(tree, { bundled, managed: { runtimeRoots: [path.join(tree.root, 'runtimes')] } });
  assert.equal(await chooser.prepare(), 4);
  const choice = chooser.chooseFor({ modelPath: tree.model });
  assert.equal(choice.binaryPath, b12098);
  assert.equal(choice.build, 12098);
  assert.equal(choice.label, 'b12098');

  // The bundled build reads it, or cannot be judged: nothing is chosen.
  assert.equal(chooserFor(tree, { bundled: tree.make('bundled-new', 12500, ['lfm3']),
    managed: { runtimeRoots: [path.join(tree.root, 'runtimes')] } }).chooser.chooseFor({ modelPath: tree.model }), null);
  const unknown = chooserFor(tree, { bundled: tree.make('bundled-unknown', 11000, 'unknown'),
    managed: { runtimeRoots: [path.join(tree.root, 'runtimes')] } }).chooser;
  await unknown.prepare();
  assert.equal(unknown.chooseFor({ modelPath: tree.model }), null);
  // A model with a saved build keeps it.
  assert.equal(chooser.chooseFor({ modelPath: tree.model, savedRuntimePath: bundled }), null);
});

test('with the flag off nothing is probed and nothing is chosen', async () => {
  const tree = makeTree();
  const bundled = tree.make('bundled', 11513, ['lfm2']);
  tree.make('runtimes/llama-b12098', 12098, ['lfm3']);
  const { chooser, state } = chooserFor(tree, { bundled, enabled: false,
    managed: { runtimeRoots: [path.join(tree.root, 'runtimes')] } });
  assert.equal(await chooser.prepare(), 0);
  assert.equal(tree.validateCalls.length, 0);
  state.enabled = true;
  await chooser.prepare();
  assert.ok(chooser.chooseFor({ modelPath: tree.model }));
  state.enabled = false;
  assert.equal(chooser.chooseFor({ modelPath: tree.model }), null);
  assert.deepEqual(chooser.optionsFor({ modelPath: tree.model }).candidates, []);
});

test('trusted builds come from saved builds, Jenny\'s runtimes folder and runtime folders one level deep', async () => {
  const tree = makeTree();
  const saved = tree.make('elsewhere/llama-b11000', 11000, ['lfm2']);
  const home = path.join(tree.root, 'userdata');
  const own = tree.make('userdata/runtimes/b12100-cuda', 12100, ['lfm3']);
  const atRoot = tree.make('folder-root', 12001, ['lfm3']);
  tree.make('deep/one/two', 99999, ['lfm3']);
  // A download's staging folder (and any dot folder) is Jenny's own work in progress, never a build.
  tree.make('userdata/runtimes/.staging-b13000-cpu', 13000, ['lfm3']);
  const { chooser } = chooserFor(tree, {
    userDataPath: home,
    managed: {
      perModel: { other: { runtimePath: saved } },
      runtimeRoots: [path.join(tree.root, 'folder-root'), path.join(tree.root, 'deep')],
    },
  });
  await chooser.prepare();
  const probed = tree.validateCalls.map((file) => file.toLowerCase());
  assert.ok(probed.includes(saved.toLowerCase()));
  assert.ok(probed.includes(own.toLowerCase()));
  assert.ok(probed.includes(atRoot.toLowerCase()));
  assert.equal(probed.some((file) => file.includes(`${path.sep}two${path.sep}`)), false, 'two levels deep is never searched');
  assert.equal(probed.some((file) => file.includes('.staging-')), false, 'a dot folder is never searched');
});

test('a linked folder, a failed probe and a non-build file are never trusted', async () => {
  const tree = makeTree();
  const real = tree.make('real/llama-b12098', 12098, ['lfm3']);
  const linkRoot = path.join(tree.root, 'linked');
  fs.symlinkSync(path.join(tree.root, 'real'), linkRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const broken = tree.make('runtimes/llama-b12500', 0, ['lfm3']);
  fs.mkdirSync(path.join(tree.root, 'runtimes', 'not-a-build'), { recursive: true });
  fs.writeFileSync(path.join(tree.root, 'runtimes', 'not-a-build', 'readme.txt'), '');
  const { chooser } = chooserFor(tree, {
    bundled: tree.make('bundled', 11513, ['lfm2']),
    managed: { runtimeRoots: [linkRoot, path.join(tree.root, 'runtimes')] },
  });
  await chooser.prepare();
  const probed = tree.validateCalls.map((file) => file.toLowerCase());
  assert.equal(probed.some((file) => file.startsWith(linkRoot.toLowerCase())), false, 'a junction root is refused before any probe');
  assert.ok(probed.includes(broken.toLowerCase()));
  assert.equal(chooser.chooseFor({ modelPath: tree.model }), null, 'the only lfm3 build failed its probe');
  // A failed probe is remembered for the session.
  tree.validateCalls.length = 0;
  await chooser.prepare();
  assert.equal(tree.validateCalls.some((file) => file.toLowerCase() === broken.toLowerCase()), false);
  assert.ok(real);
});

test('a folder under a linked ancestor (a relocated profile) is trusted; only the folder itself must not be a link', async () => {
  const tree = makeTree();
  fs.mkdirSync(path.join(tree.root, 'realprofile'), { recursive: true });
  const linkProfile = path.join(tree.root, 'linkprofile');
  fs.symlinkSync(path.join(tree.root, 'realprofile'), linkProfile, process.platform === 'win32' ? 'junction' : 'dir');
  // Written through the link, so the fake probe knows the build by the path the chooser sees.
  const own = tree.make('linkprofile/runtimes/b12098-win-x64-cpu', 12098, ['lfm3']);
  const { chooser } = chooserFor(tree, { userDataPath: linkProfile, bundled: tree.make('bundled', 11513, ['lfm2']) });
  assert.equal(await chooser.prepare(), 2, 'the bundled build and the downloaded one');
  const chosen = chooser.chooseFor({ modelPath: tree.model });
  assert.equal(chosen && chosen.build, 12098);
  assert.equal(path.basename(path.dirname(chosen.binaryPath)), path.basename(path.dirname(own)));
});

test('at most sixteen builds are considered', async () => {
  const tree = makeTree();
  for (let index = 0; index < 20; index += 1) {
    tree.make(`runtimes/llama-b${11000 + index}`, 11000 + index, ['lfm3']);
  }
  const { chooser } = chooserFor(tree, { managed: { runtimeRoots: [path.join(tree.root, 'runtimes')] } });
  assert.equal(await chooser.prepare(), 16);
});

test('options name builds by id, never by path, and skip the current build and builds that cannot read it', async () => {
  const tree = makeTree();
  const bundled = tree.make('bundled', 11513, ['lfm2']);
  const b12098 = tree.make('runtimes/llama-b12098', 12098, ['lfm3']);
  tree.make('runtimes/llama-b12000', 12000, 'unknown');
  tree.make('runtimes/llama-b11950', 11950, ['lfm3']);
  tree.make('runtimes/llama-b11900', 11900, ['lfm3']);
  tree.make('runtimes/llama-b13000', 13000, ['lfm2']);
  const { chooser } = chooserFor(tree, { bundled, managed: { runtimeRoots: [path.join(tree.root, 'runtimes')] } });
  await chooser.prepare();
  const options = chooser.optionsFor({ modelPath: tree.model });
  assert.deepEqual(options.current, { source: 'auto', build: 12098, label: 'b12098' });
  assert.deepEqual(options.candidates.map((item) => [item.label, item.reads]),
    [['b11950', 'yes'], ['b11900', 'yes'], ['b12000', 'unknown']]);
  assert.equal(JSON.stringify(options).includes(tree.root), false);
  assert.equal(chooser.pathForId(options.candidates[0].id).toLowerCase(), path.join(tree.root, 'runtimes', 'llama-b11950', EXE).toLowerCase());
  assert.equal(chooser.pathForId('feedfacefeedface'), '');
  // With a saved build, the automatic one is offered like any other.
  const savedOptions = chooser.optionsFor({ modelPath: tree.model, savedRuntimePath: bundled });
  assert.equal(savedOptions.current.source, 'saved');
  assert.equal(savedOptions.candidates[0].id, chooser.optionsFor({ modelPath: tree.model, savedRuntimePath: bundled }).candidates[0].id);
  assert.ok(savedOptions.candidates.some((item) => chooser.pathForId(item.id) === b12098));
});

// ---- inside the manager ----

function managerHarness(tree, { managed, bundled }) {
  const launches = [];
  const logs = [];
  const state = { managed, flags: { llama_server_acceleration: true, auto_runtime_pick: true } };
  let nextPid = 900;
  const lifecycle = {
    async startLlamaServer(options) {
      launches.push(options);
      const pid = nextPid++;
      return { pid, baseUrl: `http://127.0.0.1:${options.port}/v1`, reused: false, mmproj: '', apiKey: `k${pid}`,
        async stop() { return { confirmed: true }; }, stopSync() {} };
    },
    resolveBinaryPath: () => bundled,
    resolveGgufPath: () => ({ path: '', projectorPath: '' }),
    resolveProjectorPath: () => '',
    sweepStaleApiKeyFiles() {},
  };
  const manager = createLlamaServerManager({
    processRef: { env: {}, resourcesPath: '' },
    rootDir: os.tmpdir(),
    userDataPath: '',
    getShellConfigService: () => ({
      getLocalEngines: () => ({ openaiCompatible: { port: 8033, apiUrl: '', acceleration: null, managed: state.managed } }),
      getState: () => ({ featureOverrides: {} }),
    }),
    log: (level, event, details) => logs.push({ level, event, details }),
    lifecycle,
    resolveLaunchAccelerationImpl: () => ({ mode: 'off', reason: 'disabled', extraArgs: [], drafter: '', vramHeadroomMb: 0 }),
    planLaunchMemoryImpl: async ({ requestedContext }) => ({ reason: 'fits', contextSize: requestedContext, extraArgs: [] }),
    resolveSettingsImpl: () => ({
      autostart: true, binaryOverride: '', host: '127.0.0.1', port: 8033, profileId: '', profile: null,
      profileError: '', modelPathOverride: '', modelTagOverride: '', readinessTimeoutMs: 1000,
    }),
    buildFeatureFlagsImpl: () => state.flags,
    createRuntimeChooserImpl: (options) => createRuntimeChooser({
      ...options, readArchitecture: () => 'lfm3', validateImpl: tree.validateImpl, archSupportImpl: tree.archSupportImpl,
    }),
  });
  return { manager, launches, logs, state };
}

test('a model the bundled build cannot read launches on the automatic build, once, and stays up', async () => {
  const tree = makeTree();
  const bundled = tree.make('bundled', 11513, ['lfm2']);
  const b12098 = tree.make('runtimes/llama-b12098-cuda13.4', 12098, ['lfm3']);
  const managed = {
    enabled: true,
    runtimeRoots: [path.join(tree.root, 'runtimes')],
    perModel: { [KEY]: { engine: 'llama-server', tag: TAG, modelPath: tree.model } },
  };
  const h = managerHarness(tree, { managed, bundled });
  const spec = { modelTag: TAG, modelPath: tree.model };
  const status = await h.manager.ensureRunning(spec);
  assert.equal(status.state, 'ready');
  assert.equal(h.launches.length, 1);
  assert.equal(h.launches[0].binaryPath, b12098);
  assert.equal(h.launches[0].runtimeSource, 'auto');
  assert.equal(status.runtimeAuto, true);
  assert.equal(status.runtimeLabel, 'build 12098');
  const logged = h.logs.find((entry) => entry.event === 'llama.server.runtime_auto');
  assert.deepEqual(logged.details, { model: KEY, runtime: 'build 12098' });
  assert.equal(JSON.stringify(h.logs).includes(tree.root), false, 'no log line carries a path');
  // The chat preflight's relaunch check reads the same choice: no relaunch loop.
  await h.manager.ensureRunning(spec);
  await h.manager.ensureRunning(spec);
  assert.equal(h.launches.length, 1);
});

test('a stop or stopSync while the builds are probed retires the launch: nothing spawns', async () => {
  for (const how of ['stop', 'stopSync']) {
    const tree = makeTree();
    const bundled = tree.make('bundled', 11513, ['lfm2']);
    tree.make('runtimes/llama-b12098', 12098, ['lfm3']);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const gated = { ...tree, validateImpl: async (candidate) => { await held; return tree.validateImpl(candidate); } };
    const managed = {
      enabled: true,
      runtimeRoots: [path.join(tree.root, 'runtimes')],
      perModel: { [KEY]: { engine: 'llama-server', tag: TAG, modelPath: tree.model } },
    };
    const h = managerHarness(gated, { managed, bundled });
    const launching = h.manager.ensureRunning({ modelTag: TAG, modelPath: tree.model });
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
    const stopped = how === 'stop' ? h.manager.stop() : (h.manager.stopSync(), Promise.resolve());
    release();
    await launching;
    await stopped;
    await h.manager.settled();
    assert.equal(h.launches.length, 0, `${how}: no server spawned after the stop`);
    assert.notEqual(h.manager.getStatus().state, 'ready', how);
  }
});

test('a saved build beats the automatic one, and a removed automatic build re-resolves instead of failing', async () => {
  const tree = makeTree();
  const bundled = tree.make('bundled', 11513, ['lfm2']);
  const forkDir = path.join(tree.root, 'saved', 'llama-prism-b10683');
  const fork = tree.make('saved/llama-prism-b10683', 10683, ['lfm2']);
  tree.make('runtimes/llama-b12098', 12098, ['lfm3']);
  const managed = {
    enabled: true,
    runtimeRoots: [path.join(tree.root, 'runtimes')],
    perModel: { [KEY]: { engine: 'llama-server', tag: TAG, modelPath: tree.model, runtimePath: fork, runtimeBuild: 10683 } },
  };
  const h = managerHarness(tree, { managed, bundled });
  await h.manager.ensureRunning({ modelTag: TAG, modelPath: tree.model });
  assert.equal(h.launches[0].binaryPath, fork);
  assert.equal(h.launches[0].runtimeSource, 'saved');

  // No saved build, and the runtime folder is gone: the next launch is bundled.
  h.state.managed = { ...managed, runtimeRoots: [], perModel: { [KEY]: { engine: 'llama-server', tag: TAG, modelPath: tree.model } } };
  await h.manager.restart({ modelTag: TAG, modelPath: tree.model });
  assert.equal(h.launches.at(-1).binaryPath, bundled);
  assert.equal(h.launches.at(-1).runtimeSource, 'bundled');
  assert.ok(forkDir);
});

test('with the flag off the manager launches exactly as before', async () => {
  const tree = makeTree();
  const bundled = tree.make('bundled', 11513, ['lfm2']);
  tree.make('runtimes/llama-b12098', 12098, ['lfm3']);
  const h = managerHarness(tree, {
    bundled,
    managed: { enabled: true, runtimeRoots: [path.join(tree.root, 'runtimes')], perModel: {} },
  });
  h.state.flags = { llama_server_acceleration: true };
  const status = await h.manager.ensureRunning({ modelTag: TAG, modelPath: tree.model });
  assert.equal(h.launches[0].binaryPath, bundled);
  assert.equal(status.runtimeAuto, false);
  assert.equal(tree.validateCalls.length, 0);
});

// ---- IPC ----

const TRUSTED = { sender: 'main-window' };
const allowMainWindow = {
  authorize: (event) => event === TRUSTED,
  unauthorizedResult: () => ({ ok: false, authorized: false, code: 'ipc_sender_unauthorized' }),
};

function ipcHarness({
  tree, managed, bundled, dialogResult = { canceled: true, filePaths: [] }, authorization = allowMainWindow, flagOn = true,
  runtimeDownload = null,
}) {
  const handlers = new Map();
  const state = { managed };
  const shellConfigService = {
    getState: () => ({ featureOverrides: {} }),
    getLocalEngines: () => ({ openaiCompatible: { managed: state.managed } }),
    updateManagedLlamaServer(patch) {
      state.managed = { ...state.managed, perModel: { ...state.managed.perModel, ...patch.perModel } };
    },
  };
  // The chooser reads the live settings, as the manager's does.
  const runtimeChooser = createRuntimeChooser({
    getManaged: () => state.managed, resolveBundledPath: () => bundled, isEnabled: () => true,
    readArchitecture: () => 'lfm3', validateImpl: tree.validateImpl, archSupportImpl: tree.archSupportImpl,
  });
  const manager = { runtimeChooser, runtimeFolderPicks: createRuntimePickRegistry() };
  const dialogCalls = [];
  registerLlamaServerRuntimeIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    getManager: () => manager,
    shellConfigService,
    getMainWindow: () => 'main-window',
    dialogImpl: { showOpenDialog: async (win, options) => { dialogCalls.push(options); return dialogResult; } },
    authorization,
    env: { JENNY_ENABLE_AUTO_RUNTIME_PICK: flagOn ? '1' : '0' },
    validateImpl: tree.validateImpl,
    runtimeDownload,
  });
  const call = (method, payload, event = TRUSTED) => handlers.get(getBridgeChannel(method, 'invoke'))(event, payload);
  return { call, manager, state, dialogCalls };
}

test('the runtime folder dialog records a local pick, refuses links and network paths, and trusts only main', async () => {
  const tree = makeTree();
  const folder = path.join(tree.root, 'runtimes');
  fs.mkdirSync(folder, { recursive: true });
  const picked = ipcHarness({ tree, managed: { perModel: {} }, dialogResult: { canceled: false, filePaths: [folder] } });
  assert.deepEqual(await picked.call('llamaServer.chooseRuntimeFolder', {}), { ok: true, picked: true, path: folder });
  assert.equal(picked.manager.runtimeFolderPicks.has(folder), true);

  const linkRoot = path.join(tree.root, 'linked');
  fs.symlinkSync(folder, linkRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = ipcHarness({ tree, managed: { perModel: {} }, dialogResult: { canceled: false, filePaths: [linkRoot] } });
  assert.deepEqual(await linked.call('llamaServer.chooseRuntimeFolder', {}), { ok: false, reason: 'link_folder' });
  assert.equal(linked.manager.runtimeFolderPicks.size(), 0);

  if (process.platform === 'win32') {
    const network = ipcHarness({ tree, managed: { perModel: {} }, dialogResult: { canceled: false, filePaths: ['\\\\host\\share\\runtimes'] } });
    assert.deepEqual(await network.call('llamaServer.chooseRuntimeFolder', {}), { ok: false, reason: 'network_path' });
  }
  const cancelled = ipcHarness({ tree, managed: { perModel: {} } });
  assert.deepEqual(await cancelled.call('llamaServer.chooseRuntimeFolder', {}), { ok: true, picked: false, path: '' });

  const foreign = ipcHarness({ tree, managed: { perModel: {} }, dialogResult: { canceled: false, filePaths: [folder] } });
  assert.equal((await foreign.call('llamaServer.chooseRuntimeFolder', {}, { sender: 'webview' })).code, 'ipc_sender_unauthorized');
  const unguarded = ipcHarness({ tree, managed: { perModel: {} }, authorization: null, dialogResult: { canceled: false, filePaths: [folder] } });
  assert.equal((await unguarded.call('llamaServer.chooseRuntimeFolder', {})).code, 'ipc_sender_unauthorized');
  assert.equal(foreign.dialogCalls.length + unguarded.dialogCalls.length, 0);

  const off = ipcHarness({ tree, managed: { perModel: {} }, flagOn: false, dialogResult: { canceled: false, filePaths: [folder] } });
  assert.deepEqual(await off.call('llamaServer.chooseRuntimeFolder', {}), { ok: false, reason: 'flag_off' });
});

test('runtimeOptions and useRuntimeBuild: ids in, a saved build out, stale ids refused', async () => {
  const tree = makeTree();
  const bundled = tree.make('bundled', 11513, ['lfm2']);
  tree.make('runtimes/llama-b12098', 12098, ['lfm3']);
  const b11950 = tree.make('runtimes/llama-b11950', 11950, ['lfm3']);
  const managed = {
    runtimeRoots: [path.join(tree.root, 'runtimes')],
    perModel: { [KEY]: { engine: 'llama-server', tag: TAG, modelPath: tree.model } },
  };
  const h = ipcHarness({ tree, managed, bundled });
  assert.deepEqual(await h.call('llamaServer.runtimeOptions', { modelTag: 'nope' }), { ok: false, reason: 'unknown_model' });
  const options = await h.call('llamaServer.runtimeOptions', { modelTag: TAG });
  assert.equal(options.ok, true);
  assert.deepEqual(options.current, { source: 'auto', build: 12098, label: 'b12098' });
  assert.equal(options.architecture, 'lfm3');
  assert.equal(JSON.stringify(options).includes(tree.root), false);
  const pick = options.candidates.find((item) => item.label === 'b11950');

  assert.deepEqual(await h.call('llamaServer.useRuntimeBuild', { modelTag: TAG, id: 'feedfacefeedface' }), { ok: false, reason: 'stale_option' });
  assert.deepEqual(await h.call('llamaServer.useRuntimeBuild', { modelTag: TAG, id: pick.id }), { ok: true, build: 11950 });
  assert.equal(h.state.managed.perModel[KEY].runtimePath, b11950);
  assert.equal(h.state.managed.perModel[KEY].runtimeBuild, 11950);
  const after = await h.call('llamaServer.runtimeOptions', { modelTag: TAG });
  assert.deepEqual(after.current, { source: 'saved', build: 11950, label: 'b11950' });

  // A build that stops validating is not saved: the prepare before the save retires its id.
  tree.builds.set(path.join(tree.root, 'runtimes', 'llama-b12098', EXE).toLowerCase(), 0);
  const stale = after.candidates.find((item) => item.label === 'b12098');
  assert.deepEqual(await h.call('llamaServer.useRuntimeBuild', { modelTag: TAG, id: stale.id }), { ok: false, reason: 'stale_option' });
  assert.equal(h.state.managed.perModel[KEY].runtimePath, b11950);
});

test('an id issued for a folder the user then removed is refused, and Use bundled saves no path', async () => {
  const tree = makeTree();
  const bundled = tree.make('bundled', 11513, 'unknown');
  const b12098 = tree.make('runtimes/llama-b12098', 12098, ['lfm3']);
  const managed = {
    runtimeRoots: [path.join(tree.root, 'runtimes')],
    perModel: { [KEY]: { engine: 'llama-server', tag: TAG, modelPath: tree.model, runtimePath: b12098, runtimeBuild: 12098, mtp: { mode: 'off' } } },
  };
  const h = ipcHarness({ tree, managed, bundled });
  const saved = await h.call('llamaServer.runtimeOptions', { modelTag: TAG });
  const bundledOption = saved.candidates.find((item) => item.label === 'bundled');
  assert.ok(bundledOption, 'a saved build offers the bundled one');
  assert.deepEqual(await h.call('llamaServer.useRuntimeBuild', { modelTag: TAG, id: bundledOption.id }), { ok: true, build: 11513, bundled: true });
  const entry = h.state.managed.perModel[KEY];
  assert.equal('runtimePath' in entry, false, 'the install path is never saved as a build');
  assert.equal('runtimeBuild' in entry, false);
  assert.deepEqual(entry.mtp, { mode: 'off' }, 'the rest of the entry is kept');

  // The folder goes; an id the renderer still holds for its build must not save it.
  const other = tree.make('elsewhere/llama-b12200', 12200, ['lfm3']);
  h.state.managed = { ...h.state.managed, runtimeRoots: [path.join(tree.root, 'elsewhere')] };
  const offered = await h.call('llamaServer.runtimeOptions', { modelTag: TAG });
  const held = offered.candidates.find((item) => item.label === 'b12200');
  h.state.managed = { ...h.state.managed, runtimeRoots: [] };
  assert.deepEqual(await h.call('llamaServer.useRuntimeBuild', { modelTag: TAG, id: held.id }), { ok: false, reason: 'stale_option' });
  assert.equal(h.state.managed.perModel[KEY].runtimePath, undefined);
  assert.ok(other);
});

// ---- Row 142 S3: reader and build questions, folder summary, download channels ----

test('hasReader, bundledReads and rootSummary answer from the last prepare', async () => {
  const tree = makeTree();
  const bundled = tree.make('bundled', 11513, ['lfm2']);
  tree.make('runtimes/llama-b12098', 12098, ['lfm2', 'lfm3']);
  tree.make('runtimes/llama-b11900', 11900, ['lfm2']);
  tree.make('elsewhere/llama-b11000', 11000, ['lfm2']);
  const runtimes = path.join(tree.root, 'runtimes');
  const empty = path.join(tree.root, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  const { chooser, state } = chooserFor(tree, { bundled, managed: { runtimeRoots: [runtimes, empty, 'relative\\nope'] } });
  assert.equal(chooser.hasReader('lfm3'), false, 'nothing is validated before prepare()');
  assert.deepEqual(chooser.rootSummary().map((item) => item.builds), [0, 0]);
  await chooser.prepare();
  assert.equal(chooser.bundledReads('lfm3'), 'no');
  assert.equal(chooser.bundledReads('lfm2'), 'yes');
  assert.equal(chooser.hasReader('lfm3'), true);
  assert.equal(chooser.hasReader('lfm2'), true);
  assert.equal(chooser.hasReader('unseen'), false);
  assert.equal(chooser.hasReader(''), false);
  assert.deepEqual(chooser.rootSummary(), [
    { path: runtimes, builds: 2, newest: 12098 },
    { path: empty, builds: 0, newest: 0 },
  ]);
  state.managed = { runtimeRoots: [empty] };
  assert.deepEqual(chooser.rootSummary(), [{ path: empty, builds: 0, newest: 0 }]);
  // The bundled build never counts as "another build that reads it".
  const only = chooserFor(makeTree(), { bundled: tree.make('bundled2', 11514, ['lfm3']), managed: {} });
  await only.chooser.prepare();
  assert.equal(only.chooser.hasReader('lfm3'), false);
});

test('runtimeOptions carries the download offer; the download channels and folder summary obey the flag and authorization', async () => {
  const tree = makeTree();
  const bundled = tree.make('bundled', 11513, ['lfm2']);
  const runtimes = path.join(tree.root, 'runtimes');
  tree.make('runtimes/llama-b11900', 11900, ['lfm2']);
  const asked = [];
  const runtimeDownload = {
    warm: async () => {},
    offerFor: (query) => { asked.push(query); return { build: 12098, sizeBytes: 1234 }; },
    start: async (query) => { asked.push({ start: query }); return { ok: true, build: 12098 }; },
    status: () => ({ state: 'downloading', build: 12098, receivedBytes: 5, totalBytes: 10 }),
    cancel: () => ({ ok: true }),
  };
  const managed = {
    runtimeRoots: [runtimes],
    perModel: { [KEY]: { engine: 'llama-server', tag: TAG, modelPath: tree.model } },
  };
  const h = ipcHarness({ tree, managed, bundled, runtimeDownload });
  const options = await h.call('llamaServer.runtimeOptions', { modelTag: TAG });
  assert.deepEqual(options.download, { build: 12098, sizeBytes: 1234 });
  // The download service asks the chooser itself (its injected resolvers).
  assert.deepEqual(asked[0], { architecture: 'lfm3' });
  assert.deepEqual(await h.call('llamaServer.runtimeFolderSummary', {}), { ok: true, folders: [{ path: runtimes, builds: 1, newest: 11900 }] });
  assert.deepEqual(await h.call('llamaServer.runtimeDownloadStart', { architecture: 'lfm3', path: 'C:\\evil' }), { ok: true, build: 12098 });
  assert.deepEqual(asked.at(-1), { start: { architecture: 'lfm3' } });
  assert.deepEqual(await h.call('llamaServer.runtimeDownloadStart', { architecture: 7 }), { ok: true, build: 12098 });
  assert.deepEqual(asked.at(-1), { start: { architecture: '' } });
  assert.deepEqual(await h.call('llamaServer.runtimeDownloadStatus', {}), {
    ok: true, state: 'downloading', build: 12098, receivedBytes: 5, totalBytes: 10,
  });
  assert.deepEqual(await h.call('llamaServer.runtimeDownloadCancel', {}), { ok: true });

  const noService = ipcHarness({ tree, managed, bundled });
  assert.equal((await noService.call('llamaServer.runtimeOptions', { modelTag: TAG })).download, null);
  assert.deepEqual(await noService.call('llamaServer.runtimeDownloadStart', { architecture: 'lfm3' }), { ok: false, reason: 'manager_unavailable' });

  const off = ipcHarness({ tree, managed, bundled, runtimeDownload, flagOn: false });
  for (const method of ['runtimeDownloadStart', 'runtimeDownloadStatus', 'runtimeDownloadCancel', 'runtimeFolderSummary']) {
    assert.deepEqual(await off.call(`llamaServer.${method}`, { architecture: 'lfm3' }), { ok: false, reason: 'flag_off' }, method);
  }
  const startCalls = asked.filter((entry) => entry.start).length;
  const foreign = ipcHarness({ tree, managed, bundled, runtimeDownload });
  const unguarded = ipcHarness({ tree, managed, bundled, runtimeDownload, authorization: null });
  for (const method of ['runtimeDownloadStart', 'runtimeDownloadStatus', 'runtimeDownloadCancel', 'runtimeFolderSummary']) {
    assert.equal((await foreign.call(`llamaServer.${method}`, {}, { sender: 'webview' })).code, 'ipc_sender_unauthorized', method);
    assert.equal((await unguarded.call(`llamaServer.${method}`, {})).code, 'ipc_sender_unauthorized', method);
  }
  assert.equal(asked.filter((entry) => entry.start).length, startCalls);
});
