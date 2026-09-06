'use strict';

/* W6 theme bridge: palette CSS vars -> Monaco defineTheme('jenny') with
 * re-theme on data-palette mutations. The bridge is exercised against a fake
 * document/MutationObserver pair so every resolution path (plain hex vars,
 * rgba vars, probe-element fallback for color-mix) is deterministic. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  JENNY_MONACO_THEME,
  buildJennyMonacoTheme,
  createIdeThemeBridge,
  parseCssColor,
  toMonacoHex,
} = require('../renderer/features/renderer-ide-theme-bridge');

function buildFakeThemeEnv({ vars = {}, probeColor = '' } = {}) {
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
    }

    observe(target, options) {
      this.target = target;
      this.options = options;
      observers.push(this);
    }

    disconnect() {
      const index = observers.indexOf(this);
      if (index !== -1) {
        observers.splice(index, 1);
      }
    }
  }
  const probes = [];
  const documentRef = {
    documentElement: { dataset: { palette: 'signal' } },
    body: {
      appendChild() {},
    },
    createElement() {
      const probe = {
        style: {},
        removed: false,
        remove() {
          this.removed = true;
        },
      };
      probes.push(probe);
      return probe;
    },
    defaultView: {
      getComputedStyle(element) {
        if (element === documentRef.documentElement) {
          return { getPropertyValue: (name) => vars[name] || '' };
        }
        return { color: probeColor, getPropertyValue: () => '' };
      },
    },
  };
  return {
    documentRef,
    observers,
    probes,
    FakeMutationObserver,
    vars,
    notifyPaletteChange() {
      for (const observer of [...observers]) {
        observer.callback([], observer);
      }
    },
  };
}

function buildFakeMonaco({ throwOnDefine = false } = {}) {
  const calls = { defineTheme: [], setTheme: [] };
  return {
    calls,
    editor: {
      defineTheme(name, data) {
        if (throwOnDefine) {
          throw new Error('invalid theme data');
        }
        calls.defineTheme.push({ name, data });
      },
      setTheme(name) {
        calls.setTheme.push(name);
      },
    },
  };
}

const SIGNAL_VARS = {
  '--bg-base': '#071019',
  '--bg-surface': '#0f1926',
  '--bg-panel': '#101b29',
  '--text-primary': '#f4fbff',
  '--text-secondary': '#93b8c9',
  '--text-muted': '#5f8b9f',
  '--accent': '#29c0ff',
  '--line': 'rgba(65, 196, 255, 0.18)',
  '--text-danger-emphasis': '#ff9ea7',
  '--text-success-soft': '#d8fff0',
};

test('parseCssColor handles hex, rgb()/rgba(), color(srgb) and rejects junk', () => {
  assert.deepEqual(parseCssColor('#29c0ff'), { r: 41, g: 192, b: 255, a: 1 });
  assert.deepEqual(parseCssColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseCssColor('#ff000080').a.toFixed(2), '0.50');
  assert.deepEqual(parseCssColor('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30, a: 1 });
  assert.deepEqual(parseCssColor('rgba(65, 196, 255, 0.18)'), { r: 65, g: 196, b: 255, a: 0.18 });
  assert.deepEqual(parseCssColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseCssColor('color(srgb 0.5 0 0.5)'), { r: 128, g: 0, b: 128, a: 1 });
  assert.deepEqual(parseCssColor('color(srgb 1 0 0 / 0.25)'), { r: 255, g: 0, b: 0, a: 0.25 });
  assert.equal(parseCssColor(''), null);
  assert.equal(parseCssColor('color-mix(in srgb, red, blue)'), null);
  assert.equal(parseCssColor('var(--accent)'), null);
});

test('toMonacoHex emits #rrggbb / #rrggbbaa with alpha override support', () => {
  assert.equal(toMonacoHex({ r: 41, g: 192, b: 255, a: 1 }), '#29c0ff');
  assert.equal(toMonacoHex({ r: 41, g: 192, b: 255, a: 1 }, 0.3), '#29c0ff4d');
  // Source alpha is preserved when no override is given (rgba --line vars).
  assert.equal(toMonacoHex({ r: 65, g: 196, b: 255, a: 0.18 }), '#41c4ff2e');
  assert.equal(toMonacoHex(null), '');
});

test('buildJennyMonacoTheme maps resolved slots and detects light palettes', () => {
  const dark = buildJennyMonacoTheme({
    base: parseCssColor('#071019'),
    textPrimary: parseCssColor('#f4fbff'),
    accent: parseCssColor('#29c0ff'),
    danger: parseCssColor('#ff9ea7'),
    success: parseCssColor('#d8fff0'),
  });
  assert.equal(dark.base, 'vs-dark');
  assert.equal(dark.inherit, true);
  assert.deepEqual(dark.rules, []);
  assert.equal(dark.colors['editor.background'], '#071019');
  assert.equal(dark.colors['editor.foreground'], '#f4fbff');
  assert.equal(dark.colors['editor.selectionBackground'], '#29c0ff4d');
  assert.equal(dark.colors['editorCursor.foreground'], '#29c0ff');
  assert.equal(dark.colors['diffEditor.insertedTextBackground'], '#d8fff033');
  assert.equal(dark.colors['diffEditor.removedTextBackground'], '#ff9ea733');
  // Unresolved slots are skipped so Monaco inherits the base theme value.
  assert.equal('editorWidget.background' in dark.colors, false);
  assert.equal('editorLineNumber.foreground' in dark.colors, false);

  const light = buildJennyMonacoTheme({ base: parseCssColor('#f5f5f5') });
  assert.equal(light.base, 'vs');

  const empty = buildJennyMonacoTheme({});
  assert.equal(empty.base, 'vs-dark');
  assert.deepEqual(empty.colors, {});
});

test('buildJennyMonacoTheme emits syntax rules only when --syntax-* resolve', () => {
  const themed = buildJennyMonacoTheme({
    base: parseCssColor('#0c0e12'),
    syntaxKeyword: parseCssColor('#82a8ff'),
    syntaxString: parseCssColor('#9ece6a'),
    syntaxComment: parseCssColor('#6c7a93'),
    syntaxNumber: parseCssColor('#f6c177'),
    syntaxType: parseCssColor('#4ec9b0'),
    syntaxFunction: parseCssColor('#e0c879'),
    syntaxVariable: parseCssColor('#9cdcfe'),
    syntaxConstant: parseCssColor('#f78c6c'),
  });
  assert.equal(themed.base, 'vs-dark');
  // Bare RRGGBB (no '#'), comment italic, regexp reuses the string color.
  assert.deepEqual(themed.rules, [
    { token: 'comment', foreground: '6c7a93', fontStyle: 'italic' },
    { token: 'string', foreground: '9ece6a' },
    { token: 'regexp', foreground: '9ece6a' },
    { token: 'keyword', foreground: '82a8ff' },
    { token: 'number', foreground: 'f6c177' },
    { token: 'type', foreground: '4ec9b0' },
    { token: 'function', foreground: 'e0c879' },
    { token: 'variable', foreground: '9cdcfe' },
    { token: 'constant', foreground: 'f78c6c' },
  ]);

  // Palettes without syntax vars keep rules empty (Monaco inherits vs-dark).
  assert.deepEqual(buildJennyMonacoTheme({ base: parseCssColor('#0c0e12') }).rules, []);
  // Partial definitions only emit the resolved scopes.
  const partial = buildJennyMonacoTheme({ syntaxKeyword: parseCssColor('#82a8ff') });
  assert.deepEqual(partial.rules, [{ token: 'keyword', foreground: '82a8ff' }]);
});

test('theme bridge defines and applies jenny when Monaco is ready', (t) => {
  const env = buildFakeThemeEnv({ vars: { ...SIGNAL_VARS } });
  const monaco = buildFakeMonaco();
  const logs = [];
  const bridge = createIdeThemeBridge({
    documentRef: env.documentRef,
    mutationObserverCtor: env.FakeMutationObserver,
    appendClientLog: (level, event, details) => logs.push({ level, event, details }),
  });
  t.after(() => bridge.dispose());

  assert.equal(bridge.handleMonacoReady(monaco), true);
  assert.equal(monaco.calls.defineTheme.length, 1);
  assert.equal(monaco.calls.defineTheme[0].name, JENNY_MONACO_THEME);
  const data = monaco.calls.defineTheme[0].data;
  assert.equal(data.base, 'vs-dark');
  assert.equal(data.colors['editor.background'], '#071019');
  assert.equal(data.colors['editorLineNumber.foreground'], '#5f8b9f');
  assert.equal(data.colors['editorWidget.border'], '#41c4ff2e');
  assert.equal(data.colors['minimap.background'], '#071019');
  assert.deepEqual(monaco.calls.setTheme, ['jenny']);
  assert.equal(logs.at(-1).event, 'ide.theme_applied');
  assert.equal(logs.at(-1).details.palette, 'signal');

  // The observer watches :root data-palette only.
  assert.equal(env.observers.length, 1);
  assert.deepEqual(env.observers[0].options, {
    attributes: true,
    attributeFilter: ['data-palette'],
  });
});

test('theme bridge re-themes on palette mutations and dedupes no-op changes', (t) => {
  const env = buildFakeThemeEnv({ vars: { ...SIGNAL_VARS } });
  const monaco = buildFakeMonaco();
  const bridge = createIdeThemeBridge({
    documentRef: env.documentRef,
    mutationObserverCtor: env.FakeMutationObserver,
  });
  t.after(() => bridge.dispose());
  bridge.handleMonacoReady(monaco);
  assert.equal(monaco.calls.defineTheme.length, 1);

  // Attribute churn without color changes is deduped by signature.
  env.notifyPaletteChange();
  assert.equal(monaco.calls.defineTheme.length, 1);

  // A real palette swap redefines and re-applies.
  env.vars['--bg-base'] = '#f7f3ea';
  env.documentRef.documentElement.dataset.palette = 'paper';
  env.notifyPaletteChange();
  assert.equal(monaco.calls.defineTheme.length, 2);
  assert.equal(monaco.calls.defineTheme[1].data.base, 'vs');
  assert.equal(monaco.calls.defineTheme[1].data.colors['editor.background'], '#f7f3ea');
  assert.deepEqual(monaco.calls.setTheme, ['jenny', 'jenny']);

  // After dispose, mutations no longer reach Monaco.
  bridge.dispose();
  env.vars['--bg-base'] = '#000000';
  env.notifyPaletteChange();
  assert.equal(monaco.calls.defineTheme.length, 2);
  assert.equal(env.observers.length, 0);
});

test('theme bridge resolves color-mix style values through the probe element', (t) => {
  const vars = { ...SIGNAL_VARS, '--accent': 'color-mix(in srgb, red, blue)' };
  const env = buildFakeThemeEnv({ vars, probeColor: 'color(srgb 0.5 0 0.5)' });
  const monaco = buildFakeMonaco();
  const bridge = createIdeThemeBridge({
    documentRef: env.documentRef,
    mutationObserverCtor: env.FakeMutationObserver,
  });
  t.after(() => bridge.dispose());
  bridge.handleMonacoReady(monaco);

  const colors = monaco.calls.defineTheme[0].data.colors;
  assert.equal(colors['editorCursor.foreground'], '#800080');
  // The single probe is cleaned up after resolution.
  assert.equal(env.probes.length, 1);
  assert.equal(env.probes[0].removed, true);
});

test('theme bridge falls back to vs-dark when defineTheme rejects the data', (t) => {
  const env = buildFakeThemeEnv({ vars: { ...SIGNAL_VARS } });
  const monaco = buildFakeMonaco({ throwOnDefine: true });
  const logs = [];
  const bridge = createIdeThemeBridge({
    documentRef: env.documentRef,
    mutationObserverCtor: env.FakeMutationObserver,
    appendClientLog: (level, event) => logs.push({ level, event }),
  });
  t.after(() => bridge.dispose());

  assert.equal(bridge.handleMonacoReady(monaco), false);
  assert.deepEqual(monaco.calls.setTheme, ['vs-dark']);
  assert.ok(logs.some((entry) => entry.event === 'ide.theme_apply_failed'));
});

test('theme bridge is inert without Monaco or a document', () => {
  const bridge = createIdeThemeBridge({ documentRef: null });
  assert.equal(bridge.handleMonacoReady(null), false);
  assert.equal(bridge.applyTheme(), false);
  bridge.dispose();
});
