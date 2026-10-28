'use strict';

// Jenny CLI S9: one function decides where the CLI's sidecar, flock helper and Python live. The
// source tree runs `python -m sidecar` from the repository venv; an installed copy (the CLI entry
// inside resources/app.asar, reached through the resources/bin shim) runs the packaged PyInstaller
// sidecar through the desktop's own manifest-validating resolver and never hunts a venv in the asar.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hostLaunchOptions, lockOptions, resolveCliRuntime, venvPython } = require('../../services/cli-host/runtime-layout');

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-cli-runtime-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
}

function packagedLayout(t, { manifest = false, embed = false } = {}) {
  const resources = path.join(tempDir(t), 'resources');
  const root = path.join(resources, 'app.asar');
  fs.mkdirSync(root, { recursive: true });
  if (manifest) touch(path.join(resources, 'sidecar', 'manifest.json'));
  if (embed) touch(path.join(resources, 'python-embed', 'bin', 'python3.13'));
  return { resources, root };
}

test('source mode: the repository venv per platform, JENNY_BACKEND_PYTHON first, the tree helper and cwd', (t) => {
  const root = tempDir(t);
  const winPython = touch(path.join(root, '.venv', 'Scripts', 'python.exe'));
  const posixPython = touch(path.join(root, '.venv', 'bin', 'python'));

  const win = resolveCliRuntime({ root, env: {}, platform: 'win32' });
  assert.equal(win.mode, 'source');
  assert.equal(win.root, path.resolve(root));
  assert.equal(win.resourcesPath, '');
  assert.equal(win.pythonExecutable, winPython);
  assert.equal(win.lockPythonExecutable, '', 'Windows locks through the named pipe and needs no interpreter');
  assert.equal(win.lockHelperPath, path.join(root, 'services', 'host', 'profile_lock.py'));
  assert.equal(win.sidecarCwd, path.resolve(root));
  assert.equal(win.pythonRuntimeBundleRoot, path.join(root, 'vendor'));
  assert.equal(win.resolvePackagedLaunch, null);
  assert.equal(win.packagedManifestPresent, false);

  const linux = resolveCliRuntime({ root, env: {}, platform: 'linux' });
  assert.equal(linux.pythonExecutable, posixPython);
  assert.equal(linux.lockPythonExecutable, posixPython, 'the flock helper runs on the sidecar interpreter');

  const explicit = resolveCliRuntime({ root, env: { JENNY_BACKEND_PYTHON: '  /opt/py/bin/python3  ' }, platform: 'darwin' });
  assert.equal(explicit.pythonExecutable, '/opt/py/bin/python3');
  assert.equal(explicit.lockPythonExecutable, '/opt/py/bin/python3');

  const bare = resolveCliRuntime({ root: tempDir(t), env: {}, platform: 'linux' });
  assert.equal(bare.mode, 'source');
  assert.equal(bare.pythonExecutable, '', 'nothing is guessed past the venv');
  assert.equal(bare.lockPythonExecutable, '');
});

test('packaged mode: the root named app.asar, the resources sidecar, the unpacked helper and the embedded Python', (t) => {
  const { resources, root } = packagedLayout(t, { manifest: true, embed: true });
  const runtime = resolveCliRuntime({ root, env: { JENNY_BACKEND_PYTHON: '/ignored/for/the/sidecar' }, platform: 'linux' });
  assert.equal(runtime.mode, 'packaged');
  assert.equal(runtime.root, root);
  assert.equal(runtime.resourcesPath, resources);
  assert.equal(runtime.pythonExecutable, '', 'the packaged sidecar is a binary; JENNY_BACKEND_PYTHON does not redirect it');
  assert.equal(runtime.lockHelperPath, path.join(resources, 'app.asar.unpacked', 'services', 'host', 'profile_lock.py'));
  assert.equal(runtime.sidecarCwd, resources);
  assert.equal(runtime.pythonRuntimeBundleRoot, resources);
  assert.equal(runtime.packagedManifestPresent, true);
  assert.equal(typeof runtime.resolvePackagedLaunch, 'function');
  assert.equal(runtime.lockPythonExecutable, '/ignored/for/the/sidecar', 'an operator interpreter is the flock helper\'s explicit choice');

  const embedded = resolveCliRuntime({ root, env: {}, platform: 'linux' });
  assert.equal(embedded.lockPythonExecutable, path.join(resources, 'python-embed', 'bin', 'python3.13'));

  const mac = packagedLayout(t, { manifest: true });
  assert.equal(resolveCliRuntime({ root: mac.root, env: {}, platform: 'darwin' }).lockPythonExecutable, '',
    'macOS ships no Python: the lock reports itself unavailable unless the operator names one');
  assert.equal(resolveCliRuntime({ root, env: { JENNY_BACKEND_PYTHON: 'C:/py/python.exe' }, platform: 'win32' }).lockPythonExecutable, '');
});

