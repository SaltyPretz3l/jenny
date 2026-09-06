const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

function loadRendererMonacoEditorUtils() {
  const modulePath = require.resolve('../renderer/features/renderer-monaco-editor-utils');
  delete require.cache[modulePath];
  return require('../renderer/features/renderer-monaco-editor-utils');
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

test('Monaco AMD onError swallows Monaco loader failures but preserves non-Monaco delegation', async (t) => {
  const dom = new JSDOM(
    '<div id="host"></div><textarea id="fallback"></textarea>',
    { pretendToBeVisual: true, url: 'file:///C:/dev/jenny/index.html' }
  );
  installDomGlobals(dom, t);
  const monacoUtils = loadRendererMonacoEditorUtils();
  const delegatedErrors = [];

  function amdRequire(_modules, _success, failure) {
    if (typeof failure === 'function') {
      failure(new Error('editor.main callback failed'));
    }
  }
  amdRequire.config = function config() {};
  amdRequire.onError = function previousOnError(error) {
    delegatedErrors.push(error);
    throw new Error('previous require.onError invoked');
  };
  dom.window.require = amdRequire;

  const editor = monacoUtils.createArtifactEditor({
    host: dom.window.document.getElementById('host'),
    fallbackTextarea: dom.window.document.getElementById('fallback'),
  });

  await editor.setDocument({
    value: '# Scratch Plan',
    language: 'markdown',
    readOnly: false,
  });

  assert.equal(typeof dom.window.MonacoEnvironment?.getWorkerUrl, 'function');
  const workerUrl = dom.window.MonacoEnvironment.getWorkerUrl('vs/base/worker/workerMain', 'editorWorkerService');
  assert.doesNotMatch(workerUrl, /^data:/);
  assert.match(workerUrl, /^file:/);
  assert.match(workerUrl, /monaco-worker-bootstrap\.js\?vs=/);
  // The ?vs= payload is the resolved AMD base the worker must load from -
  // anchored at the app root, never relative to renderer/frames/ - and the
  // label rides along so the bootstrap can pre-import language bundles.
  const workerParams = new dom.window.URL(workerUrl).searchParams;
  assert.equal(workerParams.get('vs'), 'file:///C:/dev/jenny/node_modules/monaco-editor/min/vs/');
  assert.equal(workerParams.get('label'), 'editorWorkerService');
  const tsWorkerUrl = dom.window.MonacoEnvironment.getWorkerUrl('workerMain', 'typescript');
  assert.equal(new dom.window.URL(tsWorkerUrl).searchParams.get('label'), 'typescript');
  assert.match(dom.window.document.getElementById('fallback').value, /Scratch Plan/);
  assert.doesNotThrow(() => {
    dom.window.require.onError({
      requireModules: ['vs/editor/editor.main'],
      message: 'Monaco module failed',
    });
  });
  assert.doesNotThrow(() => {
    dom.window.require.onError({
      target: {
        src: 'file:///C:/dev/jenny/node_modules/monaco-editor/min/vs/editor/editor.main.js',
      },
    });
  });
  assert.throws(() => {
    dom.window.require.onError({
      requireModules: ['app/runtime'],
      message: 'Application module failed',
    });
  }, /previous require\.onError invoked/);
  assert.equal(delegatedErrors.length, 1);
});

test('createArtifactEditor lazy-loads the Monaco loader via scriptLoaderUtils when window.require is absent', async (t) => {
  const dom = new JSDOM(
    '<div id="host"></div><textarea id="fallback"></textarea>',
    { pretendToBeVisual: true, url: 'file:///C:/dev/jenny/index.html' }
  );
  installDomGlobals(dom, t);
  const monacoUtils = loadRendererMonacoEditorUtils();

  let ensureCalls = 0;
  let requestedSrc = '';
  const previousLoader = global.scriptLoaderUtils;
  global.scriptLoaderUtils = {
    ensureScript(opts) {
      ensureCalls += 1;
      requestedSrc = String(opts.src || '');
      // Simulate loader.js arriving: define an AMD require whose editor.main
      // load fails, so we deterministically exercise the textarea fallback.
      function amdRequire(_modules, _success, failure) {
        if (typeof failure === 'function') {
          failure(new Error('editor.main unavailable in test'));
        }
      }
      amdRequire.config = function config() {};
      dom.window.require = amdRequire;
      return Promise.resolve(Boolean(opts.isReady()));
    },
  };
  t.after(() => { global.scriptLoaderUtils = previousLoader; });

  const editor = monacoUtils.createArtifactEditor({
    host: dom.window.document.getElementById('host'),
    fallbackTextarea: dom.window.document.getElementById('fallback'),
  });
  await editor.setDocument({ value: '# Lazy Monaco', language: 'markdown', readOnly: false });

  assert.equal(ensureCalls, 1, 'the Monaco loader should be injected on first editor use');
  assert.match(requestedSrc, /monaco-editor\/min\/vs\/loader\.js$/);
  // Loader present but editor.main failed → graceful textarea fallback.
  assert.equal(editor.isUsingMonaco(), false);
  assert.match(dom.window.document.getElementById('fallback').value, /Lazy Monaco/);
});

test('fingerprintText distinguishes same-length content changes (WIDE-053)', () => {
  const monacoUtils = loadRendererMonacoEditorUtils();
  const a = monacoUtils.fingerprintText('a'.repeat(20));
  const b = monacoUtils.fingerprintText('b'.repeat(20));
  const aAgain = monacoUtils.fingerprintText('a'.repeat(20));
  assert.notEqual(a, b, 'same-length different content must not collide');
  assert.equal(a, aAgain, 'identical content is deterministic');
  assert.notEqual(a, monacoUtils.fingerprintText('a'.repeat(21)), 'length change must differ too');
});

test('monaco worker bootstrap resolves the AMD base from ?vs= with an app-root fallback', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'frames', 'monaco-worker-bootstrap.js'),
    'utf8'
  );

  function runWorkerBootstrap(href) {
    const imported = [];
    const workerSelf = { location: { href } };
    vm.runInNewContext(source, {
      self: workerSelf,
      URL,
      importScripts: (url) => imported.push(url),
    }, { filename: 'monaco-worker-bootstrap.js' });
    return { imported, env: workerSelf.MonacoEnvironment };
  }

  // The window side passes the resolved AMD base explicitly.
  const vsBase = 'file:///C:/dev/jenny/node_modules/monaco-editor/min/vs/';
  const explicit = runWorkerBootstrap(
    `file:///C:/dev/jenny/renderer/frames/monaco-worker-bootstrap.js?vs=${encodeURIComponent(vsBase)}`
  );
  assert.deepEqual(explicit.imported, [`${vsBase}base/worker/workerMain.js`]);
  assert.equal(explicit.env.baseUrl, vsBase);

  // No query: the app root sits two levels above renderer/frames/. The old
  // relative resolution produced renderer/frames/node_modules/... - a path
  // that does not exist, so every worker importScripts failed and Monaco
  // silently degraded to main-thread workers.
  const fallback = runWorkerBootstrap(
    'file:///C:/dev/jenny/renderer/frames/monaco-worker-bootstrap.js'
  );
  assert.deepEqual(fallback.imported, [`${vsBase}base/worker/workerMain.js`]);
  assert.doesNotMatch(String(fallback.env.baseUrl), /renderer\/frames/);

  // Language labels pre-import their AMD bundle after workerMain, so the
  // in-worker loader resolves the module locally instead of fetch()ing a
  // file: URL (Electron file pages read as same-origin, steering Monaco's
  // loader onto its fetch+eval path, and fetch cannot read file:).
  const tsLabel = runWorkerBootstrap(
    `file:///C:/dev/jenny/renderer/frames/monaco-worker-bootstrap.js?vs=${encodeURIComponent(vsBase)}&label=javascript`
  );
  assert.deepEqual(tsLabel.imported, [
    `${vsBase}base/worker/workerMain.js`,
    `${vsBase}language/typescript/tsWorker.js`,
  ]);
  const baseLabel = runWorkerBootstrap(
    `file:///C:/dev/jenny/renderer/frames/monaco-worker-bootstrap.js?vs=${encodeURIComponent(vsBase)}&label=editorWorkerService`
  );
  assert.deepEqual(baseLabel.imported, [`${vsBase}base/worker/workerMain.js`]);
});

