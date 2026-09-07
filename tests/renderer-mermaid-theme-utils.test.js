const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const themeUtils = require('../renderer/features/renderer-mermaid-theme-utils');
const { getPalettePresets } = require('../renderer/shared/appearance-utils');

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

/* WCAG 2.x relative-luminance contrast, reusing the module's own channel
 * math contract (solid 6-digit hex in, ratio out). */
function hexLuminance(hex) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
  assert.ok(match, `expected solid 6-digit hex, got: ${hex}`);
  const channel = (raw) => {
    const c = parseInt(raw, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return (0.2126 * channel(match[1])) + (0.7152 * channel(match[2])) + (0.0722 * channel(match[3]));
}

function wcagContrast(hexA, hexB) {
  const la = hexLuminance(hexA);
  const lb = hexLuminance(hexB);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* Live palette tokens (styles/palette-*.css + foundation.css for midnight),
 * WITHOUT the retired --mermaid-node-label-* declarations: the WS1 spec
 * formulas are what these fixtures exercise. */
const PALETTE_FIXTURES = [
  {
    paletteId: 'midnight',
    mode: 'dark',
    tokens: {
      '--bg-surface': '#171a27',
      '--surface-input-background': 'rgba(14, 16, 24, 0.92)',
      '--bg-panel': '#181b28',
      '--surface-input-background-strong': 'rgba(11, 13, 20, 0.78)',
      '--text-primary': '#f3f4fc',
      '--accent': '#6d82ff',
      '--accent-cyan': '#16e9ff',
      '--border-default': 'rgba(112, 118, 147, 0.14)',
      color: '#f3f4fc',
    },
  },
  {
    paletteId: 'pewter',
    mode: 'dark',
    tokens: {
      '--bg-surface': '#171a20',
      '--surface-input-background': 'rgba(10, 12, 16, 0.92)',
      '--bg-panel': '#15181f',
      '--surface-input-background-strong': 'rgba(8, 10, 13, 0.78)',
      '--text-primary': '#eef1f7',
      '--accent': '#6a809f',
      '--accent-cyan': '#22e0ff',
      '--border-default': 'rgba(150, 166, 196, 0.14)',
      color: '#eef1f7',
    },
  },
  {
    paletteId: 'obsidian',
    mode: 'dark',
    tokens: {
      '--bg-surface': '#16161a',
      '--surface-input-background': 'rgba(11, 11, 14, 0.92)',
      '--bg-panel': '#0e0e11',
      '--surface-input-background-strong': 'rgba(8, 8, 10, 0.78)',
      '--text-primary': '#f6f6f7',
      '--accent': '#1bd6ff',
      '--accent-cyan': '#3df0ff',
      '--border-default': 'rgba(168, 168, 176, 0.14)',
      color: '#f6f6f7',
    },
  },
  {
    paletteId: 'darkroom',
    mode: 'dark',
    tokens: {
      '--bg-surface': '#201f23',
      '--surface-input-background': 'rgba(19, 18, 21, 0.92)',
      '--bg-panel': '#121113',
      '--surface-input-background-strong': 'rgba(14, 13, 16, 0.78)',
      '--text-primary': '#f0efea',
      '--accent': '#9c8fbe',
      '--accent-cyan': '#9c8fbe',
      '--border-default': 'rgba(176, 172, 184, 0.14)',
      color: '#f0efea',
    },
  },
  {
    paletteId: 'slate',
    mode: 'dark',
    tokens: {
      '--bg-surface': '#1c2025',
      '--surface-input-background': '#1a1e22',
      '--bg-panel': '#121519',
      '--surface-input-background-strong': '#14171b',
      '--text-primary': '#f6f7f9',
      '--accent': '#7fb6dd',
      '--accent-cyan': '#86c3e4',
      '--border-default': 'rgba(168, 176, 188, 0.14)',
      color: '#f6f7f9',
    },
  },
  {
    paletteId: 'lexicon',
    mode: 'dark',
    tokens: {
      '--bg-surface': '#171319',
      '--surface-input-background': 'rgba(17, 13, 17, 0.92)',
      '--bg-panel': '#18131a',
      '--surface-input-background-strong': 'rgba(14, 11, 15, 0.9)',
      '--text-primary': '#f3ede4',
      '--accent': '#c88f52',
      '--accent-cyan': '#a6b8cf',
      '--border-default': 'rgba(112, 118, 147, 0.14)',
      color: '#f3ede4',
    },
  },
  {
    paletteId: 'rocko',
    mode: 'dark',
    tokens: {
      '--bg-surface': '#112824',
      '--surface-input-background': 'rgba(10, 24, 22, 0.92)',
      '--bg-panel': '#142c28',
      '--surface-input-background-strong': 'rgba(8, 18, 16, 0.78)',
      '--text-primary': '#f0e4cc',
      '--accent': '#e8641a',
      '--accent-cyan': '#3dbfab',
      '--border-default': 'rgba(61, 191, 171, 0.13)',
      color: '#f0e4cc',
    },
  },
  {
    paletteId: 'signal',
    mode: 'dark',
    tokens: {
      '--bg-surface': '#0f1926',
      '--surface-input-background': 'rgba(7, 17, 28, 0.92)',
      '--bg-panel': '#101b29',
      '--surface-input-background-strong': 'rgba(5, 12, 20, 0.88)',
      '--text-primary': '#f4fbff',
      '--accent': '#29c0ff',
      '--accent-cyan': '#12d9ff',
      '--border-default': 'rgba(65, 196, 255, 0.16)',
      color: '#f4fbff',
    },
  },
  {
    paletteId: 'jenny-night',
    mode: 'dark',
    tokens: {
      '--bg-surface': '#142655',
      '--surface-input-background': 'rgba(10, 18, 48, 0.92)',
      '--bg-panel': '#182d62',
      '--surface-input-background-strong': 'rgba(8, 14, 36, 0.78)',
      '--text-primary': '#f0e8ff',
      '--accent': '#ff3d8e',
      '--accent-cyan': '#29c0ff',
      '--border-default': 'rgba(255, 90, 160, 0.14)',
      color: '#f0e8ff',
    },
  },
  {
    paletteId: 'paper',
    mode: 'light',
    tokens: {
      '--bg-surface': '#f6f2eb',
      '--surface-input-background': 'rgba(255, 255, 255, 0.9)',
      '--bg-panel': '#f7f3ec',
      '--surface-input-background-strong': 'rgba(250, 247, 242, 0.92)',
      '--text-primary': '#1f2635',
      '--accent': '#3568f0',
      '--accent-cyan': '#157ec7',
      '--border-default': 'rgba(82, 91, 118, 0.14)',
      color: '#1f2635',
    },
  },
  {
    paletteId: 'woolly',
    mode: 'light',
    tokens: {
      '--bg-surface': '#f5efe4',
      '--surface-input-background': 'rgba(255, 253, 248, 0.9)',
      '--bg-panel': '#f2ebe0',
      '--surface-input-background-strong': 'rgba(248, 242, 232, 0.92)',
      '--text-primary': '#2c2417',
      '--accent': '#3d8c2a',
      '--accent-cyan': '#3888cc',
      '--border-default': 'rgba(128, 112, 88, 0.14)',
      color: '#2c2417',
    },
  },
  {
    paletteId: 'jenny-day',
    mode: 'light',
    tokens: {
      '--bg-surface': '#e6eef0',
      '--surface-input-background': 'rgba(248, 252, 253, 0.92)',
      '--bg-panel': '#ecf2f4',
      '--surface-input-background-strong': 'rgba(238, 246, 248, 0.94)',
      '--text-primary': '#0a2329',
      '--accent': '#4fa9b0',
      '--accent-cyan': '#5fc6cd',
      '--border-default': 'rgba(10, 35, 41, 0.18)',
      color: '#0a2329',
    },
  },
];

test('PALETTE_FIXTURES covers every palette the app actually registers', () => {
  // Two tests below claim to run "on every registered palette", but the list
  // they iterate is this hand-written fixture array. It had drifted: slate
  // shipped and was never added, so the contrast and edgeStyles gates silently
  // skipped it. Derive the expectation from production so the next palette
  // cannot be added without its fixture.
  const registered = getPalettePresets().map((preset) => preset.id);
  const covered = PALETTE_FIXTURES.map((fixture) => fixture.paletteId);
  assert.deepEqual(
    registered.filter((id) => !covered.includes(id)),
    [],
    'every registered palette needs a PALETTE_FIXTURES entry'
  );
  assert.deepEqual(
    covered.filter((id) => !registered.includes(id)),
    [],
    'PALETTE_FIXTURES must not pin a palette the app no longer registers'
  );
});

test('getMermaidPaletteMode: light set is exactly {paper, woolly, jenny-day}; other registered palettes are dark', () => {
  for (const paletteId of ['paper', 'woolly', 'jenny-day']) {
    assert.equal(
      themeUtils.getMermaidPaletteMode({ dataset: { palette: paletteId } }, {}),
      'light',
      `${paletteId} should classify light without needing a computed colorScheme`
    );
  }
  // signal declares color-scheme: dark — it must classify dark both with the
  // computed value present and with the vacuous jsdom computed style.
  assert.equal(themeUtils.getMermaidPaletteMode({ dataset: { palette: 'signal' } }, { colorScheme: 'dark' }), 'dark');
  assert.equal(themeUtils.getMermaidPaletteMode({ dataset: { palette: 'signal' } }, {}), 'dark');
  for (const paletteId of ['midnight', 'pewter', 'obsidian', 'darkroom', 'lexicon', 'rocko', 'jenny-night']) {
    assert.equal(
      themeUtils.getMermaidPaletteMode({ dataset: { palette: paletteId } }, { colorScheme: 'dark' }),
      'dark',
      `${paletteId} should classify dark`
    );
  }
});

test('getMermaidPaletteMode: unknown palettes fall back to the computed colorScheme, defaulting dark', () => {
  assert.equal(themeUtils.getMermaidPaletteMode({ dataset: { palette: 'some-future-palette' } }, { colorScheme: 'light' }), 'light');
  assert.equal(themeUtils.getMermaidPaletteMode({ dataset: { palette: 'some-future-palette' } }, { colorScheme: 'dark' }), 'dark');
  assert.equal(themeUtils.getMermaidPaletteMode({ dataset: { palette: 'some-future-palette' } }, { colorScheme: 'light dark' }), 'dark');
  assert.equal(themeUtils.getMermaidPaletteMode({ dataset: { palette: 'some-future-palette' } }, {}), 'dark');
  assert.equal(themeUtils.getMermaidPaletteMode({ dataset: {} }, {}), 'dark');
});

test('buildThemeConfig meets the WS1 contrast gates on every registered palette (Option A formulas)', (t) => {
  for (const fixture of PALETTE_FIXTURES) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true });
    installDomGlobals(dom, t);
    installPaletteTokens(dom, fixture.paletteId, fixture.tokens);

    const theme = themeUtils.buildThemeConfig();
    const vars = theme.config.themeVariables;

    assert.equal(
      theme.config.darkMode,
      fixture.mode === 'dark',
      `${fixture.paletteId}: expected ${fixture.mode} classification`
    );
    for (const [name, value] of Object.entries(vars)) {
      if (name === 'fontSize' || name === 'fontFamily') continue;
      assert.match(value, /^#[0-9a-f]{6}$/i, `${fixture.paletteId} ${name} should be solid hex: ${value}`);
    }
    const crText = wcagContrast(vars.primaryTextColor, vars.primaryColor);
    assert.ok(
      crText >= 4.5,
      `${fixture.paletteId}: node text contrast ${crText.toFixed(2)} must be >= 4.5 (text ${vars.primaryTextColor} on fill ${vars.primaryColor})`
    );
    const crLine = wcagContrast(vars.lineColor, vars.background);
    assert.ok(
      crLine >= 3.0,
      `${fixture.paletteId}: edge line contrast ${crLine.toFixed(2)} must be >= 3.0 (line ${vars.lineColor} on ${vars.background})`
    );
    // Edge labels sit on the strong surface card, not the diagram background.
    assert.notEqual(vars.edgeLabelBackground, vars.background, `${fixture.paletteId}: edgeLabelBackground must be surfaceCard, not background`);
  }
});

