const test = require('node:test');
const assert = require('node:assert/strict');

const LOADER_PATH = '../renderer/shared/renderer-katex-runtime-loader';

function loadFreshRuntimeLoader() {
  delete require.cache[require.resolve(LOADER_PATH)];
  return require(LOADER_PATH);
}

test('ensureKatexRuntime short-circuits to true when the runtime is already present', async (t) => {
  const prevWindow = global.window;
  const prevLoader = global.scriptLoaderUtils;
  let ensureScriptCalls = 0;

  global.window = {
    location: { href: 'http://localhost/' },
    katex: { renderToString() {} },
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

  assert.equal(await loader.ensureKatexRuntime(), true);
  assert.equal(ensureScriptCalls, 0, 'an already-loaded runtime should not re-inject the script');
});

test('ensureKatexRuntime memoizes one in-flight script load for concurrent callers', async (t) => {
  const prevWindow = global.window;
  const prevLoader = global.scriptLoaderUtils;
  let ensureScriptCalls = 0;
  let finishLoad;

  global.window = { location: { href: 'http://localhost/' } };
  global.scriptLoaderUtils = {
    ensureScript() {
      ensureScriptCalls += 1;
      return new Promise((resolve) => {
        finishLoad = resolve;
      });
    },
  };
  t.after(() => {
    global.window = prevWindow;
    global.scriptLoaderUtils = prevLoader;
  });

  const loader = loadFreshRuntimeLoader();
  loader._resetForTests();

  const first = loader.ensureKatexRuntime();
  const second = loader.ensureKatexRuntime();
  assert.equal(ensureScriptCalls, 1);
  finishLoad(true);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test('ensureKatexRuntime resolves false when ensureScript cannot load the runtime', async (t) => {
  const prevWindow = global.window;
  const prevLoader = global.scriptLoaderUtils;

  global.window = { location: { href: 'http://localhost/' } };
  global.scriptLoaderUtils = {
    ensureScript() {
      return Promise.resolve(false);
    },
  };
  t.after(() => {
    global.window = prevWindow;
    global.scriptLoaderUtils = prevLoader;
  });

  const loader = loadFreshRuntimeLoader();
  loader._resetForTests();

  assert.equal(await loader.ensureKatexRuntime(), false);
});

test('ensureKatexRuntime uses the AMD loader when Monaco has installed it', async (t) => {
  const prevWindow = global.window;
  const prevLoader = global.scriptLoaderUtils;
  let ensureScriptCalls = 0;
  let requireCalls = 0;
  let requireDeps;

  global.window = {
    location: { href: 'file:///app/index.html' },
    define: Object.assign(() => {}, { amd: {} }),
    require(deps, ok) {
      requireCalls += 1;
      requireDeps = deps;
      ok({ renderToString() {} });
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

  assert.equal(await loader.ensureKatexRuntime(), true);
  assert.equal(typeof global.window.katex.renderToString, 'function');
  assert.equal(requireCalls, 1);
  assert.equal(requireDeps.length, 1);
  assert.equal(requireDeps[0].endsWith('katex.min.js'), true);
  assert.equal(ensureScriptCalls, 0);
});

test('ensureKatexRuntime suppresses an immediate retry after an AMD load failure', async (t) => {
  const prevWindow = global.window;
  const prevLoader = global.scriptLoaderUtils;
  let requireCalls = 0;

  global.window = {
    location: { href: 'file:///app/index.html' },
    define: Object.assign(() => {}, { amd: {} }),
    require(_deps, _ok, fail) {
      requireCalls += 1;
      fail(new Error('AMD load failed'));
    },
  };
  global.scriptLoaderUtils = {
    ensureScript() {
      throw new Error('ensureScript should not be called');
    },
  };
  t.after(() => {
    global.window = prevWindow;
    global.scriptLoaderUtils = prevLoader;
  });

  const loader = loadFreshRuntimeLoader();
  loader._resetForTests();

  assert.equal(await loader.ensureKatexRuntime(), false);
  assert.equal(await loader.ensureKatexRuntime(), false);
  assert.equal(requireCalls, 1);
});

test('ensureKatexRuntime retries a script load after the cooldown expires', async (t) => {
  const prevWindow = global.window;
  const prevLoader = global.scriptLoaderUtils;
  const prevDateNow = Date.now;
  let now = 1000;
  let ensureScriptCalls = 0;

  Date.now = () => now;
  global.window = { location: { href: 'http://localhost/' } };
  global.scriptLoaderUtils = {
    ensureScript() {
      ensureScriptCalls += 1;
      return Promise.resolve(false);
    },
  };
  t.after(() => {
    Date.now = prevDateNow;
    global.window = prevWindow;
    global.scriptLoaderUtils = prevLoader;
  });

  const loader = loadFreshRuntimeLoader();
  loader._resetForTests();

  assert.equal(await loader.ensureKatexRuntime(), false);
  assert.equal(await loader.ensureKatexRuntime(), false);
  assert.equal(ensureScriptCalls, 1);

  now += 31000;
  assert.equal(await loader.ensureKatexRuntime(), false);
  assert.equal(ensureScriptCalls, 2);
});

test('ensureKatexRuntime permanently suppresses retries after three failures', async (t) => {
  const prevWindow = global.window;
  const prevLoader = global.scriptLoaderUtils;
  const prevDateNow = Date.now;
  let now = 1000;
  let ensureScriptCalls = 0;

  Date.now = () => now;
  global.window = { location: { href: 'http://localhost/' } };
  global.scriptLoaderUtils = {
    ensureScript() {
      ensureScriptCalls += 1;
      return Promise.resolve(false);
    },
  };
  t.after(() => {
    Date.now = prevDateNow;
    global.window = prevWindow;
    global.scriptLoaderUtils = prevLoader;
  });

  const loader = loadFreshRuntimeLoader();
  loader._resetForTests();

  assert.equal(await loader.ensureKatexRuntime(), false);
  now += 31000;
  assert.equal(await loader.ensureKatexRuntime(), false);
  now += 31000;
  assert.equal(await loader.ensureKatexRuntime(), false);
  assert.equal(ensureScriptCalls, 3);

  now += 31000;
  assert.equal(await loader.ensureKatexRuntime(), false);
  assert.equal(ensureScriptCalls, 3);
});
