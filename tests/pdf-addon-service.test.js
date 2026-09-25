'use strict';

// services/pdf-addon-service.js: the optional PDF reading add-on (PyMuPDF,
// AGPL-3.0). Every collaborator is injected: fetch, the sidecar probe, the
// backend restart seam and the open dialog. Nothing touches the network or
// spawns a process; wheels are hand-assembled ZIPs.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { PDF_ADDON_ENV, PdfAddonService, runSidecarProbe } = require('../services/pdf-addon-service');
const { registerPdfAddonIpc } = require('../services/main/pdf-addon-ipc-registration');
const { assembleZip } = require('./helpers/plugins/hostile-archive-builder');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');
const { initializeSessionRuntimeComposition } = require('../services/session-runtime/composition');
const { captureRuntimeRoute } = require('../services/session-runtime/lanes');
const { capacityResource } = require('../services/session-runtime/resource-broker');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const VERSION = '1.27.2.2';
const FILENAME = `pymupdf-${VERSION}-cp310-abi3-win_amd64.whl`;
const ACCEPT = Object.freeze({ licenseAccepted: true });

function wheel(extra = []) {
  return assembleZip([
    { name: 'pymupdf/', data: Buffer.alloc(0), externalAttributes: 0x10 },
    { name: 'pymupdf/__init__.py', data: Buffer.from('VersionBind = "1.27.2"\n') },
    { name: 'fitz/__init__.py', data: Buffer.from('from pymupdf import *\n') },
    { name: `pymupdf-${VERSION}.dist-info/WHEEL`, data: Buffer.from('Wheel-Version: 1.0\n') },
    ...extra,
  ]).bytes;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function manifestFor(bytes, pinOverrides = {}) {
  return {
    package: 'PyMuPDF',
    version: VERSION,
    license: 'AGPL-3.0',
    licenseUrl: 'https://www.gnu.org/licenses/agpl-3.0.html',
    minimumPythonVersion: '3.10',
    installedSizeBytes: 1000,
    platforms: {
      'win32-x64': {
        filename: FILENAME,
        url: `https://files.pythonhosted.org/packages/aa/bb/${FILENAME}`,
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
        ...pinOverrides,
      },
    },
  };
}

function fakeBackend() {
  const backend = {
    restarts: [],
    activeStreams: new Map(),
    sessionRuntime: null,
    sidecarManager: {
      process: {},
      repoRoot: 'C:/app',
      packagedSidecarLaunch: { ok: true, launchCommand: 'C:/app/sidecar.exe', launchArgs: [] },
      getStatus: () => ({ phase: 'ready' }),
    },
    async _restartManagedSidecar(reason) {
      backend.restarts.push(reason);
      return true;
    },
  };
  return backend;
}

function fetchReturning(bytes, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.length) },
      body: (async function* body() { yield bytes; })(),
    };
  };
}

