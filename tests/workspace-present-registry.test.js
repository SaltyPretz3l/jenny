'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createDefaultRegistry } = require('../services/tools');
const { BackendService } = require('../services/backend/backend-service');
const { DEFAULT_MANAGED_SHELL_MODEL } = require('../services/backend/backend-config');
const { buildManagedSidecarConfig } = require('../services/backend/managed-sidecar-lifecycle');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');
const { ELECTRON_BRIDGE_TOOL_NAMES } = require('../services/backend/electron-tool-bridge');
const {
  buildFeatureFlags,
  INTERNAL_FEATURE_FLAG_KEYS,
  FEATURE_OVERRIDE_KEYS,
  normalizeFeatureOverrides,
} = require('../services/feature-flags');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('workspace_present registry entry requires an explicit toolsWorkspacePresentEnabled option (registry factory is opt-in, independent of the tools_workspace_present_enabled feature-flag default)', () => {
  const bareRegistry = createDefaultRegistry();
  assert.equal(bareRegistry.getTool('workspace_present'), undefined);

  const enabledRegistry = createDefaultRegistry({ toolsWorkspacePresentEnabled: true });
  const tool = enabledRegistry.getTool('workspace_present');
  assert.ok(tool, 'workspace_present registers when the option is true');
  assert.equal(tool.readOnly, true);
  assert.equal(tool.workspaceRequired, true);
});

test('workspace_present carries the manifest input schema including change_diff', () => {
  const registry = createDefaultRegistry({ toolsWorkspacePresentEnabled: true });
  const tool = registry.getTool('workspace_present');
  const schema = tool.parameters;

  assert.ok(schema, 'manifest schema is attached via withManifestSchema');
  assert.equal(tool.toolFamily, 'workspace');
  assert.deepEqual(schema.properties.view.enum, ['preview', 'file_map', 'change_diff']);
  assert.equal(schema.properties.path.type, 'string');
  assert.equal(schema.properties.change_id.type, 'string');
  assert.deepEqual(schema.required, ['view']);
});

test('workspace_present is on the electron bridge allowlist', () => {
  assert.ok(ELECTRON_BRIDGE_TOOL_NAMES.has('workspace_present'));
});

test('managed sidecar config forwards the internal workspace_present flag value as set on the service', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-workspace-present-config-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });

  const disabledConfig = buildManagedSidecarConfig(service);
  service.featureFlags = {
    ...(service.featureFlags || {}),
    tools_workspace_present_enabled: true,
  };
  const enabledConfig = buildManagedSidecarConfig(service);

  assert.equal(disabledConfig.tools_workspace_present_enabled, false);
  assert.equal(enabledConfig.tools_workspace_present_enabled, true);
});

test('tools_workspace_present_enabled is an internal default-on flag rolled back only by env', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({
    JENNY_ENABLE_TOOLS_WORKSPACE_PRESENT: '1',
  });
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_TOOLS_WORKSPACE_PRESENT: '0',
  });

  assert.equal(defaults.tools_workspace_present_enabled, true);
  assert.equal(enabled.tools_workspace_present_enabled, true);
  assert.equal(disabled.tools_workspace_present_enabled, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('tools_workspace_present_enabled'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('tools_workspace_present_enabled'));
  assert.deepEqual(
    normalizeFeatureOverrides({ tools_workspace_present_enabled: true }),
    {}
  );
});
