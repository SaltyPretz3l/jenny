'use strict';

/**
 * Fix 3 (code review 2026-07-19): the workspace-root-identity guards block
 * SETTING a `.jenny` workspace root, but an already-persisted one was still
 * read and handed to the sidecar. This file is a sibling split of
 * tests/backend-service-managed-sidecar-config.test.js (already over the
 * 600-line soft ratchet) covering the managed-sidecar-config.js read seam
 * specifically: a persisted `.jenny` (or trailing-dot/space alias) root must
 * resolve to `tools_workspace_root: null` + `tools_shell_enabled: false`,
 * with one WARN, instead of reaching the sidecar.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../services/backend/backend-service');
const { DEFAULT_MANAGED_SHELL_MODEL } = require('../services/backend/backend-config');
const { buildManagedSidecarConfig } = require('../services/backend/managed-sidecar-lifecycle');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const GUARD_EVENT = 'workspace.persisted_root_is_jenny_state_dir';

function createServiceWithPersistedRoot(persistedRoot) {
  const userDataPath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jenny-shell-managed-jenny-root-guard-')
  );
  trackDirectory(userDataPath);
  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
    configService: {
      getToolsWorkspaceRoot() {
        return persistedRoot;
      },
    },
  });
  // buildManagedSidecarConfig emits unrelated WARNs in this environment
  // (e.g. safeStorage-not-ready web-search key reads) -- filter to the guard
  // event under test rather than asserting on the raw log count.
  const allLogs = [];
  service._emitServiceLog = (level, event, details) => {
    allLogs.push({ level, event, details });
  };
  const guardLogs = () => allLogs.filter((entry) => entry.event === GUARD_EVENT);
  return { service, guardLogs };
}

test('a persisted .jenny root is treated as absent: null workspace root, shell disabled, WARN logged', () => {
  const jennyRoot = path.join(os.tmpdir(), 'jenny-workspace-guard-fixture', '.jenny');
  const { service, guardLogs } = createServiceWithPersistedRoot(jennyRoot);

  const config = buildManagedSidecarConfig(service);

  assert.equal(config.tools_workspace_root, null);
  assert.equal(config.tools_shell_enabled, false);
  const logs = guardLogs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'WARN');
  assert.equal(logs[0].details.seam, 'managed_sidecar_config');
});

test('a persisted trailing-dot .jenny alias root is also treated as absent', () => {
  const jennyRootAlias = path.join(os.tmpdir(), 'jenny-workspace-guard-fixture', '.jenny.');
  const { service, guardLogs } = createServiceWithPersistedRoot(jennyRootAlias);

  const config = buildManagedSidecarConfig(service);

  assert.equal(config.tools_workspace_root, null);
  assert.equal(config.tools_shell_enabled, false);
  assert.equal(guardLogs().length, 1);
});

test('a normal persisted workspace root is unaffected: value passes through, no guard WARN', () => {
  const normalRoot = path.join(os.tmpdir(), 'jenny-workspace-guard-fixture', 'my-project');
  const { service, guardLogs } = createServiceWithPersistedRoot(normalRoot);

  const config = buildManagedSidecarConfig(service);

  assert.equal(config.tools_workspace_root, normalRoot);
  assert.equal(config.tools_shell_enabled, true);
  assert.equal(guardLogs().length, 0);
});

test('an empty persisted workspace root stays absent without a spurious guard WARN', () => {
  const { service, guardLogs } = createServiceWithPersistedRoot('');

  const config = buildManagedSidecarConfig(service);

  assert.equal(config.tools_workspace_root, null);
  assert.equal(config.tools_shell_enabled, false);
  assert.equal(guardLogs().length, 0);
});