test('buildThemeConfig darkens the light-palette line accent instead of using the raw accent', (t) => {
  const paper = PALETTE_FIXTURES.find((fixture) => fixture.paletteId === 'paper');
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true });
  installDomGlobals(dom, t);
  installPaletteTokens(dom, 'paper', paper.tokens);

  const theme = themeUtils.buildThemeConfig();
  const vars = theme.config.themeVariables;
  const naiveRawAccentLine = themeUtils.blendHexColors(vars.background, paper.tokens['--accent'], 0.85);

  assert.notEqual(
    vars.lineColor.toLowerCase(),
    String(naiveRawAccentLine).toLowerCase(),
    'paper lineColor must come from the text-darkened accent, not the raw accent blend'
  );
});

test('WS1 container CSS: no white literal remains in the .tool-mermaid-preview rules', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-tools.css'), 'utf8');
  const ruleBlocks = css.match(/\.tool-mermaid-preview[^{]*\{[^}]*\}/g) || [];
  assert.ok(ruleBlocks.length >= 1, 'expected .tool-mermaid-preview rules in styles/chat-tools.css');
  for (const block of ruleBlocks) {
    assert.doesNotMatch(block, /\bwhite\b/i, `.tool-mermaid-preview rule must be palette-derived, found a white literal:\n${block}`);
  }
});

