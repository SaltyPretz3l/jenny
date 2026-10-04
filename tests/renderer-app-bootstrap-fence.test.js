const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('cleanup registered after owner disposal runs immediately exactly once', async (t) => {
  let registerCleanup;
  const app = await loadRendererApp({
    windowGlobals: {
      rendererAgentHooks: {
        installAgentTestHooks({ window }) {
          const create = window.rendererAppLifecycleComposition.createLifecycleComposition;
          window.rendererAppLifecycleComposition.createLifecycleComposition = (ctx) => {
            registerCleanup = ctx.registerRendererCleanup;
            return create(ctx);
          };
        },
      },
    },
  });
  t.after(() => app.dispose());
  const dispose = app.window.__disposeRenderer;
  await dispose();
  let cleanupCalls = 0;
  const cleanup = () => { cleanupCalls += 1; };
  assert.equal(registerCleanup(cleanup), cleanup, 'registration preserves the cleanup handle');
  assert.equal(cleanupCalls, 1, 'late cleanup runs immediately');
  await dispose();
  assert.equal(cleanupCalls, 1, 'repeated disposal does not rerun late cleanup');
  registerCleanup(() => { throw new Error('best-effort synchronous cleanup'); });
  registerCleanup(async () => { throw new Error('best-effort asynchronous cleanup'); });
  await waitForUi(app.window);
});

for (const preference of ['chatUi', 'windowUi']) {
  test(`bootstrap disposed during ${preference} preference IPC installs nothing on resolution`, async (t) => {
    const app = await loadRendererApp();
    const { window, shell } = app;
    t.after(() => app.dispose());
    await window.__disposeRenderer();
    const pending = deferred();
    const entered = deferred();
    const completed = deferred();
    let ctx;
    const create = window.rendererAppLifecycleComposition.createLifecycleComposition;
    window.rendererAppLifecycleComposition.createLifecycleComposition = (options) => {
      ctx = options;
      const result = create(options);
      result.then(completed.resolve, completed.resolve);
      return result;
    };
    shell[preference].getState = () => {
      entered.resolve();
      return pending.promise;
    };
    const reload = app.reloadRendererApp().then(() => null, (error) => error);
    await entered.promise;
    const dispose = window.__disposeRenderer;
    await dispose();

    const installations = [];
    for (const [moduleName, method] of [
      ['rendererShellServiceRegistryUtils', 'createShellServiceRegistry'],
      ['rendererTranscriptToolCallUtils', 'createTranscriptToolCallRenderer'],
      ['rendererHeaderUtils', 'createHeaderController'],
      ['rendererAppPaneComposition', 'createPaneComposition'],
      ['rendererAppShellBindings', 'bindAppShell'],
    ]) {
      const original = window[moduleName][method];
      window[moduleName][method] = (...args) => {
        installations.push(method);
        return original(...args);
      };
    }
    const subscriptions = [];
    for (const [name, service] of Object.entries(shell)) {
      if (!service || typeof service !== 'object') continue;
      for (const method of Object.keys(service).filter((key) => /^on[A-Z]/.test(key))) {
        const original = service[method];
        service[method] = (...args) => {
          subscriptions.push(`${name}.${method}`);
          return original.apply(service, args);
        };
      }
    }
    const listeners = [];
    const addListener = window.EventTarget.prototype.addEventListener;
    window.EventTarget.prototype.addEventListener = function (...args) {
      listeners.push(args[0]);
      return addListener.apply(this, args);
    };
    let observers = 0;
    window.ResizeObserver = class {
      constructor() { observers += 1; }
      observe() {}
      disconnect() {}
    };
    const mutations = [];
    const observer = new window.MutationObserver((records) => mutations.push(...records));
    observer.observe(window.document, { subtree: true, attributes: true, childList: true, characterData: true });
    const globalWrites = [];
    for (const name of ['rendererErrorCenterRecord', 'rendererTopNavShellController', 'rendererMultiStreamController']) {
      let value = window[name];
      Object.defineProperty(window, name, {
        configurable: true,
        get: () => value,
        set(next) { globalWrites.push(name); value = next; },
      });
    }
    pending.resolve({ zoomPercent: 150, appZoomPercent: 150 });
    await completed.promise;
    await waitForUi(window, 40);
    mutations.push(...observer.takeRecords());
    observer.disconnect();
    window.EventTarget.prototype.addEventListener = addListener;
    const reloadError = await reload;
    assert.deepEqual(installations, [], 'no controllers or outer shell bindings install after disposal');
    assert.deepEqual(subscriptions, [], 'no IPC subscriptions install after disposal');
    assert.deepEqual(listeners, [], 'no event listeners install after disposal');
    assert.equal(observers, 0, 'no layout observers install after disposal');
    assert.equal(mutations.length, 0, 'no DOM writes after disposal');
    assert.deepEqual(globalWrites, [], 'no application globals are assigned after disposal');
    assert.equal(ctx.state.harness.agentActions, null, 'outer continuation cannot publish actions');
    assert.match(reloadError?.message || '', /renderer never signalled ready/, 'disposed bootstrap never signals readiness');
    await dispose();
  });
}

test('bootstrap resolved after disposal does not re-bind shell controllers', async (t) => {
  const app = await loadRendererApp();
  const { window } = app;
  t.after(() => app.dispose());
  const pending = deferred();
  const entered = deferred();
  const lateCalls = [];
  let disposed = false;
  const bindAppShell = window.rendererAppShellBindings.bindAppShell;
  window.rendererAppShellBindings.bindAppShell = (ctx) => {
    ctx.callbacks.bootstrap = () => { entered.resolve(); return pending.promise; };
    for (const name of ['chatShellController', 'commandPaletteController']) {
      const controller = ctx.controllers[name];
      const bind = controller?.bind;
      if (typeof bind === 'function') {
        controller.bind = (...args) => {
          if (disposed) lateCalls.push(name);
          return bind.apply(controller, args);
        };
      }
    }
    const renderAll = ctx.callbacks.renderAll;
    ctx.callbacks.renderAll = (...args) => {
      if (disposed) lateCalls.push('renderAll');
      return renderAll(...args);
    };
    return bindAppShell(ctx);
  };
  const reload = app.reloadRendererApp().then(() => null, (error) => error);
  await entered.promise;
  await window.__disposeRenderer();
  disposed = true;
  pending.resolve();
  await reload;
  await waitForUi(window, 20);
  assert.deepEqual(lateCalls, [], 'a disposed owner must not re-bind or render after bootstrap resolves');
});