test('setWordWrap flips the fallback textarea wrap attribute and survives late toggles', async (t) => {
  const dom = new JSDOM(
    '<div id="host"></div><textarea id="fallback"></textarea>',
    { pretendToBeVisual: true, url: 'file:///C:/dev/jenny/index.html' }
  );
  installDomGlobals(dom, t);
  const monacoUtils = loadRendererMonacoEditorUtils();
  const editor = monacoUtils.createArtifactEditor({
    host: dom.window.document.getElementById('host'),
    fallbackTextarea: dom.window.document.getElementById('fallback'),
  });
  await editor.setDocument({ value: 'long line of text', language: 'plaintext', readOnly: true });

  assert.equal(editor.getWordWrap(), true, 'wrap defaults on, matching MONACO_DEFAULTS.wordWrap');
  editor.setWordWrap(false);
  assert.equal(editor.getWordWrap(), false);
  assert.equal(dom.window.document.getElementById('fallback').getAttribute('wrap'), 'off');
  editor.setWordWrap(true);
  assert.equal(editor.getWordWrap(), true);
  assert.equal(dom.window.document.getElementById('fallback').getAttribute('wrap'), 'soft');
});

// JSDOM serializes custom-property values with commas unspaced; real browsers
// preserve the author's whitespace. Normalize so these assertions stay exact
// without encoding one engine's quirk.
function normalizeFontStack(value) {
  return String(value).replace(/,\s*/g, ', ').trim();
}

