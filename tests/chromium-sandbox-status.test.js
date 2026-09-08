'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveChromiumSandboxStatus } = require('../services/main/chromium-sandbox-status');
const { getJennyStatus } = require('../services/backend/jenny-status-composer');

test('development reports a no-sandbox launch switch', () => {
  assert.deepEqual(resolveChromiumSandboxStatus({ platform: 'linux', hasSwitch: () => true, env: {} }), {
    platform: 'linux', packaged: false, sandboxed: false,
    reason: 'no_sandbox_switch', package_kind: 'development',
  });
});

test('packaged Linux AppImage reports a no-sandbox launch switch', () => {
  assert.deepEqual(resolveChromiumSandboxStatus({
    platform: 'linux', isPackaged: true, hasSwitch: () => true,
    env: { APPIMAGE: '/tmp/Jenny-x86_64.AppImage', APPDIR: '/tmp/.mount_Jenny' },
    execPath: '/tmp/.mount_Jenny/usr/bin/jenny',
  }), {
    platform: 'linux', packaged: true, sandboxed: false,
    reason: 'no_sandbox_switch', package_kind: 'appimage',
  });
});

test('packaged Linux system install remains sandboxed', () => {
  const status = resolveChromiumSandboxStatus({ platform: 'linux', isPackaged: true, hasSwitch: () => false, env: {} });
  assert.equal(status.sandboxed, true);
  assert.equal(status.reason, '');
  assert.equal(status.package_kind, 'system');
});

test('packaged Linux ignores inherited AppImage variables', () => {
  const status = resolveChromiumSandboxStatus({
    platform: 'linux', isPackaged: true, hasSwitch: () => false,
    env: { APPIMAGE: '/tools/Other.AppImage', APPDIR: '/tmp/.mount_Other' },
    execPath: '/opt/Jenny/jenny',
  });
  assert.equal(status.package_kind, 'system');
});

test('packaged Windows install is classified as other', () => {
  const status = resolveChromiumSandboxStatus({ platform: 'win32', isPackaged: true, hasSwitch: () => false, env: {} });
  assert.equal(status.sandboxed, true);
  assert.equal(status.package_kind, 'other');
});

test('missing hasSwitch is reported as unavailable', () => {
  const status = resolveChromiumSandboxStatus({ platform: 'linux', hasSwitch: null, env: {} });
  assert.equal(status.sandboxed, null);
  assert.equal(status.reason, 'inspection_unavailable');
});

test('throwing hasSwitch is reported as unavailable', () => {
  const status = resolveChromiumSandboxStatus({ hasSwitch: () => { throw new Error('unavailable'); } });
  assert.equal(status.sandboxed, null);
  assert.equal(status.reason, 'inspection_unavailable');
});

test('result is JSON-safe', () => {
  const status = resolveChromiumSandboxStatus({
    platform: 'linux', isPackaged: true, hasSwitch: null,
    env: { APPIMAGE: '/tmp/Jenny-x86_64.AppImage', APPDIR: '/tmp/.mount_Jenny' },
    execPath: '/tmp/.mount_Jenny/usr/bin/jenny',
  });
  assert.equal(status.sandboxed, null);
  assert.deepEqual(JSON.parse(JSON.stringify(status)), status);
});

// jenny_status carries the wiring's option verbatim so the renderer notice and
// the Diagnostics row read one facet (tests/jenny-status-composer.test.js sits
// at the file-size ceiling, so the facet tests live here).
function minimalService(options) {
  return {
    options,
    getBackendStatus: () => ({ phase: 'ready', detail: '', error: '', appVersion: '1.0.0-test' }),
    currentStatus: { engine: 'ollama', model: 'llama3:8b', model_loaded: false, tools_status: {} },
    shellLogStore: {
      list: () => [],
      getCurrentDiagnosticsMetadata: () => ({ sources: {}, integrity: { complete: true, partial_reasons: [] } }),
    },
    toolPermissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
  };
}

test('jenny_status runtime facet carries the configured Chromium sandbox status', async () => {
  const chromiumSandbox = { platform: 'linux', packaged: true, sandboxed: false, reason: 'no_sandbox_switch', package_kind: 'appimage' };
  const status = await getJennyStatus(minimalService({ chromiumSandbox }));
  assert.deepEqual(status.runtime.chromium_sandbox, chromiumSandbox);
});

test('jenny_status runtime facet reports null when Chromium sandbox status is absent', async () => {
  const status = await getJennyStatus(minimalService(undefined));
  assert.equal(status.runtime.chromium_sandbox, null);
});
