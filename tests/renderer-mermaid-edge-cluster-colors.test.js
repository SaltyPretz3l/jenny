const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

/* Sibling of renderer-mermaid-utils.test.js (split out to stay under the
 * repo's 1015-line file-size cap): the renderMermaidDirect integration case
 * for Wave-R R4 defect #5 (mermaid palette contrast). See
 * renderer-mermaid-theme-utils.test.js for the underlying unit tests on
 * normalizeMermaidEdgeAndClusterColors / buildThemeConfig.edgeStyles. */

function loadRendererMermaidUtils() {
  const loaderPath = require.resolve('../renderer/features/renderer-mermaid-runtime-loader');
  delete require.cache[loaderPath];
  const modulePath = require.resolve('../renderer/features/renderer-mermaid-utils');
  delete require.cache[modulePath];
  return require('../renderer/features/renderer-mermaid-utils');
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

function installPaletteTokens(dom, paletteId, tokenMap) {
  dom.window.document.documentElement.dataset.palette = paletteId;
  const style = dom.window.document.createElement('style');
  style.textContent = ':root {' + Object.entries(tokenMap).map(([token, value]) => `${token}: ${value};`).join(' ') + '}';
  dom.window.document.head.appendChild(style);
  return style;
}

test('renderMermaidDirect bakes theme colors onto unstyled edges, arrowhead markers, and cluster backgrounds', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  installDomGlobals(dom, t);
  installPaletteTokens(dom, 'midnight', {
    '--bg-surface': '#171a27',
    '--surface-input-background': '#101724',
    '--bg-panel': '#181b28',
    '--surface-input-background-strong': '#141d2b',
    '--text-primary': '#f3f4fc',
    '--accent': '#6d82ff',
    '--accent-cyan': '#16e9ff',
    '--border-default': '#2a3a50',
    color: '#f3f4fc',
  });
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');

  // Mirrors real mermaid.render() output for a plain (unstyled) flowchart
  // edge, AFTER DOMPurify's FORBID_TAGS has stripped mermaid's injected
  // <style> block (the production sanitizeMermaidSvgMarkup contract) — no
  // fill/stroke attributes on the edge path, the arrowhead marker path, or
  // the cluster rect, matching the bug's real starting state.
  dom.window.mermaid = {
    initialize() {},
    async render() {
      return {
        svg: [
          '<svg viewBox="0 0 100 100">',
          '<defs><marker id="flowchart-pointEnd"><path class="arrowMarkerPath" d="M 0 0 L 10 5 L 0 10 z"></path></marker></defs>',
          '<g class="cluster"><rect x="0" y="0" width="40" height="40"></rect></g>',
          '<path class="edge-thickness-normal edge-pattern-solid flowchart-link" marker-end="url(#flowchart-pointEnd)" d="M0 0 L40 40"></path>',
          '</svg>',
        ].join(''),
      };
    },
  };

  await mermaidUtils.renderMermaidDirect(host, 'flowchart TD\nA-->B');

  const edgePath = host.querySelector('path.flowchart-link');
  assert.equal(edgePath.getAttribute('fill'), 'none', 'edge path must render as an open line, not a filled blob');
  assert.match(edgePath.getAttribute('stroke'), /^#[0-9a-f]{6}$/i, 'edge path must get a solid theme stroke color');
  assert.notEqual(edgePath.getAttribute('stroke'), '#000000', 'edge stroke must not default to black');

  const arrowPath = host.querySelector('marker path.arrowMarkerPath');
  assert.match(arrowPath.getAttribute('fill'), /^#[0-9a-f]{6}$/i, 'arrowhead marker must get a solid theme fill color');

  const clusterRect = host.querySelector('.cluster rect');
  assert.match(clusterRect.getAttribute('fill'), /^#[0-9a-f]{6}$/i, 'subgraph/cluster background must get a solid theme fill color');
  assert.notEqual(clusterRect.getAttribute('fill'), '#000000', 'cluster background must not default to a black slab');
});

test('renderMermaidDirect leaves a custom linkStyle edge stroke untouched (no clobbering user styling)', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  installDomGlobals(dom, t);
  installPaletteTokens(dom, 'paper', {
    '--bg-surface': '#f6f2eb',
    '--surface-input-background': 'rgba(255, 255, 255, 0.9)',
    '--bg-panel': '#f7f3ec',
    '--surface-input-background-strong': 'rgba(250, 247, 242, 0.92)',
    '--text-primary': '#1f2635',
    '--accent': '#3568f0',
    '--accent-cyan': '#157ec7',
    '--border-default': 'rgba(82, 91, 118, 0.14)',
    color: '#1f2635',
  });
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');

  dom.window.mermaid = {
    initialize() {},
    async render() {
      return {
        svg: [
          '<svg viewBox="0 0 100 100">',
          '<path class="edge-thickness-normal edge-pattern-solid flowchart-link" style="stroke:#ff00ff;fill:none;" d="M0 0 L40 40"></path>',
          '</svg>',
        ].join(''),
      };
    },
  };

  await mermaidUtils.renderMermaidDirect(host, 'flowchart TD\nA-->|custom| B');

  const edgePath = host.querySelector('path.flowchart-link');
  // No plain `fill`/`stroke` attribute is added when a style attribute
  // already carries real content — the inline style always wins the CSS
  // cascade over a bare presentation attribute, so leaving it alone (rather
  // than setting a conflicting attribute) is the correct, non-interfering
  // behavior either way.
  assert.equal(edgePath.getAttribute('style'), 'stroke:#ff00ff;fill:none;');
});
