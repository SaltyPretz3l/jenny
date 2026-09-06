'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { cleanupTrackedResources, trackDirectory } = require('../helpers/resource-cleanup');
const { createManagedService } = require('../helpers/managed-sidecar-runtime-helpers');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('electron_state_root derives the versioned recovery root without a new wire field', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-recovery-config-'));
  trackDirectory(userDataPath);
  const service = createManagedService(userDataPath);
  const config = service._buildManagedSidecarConfig();
  const python = path.join(process.cwd(), '.venv', 'Scripts', 'python.exe');
  const probe = [
    'import sys',
    'from sidecar.ai.container_mcp_servers import _workspace_recovery_version_root',
    'sys.stdout.write(_workspace_recovery_version_root(sys.argv[1]))',
  ].join(';');

  const result = spawnSync(python, ['-c', probe, config.electron_state_root], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    path.normalize(result.stdout),
    path.join(userDataPath, 'workspace-recovery', 'v1')
  );
  assert.equal(Object.hasOwn(config, 'workspace_recovery_root'), false);
  assert.equal(Object.hasOwn(config, 'workspace_active_use_seconds'), false);
});
