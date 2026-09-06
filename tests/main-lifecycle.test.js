const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MainLifecycleController,
  registerMainProcessLifecycleHandlers,
  registerMainWindowSessionEndHandlers,
} = require('../services/main-lifecycle');
const {
  stopRuntimeWithDependencies,
} = require('../services/runtime-stop');

class FakeEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, listener) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }
    this._listeners.get(event).push(listener);
  }

  listenerCount(event) {
    return this._listeners.get(event)?.length || 0;
  }

  async emitAsync(event, payload) {
    const listeners = this._listeners.get(event) || [];
    for (const listener of listeners) {
      await listener(payload);
    }
  }
}

class FakeApp extends FakeEmitter {
  constructor() {
    super();
    this.quitCalls = 0;
    this.exitCalls = [];
    this.lastQuitPromise = null;
    this.lastBeforeQuitEvent = null;
  }

  quit() {
    this.quitCalls += 1;
    const event = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    this.lastBeforeQuitEvent = event;
    this.lastQuitPromise = this.emitAsync('before-quit', event)
      .then(() => this.emitAsync('will-quit'))
      .then(() => undefined);
    return this.lastQuitPromise;
  }

  exit(code = 0) {
    this.exitCalls.push(code);
  }
}

class FakeWindow extends FakeEmitter {}

test('window-all-closed routes through graceful shutdown and exits after stop completes', async () => {
  const app = new FakeApp();
  let resolveStop;
  let stopCallCount = 0;
  const stopPromise = new Promise((resolve) => {
    resolveStop = resolve;
  });
  const lifecycle = new MainLifecycleController({
    appQuit: () => app.quit(),
    appExit: (code) => app.exit(code),
    stopRuntime: async () => {
      stopCallCount += 1;
      await stopPromise;
    },
    onWillQuit: () => {},
    getPlatform: () => 'win32',
  });

  registerMainProcessLifecycleHandlers(app, lifecycle);

  assert.equal(app.listenerCount('before-quit'), 1);
  assert.equal(app.listenerCount('will-quit'), 1);
  assert.equal(app.listenerCount('window-all-closed'), 1);

  await app.emitAsync('window-all-closed');
  assert.equal(app.quitCalls, 1);
  assert.equal(stopCallCount, 1);
  assert.equal(app.lastBeforeQuitEvent.prevented, true);
  assert.deepEqual(app.exitCalls, []);

  resolveStop();
  await app.lastQuitPromise;

  assert.deepEqual(app.exitCalls, [0]);
});

test('query-session-end and session-end share one idempotent shutdown path', async () => {
  const window = new FakeWindow();
  const exitCalls = [];
  let stopCallCount = 0;
  const lifecycle = new MainLifecycleController({
    appQuit: () => {},
    appExit: (code) => exitCalls.push(code),
    stopRuntime: async () => {
      stopCallCount += 1;
    },
    getPlatform: () => 'win32',
  });

  registerMainWindowSessionEndHandlers(window, lifecycle);

  assert.equal(window.listenerCount('query-session-end'), 1);
  assert.equal(window.listenerCount('session-end'), 1);

  const queryEvent = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  const sessionEvent = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };

  await window.emitAsync('query-session-end', queryEvent);
  await window.emitAsync('session-end', sessionEvent);

  assert.equal(queryEvent.prevented, true);
  assert.equal(sessionEvent.prevented, false);
  assert.equal(stopCallCount, 1);
  assert.deepEqual(exitCalls, [0]);
});

test('requestEmergencyShutdown exits with non-zero code and remains idempotent', async () => {
  const exitCalls = [];
  let stopCallCount = 0;
  const lifecycle = new MainLifecycleController({
    appQuit: () => {},
    appExit: (code) => exitCalls.push(code),
    stopRuntime: async () => {
      stopCallCount += 1;
    },
    getPlatform: () => 'win32',
  });

  await Promise.all([
    lifecycle.requestEmergencyShutdown({ exitCode: 1 }),
    lifecycle.requestEmergencyShutdown({ exitCode: 2 }),
  ]);

  assert.equal(stopCallCount, 1);
  assert.deepEqual(exitCalls, [1]);
});

test('registered shutdown tasks are awaited before runtime stop and app exit', async () => {
  const order = [];
  let releaseTask;
  const taskPromise = new Promise((resolve) => {
    releaseTask = resolve;
  });
  const lifecycle = new MainLifecycleController({
    appQuit: () => {},
    appExit: (code) => order.push(`exit:${code}`),
    stopRuntime: async () => {
      order.push('stop-runtime');
    },
    getPlatform: () => 'win32',
  });
  lifecycle.registerShutdownTask(async () => {
    order.push('terminal-dispose:start');
    await taskPromise;
    order.push('terminal-dispose:done');
  });

  const event = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  const pending = lifecycle.handleBeforeQuit(event);
  await Promise.resolve();

  assert.equal(event.prevented, true);
  assert.deepEqual(order, ['terminal-dispose:start']);

  releaseTask();
  await pending;

  assert.deepEqual(order, [
    'terminal-dispose:start',
    'terminal-dispose:done',
    'stop-runtime',
    'exit:0',
  ]);
});

test('runtime shutdown stops scheduler before the backend service', async () => {
  const order = [];
  const suggestionCache = { id: 'cache' };

  await stopRuntimeWithDependencies({
    shellConfigService: {
      flushPendingWorkspaceWrite() {
        order.push('flush');
      },
    },
    systemStats: {
      stop() {
        order.push('system');
      },
    },
    schedulerService: {
      stop() {
        order.push('scheduler');
      },
    },
    backendService: {
      async stop() {
        order.push('backend');
      },
    },
    clearSuggestionCacheImpl(cache) {
      order.push(`cache:${cache.id}`);
    },
    suggestionCacheValue: suggestionCache,
    emitLifecycleProgressImpl() {},
    logImpl() {},
    runEmergencyShutdownImpl() {
      order.push('emergency');
    },
  });

  assert.deepEqual(order, [
    'flush',
    'system',
    'scheduler',
    'cache:cache',
    'backend',
    'emergency',
  ]);
});
