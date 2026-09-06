'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const safeRunnerSupport = require('../scripts/run-node-tests-safe-support');

test('Electron source detection is Windows-specific and catches direct imports', () => {
  assert.equal(
    safeRunnerSupport.isElectronBackedTestSource("const { app } = require('electron');", 'win32'),
    true
  );
  assert.equal(
    safeRunnerSupport.isElectronBackedTestSource("const { _electron } = require('playwright-core');", 'win32'),
    true
  );
  assert.equal(
    safeRunnerSupport.isElectronBackedTestSource("const { app } = require('electron');", 'linux'),
    false
  );
});

test('parallel-only drops hosted-unsafe suites while local runs retain sequential-risk coverage', () => {
  const hostedUnsafe = [
    'tests/attachment-asset-store.test.js',
    'tests/background-job-tracker.test.js',
    'tests/chatgpt-auth-service.test.js',
    'tests/codex-cli-runtime-service.test.js',
    'tests/desktop-shortcut.test.js',
    'tests/electron-session-store-migration.test.js',
    'tests/gui-smoke-harness-launch-failure.test.js',
    'tests/managed-sidecar/managed-model-acquisition.test.js',
    'tests/process-utils.test.js',
    'tests/plugins/lifecycle/real-store-e2e.test.js',
    'tests/renderer-chat-segment-text-blanking.test.js',
    'tests/renderer-chat-stream-repaint.test.js',
    'tests/renderer-home-followups.test.js',
    'tests/renderer-ide-editor.test.js',
    'tests/renderer-ide-map-atlas-layout.test.js',
    'tests/renderer-proactive.test.js',
    'tests/renderer-stream-handler-buffering.test.js',
    'tests/renderer-stream-reveal.test.js',
    'tests/run-node-tests-safe.test.js',
    'tests/setup/setup-orchestrator.test.js',
    'tests/sidecar-manager.test.js',
    'tests/uninstall-script.test.js',
    'tests/update-service.test.js',
    'tests/vllm-process-manager-dark-paths.test.js',
    'tests/weather-service.test.js',
    'tests/workspace-ide-gitdir.test.js',
    'tests/workspace-pty-spawn.test.js',
    'tests/workspace-test-runner-runner.test.js',
  ];
  for (const file of hostedUnsafe) {
    assert.equal(safeRunnerSupport.isStableLaneExcludedPath(file), true, file);
  }
  assert.equal(
    safeRunnerSupport.isStableLaneExcludedPath('tests/repo-hygiene.test.js'),
    false
  );

  const childArgs = [...hostedUnsafe, 'tests/repo-hygiene.test.js'];
  const hosted = safeRunnerSupport.selectRunGroups({ childArgs, parallelOnly: true });
  assert.deepEqual(hosted.parallelArgs, ['tests/repo-hygiene.test.js']);
  assert.deepEqual(hosted.sequentialArgs, []);

  const local = safeRunnerSupport.selectRunGroups({ childArgs, parallelOnly: false });
  const realStoreE2e = 'tests/plugins/lifecycle/real-store-e2e.test.js';
  assert.deepEqual(local.parallelArgs, childArgs.filter((file) => file !== realStoreE2e));
  assert.deepEqual(local.sequentialArgs, [realStoreE2e]);
});
