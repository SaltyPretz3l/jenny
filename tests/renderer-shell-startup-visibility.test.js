const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

test('renderer keeps exactly the boot curtain visible while startup is only sidecar_spawned', async (t) => {
  const app = await loadRendererApp({
    shell: {
      backend: {
        async getStatus() {
          return {
            phase: 'sidecar_spawned',
            detail: 'Managed sidecar process is ready.',
            mode: 'managed-dev',
            startupStage: 'spawned',
          };
        },
      },
    },
  });
  t.after(async () => app.dispose());

  await waitForUi(app.window, 40);

  assert.equal(app.window.__rendererState.backend.phase, 'sidecar_spawned');
  assert.equal(app.window.document.getElementById('authOverlay'), null);
  assert.ok(app.window.document.getElementById('startupOverlay'));
  // "Exactly the boot curtain": the banner and strip that used to double up on
  // the curtain's message are gone from the document entirely, so mid-startup
  // there is one surface speaking, not three.
  assert.equal(app.window.document.getElementById('backendBanner'), null);
  assert.equal(app.window.document.getElementById('statusStrip'), null);
});
