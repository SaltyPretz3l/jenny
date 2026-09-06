const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
} = require('./helpers/renderer-shell-harness');

test('backend-status timers are cancelled and fenced when the renderer is disposed', async (t) => {
  const app = await loadRendererApp();
  const { window, shell } = app;
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  const scheduledZeroDelay = new Map();
  const clearedHandles = new Set();
  let nextHandle = 100000;

  t.after(async () => {
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
    await app.dispose();
  });

  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  const auditMarks = [];
  window.__jennyStartupAudit = {
    config: { enabled: true, prompt: 'Run the startup audit' },
    mark(name) {
      auditMarks.push(name);
    },
  };
  window.setTimeout = (callback, delay = 0, ...args) => {
    if (delay !== 0) {
      return originalSetTimeout(callback, delay, ...args);
    }
    nextHandle += 1;
    scheduledZeroDelay.set(nextHandle, () => callback(...args));
    return nextHandle;
  };
  window.clearTimeout = (handle) => {
    if (scheduledZeroDelay.has(handle)) {
      clearedHandles.add(handle);
      return;
    }
    originalClearTimeout(handle);
  };

  await shell.__emitBackendStatus({ phase: 'ready', startupStage: 'ready' });
  const scheduledCallbacks = [...scheduledZeroDelay.values()];
  assert.ok(scheduledCallbacks.length >= 2, 'ready status schedules startup-audit and health refresh work');

  await window.__disposeRenderer();

  assert.equal(clearedHandles.size, scheduledCallbacks.length, 'dispose clears every queued zero-delay callback');
  for (const callback of scheduledCallbacks) {
    callback();
  }
  await Promise.resolve();
  assert.equal(
    auditMarks.includes('startup-audit-auto-send-ready'),
    false,
    'a dequeued callback cannot start the audit after disposal',
  );
});

test('header controller disposal is registered with renderer teardown', async (t) => {
  let disposeCalls = 0;
  const app = await loadRendererApp({
    windowGlobals: {
      rendererHeaderUtils: {
        createHeaderController() {
          return {
            renderHeader() {},
            dispose() { disposeCalls += 1; },
          };
        },
      },
    },
  });
  const { window } = app;

  t.after(async () => {
    await app.dispose();
  });

  assert.equal(disposeCalls, 0);

  await window.__disposeRenderer();

  assert.equal(disposeCalls, 1);
});