test('a packaged layout without its manifest stays packaged and its resolver refuses before chat', async (t) => {
  const { resources, root } = packagedLayout(t);
  // A venv beside the asar must never be picked up.
  touch(path.join(root, '.venv', 'Scripts', 'python.exe'));
  touch(path.join(root, '.venv', 'bin', 'python'));
  const runtime = resolveCliRuntime({ root, env: {}, platform: process.platform });
  assert.equal(runtime.mode, 'packaged');
  assert.equal(runtime.packagedManifestPresent, false);
  assert.equal(runtime.pythonExecutable, '');
  const launch = await runtime.resolvePackagedLaunch();
  assert.equal(launch.ok, false);
  assert.equal(launch.launchSource, 'packaged-binary');
  assert.match(String(launch.failureReason), /sidecar directory is missing|manifest/iu);
  assert.equal(launch.launchCommand, '');
  assert.equal(fs.existsSync(path.join(resources, 'sidecar')), false, 'the resolver writes nothing');
  fs.mkdirSync(path.join(resources, 'sidecar'));
  const empty = await resolveCliRuntime({ root, env: {}, platform: process.platform }).resolvePackagedLaunch();
  assert.equal(empty.ok, false);
  assert.match(String(empty.failureReason), /manifest/iu);
});

test('the runtime is frozen and maps onto the host and lock options', (t) => {
  const root = tempDir(t);
  const python = touch(path.join(root, '.venv', 'Scripts', 'python.exe'));
  const source = resolveCliRuntime({ root, env: {}, platform: 'win32' });
  assert.ok(Object.isFrozen(source));
  assert.throws(() => { source.mode = 'packaged'; }, TypeError);
  assert.deepEqual(hostLaunchOptions(source), { repoRoot: path.resolve(root), pythonExecutable: python });
  assert.deepEqual(lockOptions(source), { pythonExecutable: '', lockHelperPath: path.join(root, 'services', 'host', 'profile_lock.py') });

  // Commands that never start the sidecar still compose with a path when the venv is missing.
  const bare = resolveCliRuntime({ root: tempDir(t), env: {}, platform: 'win32' });
  assert.equal(hostLaunchOptions(bare).pythonExecutable, '');
  assert.equal(hostLaunchOptions(bare, { placeholderPython: true }).pythonExecutable, venvPython(bare.root));

  const { resources, root: asar } = packagedLayout(t, { manifest: true });
  const packaged = resolveCliRuntime({ root: asar, env: {}, platform: 'linux' });
  assert.ok(Object.isFrozen(packaged));
  const options = hostLaunchOptions(packaged, { placeholderPython: true });
  assert.deepEqual(Object.keys(options).sort(), ['pythonExecutable', 'pythonRuntimeBundleRoot', 'repoRoot', 'resolvePackagedLaunch']);
  assert.equal(options.repoRoot, resources);
  assert.equal(options.pythonExecutable, '', 'no placeholder interpreter in the packaged route');
  assert.equal(options.pythonRuntimeBundleRoot, resources);
  assert.equal(options.resolvePackagedLaunch, packaged.resolvePackagedLaunch);
});
