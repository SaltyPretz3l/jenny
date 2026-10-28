const test = require('node:test');
const assert = require('node:assert/strict');

const { createSetupController } = require('../renderer/features/renderer-setup-controller');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('controller ignores hydration that resolves after disposal', async () => {
  const hydration = deferred();
  const state = {};
  const controller = createSetupController({
    state,
    setupService: {
      getState: () => hydration.promise,
    },
    dom: {},
    modules: {},
    callbacks: {},
  });

  const pending = controller.init();
  controller.dispose();
  hydration.resolve({ loaded: true, setupComplete: true });
  await pending;

  assert.equal(state.setup.loaded, false);
  assert.equal(state.setup.setupComplete, false);
});

test('completeSetup defers route readiness to the backend and applies its verdict', async () => {
  let completeCalls = 0;
  const toasts = [];
  const state = {};
  const controller = createSetupController({
    state,
    setupService: {
      complete: async () => { completeCalls += 1; return null; },
    },
    dom: {},
    modules: {},
    callbacks: {
      showShellErrorToast: (message) => toasts.push(message),
    },
  });
  controller.applySnapshot({
    steps: {
      workspaceRoot: 'done',
      localModel: 'done',
      endpoint: 'pending',
    },
    readiness: {
      workspaceRoot: { ready: true },
      localModel: { ready: false },
      endpoint: { ready: false },
    },
  });

  await controller.completeSetup();

  assert.equal(completeCalls, 1);
  assert.notEqual(state.setup.setupComplete, true);
  assert.equal(toasts.length, 0);
  controller.dispose();
});

test('an applied snapshot repaints the surface showing setup; a disposed controller does not', async () => {
  let renders = 0;
  const state = {};
  const controller = createSetupController({
    state,
    setupService: { getState: async () => ({ steps: { workspaceRoot: 'done' } }) },
    dom: {},
    modules: {},
    callbacks: { renderAfterSetupChange: () => { renders += 1; } },
  });
  controller.applySnapshot({ steps: { localModel: 'done' } });
  assert.equal(renders, 1, 'Settings > Account repaints with the new step count');
  await controller.refresh();
  assert.equal(renders, 2, 'a status-driven refresh repaints too');
  controller.dispose();
  controller.applySnapshot({ steps: { endpoint: 'done' } });
  assert.equal(renders, 2);
});