test('resolveMonacoFontFamily reads --font-family-mono and returns empty when unresolvable', (t) => {
  const dom = new JSDOM(
    '<style>:root { --font-family-mono: "Cascadia Code", monospace; }</style><div id="host"></div>',
    { pretendToBeVisual: true, url: 'file:///C:/dev/jenny/index.html' }
  );
  installDomGlobals(dom, t);
  const monacoUtils = loadRendererMonacoEditorUtils();

  assert.equal(
    normalizeFontStack(monacoUtils.resolveMonacoFontFamily(dom.window.document)),
    '"Cascadia Code", monospace'
  );

  // The unresolvable case must yield '' so callers can OMIT the key. Passing
  // '' through to Monaco is worse than omitting it: Monaco treats an empty
  // string as a real family and falls back to the UA serif, whereas an absent
  // option leaves its own per-platform mono stack in place.
  const bare = new JSDOM('<div id="host"></div>', { url: 'file:///C:/dev/jenny/index.html' });
  t.after(() => bare.window.close());
  assert.equal(monacoUtils.resolveMonacoFontFamily(bare.window.document), '');
});

test('withMonacoFontFamily omits fontFamily entirely when the token does not resolve', (t) => {
  const dom = new JSDOM('<div id="host"></div>', { url: 'file:///C:/dev/jenny/index.html' });
  installDomGlobals(dom, t);
  const monacoUtils = loadRendererMonacoEditorUtils();

  const bare = monacoUtils.withMonacoFontFamily({ fontSize: 13 }, dom.window.document);
  assert.equal(Object.prototype.hasOwnProperty.call(bare, 'fontFamily'), false);
  assert.equal(bare.fontSize, 13, 'the rest of the options must pass through untouched');

  const styled = new JSDOM(
    '<style>:root { --font-family-mono: "Cascadia Mono", monospace; }</style>',
    { url: 'file:///C:/dev/jenny/index.html' }
  );
  t.after(() => styled.window.close());
  const withFont = monacoUtils.withMonacoFontFamily({ fontSize: 13 }, styled.window.document);
  assert.equal(normalizeFontStack(withFont.fontFamily), '"Cascadia Mono", monospace');
  assert.equal(withFont.fontSize, 13);
});

