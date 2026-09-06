const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  getSurfaceEffectPresets,
  getDefaultAppearancePreferences,
  getPalettePresets,
} = require('../renderer/shared/appearance-utils.js');

const surfaceEffectRuntime = require('../renderer/shell/renderer-surface-effect-runtime.js');

const ROOT = path.join(__dirname, '..');
const STYLES_DIR = path.join(ROOT, 'styles');
const APP_JS_PATH = path.join(ROOT, 'renderer', 'app.js');
const MOTION_STYLE_PATHS = [
  path.join(STYLES_DIR, 'foundation.css'),
  path.join(STYLES_DIR, 'views-surface-effects.css'),
];

// Effect id -> real controller module + factory export name (Background Effects v3
// Rev 2 registry, S2 slice B2). Kept in literal-table form (not derived from the
// registry itself) so the test can never trivially agree with a typo'd registry entry.
const EFFECT_MODULE_TABLE = {
  'reactive-grid': {
    modulePath: '../renderer/shell/renderer-reactive-grid-utils.js',
    exportName: 'createReactiveGridController',
  },
  'playlist-scroll': {
    modulePath: '../renderer/shell/renderer-playlist-scroll-utils.js',
    exportName: 'createPlaylistScrollController',
  },
  'atomic-burst': {
    modulePath: '../renderer/shell/renderer-atomic-burst-utils.js',
    exportName: 'createAtomicBurstController',
  },
  'circuit-trace': {
    modulePath: '../renderer/shell/renderer-circuit-trace-utils.js',
    exportName: 'createCircuitTraceController',
  },
  'context-weave': {
    modulePath: '../renderer/shell/renderer-context-weave-utils.js',
    exportName: 'createContextWeaveController',
  },
};

// Pre-existing naming inconsistency (not introduced by this slice): every other
// canvas/svg effect module reads its per-effect CSS custom properties under the
// `--widget-<effect>-*` namespace, but renderer-playlist-scroll-utils.js reads
// `--playlist-scroll-*` (no `widget-` segment) -- verified by grepping every
// getStyleValue(style, '--...') call site in that module. requiredTokens records
// the real token names each module reads, so the exception is honored here rather
// than silently mismatching the source of truth.
const TOKEN_PREFIX_EXCEPTIONS = {
  'playlist-scroll': '--playlist-scroll-',
};

function expectedTokenPrefix(presetId) {
  return TOKEN_PREFIX_EXCEPTIONS[presetId] || '--widget-';
}

function readStylesBlob() {
  return fs
    .readdirSync(STYLES_DIR)
    .filter((name) => name.endsWith('.css'))
    .map((name) => fs.readFileSync(path.join(STYLES_DIR, name), 'utf8'))
    .join('\n');
}