function buildService({
  bytes = wheel(),
  manifest = null,
  backend = fakeBackend(),
  fetchImpl = null,
  probe = { ok: true, version: '1.27.2' },
  userDataPath = null,
  ...rest
} = {}) {
  const probes = [];
  const root = userDataPath || createTrackedTempDir('jenny-pdf-addon-');
  const service = new PdfAddonService({
    userDataPath: root,
    isPackaged: true,
    platform: 'win32',
    arch: 'x64',
    manifest: manifest || manifestFor(bytes),
    fetchImpl: fetchImpl || fetchReturning(bytes),
    getBackend: () => backend,
    runProbe: async (launch) => {
      probes.push(launch);
      return probe;
    },
    applyPollMs: 5,
    ...rest,
  });
  const phases = [];
  service.on('changed', (state) => phases.push(state.state));
  return { service, backend, probes, phases, userDataPath: root, addonRoot: path.join(root, 'addons', 'pdf') };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function reopen(userDataPath, bytes) {
  return new PdfAddonService({
    userDataPath, isPackaged: true, platform: 'win32', arch: 'x64', manifest: manifestFor(bytes),
  });
}

test('install needs an explicit licence acceptance and a pinned https wheel on files.pythonhosted.org', () => {
  const { service } = buildService();
  for (const payload of [undefined, {}, { licenseAccepted: 'yes' }, { licenseAccepted: true, extra: 1 }]) {
    assert.throws(() => service.install(payload), (error) => error.reason === 'licence_not_accepted');
  }
  assert.equal(service.getState().state, 'not_installed');

  const noPin = buildService({ platform: 'linux', arch: 'arm64' }).service;
  assert.equal(noPin.getState().state, 'unsupported');
  assert.deepEqual(noPin.sidecarEnv(), { [PDF_ADDON_ENV]: '' });
  assert.throws(() => noPin.install(ACCEPT), (error) => error.reason === 'pdf_addon_busy');

  const bytes = wheel();
  for (const url of [`https://evil.example/${FILENAME}`, `http://files.pythonhosted.org/x/${FILENAME}`,
    `https://files.pythonhosted.org/x/other.whl`]) {
    const offPin = buildService({ bytes, manifest: manifestFor(bytes, { url }) }).service;
    assert.equal(offPin.getState().state, 'unsupported', url);
  }
});

test('install downloads the pinned wheel without redirects, publishes it, probes it and restarts the idle sidecar', async () => {
  const bytes = wheel();
  const calls = [];
  const { service, backend, probes, phases, userDataPath, addonRoot } = buildService({
    bytes, fetchImpl: fetchReturning(bytes, calls),
  });
  assert.deepEqual(service.sidecarEnv(), { [PDF_ADDON_ENV]: '' });

  assert.equal(service.install(ACCEPT).state, 'downloading');
  await service.whenSettled();

  const state = service.getState();
  assert.equal(state.state, 'ready');
  assert.equal(state.installedVersion, VERSION);
  assert.equal(state.applyPending, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, manifestFor(bytes).platforms['win32-x64'].url);
  assert.equal(calls[0].options.redirect, 'error');
  for (const phase of ['downloading', 'verifying', 'installing', 'ready']) assert.ok(phases.includes(phase), phase);

  const dir = service.sidecarEnv()[PDF_ADDON_ENV];
  assert.equal(dir, path.join(addonRoot, VERSION));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')), {
    package: 'PyMuPDF', version: VERSION, minimum_python_version: '3.10',
  });
  assert.ok(fs.existsSync(path.join(dir, 'fitz', '__init__.py')));
  assert.deepEqual(fs.readdirSync(addonRoot).sort(), [VERSION, 'state.json']);
  assert.deepEqual(probes, [{ command: 'C:/app/sidecar.exe', args: [], cwd: 'C:/app', addonDir: dir }]);
  assert.deepEqual(backend.restarts, ['pdf_addon_installed']);

  const nextStart = reopen(userDataPath, bytes);
  assert.equal(nextStart.getState().state, 'ready');
  assert.equal(nextStart.sidecarEnv()[PDF_ADDON_ENV], dir);
});

test('the sidecar is never restarted mid-turn; the install applies once no turn is running', async () => {
  const backend = fakeBackend();
  backend.activeStreams.set('stream-1', {});
  let running = true;
  backend.sessionRuntime = { hasProducingWork: () => running };
  const { service } = buildService({ backend });

  service.install(ACCEPT);
  await waitFor(() => service.getState().applyPending === true);
  assert.equal(service.getState().state, 'installing');

  backend.activeStreams.clear();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(backend.restarts, []);

  running = false;
  await service.whenSettled();
  assert.deepEqual(backend.restarts, ['pdf_addon_installed']);
  assert.equal(service.getState().state, 'ready');
});

