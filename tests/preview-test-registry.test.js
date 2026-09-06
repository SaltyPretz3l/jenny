'use strict';

/* Red-first wiring contract for `preview_test` (W8-S4): registry gating,
 * manifest schema attachment, electron bridge allowlist, managed-sidecar
 * flag forwarding, and the default-on internal feature flag. Mirrors
 * workspace-present-registry.test.js. */

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

test('preview_test registry entry requires an explicit toolsPreviewTestEnabled option', () => {
  const bareRegistry = createDefaultRegistry();
  assert.equal(bareRegistry.getTool('preview_test'), undefined);

  const enabledRegistry = createDefaultRegistry({ toolsPreviewTestEnabled: true });
  const tool = enabledRegistry.getTool('preview_test');
  assert.ok(tool, 'preview_test registers when the option is true');
  assert.equal(tool.readOnly, true);
  assert.equal(tool.workspaceRequired, true);
});

test('preview_test carries the manifest input schema', () => {
  const registry = createDefaultRegistry({ toolsPreviewTestEnabled: true });
  const tool = registry.getTool('preview_test');
  const schema = tool.parameters;

  assert.ok(schema, 'manifest schema is attached via withManifestSchema');
  assert.equal(tool.toolFamily, 'workspace');
  assert.equal(schema.properties.path.type, 'string');
  assert.deepEqual(schema.properties.viewport.enum, ['desktop', 'mobile', 'tablet']);
  assert.equal(schema.properties.wait_ms.type, 'integer');
  assert.equal(schema.properties.events.type, 'array');
  assert.deepEqual(schema.properties.events.items.properties.action.enum, ['click', 'type']);
  assert.deepEqual(schema.required, ['path']);
});

test('preview_test is on the electron bridge allowlist', () => {
  assert.ok(ELECTRON_BRIDGE_TOOL_NAMES.has('preview_test'));
});

test('managed sidecar config forwards the internal preview_test flag value as set on the service', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-preview-test-config-'));
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
    tools_preview_test_enabled: true,
  };
  const enabledConfig = buildManagedSidecarConfig(service);

  assert.equal(disabledConfig.tools_preview_test_enabled, false);
  assert.equal(enabledConfig.tools_preview_test_enabled, true);
});

test('tools_preview_test_enabled is an internal default-on flag rolled back only by env', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({
    JENNY_ENABLE_TOOLS_PREVIEW_TEST: '1',
  });
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_TOOLS_PREVIEW_TEST: '0',
  });

  assert.equal(defaults.tools_preview_test_enabled, true);
  assert.equal(enabled.tools_preview_test_enabled, true);
  assert.equal(disabled.tools_preview_test_enabled, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('tools_preview_test_enabled'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('tools_preview_test_enabled'));
  assert.deepEqual(
    normalizeFeatureOverrides({ tools_preview_test_enabled: true }),
    {}
  );
});
