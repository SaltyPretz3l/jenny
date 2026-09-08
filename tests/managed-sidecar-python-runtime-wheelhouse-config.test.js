// Focused coverage for services/backend/managed-sidecar-config.js's
// managed Python runtime bundle path wiring. Kept separate from the
// already near-cap backend-service-managed-sidecar-config.test.js.
const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../services/backend/backend-service');
const { DEFAULT_MANAGED_SHELL_MODEL } = require('../services/backend/backend-config');
const { bundledPythonRelativePath } = require('../services/backend/managed-sidecar-config');
const { buildManagedSidecarConfig } = require('../services/backend/managed-sidecar-lifecycle');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

const ROOT = path.resolve(__dirname, '..');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('bundled Python paths stay in lockstep with the platform contracts', () => {
  const win = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'config', 'python-runtime-bundle-lock.json'), 'utf8'
  ));
  const linux = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'config', 'python-runtime-bundle-lock.linux-x64.json'), 'utf8'
  ));

  assert.equal(bundledPythonRelativePath('win32').slice(1).join('/'), win.python.executable);
  assert.equal(bundledPythonRelativePath('linux').slice(1).join('/'), linux.python.executable);
});

function buildTestService(suffix, options = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), `jenny-shell-managed-wheelhouse-${suffix}-`));
  trackDirectory(userDataPath);
  return new BackendService({
    userDataPath,
    repoRoot: options.repoRoot,
    pythonRuntimeBundleRoot: options.pythonRuntimeBundleRoot,
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });
}

function expectedBundledPython(bundleRoot) {
  const relativePath = bundledPythonRelativePath(process.platform);
  return relativePath ? path.join(bundleRoot, ...relativePath) : null;
}

test('bundled Python relative paths are platform-specific', () => {
  assert.deepEqual(bundledPythonRelativePath('win32'), ['python-embed', 'python.exe']);
  assert.deepEqual(bundledPythonRelativePath('linux'), ['python-embed', 'bin', 'python3.13']);
  assert.equal(bundledPythonRelativePath('darwin'), null);
});

test('python runtime bundle paths resolve from the development repo root', () => {
  const repoRoot = path.join(os.tmpdir(), 'jenny-shell-fake-repo');
  const config = buildManagedSidecarConfig(buildTestService('development', { repoRoot }));

  assert.equal(
    config.tools_python_runtime_wheelhouse_dir,
    path.join(repoRoot, 'vendor', 'python-runtime-wheels'),
  );
  assert.equal(
    config.tools_python_runtime_bundled_python,
    expectedBundledPython(path.join(repoRoot, 'vendor')),
  );
});

test('Electron development ignores its unrelated resourcesPath', () => {
  const repoRoot = path.join(os.tmpdir(), 'jenny-shell-fake-repo');
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = path.join(os.tmpdir(), 'electron-dist-resources');
  let config;
  try {
    config = buildManagedSidecarConfig(buildTestService('electron-development', { repoRoot }));
  } finally {
    if (originalResourcesPath === undefined) {
      delete process.resourcesPath;
    } else {
      process.resourcesPath = originalResourcesPath;
    }
  }

  assert.equal(
    config.tools_python_runtime_wheelhouse_dir,
    path.join(repoRoot, 'vendor', 'python-runtime-wheels'),
  );
  assert.equal(
    config.tools_python_runtime_bundled_python,
    expectedBundledPython(path.join(repoRoot, 'vendor')),
  );
});

test('python runtime bundle paths resolve from the packaged resources root', () => {
  const resourcesRoot = path.join(os.tmpdir(), 'jenny-shell-fake-resources');
  const config = buildManagedSidecarConfig(buildTestService('packaged', {
    pythonRuntimeBundleRoot: resourcesRoot,
  }));

  assert.equal(
    config.tools_python_runtime_wheelhouse_dir,
    path.join(resourcesRoot, 'python-runtime-wheels'),
  );
  assert.equal(
    config.tools_python_runtime_bundled_python,
    expectedBundledPython(resourcesRoot),
  );
});
