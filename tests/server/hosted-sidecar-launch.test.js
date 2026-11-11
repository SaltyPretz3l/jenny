'use strict';

// Slice 1f-2: a host started from the packaged desktop app launches the
// packaged one-file sidecar the way the CLI host does (resources directory as
// its working directory, no interpreter guessed), and a host started from a
// source checkout or the Docker image behaves exactly as before
// (`/opt/jenny-venv/bin/python` unless the config names an interpreter).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createHostCore, sidecarLaunchOptions } = require('../../server/host-core');
const { createHostedBackend } = require('../../services/host/service-composition');
const { ControlLeases } = require('../../server/control-leases');
const { ClientRegistry } = require('../../server/client-registry');
const { BackendHarness } = require('../helpers/command-router-fixture');

const SOURCE_ROOT = path.resolve(__dirname, '..', '..');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeComposition(root) {
  const backend = new BackendHarness(root);
  backend.sidecarManager = { process: null };
  return { backend, start: async () => {}, stop: async () => ({ exitConfirmed: true }),
    dispose: async () => { backend.dispose(); } };
}

function coreWith(t, config, extra = {}) {
  const calls = [];
  const core = createHostCore({ config, clients: new ClientRegistry(), leases: new ControlLeases(), logger: () => {},
    createBackend: (options) => { calls.push(options); return fakeComposition(config.userDataPath); }, ...extra });
  t.after(() => core.dispose());
  return calls[0];
}

function baseConfig(t) {
  const root = tempDir(t, 'jenny-launch-');
  return { userDataPath: root, workspaceRoot: null, secretsDir: root, execution: null };
}

test('a source checkout keeps the Docker defaults: /opt python unless the config names one', (t) => {
  const launch = sidecarLaunchOptions({ config: {}, appRoot: SOURCE_ROOT });
  assert.deepEqual(launch, { repoRoot: SOURCE_ROOT, pythonExecutable: '/opt/jenny-venv/bin/python' });
  assert.equal(sidecarLaunchOptions({ config: { pythonExecutable: '/usr/bin/python3' }, appRoot: SOURCE_ROOT })
    .pythonExecutable, '/usr/bin/python3');

  const options = coreWith(t, baseConfig(t));
  assert.equal(options.pythonExecutable, '/opt/jenny-venv/bin/python');
  assert.equal(options.repoRoot, SOURCE_ROOT);
  assert.equal(Object.hasOwn(options, 'resolvePackagedLaunch'), false);
  assert.equal(Object.hasOwn(options, 'pythonRuntimeBundleRoot'), false);
});

test('a packaged app (root app.asar) launches the packaged sidecar from the resources directory', (t) => {
  const resources = tempDir(t, 'jenny-resources-');
  const appRoot = path.join(resources, 'app.asar');
  const launch = sidecarLaunchOptions({ config: { pythonExecutable: '/ignored/python' }, appRoot, platform: 'win32' });
  assert.equal(launch.repoRoot, resources, 'a real working directory, not the asar');
  assert.equal(launch.pythonRuntimeBundleRoot, resources);
  assert.equal(typeof launch.resolvePackagedLaunch, 'function');
  assert.equal(launch.pythonExecutable, undefined, 'no interpreter is guessed for a packaged launch');

  const options = coreWith(t, baseConfig(t), { launch });
  assert.equal(options.repoRoot, resources);
  assert.equal(options.resolvePackagedLaunch, launch.resolvePackagedLaunch);
  assert.equal(options.pythonRuntimeBundleRoot, resources);
  assert.equal(options.pythonExecutable, undefined);
  assert.notEqual(options.pythonExecutable, '/opt/jenny-venv/bin/python');
});

test('createHostedBackend forwards the packaged-launch options to BackendService and its sidecar manager', (t) => {
  const root = tempDir(t, 'jenny-hosted-backend-');
  const resolvePackagedLaunch = async () => ({ ok: false, failureReason: 'test' });
  const composition = createHostedBackend({
    userDataPath: root, hostMode: 'server', hostExecutionPolicyVersion: 1, repoRoot: root,
    modelEndpoint: { engine: 'ollama', model: 'm', apiUrl: 'http://127.0.0.1:11434' },
    credentialService: { get: () => '', getStatus: () => ({ ready: true }) },
    resolvePackagedLaunch, pythonRuntimeBundleRoot: root, launchCommand: 'C:\\x\\jenny-sidecar.exe', launchArgs: ['--x'],
  });
  t.after(() => composition.dispose());
  const { backend } = composition;
  assert.equal(backend.options.resolvePackagedLaunch, resolvePackagedLaunch);
  assert.equal(backend.options.pythonRuntimeBundleRoot, root);
  assert.equal(backend.sidecarManager._resolvePackagedLaunch, resolvePackagedLaunch);
  assert.equal(backend.sidecarManager.launchCommand, 'C:\\x\\jenny-sidecar.exe');
  assert.deepEqual(backend.sidecarManager.launchArgs, ['--x']);
});

test('createHostedBackend without packaged options passes none (Docker unchanged)', (t) => {
  const root = tempDir(t, 'jenny-hosted-backend-');
  const composition = createHostedBackend({
    userDataPath: root, hostMode: 'server', hostExecutionPolicyVersion: 1, repoRoot: root,
    pythonExecutable: '/opt/jenny-venv/bin/python',
    modelEndpoint: { engine: 'ollama', model: 'm', apiUrl: 'http://127.0.0.1:11434' },
    credentialService: { get: () => '', getStatus: () => ({ ready: true }) },
  });
  t.after(() => composition.dispose());
  const { backend } = composition;
  for (const key of ['resolvePackagedLaunch', 'pythonRuntimeBundleRoot', 'launchCommand', 'launchArgs']) {
    assert.equal(Object.hasOwn(backend.options, key), false, key);
  }
  assert.equal(backend.sidecarManager._resolvePackagedLaunch, null);
  assert.equal(backend.sidecarManager.launchCommand, '/opt/jenny-venv/bin/python');
});
