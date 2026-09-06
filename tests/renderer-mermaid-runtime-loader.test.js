const test = require('node:test');
const assert = require('node:assert/strict');

const LOADER_PATH = '../renderer/features/renderer-mermaid-runtime-loader';

function loadFreshRuntimeLoader() {
  delete require.cache[require.resolve(LOADER_PATH)];
  return require(LOADER_PATH);
}

test('ensureMermaidRuntime resolves false (no unhandled rejection) when the script load rejects', async (t) => {
  const prevWindow = global.window;
  const prevLoader = global.scriptLoaderUtils;
  let ensureScriptCalls = 0;

  global.window = { location: { href: 'http://localhost/' } };
  global.scriptLoaderUtils = {
    ensureScript() {
      ensureScriptCalls += 1;
      return Promise.reject(new Error('mermaid.min.js failed to load'));
    },
  };
  t.after(() => {
    global.window = prevWindow;
    global.scriptLoaderUtils = prevLoader;
  });

  const loader = loadFreshRuntimeLoader();
  loader._resetForTests();

  // A rejected load must surface as a resolved `false`, never a thrown rejection.
  const first = await loader.ensureMermaidRuntime();
  assert.equal(first, false);

  // The cache must be cleared on failure so a later render can retry (rather
  // than re-await a permanently-rejected cached promise).
  const second = await loader.ensureMermaidRuntime();
  assert.equal(second, false);
  assert.equal(ensureScriptCalls, 2, 'a failed load should not be cached; retry must re-invoke ensureScript');
});

test('ensureMermaidRuntime short-circuits to true when the runtime is already present', async (t) => {
  const prevWindow = global.window;
  const prevLoader = global.scriptLoaderUtils;
  let ensureScriptCalls = 0;

  global.window = {
    location: { href: 'http://localhost/' },
    mermaid: { render() {}, initialize() {} },
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

  assert.equal(await loader.ensureMermaidRuntime(), true);
  assert.equal(ensureScriptCalls, 0, 'an already-loaded runtime should not re-inject the script');
});
