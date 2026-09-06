const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

test('auth sign-out clears transient thread collapse state through the renderer event path', async (t) => {
  const app = await loadRendererApp();
  t.after(async () => {
    await app.dispose();
  });

  const rendererState = app.window.__rendererState;
  const collapsedBySession = new Map([
    ['session-a', new Set(['assistant-a'])],
    ['session-b', new Set(['assistant-b'])],
  ]);
  rendererState.ui.threadBranchesCollapsedBySession = collapsedBySession;

  await app.shell.__emitAuthState({ authenticated: false, user: null });
  await waitForUi(app.window, 20);

  assert.equal(collapsedBySession.size, 0);
  assert.equal(rendererState.ui.threadBranchesCollapsedBySession, collapsedBySession);
});

test('auth sign-out repairs counterfeit thread collapse state without invoking it', async (t) => {
  const app = await loadRendererApp();
  t.after(async () => {
    await app.dispose();
  });

  const rendererState = app.window.__rendererState;
  let clearCalled = false;
  rendererState.ui.threadBranchesCollapsedBySession = {
    clear() {
      clearCalled = true;
      throw new Error('counterfeit clear must not run');
    },
  };

  await app.shell.__emitAuthState({ authenticated: false, user: null });
  await waitForUi(app.window, 20);

  assert.equal(clearCalled, false);
  assert.equal(rendererState.ui.threadBranchesCollapsedBySession instanceof app.window.Map, true);
  assert.equal(rendererState.ui.threadBranchesCollapsedBySession.size, 0);
});
