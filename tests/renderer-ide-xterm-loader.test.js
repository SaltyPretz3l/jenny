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

// Monaco's AMD loader is live in the real renderer: window.define.amd is set
// and window.require is the AMD require. xterm's UMD wrapper then registers an
// anonymous AMD module and never sets window.Terminal, so a plain <script>
// injection resolves false forever ("The terminal runtime could not be
// loaded"). The loader must go through the AMD require and publish the globals.
test('ensureXtermRuntime loads through the AMD require when Monaco owns define.amd and publishes both globals', async (t) => {
  const prevWindow = global.window;
  const prevLoader = global.scriptLoaderUtils;
  const amdRequests = [];
  let ensureScriptCalls = 0;
  const FakeTerminal = function FakeTerminal() {};
  const FakeFitAddon = function FakeFitAddon() {};

  const define = function define() {};
  define.amd = {};
  global.window = {
    location: { href: 'file:///G:/app/index.html' },
    define,
    require(deps, onLoad) {
      amdRequests.push(deps[0]);
      if (deps[0].includes('@xterm/xterm/lib/xterm.js')) {
        onLoad({ Terminal: FakeTerminal });
      } else {
        onLoad({ FitAddon: FakeFitAddon });
      }
    },
  };
  global.scriptLoaderUtils = {
    ensureScript() {
      ensureScriptCalls += 1;
      return Promise.resolve(false);
    },
  };
  t.after(() => {
    global.window = prevWindow;
    global.scriptLoaderUtils = prevLoader;
  });

  const loader = loadFreshRuntimeLoader();
  loader._resetForTests();

  assert.equal(await loader.ensureXtermRuntime(), true);
  assert.equal(global.window.Terminal, FakeTerminal, 'Terminal published from the AMD module value');
  assert.equal(global.window.FitAddon.FitAddon, FakeFitAddon, 'FitAddon published from the AMD module value');
  assert.equal(amdRequests.length, 2);
  assert.ok(amdRequests[0].includes('@xterm/xterm/lib/xterm.js'), 'xterm.js first');
  assert.ok(amdRequests[1].includes('@xterm/addon-fit/lib/addon-fit.js'));
  assert.equal(ensureScriptCalls, 0, 'never falls back to a plain <script> tag under an AMD loader');
  assert.equal(loader.isXtermRuntimeReady(), true);
});

test('ensureXtermRuntime resolves false and allows a retry when the AMD load errors', async (t) => {
  const prevWindow = global.window;
  const prevLoader = global.scriptLoaderUtils;
  let attempts = 0;
  const define = function define() {};
  define.amd = {};
  global.window = {
    location: { href: 'file:///G:/app/index.html' },
    define,
    require(_deps, _onLoad, onError) {
      attempts += 1;
      onError(new Error('404'));
    },
  };
  global.scriptLoaderUtils = null;
  t.after(() => {
    global.window = prevWindow;
    global.scriptLoaderUtils = prevLoader;
  });

  const loader = loadFreshRuntimeLoader();
  loader._resetForTests();

  assert.equal(await loader.ensureXtermRuntime(), false);
  assert.equal(await loader.ensureXtermRuntime(), false);
  assert.equal(attempts, 2, 'a failed AMD load is retried on the next call');
  assert.equal(global.window.Terminal, undefined);
});