function composedRuntime() {
  return initializeSessionRuntimeComposition({ options: { userDataPath: createTrackedTempDir('jenny-pdf-addon-runtime-') },
    featureFlags: { session_runtime: false }, activeStreams: new Map(),
    sessionStore: { conversationStore: { resolvePendingContinuation() {} }, getSession() {}, getActiveTurn() {} },
    sessionTurnActors: { blockCheckpointOrphan() {}, pauseRecoveredCheckpoint() {}, settleCheckpointOrphan() {} },
    turnEventJournal: { list: () => [] }, sessionExecutionAuthority: {}, configService: { getState: () => ({}) } });
}

// F23: a paused queued reply is persisted by the runtime store and a
// quarantined lease has no live producer, so neither holds the restart that
// applies the add-on; a turn still holding its lane does.
test('the install applies with only a paused reply and quarantined leases left, but not while a turn runs', async () => {
  const runtime = composedRuntime();
  const route = captureRuntimeRoute({ configuration_revision: 'rev_1', engine_type: 'ollama',
    provider_id: 'ollama', requires_gpu: false, resource_class: 'local' });
  const turn = runtime.lanes.tryAcquireTurn({ sessionId: 'session_1', route });
  assert.equal(turn.status, 'granted');
  const maintenance = await runtime.resourceBroker.acquire({ ownerId: 'desktop-sandbox-maintenance',
    resources: [capacityResource('sandbox_commands')] });
  runtime.resourceBroker.release(maintenance, { producerSettled: false });
  runtime.store.submit({ idempotencyKey: 'queued_reply', projectId: 'project_1', sessionId: 'session_2',
    purpose: 'chat', input: { prompt: 'hello' }, authority: { project_id: 'project_1', root_path: null,
      root_id: null, root_revision: 0, device_id: null, inode: null } });
  assert.equal(runtime.scheduler.pausePending().paused, 1);
  const backend = fakeBackend();
  backend.sessionRuntime = runtime;
  const { service } = buildService({ backend });

  service.install(ACCEPT);
  await waitFor(() => service.getState().applyPending === true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(backend.restarts, []);

  runtime.lanes.release(turn.lease, { producerSettled: false });
  await waitFor(() => backend.restarts.length > 0);
  assert.deepEqual(backend.restarts, ['pdf_addon_installed']);
  assert.equal(runtime.hasPendingOrAdmittedWork(), true);
  assert.deepEqual([runtime.lanes.snapshot().quarantined, runtime.resourceBroker.snapshot().quarantined_count], [1, 1]);
  assert.equal(runtime.store.getStatus().pending.host_count, 1);
  await service.whenSettled();
  assert.equal(service.getState().state, 'ready');
});

test('a stopped sidecar is not restarted: the next spawn reads the add-on directory', async () => {
  const backend = fakeBackend();
  backend.sidecarManager.process = null;
  const { service } = buildService({ backend });
  service.install(ACCEPT);
  await service.whenSettled();
  assert.equal(service.getState().state, 'ready');
  assert.deepEqual(backend.restarts, []);
});

test('a fingerprint or size mismatch deletes the download and installs nothing', async () => {
  const bytes = wheel();
  const cases = [
    [manifestFor(bytes, { sha256: '0'.repeat(64) }), fetchReturning(bytes)],
    [manifestFor(bytes), fetchReturning(Buffer.concat([bytes, Buffer.from('x')]))],
  ];
  for (const [manifest, fetchImpl] of cases) {
    const { service, backend, addonRoot } = buildService({ bytes, manifest, fetchImpl });
    service.install(ACCEPT);
    await service.whenSettled();
    assert.equal(service.getState().state, 'failed');
    assert.equal(service.getState().reason, 'fingerprint');
    assert.deepEqual(service.sidecarEnv(), { [PDF_ADDON_ENV]: '' });
    assert.deepEqual(fs.readdirSync(addonRoot), []);
    assert.deepEqual(backend.restarts, []);
  }
});

test('an unreachable or redirecting server fails as a network error and can be retried', async () => {
  const bytes = wheel();
  let attempts = 0;
  const { service } = buildService({
    bytes,
    fetchImpl: async (url, options) => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
      return fetchReturning(bytes)(url, options);
    },
  });
  service.install(ACCEPT);
  await service.whenSettled();
  assert.deepEqual([service.getState().state, service.getState().reason], ['failed', 'network']);

  service.install(ACCEPT);
  await service.whenSettled();
  assert.equal(service.getState().state, 'ready');
});

