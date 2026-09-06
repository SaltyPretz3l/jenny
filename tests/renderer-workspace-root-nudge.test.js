'use strict';

// Bundled Engine Onboarding v1 slot B, Step 7 — pre-send "no workspace root"
// nudge (workspace_root_nudge). RED-FIRST: covers flag-off no-op, no-root
// render, root-set no-chip, session-scoped dismiss survives re-render, the
// action invokes the injected transactional root chooser,
// and root-becomes-set removing the chip live.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createWorkspaceRootNudgeController } = require('../renderer/features/renderer-workspace-root-nudge');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function makeDom() {
  return new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <div class="composer-wrap" id="composerWrap" data-dock-anchor="composer">
          <div class="composer" id="composerRoot"></div>
        </div>
      </body>
    </html>
  `, { pretendToBeVisual: true, url: 'http://localhost/' });
}

function makeState(overrides) {
  return {
    features: { featureFlags: { workspace_root_nudge: true } },
    workspaceRoot: { path: '', status: { state: 'missing', message: 'No workspace root is configured yet.' } },
    ...overrides,
  };
}

function createHarness(t, { state, windowExtras, chooseWorkspaceRoot } = {}) {
  const dom = makeDom();
  const windowRef = Object.assign(dom.window, windowExtras || {});
  const controller = createWorkspaceRootNudgeController({
    state: state || makeState(),
    windowRef,
    documentRef: dom.window.document,
    appendClientLog: () => {},
    chooseWorkspaceRoot,
  });
  controller.bind();
  t.after(() => controller.dispose());
  return { dom, controller, windowRef };
}

test('flag OFF renders nothing', (t) => {
  const state = makeState({ features: { featureFlags: { workspace_root_nudge: false } } });
  const { dom, controller } = createHarness(t, { state });
  controller.render();
  assert.equal(dom.window.document.getElementById('workspaceRootNudge'), null);
});

test('no root + flag ON renders the chip', (t) => {
  const { dom, controller } = createHarness(t);
  controller.render();
  const chip = dom.window.document.getElementById('workspaceRootNudge');
  assert.ok(chip, 'chip should render when no workspace root is set');
  assert.match(chip.textContent, /No workspace root set/);
  assert.match(chip.textContent, /file tools are off for this chat/);
  assert.ok(chip.querySelector('[data-workspace-root-nudge-action="set-root"]'));
  const dismiss = chip.querySelector('[data-workspace-root-nudge-action="dismiss"]');
  assert.ok(dismiss);
  assert.equal(dismiss.title, 'Dismiss workspace root hint');
});

test('persisted root hides the chip while its status probe is still checking', (t) => {
  const state = makeState({
    workspaceRoot: { path: 'C:\\dev\\jenny', status: { state: 'checking', message: 'Checking workspace root.' } },
  });
  const { dom, controller } = createHarness(t, { state });
  controller.render();
  assert.equal(dom.window.document.getElementById('workspaceRootNudge'), null);
});

test('configured but invalid root does not show a misleading no-root chip', (t) => {
  const state = makeState({
    workspaceRoot: { path: 'C:\\dev\\missing', status: { state: 'invalid', message: 'Root does not exist.' } },
  });
  const { dom, controller } = createHarness(t, { state });
  controller.render();
  assert.equal(dom.window.document.getElementById('workspaceRootNudge'), null);
});

test('dismiss hides for the session (re-render does not resurrect)', (t) => {
  const { dom, controller } = createHarness(t);
  controller.render();
  assert.ok(dom.window.document.getElementById('workspaceRootNudge'));

  const dismissButton = dom.window.document.querySelector('[data-workspace-root-nudge-action="dismiss"]');
  dismissButton.dispatchEvent(new dom.window.Event('click', { bubbles: true }));

  assert.equal(dom.window.document.getElementById('workspaceRootNudge'), null);

  controller.render();
  assert.equal(dom.window.document.getElementById('workspaceRootNudge'), null, 're-render must not resurrect a dismissed chip');
});

test('the action invokes the injected transition chooser, never the legacy bridge mutator', async (t) => {
  let called = 0;
  let legacyCalls = 0;
  const chooseWorkspaceRoot = () => {
    called += 1;
    return Promise.resolve({ canceled: true });
  };
  const { dom, controller } = createHarness(t, {
    chooseWorkspaceRoot,
    windowExtras: { jennyShell: { workspaceRoot: { choose: () => { legacyCalls += 1; } } } },
  });
  controller.render();

  const setRootButton = dom.window.document.querySelector('[data-workspace-root-nudge-action="set-root"]');
  setRootButton.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(called, 1);
  assert.equal(legacyCalls, 0);
});

test('a workspace chooser completion cannot remount the nudge after disposal', async (t) => {
  let releaseChooser;
  const { dom, controller } = createHarness(t, {
    chooseWorkspaceRoot() {
      return new Promise((resolve) => { releaseChooser = resolve; });
    },
  });
  controller.render();
  const setRootButton = dom.window.document.querySelector('[data-workspace-root-nudge-action="set-root"]');
  setRootButton.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(typeof releaseChooser, 'function');

  controller.dispose();
  assert.equal(dom.window.document.getElementById('workspaceRootNudge'), null);

  releaseChooser({ canceled: true });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(dom.window.document.getElementById('workspaceRootNudge'), null);
});

test('root becoming set removes the chip before its status probe settles', (t) => {
  const state = makeState();
  const { dom, controller } = createHarness(t, { state });
  controller.render();
  assert.ok(dom.window.document.getElementById('workspaceRootNudge'));

  state.workspaceRoot = { path: 'C:\\dev\\jenny', status: { state: 'checking', message: 'Checking workspace root.' } };
  controller.render();

  assert.equal(dom.window.document.getElementById('workspaceRootNudge'), null);
});

test('a fresh controller instance still shows the chip (dismiss is module-state, not persisted config)', (t) => {
  const { dom, controller } = createHarness(t);
  controller.render();
  const dismissButton = dom.window.document.querySelector('[data-workspace-root-nudge-action="dismiss"]');
  dismissButton.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(dom.window.document.getElementById('workspaceRootNudge'), null);

  // A second, independent controller instance (simulating a new session/window)
  // is not affected by the first instance's session-scoped dismiss.
  const { dom: dom2, controller: controller2 } = createHarness(t);
  controller2.render();
  assert.ok(dom2.window.document.getElementById('workspaceRootNudge'));
});

test('app binding routes the nudge action through the commit-capable workspace chooser', async () => {
  const app = await loadRendererApp({
    shell: {
      features: { state: { featureFlags: { workspace_root_nudge: true } } },
    },
  });
  try {
    const button = app.window.document.querySelector('[data-workspace-root-nudge-action="set-root"]');
    assert.ok(button, 'configured feature flag should mount the workspace-root nudge');

    button.click();
    await waitForUi(app.window, 80);

    assert.equal(app.shell.__state.workspaceRootState.workspaceRoot, 'G:/workspace/selected');
    assert.equal(app.window.document.getElementById('workspaceRootNudge'), null);
  } finally {
    await app.dispose();
  }
});
