const test = require('node:test');
const assert = require('node:assert/strict');

const LOADER_PATH = '../renderer/features/renderer-ide-xterm-loader';

function loadFreshRuntimeLoader() {
  delete require.cache[require.resolve(LOADER_PATH)];
  return require(LOADER_PATH);
}

test('ensureXtermRuntime short-circuits to true when Terminal/FitAddon are already present', async (t) => {
  const prevWindow = global.window;
  const prevLoader = global.scriptLoaderUtils;
  let ensureScriptCalls = 0;

  global.window = {
    location: { href: 'http://localhost/' },
    Terminal: function FakeTerminal() {},
    FitAddon: { FitAddon: function FakeFitAddon() {} },
  };
  global.scriptLoaderUtils = {
    ensureScript() {
      ensureScriptCalls += 1;
      return Promise.resolve(true);
    },
  };
  t.after(() => {
    global.window = prevWindow;
    global.scriptLoaderUtils = prevLoader;
  });

  const loader = loadFreshRuntimeLoader();
  loader._resetForTests();

  assert.equal(loader.isXtermRuntimeReady(), true);
  assert.equal(await loader.ensureXtermRuntime(), true);
  assert.equal(ensureScriptCalls, 0, 'an already-loaded runtime should not re-inject either script');
});

test('ensureXtermRuntime loads xterm.js then addon-fit.js in order and resolves true once both globals appear', async (t) => {
  const prevWindow = global.window;
  const prevLoader = global.scriptLoaderUtils;
  const requestedSrcs = [];

  global.window = { location: { href: 'http://localhost/' } };
  global.scriptLoaderUtils = {
    ensureScript({ src, isReady }) {
      requestedSrcs.push(src);
      if (src.includes('@xterm/xterm/lib/xterm.js')) {
        global.window.Terminal = function FakeTerminal() {};
      } else if (src.includes('@xterm/addon-fit/lib/addon-fit.js')) {
        global.window.FitAddon = { FitAddon: function FakeFitAddon() {} };
      }
      return Promise.resolve(Boolean(isReady()));
    },
  };
  t.after(() => {
    global.window = prevWindow;
    global.scriptLoaderUtils = prevLoader;
  });

  const loader = loadFreshRuntimeLoader();
  loader._resetForTests();

  const ok = await loader.ensureXtermRuntime();

  assert.equal(ok, true);
  assert.equal(requestedSrcs.length, 2, 'xterm.js and addon-fit.js should each be requested exactly once');
  assert.ok(requestedSrcs[0].includes('@xterm/xterm/lib/xterm.js'), 'xterm.js must load before addon-fit.js');
  assert.ok(requestedSrcs[1].includes('@xterm/addon-fit/lib/addon-fit.js'));
});

test('ensureXtermRuntime never requests addon-fit.js when xterm.js itself fails to load', async (t) => {
  const prevWindow = global.window;
  const prevLoader = global.scriptLoaderUtils;
  const requestedSrcs = [];

  global.window = { location: { href: 'http://localhost/' } };
  global.scriptLoaderUtils = {
    ensureScript({ src }) {
      requestedSrcs.push(src);
      return Promise.resolve(false);
    },
  };
  t.after(() => {
    global.window = prevWindow;
    global.scriptLoaderUtils = prevLoader;
  });

  const loader = loadFreshRuntimeLoader();
  loader._resetForTests();

  const ok = await loader.ensureXtermRuntime();

  assert.equal(ok, false);
  assert.deepEqual(requestedSrcs, [requestedSrcs[0]], 'addon-fit.js must not be requested once xterm.js fails');
  assert.ok(requestedSrcs[0].includes('@xterm/xterm/lib/xterm.js'));
});

test('ensureXtermRuntime resolves false (no unhandled rejection) when a script load rejects, and allows retry', async (t) => {
  const prevWindow = global.window;
  const prevLoader = global.scriptLoaderUtils;
  let ensureScriptCalls = 0;

  global.window = { location: { href: 'http://localhost/' } };
  global.scriptLoaderUtils = {
    ensureScript() {
      ensureScriptCalls += 1;
      return Promise.reject(new Error('xterm.js failed to load'));
    },
  };
  t.after(() => {
    global.window = prevWindow;
    global.scriptLoaderUtils = prevLoader;
  });

  const loader = loadFreshRuntimeLoader();
  loader._resetForTests();

  const first = await loader.ensureXtermRuntime();
  assert.equal(first, false);

  const second = await loader.ensureXtermRuntime();
  assert.equal(second, false);
  assert.equal(ensureScriptCalls, 2, 'a failed load should not be cached; retry must re-invoke ensureScript');
});

test('ensureXtermRuntime dedupes concurrent callers to a single in-flight load', async (t) => {
  const prevWindow = global.window;
  const prevLoader = global.scriptLoaderUtils;
  let ensureScriptCalls = 0;
  let resolveFirst;
  const gate = new Promise((resolve) => { resolveFirst = resolve; });

  global.window = { location: { href: 'http://localhost/' } };
  global.scriptLoaderUtils = {
    ensureScript({ src, isReady }) {
      ensureScriptCalls += 1;
      if (src.includes('xterm.js')) {
        return gate.then(() => {
          global.window.Terminal = function FakeTerminal() {};
          return isReady();
        });
      }
      global.window.FitAddon = { FitAddon: function FakeFitAddon() {} };
      return Promise.resolve(isReady());
    },
  };
  t.after(() => {
    global.window = prevWindow;
    global.scriptLoaderUtils = prevLoader;
  });

  const loader = loadFreshRuntimeLoader();
  loader._resetForTests();

  const first = loader.ensureXtermRuntime();
  const second = loader.ensureXtermRuntime();
  resolveFirst();
  const [a, b] = await Promise.all([first, second]);

  assert.deepEqual([a, b], [true, true]);
  assert.equal(ensureScriptCalls, 2, 'two concurrent callers must share one in-flight xterm.js + addon-fit.js load, not start it twice');
});