test('a pinned wheel whose entry escapes the install directory is refused', async () => {
  const bytes = wheel([{ name: '../escape.py', data: Buffer.from('print(1)\n') }]);
  const { service, addonRoot } = buildService({ bytes });
  service.install(ACCEPT);
  await service.whenSettled();
  assert.deepEqual([service.getState().state, service.getState().reason], ['failed', 'install_failed']);
  assert.deepEqual(fs.readdirSync(addonRoot), []);
  assert.equal(fs.existsSync(path.join(path.dirname(addonRoot), 'escape.py')), false);
});

test('cancel during the download returns to not installed and leaves nothing behind', async () => {
  const bytes = wheel();
  const { service, addonRoot } = buildService({
    bytes,
    fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: (async function* body() {
        yield bytes.subarray(0, 10);
        await new Promise((resolve) => options.signal.addEventListener('abort', resolve));
        yield bytes.subarray(10);
      })(),
    }),
  });
  service.install(ACCEPT);
  await waitFor(() => service.getState().downloadedBytes === 10);
  assert.equal(service.getState().cancellable, true);

  service.cancel();
  await service.whenSettled();
  assert.deepEqual([service.getState().state, service.getState().reason], ['not_installed', '']);
  assert.deepEqual(fs.readdirSync(addonRoot), []);
});

test('remove unsets the add-on, restarts the sidecar, and retries a locked delete at the next start', async (t) => {
  const bytes = wheel();
  const { service, backend, userDataPath, addonRoot } = buildService({ bytes });
  service.install(ACCEPT);
  await service.whenSettled();
  const dir = service.sidecarEnv()[PDF_ADDON_ENV];

  const realRm = fs.promises.rm;
  t.after(() => { fs.promises.rm = realRm; });
  fs.promises.rm = async (target, options) => {
    if (path.resolve(String(target)) === path.resolve(dir)) {
      throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    }
    return realRm.call(fs.promises, target, options);
  };

  assert.equal(service.remove().state, 'not_installed');
  assert.deepEqual(service.sidecarEnv(), { [PDF_ADDON_ENV]: '' });
  await service.whenSettled();
  assert.deepEqual(backend.restarts, ['pdf_addon_installed', 'pdf_addon_removed']);
  assert.ok(fs.existsSync(dir));
  fs.promises.rm = realRm;

  const nextStart = reopen(userDataPath, bytes);
  assert.equal(nextStart.getState().state, 'not_installed');
  assert.deepEqual(nextStart.sidecarEnv(), { [PDF_ADDON_ENV]: '' });
  await nextStart.start();
  assert.equal(fs.existsSync(dir), false);
  const record = JSON.parse(fs.readFileSync(path.join(addonRoot, 'state.json'), 'utf8'));
  assert.deepEqual([record.installedVersion, record.pendingRemoval], [null, []]);
});