test('disposing while Monaco loads prevents a late editor instance and fallback mutation', async (t) => {
  const dom = new JSDOM(
    '<div id="host"></div><textarea id="fallback" class="hidden">before</textarea>',
    { url: 'file:///C:/dev/jenny/index.html' }
  );
  installDomGlobals(dom, t);

  let releaseLoader;
  let createCalls = 0;
  function amdRequire(_modules, onReady) {
    releaseLoader = onReady;
  }
  amdRequire.config = function config() {};
  dom.window.require = amdRequire;

  const model = {
    value: '',
    getValue() { return this.value; },
    setValue(value) { this.value = value; },
    dispose() {},
  };
  const monacoEditor = {
    updateOptions() {},
    onDidChangeModelContent() {},
    dispose() {},
  };
  const monacoUtils = loadRendererMonacoEditorUtils();
  const fallback = dom.window.document.getElementById('fallback');
  const editor = monacoUtils.createArtifactEditor({
    host: dom.window.document.getElementById('host'),
    fallbackTextarea: fallback,
  });

  const pending = editor.setDocument({ value: 'late', language: 'markdown' });
  while (!releaseLoader) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  editor.dispose();
  dom.window.monaco = {
    editor: {
      setTheme() {},
      createModel(value) { model.value = value; return model; },
      create() { createCalls += 1; return monacoEditor; },
      setModelLanguage() {},
    },
  };
  releaseLoader();
  await pending;

  assert.equal(createCalls, 0);
  assert.equal(editor.isUsingMonaco(), false);
  assert.equal(fallback.value, 'before');
  assert.equal(fallback.classList.contains('hidden'), true);
});

test('a typography change retunes registered editors and remeasures Monaco fonts', async (t) => {
  const dom = new JSDOM(
    '<style>:root { --font-family-mono: "Cascadia Code", monospace; }'
    + ':root[data-typography="editorial"] { --font-family-mono: "Cascadia Mono", monospace; }</style>',
    { pretendToBeVisual: true, url: 'file:///C:/dev/jenny/index.html' }
  );
  installDomGlobals(dom, t);
  const monacoUtils = loadRendererMonacoEditorUtils();

  const applied = [];
  const editor = { updateOptions(options) { applied.push(options); } };
  let remeasured = 0;
  dom.window.monaco = { editor: { remeasureFonts() { remeasured += 1; } } };

  const unregister = monacoUtils.registerMonacoFontConsumer(editor, dom.window.document);
  t.after(() => unregister());

  dom.window.document.documentElement.dataset.typography = 'editorial';
  // MutationObserver callbacks are microtask-scheduled.
  await new Promise((resolve) => { dom.window.queueMicrotask(resolve); });
  await new Promise((resolve) => { dom.window.queueMicrotask(resolve); });

  assert.equal(applied.length, 1, 'exactly one retune per typography change');
  assert.deepEqual(Object.keys(applied[0]), ['fontFamily'], 'only the font family may be touched');
  assert.equal(normalizeFontStack(applied[0].fontFamily), '"Cascadia Mono", monospace');
  assert.equal(remeasured, 1, 'without remeasureFonts Monaco keeps stale character-width metrics');

  // A disposed editor must stop receiving updates - a retained handle would
  // call updateOptions on a torn-down instance.
  unregister();
  dom.window.document.documentElement.dataset.typography = 'technical';
  await new Promise((resolve) => { dom.window.queueMicrotask(resolve); });
  await new Promise((resolve) => { dom.window.queueMicrotask(resolve); });
  assert.equal(applied.length, 1, 'unregistered editors must not be retuned');
});

