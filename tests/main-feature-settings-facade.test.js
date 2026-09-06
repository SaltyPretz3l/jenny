'use strict';

// Covers services/main/feature-settings-facade.js — the five feature-flag
// wrappers extracted out of main.js. The behaviour worth pinning is the
// late-binding contract: the facade is constructed at module load, but
// shellConfigService / backendService / overlayRef are all assigned later
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
  assert.equal(facade.buildEffectiveFeatureFlags().comet_overlay, false);

  shellConfigService = createConfigService({ comet_overlay: true });
  assert.equal(facade.buildEffectiveFeatureFlags().comet_overlay, true);
});

test('isCometOverlayEnabled reads live flag state and honours explicit overrides', () => {
  const shellConfigService = createConfigService({ comet_overlay: false });
  const facade = createFeatureSettingsFacade({
    env: {},
    getShellConfigService: () => shellConfigService,
  });

  assert.equal(facade.isCometOverlayEnabled(), false);
  assert.equal(
    facade.isCometOverlayEnabled({
      configService: createConfigService({ comet_overlay: true }),
    }),
    true
  );
});

test('closeCometOverlayIfDisabled disposes and clears the ref once the flag goes false', () => {
  let disposed = 0;
  let overlayRef = { dispose() { disposed += 1; } };
  const facade = createFeatureSettingsFacade({
    env: {},
    getShellConfigService: () => createConfigService({ comet_overlay: false }),
    getOverlayRef: () => overlayRef,
    setOverlayRef: (next) => { overlayRef = next; },
  });

  facade.closeCometOverlayIfDisabled();

  assert.equal(disposed, 1);
  assert.equal(overlayRef, null, 'the cleared overlay ref must be written back to main.js');
});

test('closeCometOverlayIfDisabled leaves a live overlay alone while the flag is on', () => {
  let disposed = 0;
  const liveOverlay = { dispose() { disposed += 1; } };
  let overlayRef = liveOverlay;
  const facade = createFeatureSettingsFacade({
    env: {},
    getShellConfigService: () => createConfigService({ comet_overlay: true }),
    getOverlayRef: () => overlayRef,
    setOverlayRef: (next) => { overlayRef = next; },
  });

  facade.closeCometOverlayIfDisabled();

  assert.equal(disposed, 0);
  assert.equal(overlayRef, liveOverlay);
});

test('closeCometOverlayIfDisabled is a no-op when no overlay exists', () => {
  let setCalls = 0;
  const facade = createFeatureSettingsFacade({
    env: {},
    getShellConfigService: () => createConfigService({ comet_overlay: false }),
    getOverlayRef: () => null,
    setOverlayRef: () => { setCalls += 1; },
  });

  facade.closeCometOverlayIfDisabled();

  assert.equal(setCalls, 0);
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
    getShellConfigService: () => createConfigService({ comet_overlay: false }),
    getBackendService: () => backendService,
    sendToWindow: (channel, payload) => { sent.push({ channel, payload }); },
  });

  const payload = await facade.applyFeatureSettingsPatch({
    featureOverrides: { comet_overlay: true },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload, payload);
  assert.equal(payload.featureFlags.comet_overlay, true);
});