test('install from a file uses the main-owned dialog and accepts only the pinned wheel', async () => {
  const bytes = wheel();
  const folder = createTrackedTempDir('jenny-pdf-addon-file-');
  const good = path.join(folder, FILENAME);
  const tampered = path.join(folder, `tampered-${FILENAME}`);
  fs.writeFileSync(good, bytes);
  const altered = Buffer.from(bytes);
  altered[40] ^= 0xff;
  fs.writeFileSync(tampered, altered);
  let picked = { canceled: true, filePaths: [] };
  const dialogs = [];
  const { service } = buildService({
    bytes,
    fetchImpl: async () => { throw new Error('install from a file must not download'); },
    showOpenDialog: async (options) => {
      dialogs.push(options);
      return picked;
    },
  });

  await assert.rejects(service.installFromFile({}), (error) => error.reason === 'licence_not_accepted');
  assert.equal((await service.installFromFile(ACCEPT)).state, 'not_installed');
  assert.deepEqual(dialogs[0].properties, ['openFile']);

  picked = { canceled: false, filePaths: [tampered] };
  await service.installFromFile(ACCEPT);
  await service.whenSettled();
  assert.deepEqual([service.getState().state, service.getState().reason], ['failed', 'wrong_file']);

  picked = { canceled: false, filePaths: [good] };
  await service.installFromFile(ACCEPT);
  await service.whenSettled();
  assert.equal(service.getState().state, 'ready');
});

test('cancel is refused once publishing starts, so a late Cancel never ends in a surprise install', async (t) => {
  const { service, addonRoot } = buildService();
  const realRm = fs.promises.rm;
  t.after(() => { fs.promises.rm = realRm; });
  let atPublish = null;
  fs.promises.rm = async (target, options) => {
    if (path.resolve(String(target)) === path.resolve(addonRoot, VERSION)) {
      service.cancel();
      atPublish = service.getState();
    }
    return realRm.call(fs.promises, target, options);
  };
  service.install(ACCEPT);
  await service.whenSettled();
  assert.equal(atPublish.cancellable, false);
  assert.equal(service.getState().state, 'ready');
});

test('a removal that cannot be saved reverts to the installed add-on instead of returning at the next start', async (t) => {
  const bytes = wheel();
  const { service, backend, userDataPath } = buildService({ bytes });
  service.install(ACCEPT);
  await service.whenSettled();
  const dir = service.sidecarEnv()[PDF_ADDON_ENV];
  const realWriteFile = fs.promises.writeFile;
  t.after(() => { fs.promises.writeFile = realWriteFile; });
  fs.promises.writeFile = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };

  service.remove();
  await service.whenSettled();
  fs.promises.writeFile = realWriteFile;
  assert.deepEqual([service.getState().state, service.getState().installedVersion], ['ready', VERSION]);
  assert.equal(service.sidecarEnv()[PDF_ADDON_ENV], dir);
  assert.deepEqual(backend.restarts, ['pdf_addon_installed']);
  assert.ok(fs.existsSync(dir));
  assert.equal(reopen(userDataPath, bytes).getState().state, 'ready');
});

test('only the pinned version counts as installed; another build\'s add-on is removed at start', async () => {
  const bytes = wheel();
  const { userDataPath, addonRoot } = buildService({ bytes });
  const stale = path.join(addonRoot, '1.26.0');
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, 'manifest.json'), '{"package":"PyMuPDF","minimum_python_version":"3.10"}');
  fs.writeFileSync(path.join(addonRoot, 'state.json'), JSON.stringify({ schema: 1, installedVersion: '1.26.0', probe: 'ok', pendingRemoval: [] }));

  const reopened = reopen(userDataPath, bytes);
  assert.equal(reopened.getState().state, 'not_installed');
  assert.deepEqual(reopened.sidecarEnv(), { [PDF_ADDON_ENV]: '' });
  await reopened.start();
  assert.equal(fs.existsSync(stale), false);
});

test('whenSettled waits while the install-from-file picker is open', async () => {
  let answer;
  const { service } = buildService({ showOpenDialog: () => new Promise((resolve) => { answer = resolve; }) });
  const returned = service.installFromFile(ACCEPT);
  let settled = false;
  void service.whenSettled().then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  answer({ canceled: true, filePaths: [] });
  assert.equal((await returned).state, 'not_installed');
  await waitFor(() => settled);
  assert.equal(service.getState().cancellable, false);
});

