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

test('ensureXtermRuntime loads xterm.js, addon-fit.js, then the search and web-links addons in order and resolves true', async (t) => {
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
      } else if (src.includes('@xterm/addon-search/lib/addon-search.js')) {
        global.window.SearchAddon = { SearchAddon: function FakeSearchAddon() {} };
      } else if (src.includes('@xterm/addon-web-links/lib/addon-web-links.js')) {
        global.window.WebLinksAddon = { WebLinksAddon: function FakeWebLinksAddon() {} };
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
  assert.equal(requestedSrcs.length, 4, 'each of the four scripts should be requested exactly once');
  assert.ok(requestedSrcs[0].includes('@xterm/xterm/lib/xterm.js'), 'xterm.js must load before addon-fit.js');
  assert.ok(requestedSrcs[1].includes('@xterm/addon-fit/lib/addon-fit.js'));
  assert.ok(requestedSrcs[2].includes('@xterm/addon-search/lib/addon-search.js'));
  assert.ok(requestedSrcs[3].includes('@xterm/addon-web-links/lib/addon-web-links.js'));
  assert.equal(typeof global.window.SearchAddon.SearchAddon, 'function', 'the search addon global is published');
  assert.equal(typeof global.window.WebLinksAddon.WebLinksAddon, 'function', 'the web-links addon global is published');
});

test('ensureXtermRuntime still resolves true when the optional search and web-links addons fail to load', async (t) => {
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
      } else if (src.includes('addon-search')) {
        return Promise.reject(new Error('addon-search failed'));
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

  assert.equal(await loader.ensureXtermRuntime(), true, 'a failed addon never fails the runtime');
  assert.equal(requestedSrcs.length, 4, 'a failing search addon does not stop the web-links addon from loading');
  assert.equal(loader.isXtermRuntimeReady(), true);
  assert.equal(global.window.SearchAddon, undefined);
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
  assert.deepEqual(requestedSrcs, [requestedSrcs[0]], 'no addon may be requested once xterm.js fails');
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
  assert.equal(ensureScriptCalls, 4, 'two concurrent callers must share one in-flight load of the four scripts, not start it twice');
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
  const FakeSearchAddon = function FakeSearchAddon() {};
  const FakeWebLinksAddon = function FakeWebLinksAddon() {};

  const define = function define() {};
  define.amd = {};
  global.window = {
    location: { href: 'file:///G:/app/index.html' },
    define,
    require(deps, onLoad) {
      amdRequests.push(deps[0]);
      if (deps[0].includes('@xterm/xterm/lib/xterm.js')) {
        onLoad({ Terminal: FakeTerminal });
      } else if (deps[0].includes('addon-search')) {
        onLoad({ SearchAddon: FakeSearchAddon });
      } else if (deps[0].includes('addon-web-links')) {
        onLoad({ WebLinksAddon: FakeWebLinksAddon });
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
  assert.equal(global.window.SearchAddon.SearchAddon, FakeSearchAddon, 'SearchAddon published from the AMD module value');
  assert.equal(global.window.WebLinksAddon.WebLinksAddon, FakeWebLinksAddon, 'WebLinksAddon published from the AMD module value');
  assert.equal(amdRequests.length, 4);
  assert.ok(amdRequests[0].includes('@xterm/xterm/lib/xterm.js'), 'xterm.js first');
  assert.ok(amdRequests[1].includes('@xterm/addon-fit/lib/addon-fit.js'));
  assert.ok(amdRequests[2].includes('@xterm/addon-search/lib/addon-search.js'));
  assert.ok(amdRequests[3].includes('@xterm/addon-web-links/lib/addon-web-links.js'));
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

// Cleanup T3: the terminal theme stylesheet is no longer an eager styles.css import; the
// loader injects one <link> on the first terminal Start, and after xterm.js the fit, search
// and web-links addons load concurrently.
test('the theme link is injected once on first mount and addons load concurrently', async (t) => {
  const { JSDOM } = require('jsdom');
  const prevWindow = global.window;
  const prevLoader = global.scriptLoaderUtils;
  const dom = new JSDOM('<!doctype html><head></head><body></body>', { url: 'http://localhost/index.html' });
  const requestedSrcs = [];
  const gates = new Map();
  const win = dom.window;
  global.window = win;
  global.scriptLoaderUtils = {
    ensureScript({ src, isReady }) {
      requestedSrcs.push(src);
      if (src.includes('@xterm/xterm/lib/xterm.js')) {
        win.Terminal = function FakeTerminal() {};
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        gates.set(src, () => {
          if (src.includes('addon-fit')) win.FitAddon = { FitAddon: function FakeFitAddon() {} };
          resolve(Boolean(isReady()) || !src.includes('addon-fit'));
        });
      });
    },
  };
  t.after(() => {
    global.window = prevWindow;
    global.scriptLoaderUtils = prevLoader;
    dom.window.close();
  });

  const loader = loadFreshRuntimeLoader();
  loader._resetForTests();
  const pending = loader.ensureXtermRuntime();
  const links = () => [...win.document.querySelectorAll('link[rel="stylesheet"]')];
  assert.equal(links().length, 1, 'the first Start injects the theme link');
  assert.match(links()[0].href, /styles\/ide-terminal-theme\.css$/);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  assert.equal(requestedSrcs.length, 4, 'fit, search and web-links are all requested before any of them settles');
  for (const open of gates.values()) open();
  links()[0].dispatchEvent(new win.Event('load'));
  assert.equal(await pending, true);
  assert.equal(await loader.ensureXtermRuntime(), true);
  assert.equal(links().length, 1, 'a later Start never injects a second link');
});

test('styles.css no longer imports the terminal theme; the run/test output link style stays eager', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.doesNotMatch(styles, /ide-terminal-theme\.css/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'styles/ide-terminal-theme.css'), 'utf8'), /\.ide-output-link/);
  assert.match(fs.readFileSync(path.join(root, 'styles/ide-problems.css'), 'utf8'), /\.ide-output-link\s*\{/);
  assert.match(styles, /@import url\("\.\/styles\/ide-problems\.css"\);/);
});
