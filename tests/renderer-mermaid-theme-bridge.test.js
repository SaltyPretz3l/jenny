const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const bridgeModule = require('../renderer/features/renderer-mermaid-theme-bridge');

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

function buildBridgeFixture(t) {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body>'
    + '<div class="markdown-mermaid-block" id="rendered-block" data-mermaid-rendered="true" data-mermaid-source="flowchart TD\nA-->B">'
    + '<div class="markdown-mermaid-preview"><svg></svg></div>'
    + '</div>'
    + '<div class="markdown-mermaid-block" id="unrendered-block" data-mermaid-source="flowchart TD\nC-->D">'
    + '<div class="markdown-mermaid-preview"></div>'
    + '</div>'
    + '<div class="reasoning-row-panel">'
    + '<div class="markdown-mermaid-block" id="reasoning-block" data-mermaid-rendered="true" data-mermaid-source="flowchart TD\nE-->F">'
    + '<div class="markdown-mermaid-preview"><svg></svg></div>'
    + '</div>'
    + '</div>'
    + '<div class="artifact-preview-mermaid-host" id="panel-host" data-mermaid-source="flowchart TD\nG-->H"><svg></svg></div>'
    + '</body></html>',
    { pretendToBeVisual: true, url: 'http://localhost/' }
  );
  installDomGlobals(dom, t);
  dom.window.document.documentElement.dataset.palette = 'midnight';

  const calls = {
    reinitialize: 0,
    renderHosts: [],
    controlsHosts: [],
  };
  const mermaidUtilsStub = {
    reinitializeMermaidTheme() {
      calls.reinitialize += 1;
    },
    renderMermaidDirect(host, source, options) {
      calls.renderHosts.push(host.id || host.className);
      if (options && typeof options.onSuccess === 'function') {
        options.onSuccess({ ok: true });
      }
      return Promise.resolve();
    },
    attachMermaidControls(host) {
      calls.controlsHosts.push(host.id || host.className);
    },
  };
  const themeUtilsStub = {
    buildThemeConfig() {
      return { key: 'theme-key-' + String(dom.window.document.documentElement.dataset.palette || '') };
    },
  };

  const bridge = bridgeModule.createMermaidThemeBridge({
    documentRef: dom.window.document,
    mermaidUtils: mermaidUtilsStub,
    themeUtils: themeUtilsStub,
    mutationObserverCtor: dom.window.MutationObserver,
  });
  t.after(() => bridge.dispose());

  return { dom, calls, bridge };
}

function nextTick(dom) {
  return new Promise((resolve) => dom.window.setTimeout(resolve, 0));
}

test('palette mutation reinitializes the Mermaid theme and re-renders only rendered, non-reasoning hosts', async (t) => {
  const { dom, calls } = buildBridgeFixture(t);

  dom.window.document.documentElement.dataset.palette = 'paper';
  await nextTick(dom);

  assert.equal(calls.reinitialize, 1, 'reinitializeMermaidTheme should be called once for a real palette change');
  // The markdown block's render host is its .markdown-mermaid-preview child
  // (no id, so the stub records the className).
  assert.deepEqual(
    calls.renderHosts.sort(),
    ['markdown-mermaid-preview', 'panel-host'].sort(),
    'only the rendered markdown block preview host and the artifact panel host re-render'
  );
  assert.deepEqual(
    calls.controlsHosts.sort(),
    ['markdown-mermaid-preview', 'panel-host'].sort(),
    'controls are re-attached after each successful re-render'
  );
});

test('same-palette mutation is a no-op via the theme cache-key short-circuit', async (t) => {
  const { dom, calls } = buildBridgeFixture(t);

  dom.window.document.documentElement.dataset.palette = 'midnight';
  await nextTick(dom);

  assert.equal(calls.reinitialize, 0, 'no reinitialize when the theme key is unchanged');
  assert.equal(calls.renderHosts.length, 0, 'no re-render when the theme key is unchanged');
});

test('refresh() is the direct (appearance-driven) path and short-circuits until the key changes', (t) => {
  const { dom, calls, bridge } = buildBridgeFixture(t);

  assert.equal(bridge.refresh(), false, 'refresh with an unchanged key is a no-op');
  assert.equal(calls.reinitialize, 0);

  dom.window.document.documentElement.dataset.palette = 'woolly';
  assert.equal(bridge.refresh(), true, 'refresh after a palette change re-themes');
  assert.equal(calls.reinitialize, 1);
  assert.equal(bridge.refresh(), false, 'a second refresh with the same key is a no-op');
  assert.equal(calls.reinitialize, 1);
});