test('an add-on the sidecar cannot import is load_failed, still handed to the sidecar, and removable', async () => {
  const { service, backend } = buildService({ probe: { ok: false, error: 'ImportError' } });
  service.install(ACCEPT);
  await service.whenSettled();
  assert.equal(service.getState().state, 'load_failed');
  assert.ok(service.sidecarEnv()[PDF_ADDON_ENV]);
  assert.deepEqual(backend.restarts, ['pdf_addon_installed']);

  service.remove();
  await service.whenSettled();
  assert.equal(service.getState().state, 'not_installed');
});

test('development builds leave the sidecar env alone and report the venv PyMuPDF', async () => {
  const backend = { sidecarManager: { launchCommand: 'python.exe', launchArgs: null, repoRoot: 'C:/repo' } };
  const { service, probes } = buildService({ isPackaged: false, backend });
  assert.equal(service.getState().state, 'development');
  assert.deepEqual(service.sidecarEnv(), {});
  await waitFor(() => service.getState().developmentAvailable === true);
  assert.equal(service.getState().developmentVersion, '1.27.2');
  assert.deepEqual(probes, [{ command: 'python.exe', args: ['-m', 'sidecar'], cwd: 'C:/repo', addonDir: '' }]);
  assert.throws(() => service.install(ACCEPT), (error) => error.reason === 'pdf_addon_busy');
});

test('the load probe runs the sidecar with only the add-on flag and parses its JSON line', async () => {
  const spawned = [];
  const result = await runSidecarProbe({
    command: 'C:/app/sidecar.exe',
    args: [],
    cwd: 'C:/app',
    addonDir: 'C:/data/addons/pdf/1.27.2.2',
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      setImmediate(() => {
        child.stdout.emit('data', 'log noise\n{"ok": true, "version": "1.27.2", "addon_dir": "x"}\n');
        child.emit('close', 0);
      });
      return child;
    },
  });
  assert.deepEqual(result, { ok: true, version: '1.27.2', addon_dir: 'x' });
  assert.deepEqual(spawned[0].args, ['--probe-pdf-addon']);
  assert.equal(spawned[0].env[PDF_ADDON_ENV], 'C:/data/addons/pdf/1.27.2.2');

  const hung = await runSidecarProbe({
    command: 'x', args: [], cwd: '.', addonDir: '', timeoutMs: 10,
    spawnImpl: () => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill() {} }),
  });
  assert.deepEqual(hung, { ok: false, error: 'timeout' });
});

test('IPC handlers need a trusted sender, forward only the install payload, and reject stray payloads', async () => {
  const handlers = new Map();
  const { service } = buildService();
  registerPdfAddonIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    service,
    authorization: { authorize: (event) => event.trusted === true },
  });
  assert.deepEqual([...handlers.keys()].sort(), [
    'pdf-addon:cancel', 'pdf-addon:get-state', 'pdf-addon:install', 'pdf-addon:install-from-file', 'pdf-addon:remove',
  ]);

  const untrusted = await handlers.get('pdf-addon:install')({}, ACCEPT);
  assert.equal(untrusted.authorized, false);
  assert.equal(service.getState().state, 'not_installed');

  const refused = await handlers.get('pdf-addon:install')({ trusted: true }, {});
  assert.deepEqual([refused.ok, refused.reason, refused.state], [false, 'licence_not_accepted', 'not_installed']);
  const stray = await handlers.get('pdf-addon:remove')({ trusted: true }, { path: 'C:/elsewhere' });
  assert.deepEqual([stray.ok, stray.reason], [false, 'unexpected_payload']);

  const started = await handlers.get('pdf-addon:install')({ trusted: true }, ACCEPT);
  assert.equal(started.ok, true);
  await service.whenSettled();
  const state = await handlers.get('pdf-addon:get-state')({ trusted: true });
  assert.deepEqual([state.ok, state.state], [true, 'ready']);
});
