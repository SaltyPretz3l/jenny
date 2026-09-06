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
const { buildManagedSidecarConfig } = require('../services/backend/managed-sidecar-lifecycle');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
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

test('python runtime bundle paths resolve from the development repo root', () => {
  const repoRoot = path.join(os.tmpdir(), 'jenny-shell-fake-repo');
  const config = buildManagedSidecarConfig(buildTestService('development', { repoRoot }));

  assert.equal(
    config.tools_python_runtime_wheelhouse_dir,
    path.join(repoRoot, 'vendor', 'python-runtime-wheels'),
  );
  assert.equal(
    config.tools_python_runtime_bundled_python,
    path.join(repoRoot, 'vendor', 'python-embed', 'python.exe'),
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
    path.join(repoRoot, 'vendor', 'python-embed', 'python.exe'),
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
    path.join(resourcesRoot, 'python-embed', 'python.exe'),
  );
});