test('buildThemeConfig exposes edgeStyles (lineColor/clusterFill/clusterBorder) as solid hex on every registered palette', (t) => {
  for (const fixture of PALETTE_FIXTURES) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true });
    installDomGlobals(dom, t);
    installPaletteTokens(dom, fixture.paletteId, fixture.tokens);

    const theme = themeUtils.buildThemeConfig();

    assert.ok(theme.edgeStyles, `${fixture.paletteId}: expected an edgeStyles object`);
    assert.match(theme.edgeStyles.lineColor, /^#[0-9a-f]{6}$/i, `${fixture.paletteId} edgeStyles.lineColor should be solid hex`);
    assert.match(theme.edgeStyles.clusterFill, /^#[0-9a-f]{6}$/i, `${fixture.paletteId} edgeStyles.clusterFill should be solid hex`);
    assert.match(theme.edgeStyles.clusterBorder, /^#[0-9a-f]{6}$/i, `${fixture.paletteId} edgeStyles.clusterBorder should be solid hex`);
    // Reuses the same computed values already in themeVariables — not a
    // second, independently-drifting color formula.
    assert.equal(theme.edgeStyles.lineColor, theme.config.themeVariables.lineColor);
    assert.equal(theme.edgeStyles.clusterFill, theme.config.themeVariables.clusterBkg);
    assert.equal(theme.edgeStyles.clusterBorder, theme.config.themeVariables.clusterBorder);
  }
});

