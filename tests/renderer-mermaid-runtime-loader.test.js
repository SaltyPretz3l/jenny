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

test('a board block loads the row module only while project_boards is on, and a reply with none loads nothing', async () => {
  const loader = loadFreshRuntimeLoader();
  const prevLoader = global.scriptLoaderUtils;
  const loaded = [];
  global.scriptLoaderUtils = { ensureScript({ src }) { loaded.push(src); return Promise.resolve(false); } };
  try {
    loader._resetForTests();
    const container = { querySelector: (selector) => (selector === 'pre > code.language-board' ? {} : null), ownerDocument: null };
    loader.setBoardBlocksEnabled(false);
    assert.equal(loader.renderBoardBlocks(container, {}), false);
    loader.setBoardBlocksEnabled(true);
    assert.equal(loader.renderBoardBlocks({ querySelector: () => null }, {}), false);
    assert.equal(loader.renderBoardBlocks(container, {}), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(loaded, ['renderer/features/renderer-board-block-row.js']);
  } finally {
    loader._resetForTests();
    global.scriptLoaderUtils = prevLoader;
  }
});

test('when the flag turns on, board blocks already in the page get their rows: a chat restored before the flag was known', async () => {
  const loader = loadFreshRuntimeLoader();
  const prev = { loader: global.scriptLoaderUtils, row: global.rendererBoardBlockRow, document: global.document };
  const drawn = [];
  global.scriptLoaderUtils = { ensureScript() { return Promise.resolve(true); } };
  global.rendererBoardBlockRow = { render(container) { drawn.push(container); return 1; } };
  global.document = { querySelector: (selector) => (selector === 'pre > code.language-board' ? {} : null), querySelectorAll: () => [] };
  try {
    loader._resetForTests();
    loader.setBoardBlocksEnabled(false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(drawn, [], 'off: nothing is drawn');
    loader.setBoardBlocksEnabled(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(drawn, [global.document], 'on: one pass over the page');
    loader.setBoardBlocksEnabled(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drawn.length, 1, 'told again, nothing more');
  } finally {
    loader._resetForTests();
    global.scriptLoaderUtils = prev.loader;
    if (prev.row === undefined) delete global.rendererBoardBlockRow; else global.rendererBoardBlockRow = prev.row;
    if (prev.document === undefined) delete global.document; else global.document = prev.document;
  }
});

test('a mockup block loads renderer-mockup-block.js and calls render; a reply with none loads nothing; a failed load is retried', async () => {
  const loader = loadFreshRuntimeLoader();
  const prev = { loader: global.scriptLoaderUtils, mockup: global.rendererMockupBlock, frames: global.rendererHtmlArtifactFrameUtils };
  const loaded = [];
  const rendered = [];
  let failNext = true;
  global.rendererHtmlArtifactFrameUtils = { createHtmlArtifactFrame() {} };
  global.scriptLoaderUtils = {
    ensureScript({ src, isReady }) {
      loaded.push(src);
      if (failNext) { failNext = false; return Promise.reject(new Error('load failed')); }
      global.rendererMockupBlock = { render(container, options) { rendered.push([container, options]); } };
      return Promise.resolve(Boolean(isReady()));
    },
  };
  const container = { querySelector: (selector) => (selector === 'pre > code.language-mockup' ? {} : null), ownerDocument: null };
  const none = { querySelector: () => null };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    loader._resetForTests();
    assert.equal(loader.renderMockupBlocks(none, {}), false);
    await settle();
    assert.deepEqual(loaded, [], 'no mockup block, nothing loaded');
    assert.equal(loader.renderMockupBlocks(container, { isStreaming: false }), true);
    await settle();
    assert.deepEqual(loaded, ['renderer/features/renderer-mockup-block.js']);
    assert.equal(rendered.length, 0, 'a failed load draws nothing');
    assert.equal(loader.renderMockupBlocks(container, { isStreaming: false }), true);
    await settle();
    assert.equal(loaded.length, 2, 'the next call retries the load');
    assert.deepEqual(rendered, [[container, { isStreaming: false }]]);
    assert.equal(loader.renderMockupBlocks(container, {}), true);
    await settle();
    assert.equal(loaded.length, 2, 'loaded once');
    assert.equal(rendered.length, 2);
  } finally {
    loader._resetForTests();
    global.scriptLoaderUtils = prev.loader;
    if (prev.mockup === undefined) delete global.rendererMockupBlock; else global.rendererMockupBlock = prev.mockup;
    if (prev.frames === undefined) delete global.rendererHtmlArtifactFrameUtils; else global.rendererHtmlArtifactFrameUtils = prev.frames;
  }
});

test('renderSketchBlocks also hands a mockup block to its module, and loads the frame utils first when they are missing', async () => {
  const loader = loadFreshRuntimeLoader();
  const prev = { loader: global.scriptLoaderUtils, mockup: global.rendererMockupBlock, frames: global.rendererHtmlArtifactFrameUtils };
  const loaded = [];
  delete global.rendererHtmlArtifactFrameUtils;
  delete global.rendererMockupBlock;
  global.scriptLoaderUtils = {
    ensureScript({ src, isReady }) {
      loaded.push(src);
      if (src.endsWith('renderer-html-artifact-frame-utils.js')) global.rendererHtmlArtifactFrameUtils = { createHtmlArtifactFrame() {} };
      if (src.endsWith('renderer-mockup-block.js')) global.rendererMockupBlock = { render() {} };
      return Promise.resolve(Boolean(isReady()));
    },
  };
  try {
    loader._resetForTests();
    const container = { querySelector: (selector) => (selector === 'pre > code.language-mockup' ? {} : null), ownerDocument: null };
    assert.equal(loader.renderSketchBlocks(container, {}), false, 'sketch itself is off and has no block');
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(loaded, ['renderer/features/renderer-html-artifact-frame-utils.js', 'renderer/features/renderer-mockup-block.js']);
  } finally {
    loader._resetForTests();
    global.scriptLoaderUtils = prev.loader;
    if (prev.mockup === undefined) delete global.rendererMockupBlock; else global.rendererMockupBlock = prev.mockup;
    if (prev.frames === undefined) delete global.rendererHtmlArtifactFrameUtils; else global.rendererHtmlArtifactFrameUtils = prev.frames;
  }
});
