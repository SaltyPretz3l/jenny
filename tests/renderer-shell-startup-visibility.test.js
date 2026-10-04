const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForStartupCurtainRemoval, waitForUi } = require('./helpers/renderer-shell-harness');

test('renderer keeps exactly the boot curtain visible while shared hydration is pending', async (t) => {
  let rendererState;
  let hydrationStarted = false;
  const app = await loadRendererApp({
    // Workspace restore requires a loaded session list even with a transient backend.
    windowGlobals: {
      __jennyTestHooks: {
        captureRendererState(state) { rendererState = state; state.sessionListLoaded = true; },
      },
    },
    shell: {
      workspace: { getState() { hydrationStarted = true; return new Promise(() => {}); } },
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

  assert.equal(hydrationStarted, true, 'shared hydration must actually be pending');
  assert.equal(rendererState.backend.phase, 'sidecar_spawned');
  assert.equal(app.window.document.getElementById('authOverlay'), null);
  const curtain = app.window.document.getElementById('startupOverlay');
  assert.equal(curtain.classList.contains('hidden'), false);
  assert.equal(app.window.document.getElementById('workspace').inert, true);
  // "Exactly the boot curtain": the banner and strip that used to double up on
  // the curtain's message are gone from the document entirely, so mid-startup
  // there is one surface speaking, not three.
  assert.equal(app.window.document.getElementById('backendBanner'), null);
  assert.equal(app.window.document.getElementById('statusStrip'), null);
});

test('a hydrated shell removes the curtain while the backend is still loading', async (t) => {
  let rendererState;
  let hydrationStarted = false;
  const app = await loadRendererApp({
    windowGlobals: {
      __jennyTestHooks: {
        captureRendererState(state) { rendererState = state; state.sessionListLoaded = true; },
      },
    },
    shell: {
      backend: { getStatus: async () => ({ phase: 'sidecar_spawned' }) },
      workspace: { async getState() { hydrationStarted = true; return {}; } },
    },
  });
  t.after(() => app.dispose());
  await waitForUi(app.window, 80);
  const curtain = app.window.document.getElementById('startupOverlay');
  assert.equal(curtain?.classList.contains('hidden') ?? true, true);
  // The plain-fade fallback removes the curtain.
  await waitForStartupCurtainRemoval(app.window);
  assert.equal(hydrationStarted, true, 'shared hydration must actually resolve');
  assert.equal(rendererState.backend.phase, 'sidecar_spawned');
  assert.equal(app.window.document.getElementById('workspace').inert, false);
});

for (const persistedActiveView of ['chat', 'home', 'ide']) {
  for (const startupAnimation of ['off', 'on']) {
    test(`restored ${persistedActiveView} with animation ${startupAnimation} keeps pending shared hydration isolated`, async (t) => {
      let hydrationStarted = false;
      const app = await loadRendererApp({
        persistedActiveView,
        startupAnimation,
        shell: {
          workspace: { getState() { hydrationStarted = true; return new Promise(() => {}); } },
        },
      });
      t.after(() => app.dispose());
      await waitForUi(app.window, 80);
      assert.equal(hydrationStarted, true);
      assert.equal(app.window.__rendererState.ui.activeView, persistedActiveView);
      const curtain = app.window.document.getElementById('startupOverlay');
      assert.equal(curtain?.classList.contains('hidden') ?? true, false, 'shared hydration must gate every restored view');
      assert.equal(app.window.document.getElementById('workspace').inert, true);
      if (startupAnimation === 'on') {
        // Pending hydration must also hold after the animation's minimum hold.
        await waitForUi(app.window, 950);
        assert.equal(curtain.classList.contains('hidden'), false, 'the animation hold cannot substitute for shared hydration');
        assert.equal(app.window.document.getElementById('workspace').inert, true);
      }
    });
  }
}

test('a late pane composition failure settles the mounted startup sky', async (t) => {
  const app = await loadRendererApp({
    startupAnimation: 'on',
    windowGlobals: {
      rendererAppPaneComposition: {
        createPaneComposition() { throw new Error('pane composition failed'); },
      },
    },
  });
  t.after(() => app.dispose());
  const curtain = app.window.document.getElementById('startupOverlay');
  assert.equal(curtain.getAttribute('role'), 'alertdialog');
  assert.ok(curtain.querySelector('#startupOverlayRetryButton'));
  const wordmark = curtain.querySelector('.startup-overlay-wordmark');
  const opacity = wordmark.style.opacity;
  await waitForUi(app.window, 120);
  assert.equal(wordmark.style.opacity, opacity, 'fatal composition failure must stop animation frames');
  assert.equal(curtain.__jennyStartupSky.isPaused(), true);
});

test('app shortcuts stay inert while the startup curtain is mounted', async (t) => {
  const app = await loadRendererApp({
    shell: {
      workspace: { getState() { return new Promise(() => {}); } },
    },
  });
  t.after(() => app.dispose());
  await waitForUi(app.window, 40);
  const { document } = app.window;
  assert.ok(document.getElementById('startupOverlay'));
  const viewBefore = app.window.__rendererState.ui.activeView;
  const event = new app.window.KeyboardEvent('keydown', {
    key: '3', ctrlKey: true, bubbles: true, cancelable: true,
  });
  document.body.dispatchEvent(event);
  assert.equal(app.window.__rendererState.ui.activeView, viewBefore, 'a view chord cannot switch views under the curtain');
  assert.equal(event.defaultPrevented, false, 'the blocked chord is not swallowed');
});
