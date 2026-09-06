/* UIUX-024: hidden-until-activated surfaces must not force their vendor
 * runtime bytes into the eager renderer boot path. This locks in the xterm.js
 * / addon-fit.js deferral (the Workspace IDE bottom-panel terminal is
 * explicit-start-only and invisible from the default Chat view) so a future
 * regression that re-adds a synchronous <script> tag for a hidden surface's
 * vendor runtime is caught immediately, rather than silently growing the
 * eager 534-script / 8.39 MB boot payload the audit measured. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function readIndexHtml() {
  return fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
}

/* Matches <script ...src="..."...></script> tags, capturing the full opening
 * tag attributes so we can distinguish eager (no `defer`) from lazy loads. */
function extractScriptTags(html) {
  const pattern = /<script\s+([^>]*)src="([^"]+)"([^>]*)><\/script>/gi;
  const tags = [];
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const attrs = `${match[1]} ${match[3]}`;
    tags.push({
      src: match[2],
      deferred: /\bdefer\b/.test(attrs),
    });
  }
  return tags;
}

test('index.html never eagerly (non-defer, unconditional) loads the xterm vendor runtime', () => {
  const html = readIndexHtml();
  const tags = extractScriptTags(html);

  const xtermTags = tags.filter((tag) => tag.src.includes('@xterm/xterm/lib/xterm.js')
    || tag.src.includes('@xterm/addon-fit/lib/addon-fit.js'));

  assert.deepEqual(
    xtermTags,
    [],
    'xterm.js and addon-fit.js (~478 KB + 1.5 KB) must not appear as production <script src> ' +
    'tags at all — the Workspace IDE terminal is explicit-start-only and loads them lazily ' +
    'via renderer/features/renderer-ide-xterm-loader.js (ensureXtermRuntime), never as a boot-time tag.'
  );
});

test('renderer-ide-xterm-loader.js is present and precedes the pty terminal panel controller', () => {
  const html = readIndexHtml();
  const tags = extractScriptTags(html);
  const loaderIndex = tags.findIndex((tag) => tag.src === 'renderer/features/renderer-ide-xterm-loader.js');
  const panelIndex = tags.findIndex((tag) => tag.src === 'renderer/features/renderer-ide-pty-terminal-panel.js');

  assert.notEqual(loaderIndex, -1, 'index.html should load renderer/features/renderer-ide-xterm-loader.js');
  assert.notEqual(panelIndex, -1, 'index.html should load renderer/features/renderer-ide-pty-terminal-panel.js');
  assert.ok(
    loaderIndex < panelIndex,
    'the xterm loader must load before the terminal panel controller that resolves it'
  );
});

test('script-loader-utils.js and renderer-ide-xterm-loader.js form a real, CommonJS-free dependency closure in production order (generated-closure gate, mirrors the File Map parity precedent)', () => {
  const html = readIndexHtml();
  const tags = extractScriptTags(html);
  const dependency = 'renderer/shared/script-loader-utils.js';
  const consumer = 'renderer/features/renderer-ide-xterm-loader.js';
  const dependencyIndex = tags.findIndex((tag) => tag.src === dependency);
  const consumerIndex = tags.findIndex((tag) => tag.src === consumer);

  assert.notEqual(dependencyIndex, -1, `index.html should load ${dependency}`);
  assert.notEqual(consumerIndex, -1, `index.html should load ${consumer}`);
  assert.ok(dependencyIndex < consumerIndex, `${dependency} must load before ${consumer}`);

  // No jsdom, no `require` fallback: a bare vm.createContext proves the UMD
  // registration (`root.scriptLoaderUtils = factory()` /
  // `root.rendererIdeXtermLoader = factory()`) actually resolves in this
  // order with nothing but a browser-shaped global — the same sandboxed
  // closure check the File Map layout/prefs pair uses (UIUX-023).
  const browserContext = vm.createContext({});
  for (const src of [dependency, consumer]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, src), 'utf8'), browserContext, { filename: src });
  }
  assert.equal(typeof browserContext.scriptLoaderUtils?.ensureScript, 'function');
  assert.equal(typeof browserContext.rendererIdeXtermLoader?.ensureXtermRuntime, 'function');
  assert.equal(typeof browserContext.rendererIdeXtermLoader?.isXtermRuntimeReady, 'function');
});

test('the pty terminal panel only awaits the xterm loader when a real (non-injected) terminal factory is in play', () => {
  const { createIdePtyTerminalPanel } = require('../renderer/features/renderer-ide-pty-terminal-panel');
  assert.equal(typeof createIdePtyTerminalPanel, 'function');
  // Structural guard: the source must reference the lazy loader module name,
  // not a bare `new globalRef.Terminal` with no runtime-load gate.
  const source = fs.readFileSync(
    path.join(ROOT, 'renderer/features/renderer-ide-pty-terminal-panel.js'),
    'utf8'
  );
  assert.ok(
    source.includes("resolveModule('rendererIdeXtermLoader', './renderer-ide-xterm-loader')"),
    'the panel must resolve the lazy xterm loader module rather than assuming the vendor globals are already present'
  );
});
