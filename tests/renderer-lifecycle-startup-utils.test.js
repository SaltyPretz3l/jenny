const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDeferredVisualStartupController,
} = require('../renderer/shell/renderer-lifecycle-startup-utils');

function createFakeWindow() {
  const callbacks = new Map();
  let nextHandle = 1;
  const cleared = [];
  return {
    callbacks,
    cleared,
    setTimeout(callback) {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
    clearTimeout(handle) {
      cleared.push(handle);
      callbacks.delete(handle);
    },
    run(handle) {
      callbacks.get(handle)?.();
    },
  };
}

test('deferred visual startup logs first render once and runs visual startup once', () => {
  const calls = [];
  const logs = [];
  const controller = createDeferredVisualStartupController({
    appendClientLog(level, event) {
      logs.push({ level, event });
    },
    fwd: {
      initializeComposerHolo: () => calls.push('composer'),
      initializeSpriteHolo: () => calls.push('sprite'),
      syncComposerVisualState: () => calls.push('composer-state'),
      initializeComposerLayoutObserver: () => calls.push('layout'),
      warmCodeHighlighting: () => calls.push('highlight'),
    },
    getElapsedMs: () => 7,
  });

  controller.noteFirstRenderComplete();
  controller.noteFirstRenderComplete();
  controller.runDeferredVisualStartup();
  controller.runDeferredVisualStartup();

  assert.deepEqual(logs.map((entry) => entry.event), [
    'renderer.first_render_complete',
    'renderer.visual_startup_begin',
    'renderer.visual_startup_complete',
  ]);
  assert.deepEqual(calls, ['composer', 'sprite', 'composer-state', 'layout', 'highlight']);
});

test('deferred visual startup scheduler cancels pending timeout on dispose', () => {
  const fakeWindow = createFakeWindow();
  const controller = createDeferredVisualStartupController({
    window: fakeWindow,
    appendClientLog() {},
    fwd: { disposeCodeHighlighting: () => fakeWindow.cleared.push('highlight') },
  });

  controller.scheduleDeferredVisualStartup();
  const handle = Array.from(fakeWindow.callbacks.keys())[0];
  controller.disposeLifecycleController();
  fakeWindow.run(handle);

  assert.deepEqual(fakeWindow.cleared, ['highlight', handle]);
  assert.equal(fakeWindow.callbacks.size, 0);
});
