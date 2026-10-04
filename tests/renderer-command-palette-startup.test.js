'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

test('STA-007: Ctrl+K keeps the palette hidden while the startup curtain is mounted', async (t) => {
  // Restored Home reports view readiness only after its companion fetch, so
  // holding that fetch keeps the curtain mounted deterministically while the
  // shared hydration (which arms the palette on its real feature flags) lands.
  const app = await loadRendererApp({
    persistedActiveView: 'home',
    shell: {
      features: { state: { featureFlags: { command_palette: true } } },
      companion: { getState() { return new Promise(() => {}); } },
    },
  });
  t.after(() => app.dispose());

  const { window } = app;
  const { document } = window;
  await waitForUi(window, 80);

  assert.equal(window.__rendererState.features.featureFlags.command_palette, true);
  const curtain = document.getElementById('startupOverlay');
  assert.ok(curtain, 'the startup curtain is still mounted');
  const palette = document.getElementById('commandPaletteOverlay');
  assert.ok(palette);
  assert.equal(palette.classList.contains('hidden'), true);

  const pressCtrlK = () => {
    const event = new window.KeyboardEvent('keydown', {
      key: 'k', ctrlKey: true, bubbles: true, cancelable: true,
    });
    document.body.dispatchEvent(event);
    return event;
  };

  const blocked = pressCtrlK();
  assert.equal(palette.classList.contains('hidden'), true,
    'the palette stays hidden underneath the startup curtain');
  assert.equal(blocked.defaultPrevented, false, 'startup does not swallow Ctrl+K');

  // Positive control: the palette was armed all along; only the curtain gated it.
  curtain.remove();
  const opened = pressCtrlK();
  assert.equal(palette.classList.contains('hidden'), false, 'Ctrl+K opens the palette once the curtain is gone');
  assert.equal(opened.defaultPrevented, true);
});
