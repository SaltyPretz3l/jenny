'use strict';

// Covers services/main/feature-settings-facade.js — the feature-flag
// wrappers extracted out of main.js. The behaviour worth pinning is the
// late-binding contract: the facade is constructed at module load, but
// shellConfigService / backendService are assigned later
// during startup, so every one of them must be reached through its getter on
// each call rather than captured at construction time.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFeatureSettingsFacade } = require('../services/main/feature-settings-facade');

function createConfigService(featureOverrides = {}) {
  return {
    getState() {
      return { featureOverrides };
    },
    getWorkspaceRootStatus() {
      return { state: 'ready', message: '' };
    },
    updateFeatureSettings(patch) {
      Object.assign(featureOverrides, (patch && patch.featureOverrides) || {});
      return { featureOverrides };
    },
    replaceState() {},
  };
}

test('facade resolves the shell config service lazily instead of capturing it', () => {
  let shellConfigService = null;
  const facade = createFeatureSettingsFacade({
    env: {},
    getShellConfigService: () => shellConfigService,
  });

  // Constructed before the service exists — the pre-assignment call must not
  // throw, and the post-assignment call must see the newly assigned service.
  assert.equal(facade.buildEffectiveFeatureFlags().strict_auto_run, false);

  shellConfigService = createConfigService({ strict_auto_run: true });
  assert.equal(facade.buildEffectiveFeatureFlags().strict_auto_run, true);
});

test('facade no longer exposes the removed comet overlay gate', () => {
  const facade = createFeatureSettingsFacade({ env: {} });
  assert.equal(Object.hasOwn(facade, 'isCometOverlayEnabled'), false);
  assert.equal(Object.hasOwn(facade, 'closeCometOverlayIfDisabled'), false);
});

test('buildFeatureStatePayload reports the always-managed runtime and platform', () => {
  const facade = createFeatureSettingsFacade({
    env: {},
    platform: 'win32',
    getShellConfigService: () => createConfigService({}),
  });

  const payload = facade.buildFeatureStatePayload();

  assert.equal(payload.availability.runtime.managedSidecarActive, true);
  assert.equal(payload.availability.runtime.windowsOnly, true);
});

test('applyFeatureSettingsPatch pushes the refreshed payload back to the window', async () => {
  const sent = [];
  const backendService = {
    setFeatureFlags() {},
    async refreshManagedConfig() {},
  };
  const facade = createFeatureSettingsFacade({
    env: {},
    getShellConfigService: () => createConfigService({ strict_auto_run: false }),
    getBackendService: () => backendService,
    sendToWindow: (channel, payload) => { sent.push({ channel, payload }); },
  });

  const payload = await facade.applyFeatureSettingsPatch({
    featureOverrides: { strict_auto_run: true },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload, payload);
  assert.equal(payload.featureFlags.strict_auto_run, true);
});
