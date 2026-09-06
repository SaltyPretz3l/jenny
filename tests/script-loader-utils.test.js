const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

function loadScriptLoaderUtils() {
  const modulePath = require.resolve('../renderer/shared/script-loader-utils');
  delete require.cache[modulePath];
  return require('../renderer/shared/script-loader-utils');
}

function installDomGlobals(dom, t) {
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;
  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    dom.window.close();
  });
}

/* Replace head.appendChild so an injected <script> "executes": set the
   expected global, then fire `load` on a microtask (after ensureScript has
   wired its timeout, so no timer leaks). */
function stubScriptExecution(dom, onAppend) {
  const head = dom.window.document.head;
  const realAppend = head.appendChild.bind(head);
  head.appendChild = function patchedAppend(node) {
    const result = realAppend(node);
    if (node && node.tagName === 'SCRIPT') {
      onAppend(node);
      queueMicrotask(() => {
        node.dispatchEvent(new dom.window.Event('load'));
      });
    }
    return result;
  };
}

test('ensureScript resolves true immediately when isReady is already satisfied (no injection)', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'file:///app/index.html' });
  installDomGlobals(dom, t);
  const loader = loadScriptLoaderUtils();
  loader._resetForTests();

  const ready = await loader.ensureScript({ src: 'vendor/already-here.js', isReady: () => true });

  assert.equal(ready, true);
  assert.equal(dom.window.document.querySelector('script[data-script-loader-src]'), null);
});

test('ensureScript injects a <script> and resolves true once the expected global appears', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'file:///app/index.html' });
  installDomGlobals(dom, t);
  const loader = loadScriptLoaderUtils();
  loader._resetForTests();

  stubScriptExecution(dom, () => {
    dom.window.__fakeLib = { ready: true };
  });

  const ready = await loader.ensureScript({
    src: 'vendor/fake-lib.js',
    isReady: () => Boolean(dom.window.__fakeLib && dom.window.__fakeLib.ready),
  });

  assert.equal(ready, true);
  const injected = dom.window.document.querySelector('script[data-script-loader-src="vendor/fake-lib.js"]');
  assert.ok(injected, 'expected an injected <script> carrying the loader marker attribute');
  assert.equal(injected.getAttribute('src'), 'vendor/fake-lib.js');
});

test('ensureScript dedupes concurrent + repeat calls to a single injection', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'file:///app/index.html' });
  installDomGlobals(dom, t);
  const loader = loadScriptLoaderUtils();
  loader._resetForTests();

  let appendCount = 0;
  stubScriptExecution(dom, () => {
    appendCount += 1;
    dom.window.__libCount = { ready: true };
  });
  const isReady = () => Boolean(dom.window.__libCount && dom.window.__libCount.ready);

  const [a, b] = await Promise.all([
    loader.ensureScript({ src: 'vendor/once.js', isReady }),
    loader.ensureScript({ src: 'vendor/once.js', isReady }),
  ]);
  const c = await loader.ensureScript({ src: 'vendor/once.js', isReady });

  assert.deepEqual([a, b, c], [true, true, true]);
  assert.equal(appendCount, 1, 'the script should be injected exactly once');
  assert.equal(dom.window.document.querySelectorAll('script[data-script-loader-src="vendor/once.js"]').length, 1);
});

test('ensureScript resolves false on script load error and allows a later retry', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'file:///app/index.html' });
  installDomGlobals(dom, t);
  const loader = loadScriptLoaderUtils();
  loader._resetForTests();

  const head = dom.window.document.head;
  const realAppend = head.appendChild.bind(head);
  let attempts = 0;
  head.appendChild = function patchedAppend(node) {
    const result = realAppend(node);
    if (node && node.tagName === 'SCRIPT') {
      attempts += 1;
      queueMicrotask(() => node.dispatchEvent(new dom.window.Event('error')));
    }
    return result;
  };

  const first = await loader.ensureScript({ src: 'vendor/broken.js', isReady: () => false });
  const second = await loader.ensureScript({ src: 'vendor/broken.js', isReady: () => false });

  assert.equal(first, false);
  assert.equal(second, false);
  assert.equal(attempts, 2, 'a failed load must not be cached — a later call re-attempts injection');
});

test('ensureScript resolves false when there is no injectable document', async () => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = undefined;
  global.document = undefined;
  try {
    const loader = loadScriptLoaderUtils();
    loader._resetForTests();
    const ready = await loader.ensureScript({ src: 'vendor/anything.js', isReady: () => false });
    assert.equal(ready, false);
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
});