// Parse balanced CSS blocks, then inspect selectors rather than counting raw
// text hits. This avoids comments, declarations, and non-motion rules
// accidentally satisfying the S6 motion-axis coverage gate.
function parseCssBlocks(source) {
  const css = String(source || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [];
  const stack = [];
  let segmentStart = 0;
  for (let index = 0; index < css.length; index += 1) {
    if (css[index] === '{') {
      stack.push({ prelude: css.slice(segmentStart, index).trim(), bodyStart: index + 1 });
      segmentStart = index + 1;
    } else if (css[index] === '}') {
      const open = stack.pop();
      if (open) blocks.push({ prelude: open.prelude, body: css.slice(open.bodyStart, index) });
      segmentStart = index + 1;
    }
  }
  assert.equal(stack.length, 0, 'motion CSS parser should finish with balanced braces');
  return blocks;
}

function getMotionCoveredEffectIds() {
  const covered = new Set();
  const effectSelector = /\[data-widget-modifier\s*~=\s*(["'])([^"']+)\1\]/g;
  MOTION_STYLE_PATHS.forEach((filePath) => {
    parseCssBlocks(fs.readFileSync(filePath, 'utf8')).forEach(({ prelude }) => {
      if (!/\[data-motion\s*=/.test(prelude)) return;
      effectSelector.lastIndex = 0;
      let match = effectSelector.exec(prelude);
      while (match) {
        covered.add(match[2]);
        match = effectSelector.exec(prelude);
      }
    });
  });
  return covered;
}

// Balanced-brace walk for the `factories: {...}` object literal inside the
// createSurfaceEffectManager({...}) call in renderer/app.js. Mirrors the
// extractControllerCompositionCtxKeys pattern in tests/renderer-app-split.test.js.
function extractSurfaceEffectFactoryKeys(appSource) {
  const anchorIndex = appSource.indexOf('createSurfaceEffectManager(');
  if (anchorIndex === -1) return null;
  const factoriesIndex = appSource.indexOf('factories: {', anchorIndex);
  if (factoriesIndex === -1) return null;
  const openBrace = appSource.indexOf('{', factoriesIndex);
  let depth = 0;
  let endBrace = -1;
  for (let i = openBrace; i < appSource.length; i += 1) {
    const ch = appSource[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        endBrace = i;
        break;
      }
    }
  }
  if (endBrace === -1) return null;
  const body = appSource.slice(openBrace + 1, endBrace);
  const keys = new Set();
  const keyPattern = /'([^']+)'\s*:/g;
  let match = keyPattern.exec(body);
  while (match !== null) {
    keys.add(match[1]);
    match = keyPattern.exec(body);
  }
  return keys;
}

function getNonNonePresets() {
  return getSurfaceEffectPresets().filter((preset) => preset.id !== 'none');
}

// Forces a strict-mode assignment to a (possibly frozen) object property so the
// TypeError from writing to a frozen object is guaranteed regardless of whether
// this test module itself runs in sloppy mode.
function strictAssign(target, key, value) {
  'use strict';

  target[key] = value;
}

test('the "none" preset is untouched by the Rev 2 registry metadata', () => {
  const none = getSurfaceEffectPresets().find((preset) => preset.id === 'none');
  assert.ok(none, 'none preset should exist');
  assert.deepEqual(Object.keys(none).sort(), ['description', 'id', 'label'].sort());
});

test('every non-none surface-effect preset declares full Rev 2 registry metadata', () => {
  const presets = getNonNonePresets();
  assert.equal(presets.length, 5, 'expected exactly five non-none surface-effect presets');


  presets.forEach((preset) => {
    assert.ok([2, 3].includes(preset.contractVersion), `${preset.id}.contractVersion should be 2 or 3`);
    assert.ok(
      ['legacy-host', 'manager'].includes(preset.inputMode),
      `${preset.id}.inputMode should be legacy-host or manager`
    );
    assert.ok(
      ['none', 'native'].includes(preset.activityMode),
      `${preset.id}.activityMode should be none or native`
    );
    assert.ok(
      ['canvas2d', 'svg'].includes(preset.renderer),
      `${preset.id}.renderer should be canvas2d or svg`
    );

    assert.equal(typeof preset.interaction, 'object', `${preset.id}.interaction should be an object`);
    assert.ok(preset.interaction, `${preset.id}.interaction should not be null`);
    assert.deepEqual(
      Object.keys(preset.interaction).sort(),
      ['captureOnPress', 'click', 'hover', 'press'].sort(),
      `${preset.id}.interaction should declare exactly hover/click/press/captureOnPress`
    );
    ['hover', 'click', 'press', 'captureOnPress'].forEach((key) => {
      assert.equal(
        typeof preset.interaction[key],
        'boolean',
        `${preset.id}.interaction.${key} should be a boolean`
      );
    });

    assert.ok(
      ['low', 'medium', 'high'].includes(preset.costClass),
      `${preset.id}.costClass should be low, medium, or high`
    );

    assert.ok(
      preset.paletteSupport === 'all'
        || (Array.isArray(preset.paletteSupport) && preset.paletteSupport.length > 0),
      `${preset.id}.paletteSupport should be 'all' or a non-empty array`
    );

    assert.ok(Array.isArray(preset.requiredTokens), `${preset.id}.requiredTokens should be an array`);
    assert.ok(preset.requiredTokens.length > 0, `${preset.id}.requiredTokens should be non-empty`);
    const expectedPrefix = expectedTokenPrefix(preset.id);
    preset.requiredTokens.forEach((token) => {
      assert.equal(typeof token, 'string', `${preset.id} requiredTokens entries should be strings`);
      assert.ok(
        token.startsWith(expectedPrefix),
        `${preset.id} token "${token}" should start with "${expectedPrefix}"`
      );
    });

    assert.ok(Array.isArray(preset.recommendedPalettes), `${preset.id}.recommendedPalettes should be an array`);

    assert.equal(
      typeof preset.freshInstallCandidate,
      'boolean',
      `${preset.id}.freshInstallCandidate should be a boolean`
    );
  });
});

test('S9 native migration roster contains all five shipped effects', () => {
  const nativeIds = getNonNonePresets()
    .filter((preset) => preset.contractVersion === 3
      && preset.inputMode === 'manager'
      && preset.activityMode === 'native')
    .map((preset) => preset.id)
    .sort();
  assert.deepEqual(nativeIds, [
    'atomic-burst', 'circuit-trace', 'context-weave', 'playlist-scroll', 'reactive-grid',
  ]);

  const reactiveGrid = getNonNonePresets().find((preset) => preset.id === 'reactive-grid');
  assert.deepEqual(reactiveGrid.interaction, {
    hover: true, click: true, press: false, captureOnPress: false,
  });
  const atomicBurst = getNonNonePresets().find((preset) => preset.id === 'atomic-burst');
  assert.deepEqual(atomicBurst.interaction, {
    hover: true, click: true, press: false, captureOnPress: false,
  });
  const playlistScroll = getNonNonePresets().find((preset) => preset.id === 'playlist-scroll');
  assert.deepEqual(playlistScroll.interaction, {
    hover: true, click: true, press: true, captureOnPress: true,
  });
  // D5 (2026-08-21): the weave answers the pointer with alpha only, so it
  // declares no press/capture -- there is no fabric left to gather inward.
  const contextWeave = getNonNonePresets().find((preset) => preset.id === 'context-weave');
  assert.deepEqual(contextWeave.interaction, {
    hover: true, click: true, press: false, captureOnPress: false,
  });
});

test('parsed motion CSS covers every registered effect id in a data-motion selector', () => {
  const expectedIds = getNonNonePresets().map((preset) => preset.id).sort();
  const coveredIds = Array.from(getMotionCoveredEffectIds())
    .filter((id) => expectedIds.includes(id))
    .sort();
  assert.deepEqual(
    coveredIds,
    expectedIds,
    'foundation.css + views-surface-effects.css must give all five effects an explicit motion-axis selector',
  );
});

test('no surface effect claims fresh-install candidacy and the fresh defaults match the owner-reviewed picks', () => {
  // Owner defaults review, 2026-08-19: fresh installs ship with NO surface
  // effect, so no preset may carry freshInstallCandidate: true. Re-flagging a
  // preset requires a deliberate defaults decision, not a drive-by edit.
  const presets = getSurfaceEffectPresets();
  const candidates = presets.filter((preset) => preset.freshInstallCandidate === true);
  assert.equal(candidates.length, 0, 'no preset should be freshInstallCandidate: true');

  const defaultPreferences = getDefaultAppearancePreferences();
  assert.equal(defaultPreferences.surfaceEffectId, 'none');
  assert.equal(defaultPreferences.paletteId, 'slate');
  assert.equal(defaultPreferences.typographyId, 'technical');
  assert.equal(defaultPreferences.fontScaleId, 'xlarge');
});

test('recommendedPalettes preserve the intentional effect-to-palette recommendations', () => {
  const presets = getSurfaceEffectPresets();
  const byId = Object.fromEntries(presets.map((preset) => [preset.id, preset]));

  assert.deepEqual(byId['circuit-trace'].recommendedPalettes, ['obsidian']);

  // context-weave joined the empty list on 2026-08-21: one neutral thread
  // colour per palette means it no longer favours any particular canvas.
  ['reactive-grid', 'playlist-scroll', 'atomic-burst', 'context-weave'].forEach((id) => {
    assert.deepEqual(byId[id].recommendedPalettes, [], `${id}.recommendedPalettes should be empty`);
  });
});

test('renderer field matches the real DOM node each effect module creates (canvas2d vs svg)', () => {
  const presets = getSurfaceEffectPresets();
  const byId = Object.fromEntries(presets.map((preset) => [preset.id, preset]));

  ['reactive-grid', 'playlist-scroll', 'atomic-burst', 'circuit-trace', 'context-weave'].forEach((id) => {
    assert.equal(byId[id].renderer, 'canvas2d', `${id}.renderer should be canvas2d`);
  });
  // The svg renderer left the roster with darkroom-living-ink (2026-08-21);
  // every shipped effect is canvas2d.
  assert.equal(presets.filter((preset) => preset.renderer === 'svg').length, 0);
});

test('Slate remains a gradient-free flat reading surface', () => {
  const css = fs.readFileSync(path.join(STYLES_DIR, 'palette-slate.css'), 'utf8');
  assert.doesNotMatch(css, /gradient\(/);
  assert.match(css, /--surface-main-stage-background:\s*#15181c;/);
  assert.match(css, /--surface-main-stage-overlay:\s*none;/);
  assert.match(css, /--surface-main-stage-glow:\s*none;/);
  assert.match(css, /--text-primary:\s*#f6f7f9;/);
  assert.match(css, /--text-secondary:\s*#d0d5dc;/);
  assert.match(css, /--text-muted:\s*#a7aeb8;/);
  assert.match(css, /--widget-atomic-burst-color-b:\s*rgba\(163, 150, 201, 0\.74\);/);
});

test('factories object in renderer/app.js has exactly one key per non-none preset id (bijection)', () => {
  const appSource = fs.readFileSync(APP_JS_PATH, 'utf8');
  const factoryKeys = extractSurfaceEffectFactoryKeys(appSource);
  assert.ok(factoryKeys, 'should locate the factories: {...} block inside createSurfaceEffectManager({...})');

  const presetIds = new Set(getNonNonePresets().map((preset) => preset.id));
  assert.deepEqual(
    Array.from(factoryKeys).sort(),
    Array.from(presetIds).sort(),
    'factories keys in renderer/app.js should exactly match the non-none preset ids'
  );
});

// F7 (2026-08-21): the dev gallery -- the one tool for reviewing effects --
// was missing `context-weave` from its factory map, so the effect the owner
// was asked to review could not be shown. The same bijection already guards
// renderer/app.js above; this is the gallery's half, asserted at the source
// rather than by grepping the file.
test('the dev gallery factory map has exactly one key per non-none preset id (bijection)', () => {
  const gallery = require('../renderer/shell/renderer-surface-gallery-utils.js');
  const windowRef = {
    rendererReactiveGridUtils: { createReactiveGridController() {} },
    rendererPlaylistScrollUtils: { createPlaylistScrollController() {} },
    rendererAtomicBurstUtils: { createAtomicBurstController() {} },
    rendererCircuitTraceUtils: { createCircuitTraceController() {} },
    rendererContextWeaveUtils: { createContextWeaveController() {} },
  };
  const factoryMap = gallery.buildFactoryMap(windowRef);
  assert.deepEqual(
    Object.keys(factoryMap).sort(),
    getNonNonePresets().map((preset) => preset.id).sort(),
    'gallery factory keys should exactly match the non-none preset ids'
  );
  Object.entries(factoryMap).forEach(([id, factory]) => {
    assert.equal(typeof factory, 'function', `${id} resolves to a real factory`);
  });
});

test('the dev gallery palette fallback list covers every registered palette', () => {
  const gallery = require('../renderer/shell/renderer-surface-gallery-utils.js');
  assert.deepEqual(
    gallery.FALLBACK_PALETTE_IDS.slice().sort(),
    getPalettePresets().map((preset) => preset.id).sort(),
    'the fallback list was missing `slate` (11 of 12) until 2026-08-21'
  );
});

test('each non-none preset id maps to a real, requirable controller factory function', () => {
  const presetIds = getNonNonePresets().map((preset) => preset.id);
  assert.deepEqual(
    presetIds.slice().sort(),
    Object.keys(EFFECT_MODULE_TABLE).sort(),
    'EFFECT_MODULE_TABLE should cover exactly the non-none preset ids'
  );

  presetIds.forEach((id) => {
    const { modulePath, exportName } = EFFECT_MODULE_TABLE[id];
    const mod = require(modulePath);
    assert.equal(
      typeof mod[exportName],
      'function',
      `${modulePath} should export ${exportName} as a function`
    );
  });
});

test('every requiredTokens entry appears as a literal string somewhere under styles/', () => {
  const stylesBlob = readStylesBlob();
  getNonNonePresets().forEach((preset) => {
    preset.requiredTokens.forEach((token) => {
      assert.ok(
        stylesBlob.includes(token),
        `${preset.id} requiredTokens entry "${token}" should appear literally under styles/`
      );
    });
  });
});

test('interaction, requiredTokens, and recommendedPalettes are frozen for every non-none preset', () => {
  getNonNonePresets().forEach((preset) => {
    assert.ok(Object.isFrozen(preset.interaction), `${preset.id}.interaction should be frozen`);
    assert.ok(Object.isFrozen(preset.requiredTokens), `${preset.id}.requiredTokens should be frozen`);
    assert.ok(Object.isFrozen(preset.recommendedPalettes), `${preset.id}.recommendedPalettes should be frozen`);
  });
});

test('every requiredTokens entry across all presets has a schema row in the shared runtime SURFACE_EFFECT_TOKEN_SCHEMAS table', () => {
  const schemas = surfaceEffectRuntime.SURFACE_EFFECT_TOKEN_SCHEMAS;
  assert.ok(schemas && typeof schemas === 'object', 'runtime should export SURFACE_EFFECT_TOKEN_SCHEMAS');

  const missing = [];
  getNonNonePresets().forEach((preset) => {
    preset.requiredTokens.forEach((token) => {
      if (!Object.prototype.hasOwnProperty.call(schemas, token)) {
        missing.push(`${preset.id}: ${token}`);
      }
    });
  });

  assert.deepEqual(missing, [], `every requiredTokens entry should have a runtime schema row; missing:\n${missing.join('\n')}`);
});

test('nested preset metadata mutation attempts throw and never leak across getSurfaceEffectPresets() reads', () => {
  const first = getSurfaceEffectPresets().find((preset) => preset.id === 'circuit-trace');
  const interactionSnapshot = JSON.stringify(first.interaction);
  const tokensSnapshot = JSON.stringify(first.requiredTokens);
  const palettesSnapshot = JSON.stringify(first.recommendedPalettes);

  assert.throws(() => strictAssign(first.interaction, 'hover', !first.interaction.hover), TypeError);
  assert.throws(() => {
    first.requiredTokens.push('--hacked-token');
  }, TypeError);
  assert.throws(() => {
    first.recommendedPalettes.push('hacked-palette');
  }, TypeError);

  const second = getSurfaceEffectPresets().find((preset) => preset.id === 'circuit-trace');
  assert.equal(JSON.stringify(second.interaction), interactionSnapshot);
  assert.equal(JSON.stringify(second.requiredTokens), tokensSnapshot);
  assert.equal(JSON.stringify(second.recommendedPalettes), palettesSnapshot);
});