test('every Monaco create site opts in to the mono token and unregisters on dispose', () => {
  // Source-level on purpose: Monaco never instantiates under JSDOM (it takes
  // the textarea fallback), so the helpers above can be fully green while a
  // create site quietly stops calling them - which is exactly the regression
  // that shipped. `fontFamily` absent is NOT a no-op: Monaco substitutes its
  // own per-platform stack, silently leaving the app's typography.
  const fs = require('node:fs');
  const path = require('node:path');
  const repoRoot = path.join(__dirname, '..');
  const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

  const artifactSource = read('renderer/features/renderer-monaco-editor-utils.js');
  const ideSource = read('renderer/features/renderer-ide-editor-host.js');

  const createCalls = [
    ...artifactSource.matchAll(/editor\.create(?:DiffEditor)?\(/g),
    ...ideSource.matchAll(/editor\.create(?:DiffEditor)?\(/g),
  ];
  assert.equal(createCalls.length, 3, 'expected exactly 3 Monaco create sites (artifact, IDE, IDE diff)');

  // Each create call must hand its options through the wrapper.
  assert.match(artifactSource, /editor\.create\(host, withMonacoFontFamily\(\{/);
  assert.match(ideSource, /editor\.create\(host, fonts\.withFont\(\{/);
  assert.match(ideSource, /editor\.createDiffEditor\(diffEditorEl, fonts\.withFont\(/);

  // And each must release its registration, or the observer reaches a
  // torn-down editor.
  assert.match(artifactSource, /unregisterFontConsumer = registerMonacoFontConsumer\(/);
  assert.match(artifactSource, /dispose\(\) \{[\s\S]*?unregisterFontConsumer\(\);/);
  // The IDE host runs three editors (main + both diff sides) through one
  // binding that holds every unregister handle and drops them together.
  assert.match(ideSource, /fonts\.register\(monacoEditor,/);
  assert.match(ideSource, /fonts\.register\(diffEditor\.getOriginalEditor\?\.\(\),/);
  assert.match(ideSource, /fonts\.register\(diffEditor\.getModifiedEditor\?\.\(\),/);
  assert.match(ideSource, /function dispose\(\) \{[\s\S]*?fonts\.release\(\);/);
  // ...and the binding must actually invoke every handle it handed out.
  assert.match(artifactSource, /release\(\) \{\s*handles\.splice\(0\)\.forEach\(/);

  // MONACO_DEFAULTS must stay font-free: it is evaluated at module load,
  // before any appearance preference has been applied to the document.
  const defaults = artifactSource.match(/const MONACO_DEFAULTS = \{[\s\S]*?\};/)?.[0] || '';
  assert.notEqual(defaults, '', 'expected MONACO_DEFAULTS to still exist');
  assert.equal(defaults.includes('fontFamily'), false, 'MONACO_DEFAULTS must not freeze a font at load time');
});

test('workspacePathToMonacoUriString is lossless for URI-delimiter filenames (hyg-W4-37-F10)', async () => {
  const { URI } = await import('monaco-editor/esm/vs/base/common/uri.js');
  const { workspacePathToMonacoUriString } = require('../renderer/features/renderer-monaco-editor-utils');
  assert.equal(typeof workspacePathToMonacoUriString, 'function');
  for (const path of ['src/foo#bar.ts', 'notes/q?a.md', 'pkg/100%.js', 'plain/dir/file.ts']) {
    const uri = URI.parse(workspacePathToMonacoUriString(path));
    assert.equal(uri.scheme, 'jenny-workspace', path);
    assert.equal(uri.fragment, '', `${path} must not leak into the URI fragment`);
    assert.equal(uri.query, '', `${path} must not leak into the URI query`);
    // pathFromModel contract: decoded uri.path minus the leading slash IS the path.
    assert.equal(String(uri.path).replace(/^\//, ''), path, path);
  }
});