test('the lazily created shared bridge re-themes diagrams rendered before it existed', (t) => {
  // applyAppearancePreferences creates the shared instance INSIDE the first
  // palette change after boot: the attribute is already the new palette, and
  // the rendered diagram still carries the old one.
  const { dom, calls, bridge } = buildBridgeFixture(t);
  bridge.dispose();
  t.after(() => bridgeModule.disposeSharedMermaidThemeBridge());
  const deps = {
    documentRef: dom.window.document,
    mermaidUtils: {
      reinitializeMermaidTheme() { calls.reinitialize += 1; },
      renderMermaidDirect(host) { calls.renderHosts.push(host.id || host.className); return Promise.resolve(); },
    },
    themeUtils: { buildThemeConfig() { return { key: 'theme-key-' + dom.window.document.documentElement.dataset.palette }; } },
    mutationObserverCtor: dom.window.MutationObserver,
  };

  dom.window.document.documentElement.dataset.palette = 'paper';
  assert.equal(bridgeModule.refreshSharedMermaidTheme(deps), true, 'first call re-themes');
  assert.equal(calls.reinitialize, 1);
  assert.deepEqual(calls.renderHosts.sort(), ['markdown-mermaid-preview', 'panel-host'].sort());
  assert.equal(bridgeModule.refreshSharedMermaidTheme(), false, 'same palette again is a no-op');
  assert.equal(calls.renderHosts.length, 2);
});

test('overlapping palette refreshes serialize each host and coalesce to the newest theme', async (t) => {
  const host = { theme: '', getAttribute: () => 'flowchart TD\nA-->B' };
  const root = { dataset: { palette: 'a' } };
  const pending = [];
  const bridge = bridgeModule.createMermaidThemeBridge({
    documentRef: {
      documentElement: root,
      querySelectorAll: (selector) => (selector.startsWith('.artifact') ? [host] : []),
    },
    mermaidUtils: {
      reinitializeMermaidTheme() {},
      renderMermaidDirect(target) {
        const theme = root.dataset.palette;
        return new Promise((resolve) => pending.push(() => {
          target.theme = theme;
          resolve();
        }));
      },
    },
    themeUtils: { buildThemeConfig: () => ({ key: root.dataset.palette }) },
    mutationObserverCtor: null,
  });
  t.after(() => bridge.dispose());

  root.dataset.palette = 'b';
  bridge.refresh();
  root.dataset.palette = 'c';
  bridge.refresh();
  assert.equal(pending.length, 1, 'theme C waits for the in-flight theme B render');
  pending.shift()();
  await new Promise(setImmediate);
  assert.equal(pending.length, 1, 'only the latest queued theme is rendered next');
  pending.shift()();
  await new Promise(setImmediate);
  assert.equal(host.theme, 'c', 'the host settles on the current palette');
});

test('dispose() disconnects the observer so later palette mutations are ignored', async (t) => {
  const { dom, calls, bridge } = buildBridgeFixture(t);

  bridge.dispose();
  dom.window.document.documentElement.dataset.palette = 'paper';
  await nextTick(dom);

  assert.equal(calls.reinitialize, 0);
  assert.equal(calls.renderHosts.length, 0);
});

test('the block preview host receives the block source (host resolution contract)', async (t) => {
  const { dom } = buildBridgeFixture(t);
  const seen = [];
  const bridge = bridgeModule.createMermaidThemeBridge({
    documentRef: dom.window.document,
    mermaidUtils: {
      reinitializeMermaidTheme() {},
      renderMermaidDirect(host, source) {
        seen.push({ id: host.id, source });
        return Promise.resolve();
      },
      attachMermaidControls() {},
    },
    themeUtils: {
      buildThemeConfig() {
        return { key: 'k-' + String(dom.window.document.documentElement.dataset.palette || '') };
      },
    },
    mutationObserverCtor: null,
  });
  t.after(() => bridge.dispose());

  dom.window.document.documentElement.dataset.palette = 'jenny-day';
  bridge.refresh();

  const panelHost = seen.find((entry) => entry.id === 'panel-host');
  assert.ok(panelHost, 'panel host re-renders through refresh()');
  assert.equal(panelHost.source, 'flowchart TD\nG-->H');
  assert.ok(
    seen.some((entry) => entry.source === 'flowchart TD\nA-->B'),
    'the rendered markdown block re-renders with the block-attribute source'
  );
});