test('normalizeMermaidLabelContainers bakes the node fill onto every label-container shape Mermaid 11 emits', () => {
  const { JSDOM: LocalJSDOM } = require('jsdom');
  const dom = new LocalJSDOM('<!doctype html><html><body></body></html>');
  const doc = dom.window.document;
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.innerHTML = [
    '<g class="node default"><rect class="basic label-container" x="0" y="0" width="10" height="10"></rect></g>',
    '<g class="node default"><polygon class="label-container" points="0,0 10,0 5,10"></polygon></g>',
    // Cylinder ([(db)]) and stadium shapes are paths; circles are circles.
    '<g class="node default"><path class="basic label-container outer-path" d="M0 0 L10 10"></path></g>',
    '<g class="node default"><circle class="basic label-container" r="5"></circle></g>',
    '<g class="node default"><path class="edge-thickness-normal flowchart-link" d="M0 0 L20 20"></path></g>',
  ].join('');
  doc.body.appendChild(svg);

  themeUtils.normalizeMermaidLabelContainers(svg, {
    containerFill: '#e6eaf3',
    containerStroke: '#7c9bee',
    textColor: '#1f2635',
  });

  for (const shape of svg.querySelectorAll('.label-container')) {
    assert.equal(shape.getAttribute('fill'), '#e6eaf3', `${shape.tagName} label container gets the node fill`);
    assert.equal(shape.getAttribute('stroke'), '#7c9bee', `${shape.tagName} label container gets the node stroke`);
  }
  assert.equal(svg.querySelector('.flowchart-link').getAttribute('fill'), null, 'edges are not label containers');
});

test('normalizeMermaidEdgeAndClusterColors bakes palette colors onto unstyled edges, markers, and cluster backgrounds', () => {
  const { JSDOM: LocalJSDOM } = require('jsdom');
  const dom = new LocalJSDOM('<!doctype html><html><body></body></html>');
  const doc = dom.window.document;
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.innerHTML = [
    '<defs>',
    '  <marker id="m-pointEnd" class="marker flowchart-v2"><path class="arrowMarkerPath" d="M 0 0 L 10 5 L 0 10 z"></path></marker>',
    '  <marker id="m-lollipopEnd" class="marker lollipop"><circle fill="transparent" cx="7" cy="7" r="6"></circle></marker>',
    '</defs>',
    '<path class="edge-thickness-normal edge-pattern-solid flowchart-link" marker-end="url(#m-pointEnd)" d="M0 0 L10 10"></path>',
    '<path class="edge-thickness-normal edge-pattern-solid flowchart-link" marker-end="url(#m-lollipopEnd)" stroke="#ff0000" d="M0 0 L20 20"></path>',
    '<g class="cluster"><rect x="0" y="0" width="10" height="10"></rect></g>',
    '<g class="cluster"><rect x="0" y="0" width="10" height="10" fill="#123456"></rect></g>',
  ].join('');
  doc.body.appendChild(svg);

  themeUtils.normalizeMermaidEdgeAndClusterColors(svg, {
    lineColor: '#123abc',
    clusterFill: '#0a0a0a',
    clusterBorder: '#0b0b0b',
  });

  const edges = svg.querySelectorAll('path.flowchart-link');
  assert.equal(edges[0].getAttribute('fill'), 'none', 'default edge path should get fill:none');
  assert.equal(edges[0].getAttribute('stroke'), '#123abc', 'default edge path should get the theme lineColor stroke');
  // A pre-existing stroke (custom linkStyle) must not be clobbered.
  assert.equal(edges[1].getAttribute('stroke'), '#ff0000', 'edge with an existing stroke attribute must be left alone');

  const arrowPath = svg.querySelector('#m-pointEnd path');
  assert.equal(arrowPath.getAttribute('fill'), '#123abc', 'unfilled marker path should get the theme lineColor fill');
  assert.equal(arrowPath.getAttribute('stroke'), '#123abc', 'unfilled marker path should get the theme lineColor stroke');

  const lollipopCircle = svg.querySelector('#m-lollipopEnd circle');
  assert.equal(lollipopCircle.getAttribute('fill'), 'transparent', 'an intentionally transparent marker shape must not be recolored');

  const clusterRects = svg.querySelectorAll('.cluster rect');
  assert.equal(clusterRects[0].getAttribute('fill'), '#0a0a0a', 'unstyled cluster background should get the theme clusterFill');
  assert.equal(clusterRects[0].getAttribute('stroke'), '#0b0b0b', 'unstyled cluster background should get the theme clusterBorder');
  assert.equal(clusterRects[1].getAttribute('fill'), '#123456', 'a cluster rect with a pre-existing fill attribute must be left alone');
});

test('normalizeMermaidEdgeAndClusterColors is a no-op when svgRoot or edgeStyles is missing, or colors are not simple hex', () => {
  const { JSDOM: LocalJSDOM } = require('jsdom');
  const dom = new LocalJSDOM('<!doctype html><html><body></body></html>');
  const doc = dom.window.document;
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.innerHTML = '<path class="flowchart-link" d="M0 0 L10 10"></path>';
  doc.body.appendChild(svg);

  assert.doesNotThrow(() => themeUtils.normalizeMermaidEdgeAndClusterColors(null, { lineColor: '#123abc' }));
  assert.doesNotThrow(() => themeUtils.normalizeMermaidEdgeAndClusterColors(svg, null));

  themeUtils.normalizeMermaidEdgeAndClusterColors(svg, { lineColor: 'not-a-color', clusterFill: '', clusterBorder: '' });
  const edge = svg.querySelector('path.flowchart-link');
  assert.equal(edge.getAttribute('fill'), null, 'an unsafe/empty color must never be baked in');
  assert.equal(edge.getAttribute('stroke'), null);
});

test('buildThemeConfig scales fontSize from --chat-zoom-factor, clamps 11-20px, and folds the factor into the cache key', (t) => {
  const midnight = PALETTE_FIXTURES.find((fixture) => fixture.paletteId === 'midnight');
  const cases = [
    { zoom: null, fontSize: '13px' },
    { zoom: '1.4', fontSize: '18px' },
    { zoom: '2.5', fontSize: '20px' },
    { zoom: '0.5', fontSize: '11px' },
  ];
  const keys = new Set();
  for (const item of cases) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true });
    installDomGlobals(dom, t);
    const tokens = { ...midnight.tokens };
    if (item.zoom != null) {
      tokens['--chat-zoom-factor'] = item.zoom;
    }
    installPaletteTokens(dom, 'midnight', tokens);

    const theme = themeUtils.buildThemeConfig();

    assert.equal(
      theme.config.themeVariables.fontSize,
      item.fontSize,
      `zoom ${item.zoom == null ? '(unset)' : item.zoom} should yield ${item.fontSize}`
    );
    keys.add(theme.key);
  }
  assert.equal(keys.size, cases.length, 'each distinct zoom factor must produce a distinct theme cache key');
});
