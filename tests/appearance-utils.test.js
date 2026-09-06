const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  applyAppearanceToDocument,
  getDefaultAppearancePreferences,
  getPalettePresets,
  getSurfaceEffectPresets,
  getThemeBundles,
  getTimelineStylePresets,
  getTypographyPresets,
  getFontScalePresets,
  loadAppearancePreferences,
  normalizeAppearancePreferences,
  detectActiveThemeBundle,
  resolveThemeBundle,
  saveAppearancePreferences,
} = require('../renderer/shared/appearance-utils');

function createStorage(initialValue) {
  const values = new Map();
  if (typeof initialValue === 'string') {
    values.set(STORAGE_KEY, initialValue);
  }
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    values,
  };
}

function readStyleFile(fileName) {
  return fs.readFileSync(path.join(__dirname, '..', 'styles', fileName), 'utf8');
}

test('appearance presets expose the expected curated options', () => {
  assert.deepEqual(getPalettePresets().map((preset) => preset.id), [
    'midnight',
    'pewter',
    'obsidian',
    'darkroom',
    'slate',
    'paper',
    'signal',
    'woolly',
    'lexicon',
    'rocko',
    'jenny-day',
    'jenny-night',
  ]);
  assert.deepEqual(getTypographyPresets().map((preset) => preset.id), ['system', 'editorial', 'technical']);
  assert.deepEqual(getSurfaceEffectPresets().map((preset) => preset.id), [
    'none',
    'reactive-grid',
    'playlist-scroll',
    'atomic-burst',
    'circuit-trace',
    'context-weave',
  ]);
  assert.equal(
    getSurfaceEffectPresets().some((preset) => preset.id === 'peripheral-garden'),
    false,
    'peripheral-garden (UIUX-039) had a full token surface but no bound controller and was removed'
  );
  assert.equal(
    getSurfaceEffectPresets().some((preset) => preset.id === 'circuit-trace-v3'),
    false,
    'Circuit Trace v3 should stay internally gated, not become a separate picker option'
  );
  // explorer-minimal retired 2026-07-05 (quiet-timeline overhaul): the default
  // one-liner timeline superseded its coalesced-run presentation.
  assert.deepEqual(getTimelineStylePresets().map((preset) => preset.id), ['default']);
});

test('retired motion, sprite, and thread preferences are omitted from v2', () => {
  const normalized = normalizeAppearancePreferences({
    motionId: 'calm',
    explicitMotion: true,
    spriteHoloId: 'on',
    threadStyleId: 'bold-graph',
  });
  assert.equal(Object.hasOwn(normalized, 'motionId'), false);
  assert.equal(Object.hasOwn(normalized, 'explicitMotion'), false);
  assert.equal(Object.hasOwn(normalized, 'spriteHoloId'), false);
  assert.equal(Object.hasOwn(normalized, 'threadStyleId'), false);
});

test('a persisted explorer-minimal timelineStyleId (retired) normalizes to the default preset', () => {
  // explorer-minimal retired 2026-07-05 (quiet-timeline overhaul): stored prefs
  // must degrade to the default flat timeline, not a broken/unknown id.
  const normalized = normalizeAppearancePreferences({ timelineStyleId: 'explorer-minimal' });
  assert.equal(normalized.timelineStyleId, 'default');
});

test('light appearance palettes are exactly those whose CSS declares color-scheme: light', () => {
  // Derive light/dark from each palette's authoritative `color-scheme` declaration
  // rather than a hand-maintained exclusion list, so new dark palettes need no edit here.
  const lightPaletteIds = getPalettePresets()
    .map((preset) => preset.id)
    .filter((id) => {
      // midnight has no palette-*.css; its baseline lives in foundation.css (color-scheme: dark).
      if (id === 'midnight') return false;
      return /color-scheme:\s*light/.test(readStyleFile(`palette-${id}.css`));
    });
  assert.deepEqual(lightPaletteIds, ['paper', 'woolly', 'jenny-day']);
});

test('theme bundles expose the curated default and lexicon bundle mappings', () => {
  assert.deepEqual(getThemeBundles().map((bundle) => bundle.id), [
    'jenny-default',
    'pewter',
    'obsidian',
    'slate',
    'lexicon',
    'rocko',
    'jenny-day',
    'jenny-night',
  ]);
  assert.deepEqual(resolveThemeBundle('lexicon'), {
    id: 'lexicon',
    label: 'Lexicon',
    description: 'Dark editorial palette with a quiet, text-forward chrome.',
    preferences: {
      paletteId: 'lexicon',
      typographyId: 'editorial',
      surfaceEffectId: 'none',
      composerHoloId: 'on',
      timelineStyleId: 'default',
      fontScaleId: 'default',
      chatWidthId: 'default',
    },
  });
  assert.deepEqual(resolveThemeBundle('rocko'), {
    id: 'rocko',
    label: 'Retro Teal',
    description: 'Teal + orange 90s palette with a bright, playful shell.',
    preferences: {
      paletteId: 'rocko',
      typographyId: 'system',
      surfaceEffectId: 'none',
      composerHoloId: 'on',
      timelineStyleId: 'default',
      fontScaleId: 'default',
      chatWidthId: 'default',
    },
  });
  assert.deepEqual(resolveThemeBundle('slate'), {
    id: 'slate',
    label: 'Slate',
    description: 'Blank-space reading surface — flat dark canvas, no ambient background effect, crisp ice-blue holo accents.',
    preferences: {
      paletteId: 'slate',
      typographyId: 'system',
      surfaceEffectId: 'none',
      composerHoloId: 'on',
      timelineStyleId: 'default',
      fontScaleId: 'default',
      chatWidthId: 'default',
    },
  });
});

test('detectActiveThemeBundle returns the matching bundle when appearance axes align', () => {
  assert.equal(
    detectActiveThemeBundle({
      paletteId: 'lexicon',
      typographyId: 'editorial',
      surfaceEffectId: 'none',
      composerHoloId: 'on',
    })?.id,
    'lexicon'
  );
  assert.equal(
    detectActiveThemeBundle({
      paletteId: 'lexicon',
      typographyId: 'editorial',
      surfaceEffectId: 'none',
      composerHoloId: 'off',
    }),
    null
  );
});

test('normalizeAppearancePreferences falls back to defaults for unknown values', () => {
  assert.deepEqual(
    normalizeAppearancePreferences({
      paletteId: 'paper',
      typographyId: 'unknown',
      motionId: 'wild',
    }),
    {
      paletteId: 'paper',
      typographyId: 'system',
      surfaceEffectId: 'none',
      composerHoloId: 'on',
      timelineStyleId: 'default',
      fontScaleId: 'default',
      chatWidthId: 'default',
    }
  );
});

test('normalizeAppearancePreferences coerces legacy composer holo presets to on', () => {
  ['subtle', 'balanced', 'intense'].forEach((legacyId) => {
    const normalized = normalizeAppearancePreferences({ composerHoloId: legacyId });
    assert.equal(normalized.composerHoloId, 'on');
  });
  assert.equal(normalizeAppearancePreferences({ composerHoloId: 'off' }).composerHoloId, 'off');
  assert.equal(normalizeAppearancePreferences({}).composerHoloId, 'on');
});

test('normalizeAppearancePreferences falls back to none for retired surface effects and still matches Lexicon', () => {
  const normalized = normalizeAppearancePreferences({
    paletteId: 'lexicon',
    typographyId: 'editorial',
    surfaceEffectId: 'pretext-drift',
    composerHoloId: 'on',
  });

  assert.equal(normalized.surfaceEffectId, 'none');
  assert.equal(detectActiveThemeBundle(normalized)?.id, 'lexicon');
});

// UIUX-039: peripheral-garden was a surface-effect preset with a full CSS
// token surface but no JS controller ever bound to it (no
// renderer/peripheral-garden/index.js) — an advertised surface without a
// runtime owner. Removed from SURFACE_EFFECT_PRESETS; any old persisted
// preference migrates to 'none' via normalizePresetId, same repair path
// already covered above for other retired effects.
// Rescued from the retired tests/appearance-darkroom.test.js (2026-08-21):
// the Darkroom *palette* survives the removal of the Darkroom theme bundle and
// the living-ink effect, so a persisted paletteId must still round-trip.
test('the darkroom palette stays selectable after its theme bundle and effect were removed', () => {
  assert.equal(normalizeAppearancePreferences({ paletteId: 'darkroom' }).paletteId, 'darkroom');
  assert.ok(getPalettePresets().some((preset) => preset.id === 'darkroom'));
  assert.equal(
    getThemeBundles().some((bundle) => bundle.id === 'darkroom'),
    false,
    'the curated Darkroom bundle was removed on 2026-08-21 (D2); the palette was not'
  );
});

// Surface Effects review 2026-08-21 (D1/D3): Doodle Field and Living Ink were
// removed outright. normalizePresetId is the only migration every existing
// install has, so assert it explicitly rather than leaning on the
// peripheral-garden case to cover it by implication.
test('persisted doodle-field and darkroom-living-ink surface effects migrate to none', () => {
  ['doodle-field', 'darkroom-living-ink'].forEach((retiredId) => {
    const normalized = normalizeAppearancePreferences({
      paletteId: 'midnight',
      typographyId: 'system',
      surfaceEffectId: retiredId,
      composerHoloId: 'on',
    });
    assert.equal(normalized.surfaceEffectId, 'none', retiredId + ' should migrate to none');
  });
  const effectIds = getSurfaceEffectPresets().map((preset) => preset.id);
  assert.equal(effectIds.includes('doodle-field'), false);
  assert.equal(effectIds.includes('darkroom-living-ink'), false);
});

test('normalizeAppearancePreferences migrates a persisted peripheral-garden surface effect to none', () => {
  const normalized = normalizeAppearancePreferences({
    paletteId: 'midnight',
    typographyId: 'system',
    surfaceEffectId: 'peripheral-garden',
    composerHoloId: 'on',
  });

  assert.equal(normalized.surfaceEffectId, 'none');
});

test('loadAppearancePreferences returns defaults when storage is empty or invalid', () => {
  assert.deepEqual(loadAppearancePreferences(createStorage()), getDefaultAppearancePreferences());
  assert.deepEqual(loadAppearancePreferences(createStorage('{bad json')), getDefaultAppearancePreferences());
});

test('v1 appearance storage migrates once to v2 and drops retired preferences', () => {
  const values = new Map([[LEGACY_STORAGE_KEY, JSON.stringify({
    paletteId: 'paper',
    motionId: 'calm',
    explicitMotion: true,
    spriteHoloId: 'on',
    threadStyleId: 'bold-graph',
  })]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };

  const migrated = loadAppearancePreferences(storage);
  assert.equal(migrated.paletteId, 'paper');
  assert.equal(Object.hasOwn(migrated, 'motionId'), false);
  assert.deepEqual(JSON.parse(values.get(STORAGE_KEY)), migrated);
  assert.equal(values.has(LEGACY_STORAGE_KEY), false);
});

test('failed v1 migration retains legacy storage while returning bounded normalized state', () => {
  const legacyRaw = JSON.stringify({ paletteId: 'signal', motionId: 'expressive' });
  const storage = {
    getItem: (key) => key === LEGACY_STORAGE_KEY ? legacyRaw : null,
    setItem() { throw new Error('quota exceeded'); },
    removeItem() { assert.fail('legacy must remain when v2 write fails'); },
  };

  const migrated = loadAppearancePreferences(storage);
  assert.equal(migrated.paletteId, 'signal');
  assert.equal(Object.hasOwn(migrated, 'motionId'), false);
});

test('fresh-install default is the Slate + Technical + Extra Large ship look (owner review 2026-08-19)', () => {
  const fresh = getDefaultAppearancePreferences();
  assert.equal(fresh.paletteId, 'slate');
  assert.equal(fresh.typographyId, 'technical');
  assert.equal(fresh.fontScaleId, 'xlarge');
  assert.equal(fresh.surfaceEffectId, 'none');
  // A brand-new profile should read as the named "Jenny Default" bundle,
  // not "Custom", so Settings shows a recognizable selection.
  assert.equal(detectActiveThemeBundle(fresh)?.id, 'jenny-default');
});

test('normalizing partial/empty stored prefs keeps the conservative none surface', () => {
  // Existing users with missing fields must not get a surprise animated surface.
  assert.equal(normalizeAppearancePreferences({}).surfaceEffectId, 'none');
  assert.equal(normalizeAppearancePreferences({}).paletteId, 'midnight');
});

test('loadAppearancePreferences preserves stored legacy surface effects', () => {
  const storage = createStorage(JSON.stringify({
    paletteId: 'midnight',
    typographyId: 'system',
    surfaceEffectId: 'reactive-grid',
  }));

  assert.deepEqual(loadAppearancePreferences(storage), {
    paletteId: 'midnight',
    typographyId: 'system',
    surfaceEffectId: 'reactive-grid',
    composerHoloId: 'on',
    timelineStyleId: 'default',
    fontScaleId: 'default',
    chatWidthId: 'default',
  });
});

test('saveAppearancePreferences stores normalized preferences and round-trips through load', () => {
  const storage = createStorage();

  const saved = saveAppearancePreferences(storage, {
    paletteId: 'signal',
    typographyId: 'technical',
    composerHoloId: 'on',
  });

  assert.deepEqual(saved, {
    paletteId: 'signal',
    typographyId: 'technical',
    surfaceEffectId: 'none',
    composerHoloId: 'on',
    timelineStyleId: 'default',
    fontScaleId: 'default',
    chatWidthId: 'default',
  });
  assert.deepEqual(loadAppearancePreferences(storage), saved);
});

test('saveAppearancePreferences keeps the committed v2 value when legacy cleanup fails', () => {
  const values = new Map([[LEGACY_STORAGE_KEY, JSON.stringify({ paletteId: 'paper' })]]);
  const storage = {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem() { throw new Error('storage cleanup blocked'); },
  };

  const saved = saveAppearancePreferences(storage, { paletteId: 'signal' });

  assert.equal(saved.paletteId, 'signal');
  assert.deepEqual(JSON.parse(values.get(STORAGE_KEY)), saved);
  assert.deepEqual(loadAppearancePreferences(storage), saved);
});

test('applyAppearanceToDocument writes appearance ids onto the root dataset', () => {
  const appliedStyle = new Map();
  const removedStyle = new Set();
  const root = {
    dataset: {},
    style: {
      setProperty(name, value) {
        appliedStyle.set(name, value);
      },
      removeProperty(name) {
        removedStyle.add(name);
        appliedStyle.delete(name);
      },
    },
  };

  const result = applyAppearanceToDocument(root, {
    paletteId: 'paper',
    typographyId: 'editorial',
    composerHoloId: 'off',
    spriteHoloId: 'on',
    threadStyleId: 'bold-graph',
  });

  assert.deepEqual(result, {
    paletteId: 'paper',
    typographyId: 'editorial',
    surfaceEffectId: 'none',
    composerHoloId: 'off',
    timelineStyleId: 'default',
    fontScaleId: 'default',
    chatWidthId: 'default',
  });
  assert.deepEqual(root.dataset, {
    palette: 'paper',
    typography: 'editorial',
    motion: 'standard',
    surfaceEffect: 'none',
    composerHolo: 'off',
    spriteHolo: 'off',
    threadStyle: 'subtle',
    timelineStyle: 'default',
    fontScale: 'default',
    chatWidth: 'default',
  });
  assert.equal(appliedStyle.get('--font-scale'), '1');
  assert.equal(appliedStyle.get('--composer-holo-draw-enabled'), '0');
  assert.equal(appliedStyle.get('--composer-holo-shell-ring-strength'), '0%');
  assert.equal(appliedStyle.get('--composer-holo-shell-glow-strength'), '0%');
  assert.equal(appliedStyle.get('--sprite-holo-draw-enabled'), '0');
  assert.equal(appliedStyle.has('--thread-dot-size'), false);
  assert.equal(appliedStyle.has('--thread-dot-hit-size'), false);
  assert.equal(removedStyle.has('--thread-rail-opacity'), true);
  assert.equal(removedStyle.has('--thread-node-gap'), true);
  assert.equal(appliedStyle.get('--thread-holo-scale'), '0.42');
});

test('stale sprite preferences cannot enable the retired sprite ring outside palette-owned behavior', () => {
  const appliedStyle = new Map();
  const root = {
    dataset: {},
    style: {
      setProperty(name, value) {
        appliedStyle.set(name, value);
      },
    },
  };

  applyAppearanceToDocument(root, {
    spriteHoloId: 'on',
  });

  assert.equal(root.dataset.spriteHolo, 'off');
  assert.equal(appliedStyle.get('--sprite-holo-draw-enabled'), '0');
  assert.equal(appliedStyle.get('--sprite-holo-draw-stroke-scale'), '0');
  assert.equal(appliedStyle.get('--sprite-holo-border-width'), '0px');
});

test('Slate enables its palette-owned sprite holo and clears prior disabled overrides', () => {
  const appliedStyle = new Map();
  const removedStyle = new Set();
  const root = {
    dataset: {},
    style: {
      setProperty(name, value) {
        appliedStyle.set(name, value);
      },
      removeProperty(name) {
        removedStyle.add(name);
        appliedStyle.delete(name);
      },
    },
  };

  applyAppearanceToDocument(root, { paletteId: 'paper' });
  assert.equal(appliedStyle.get('--sprite-holo-draw-enabled'), '0');

  applyAppearanceToDocument(root, { paletteId: 'slate' });

  assert.equal(root.dataset.spriteHolo, 'on');
  assert.equal(appliedStyle.has('--sprite-holo-draw-enabled'), false);
  assert.equal(appliedStyle.has('--sprite-holo-border-width'), false);
  assert.equal(removedStyle.has('--sprite-holo-draw-enabled'), true);
  assert.equal(removedStyle.has('--sprite-holo-border-width'), true);

  applyAppearanceToDocument(root, { paletteId: 'paper' });

  assert.equal(root.dataset.spriteHolo, 'off');
  assert.equal(appliedStyle.get('--sprite-holo-draw-enabled'), '0');
  assert.equal(appliedStyle.get('--sprite-holo-border-width'), '0px');
});

test('command palette focus states expose a visible tokenized keyboard focus affordance', () => {
  const commandPaletteCss = readStyleFile('command-palette.css');

  assert.match(
    commandPaletteCss,
    /\.command-palette-input:focus-visible\s*\{[\s\S]*?(box-shadow|border-color|background):[\s\S]*?var\(--focus-outline/,
    'command palette input focus-visible should include a visible focus token'
  );
  assert.match(
    commandPaletteCss,
    /\.command-palette-list:focus-visible\s*\{[\s\S]*?var\(--focus-outline/,
    'command palette listbox focus-visible should include a visible focus token'
  );
});

test('shared palette semantics keep the Home orbit-field and Settings shell wired to global theme tokens', () => {
  const rootDir = path.resolve(__dirname, '..');
  const foundationCss = fs.readFileSync(path.join(rootDir, 'styles', 'foundation.css'), 'utf8');
  const foundationWidgetTokensCss = fs.readFileSync(
    path.join(rootDir, 'styles', 'foundation-widget-tokens.css'),
    'utf8'
  );
  const foundationTokenCss = `${foundationCss}\n${foundationWidgetTokensCss}`;
  const homeCss = fs.readFileSync(path.join(rootDir, 'styles', 'views-home-artifacts.css'), 'utf8');
  const composerCss = fs.readFileSync(path.join(rootDir, 'styles', 'chat-composer.css'), 'utf8');
  // Quiet-timeline overhaul (2026-07-05): reasoning-row styling moved into the
  // unified machinery grammar, which consumes the --tl-* timeline contract
  // (chat-timeline-tokens.css) instead of the legacy --widget-thinking-* set.
  const reasoningV2Css = fs.readFileSync(path.join(rootDir, 'styles', 'chat-machinery.css'), 'utf8');
  const settingsCss = [
    'settings.css',
    'settings-layout.css',
    'settings-nav.css',
    'settings-sections.css',
    'settings-control-tower.css',
    'settings-controls.css',
    'settings-responsive.css',
    'settings-playground.css',
  ].map((fileName) => fs.readFileSync(path.join(rootDir, 'styles', fileName), 'utf8')).join('\n');
  const paletteFiles = getPalettePresets()
    .map((preset) => `palette-${preset.id}.css`)
    .filter((fileName) => fs.existsSync(path.join(rootDir, 'styles', fileName)));
  assert.ok(
    paletteFiles.includes('palette-rocko.css'),
    'shared semantic palette coverage should include Rocko while it is an active palette CSS file'
  );
  assert.match(
    foundationCss,
    /--mat-live-accent:\s*var\(--accent-cyan\);/,
    'midnight foundation should expose the live accent semantic'
  );
  assert.match(
    foundationCss,
    /--mat-live-border:\s*color-mix\(in srgb,\s*var\(--mat-live-accent\)\s*10%,\s*var\(--border-subtle\)\s*\);/,
    'midnight foundation should tint the live border from the live accent semantic'
  );
  assert.match(
    foundationCss,
    /--artifact-surface-focus-ring:\s*[^;]+;/,
    'foundation should expose the shared artifact focus ring token'
  );
  // --mermaid-node-label-* retired from foundation (Artifact WS1): Mermaid
  // node colors are formula-derived from the palette accent in
  // renderer-mermaid-theme-utils.js; the tokens remain optional overrides
  // that a palette may declare, so their absence here is the contract.
  assert.doesNotMatch(
    foundationCss,
    /--mermaid-node-label-(?:bg|border|text):/,
    'foundation must not re-hardcode Mermaid node label colors (WS1 formulas own them)'
  );
  assert.match(
    foundationCss,
    /--settings-shell-nav-bg:\s*[^;]+;/,
    'foundation should expose the shared settings nav surface token'
  );
  assert.match(
    foundationCss,
    /--settings-shell-masthead-bg:\s*[^;]+;/,
    'foundation should expose the shared settings masthead surface token'
  );
  assert.match(
    foundationCss,
    /--settings-shell-panel-bg:\s*[^;]+;/,
    'foundation should expose the shared settings panel surface token'
  );
  assert.match(
    foundationCss,
    /--settings-shell-field-bg:\s*[^;]+;/,
    'foundation should expose the shared settings field surface token'
  );
  // UIUX-039: peripheral-garden's token surface was removed with the preset
  // (no bound controller ever consumed it) — assert absence, not presence.
  assert.doesNotMatch(
    foundationCss,
    /--widget-peripheral-garden-/,
    'foundation must not carry orphaned peripheral-garden tokens (UIUX-039, preset removed)'
  );

  for (const paletteFile of paletteFiles) {
    const paletteCss = fs.readFileSync(path.join(rootDir, 'styles', paletteFile), 'utf8');
    assert.match(
      paletteCss,
      /--mat-live-accent:\s*[^;]+;/,
      `${paletteFile} should expose the live accent semantic`
    );
    assert.match(
      paletteCss,
      /--mat-live-border:\s*color-mix\(in srgb,\s*[^;]+var\(--border-subtle\)\s*\);/,
      `${paletteFile} should tint the live border semantic`
    );
    assert.match(
      paletteCss,
      /--widget-face-glow-color:\s*[^;]+;/,
      `${paletteFile} should expose the shared face glow token`
    );
    assert.match(
      paletteCss,
      /--widget-face-aura-primary:\s*[^;]+;/,
      `${paletteFile} should expose the shared face primary aura token`
    );
    assert.match(
      paletteCss,
      /--widget-face-aura-secondary:\s*[^;]+;/,
      `${paletteFile} should expose the shared face secondary aura token`
    );
    assert.match(
      paletteCss,
      /--widget-face-shine-color:\s*[^;]+;/,
      `${paletteFile} should expose the shared face shine token`
    );
    assert.match(
      paletteCss,
      /--surface-composer-signal-background:\s*[^;]+;/,
      `${paletteFile} should expose the shared composer signal surface token`
    );
    assert.match(
      paletteCss,
      /--widget-composer-signal-border:\s*[^;]+;/,
      `${paletteFile} should expose the shared composer signal border token`
    );
    assert.match(
      paletteCss,
      /--artifact-surface-focus-ring:\s*[^;]+;/,
      `${paletteFile} should expose the shared artifact focus ring token`
    );
    // --mermaid-node-label-* retired from the per-palette mandatory set
    // (Artifact WS1): node colors are formula-derived from the palette
    // accent; a palette MAY still declare them as deliberate overrides,
    // but none of the shipped palettes do.
    assert.doesNotMatch(
      paletteCss,
      /--mermaid-node-label-(?:bg|border|text):/,
      `${paletteFile} must not re-hardcode Mermaid node label colors (WS1 formulas own them)`
    );
    assert.match(
      paletteCss,
      /--settings-shell-accent:\s*[^;]+;/,
      `${paletteFile} should expose the shared settings accent semantic`
    );
    assert.match(
      paletteCss,
      /--settings-shell-nav-bg:\s*[^;]+;/,
      `${paletteFile} should expose the shared settings nav surface token`
    );
    assert.match(
      paletteCss,
      /--settings-shell-masthead-bg:\s*[^;]+;/,
      `${paletteFile} should expose the shared settings masthead surface token`
    );
    assert.match(
      paletteCss,
      /--settings-shell-panel-bg:\s*[^;]+;/,
      `${paletteFile} should expose the shared settings panel surface token`
    );
    assert.match(
      paletteCss,
      /--settings-shell-field-bg:\s*[^;]+;/,
      `${paletteFile} should expose the shared settings field surface token`
    );
    assert.doesNotMatch(
      paletteCss,
      /--widget-peripheral-garden-/,
      `${paletteFile} must not carry orphaned peripheral-garden tokens (UIUX-039, preset removed)`
    );
  }

  assert.match(
    homeCss,
    /--home-live-accent:\s*var\(--mat-live-accent\);/,
    'Home should inherit the live accent semantic rather than a local accent pick'
  );
  assert.match(
    homeCss,
    /--home-orbit-glow:\s*var\(--widget-face-glow-color\);/,
    'Home should inherit the shared orbit glow token'
  );
  assert.match(
    homeCss,
    /--home-orbit-aura-primary:\s*var\(--widget-face-aura-primary\);/,
    'Home should inherit the shared orbit primary aura token'
  );
  assert.match(
    homeCss,
    /--home-orbit-aura-secondary:\s*var\(--widget-face-aura-secondary\);/,
    'Home should inherit the shared orbit secondary aura token'
  );
  assert.match(
    homeCss,
    /--home-orbit-shine:\s*var\(--widget-face-shine-color\);/,
    'Home should derive orbit shine from the shared face shine token'
  );
  assert.match(
    foundationCss,
    /--surface-composer-signal-background:\s*[^;]+;/,
    'foundation should expose the shared composer signal surface token'
  );
  assert.match(
    foundationTokenCss,
    /--widget-composer-signal-border:\s*[^;]+;/,
    'foundation token surface should expose the shared composer signal border token'
  );
  assert.match(
    composerCss,
    /var\(--surface-composer-signal-background\)/,
    'chat composer styling should consume the shared composer signal surface token'
  );
  assert.match(
    composerCss,
    /var\(--widget-composer-signal-border\)/,
    'chat composer styling should consume the shared composer signal border token'
  );
  assert.match(
    reasoningV2Css,
    /var\(--tl-row-hover\)/,
    'machinery rows should consume the shared timeline hover token'
  );
  assert.match(
    reasoningV2Css,
    /var\(--tl-status-active\)/,
    'machinery styling should derive status hues from the --tl-status-* aliases'
  );
  assert.match(
    reasoningV2Css,
    /var\(--tl-font-ui\)/,
    'machinery styling should consume the timeline UI type token'
  );
  assert.match(
    reasoningV2Css,
    /var\(--tl-font-detail\)/,
    'expanded machinery panels should consume the timeline detail type token'
  );
  assert.doesNotMatch(
    reasoningV2Css,
    /--widget-thinking-/,
    'machinery styling must not reach back to the legacy --widget-thinking-* namespace'
  );
  assert.match(
    reasoningV2Css,
    /font:\s*inherit;/,
    'reasoning row styling should inherit the active shell typography'
  );
  // The contract is "never pin a face; always resolve through the preference",
  // not "never write font-family". The blanket ban predated --font-family-mono
  // becoming preset-scoped, and it forced the file's <pre> blocks to rely on a
  // global pre/code reset that does not exist in styles/ — so they rendered in
  // the UA fixed font instead of the app's mono face. Every font-family here
  // must go through a --font-family-* token; literal families stay banned.
  // Strip comments first: prose that mentions a declaration is not a
  // declaration (this scan matched its own explanatory comment otherwise).
  const machineryRules = reasoningV2Css.replace(/\/\*[\s\S]*?\*\//g, '');
  const machineryFamilies = [...machineryRules.matchAll(/font-family\s*:([^;]*);/g)]
    .map((match) => match[1].trim());
  assert.ok(
    machineryFamilies.length > 0,
    'expected at least one font-family declaration (code surfaces need the mono token)'
  );
  for (const declaration of machineryFamilies) {
    assert.match(
      declaration,
      /^var\(--font-family-[a-z]+\)$/,
      `machinery font-family must resolve through a token, got: ${declaration}`
    );
  }
  assert.match(
    reasoningV2Css,
    /var\(--motion-duration-fast\)/,
    'reasoning row styling should consume the shared fast motion token'
  );
  assert.match(
    reasoningV2Css,
    /var\(--motion-duration-regular\)/,
    'reasoning row styling should consume the shared regular motion token'
  );
  // Custom-property *definitions* (e.g. `--reasoning-reveal-duration: 380ms;`)
  // are the sanctioned way to introduce a tunable motion knob — the soft-landing
  // reveal defines its own `--reasoning-reveal-*` tokens in `:root`. The contract
  // forbids hardcoding raw durations in actual transition/animation *usages*, so
  // strip the token declarations before asserting no bare `ms` remains.
  const reasoningCssSansTokenDefs = reasoningV2Css.replace(
    /^\s*--[\w-]+:\s*[^;]*;\s*$/gm,
    ''
  );
  assert.doesNotMatch(
    reasoningCssSansTokenDefs,
    /\b\d+ms\b/,
    'reasoning row styling should not hardcode motion durations in transition/animation usages'
  );
  // 2026-07 open-sections polish: the nav rail is a flush column (no panel
  // surface); its remaining theme wiring is the active-item surface token and
  // the header hairline.
  assert.match(
    settingsCss,
    /\.settings-nav-item\.active\s*\{[\s\S]*?background:\s*[^;]*var\(--settings-shell-nav-item-active-bg\)[^;]*;/,
    'active settings nav item should consume the shared nav active surface token'
  );
  assert.match(
    settingsCss,
    /\.settings-nav-header\s*\{[\s\S]*?border-bottom:\s*[^;]*var\(--settings-shell-muted-border\)[^;]*;/,
    'settings nav header should consume the shared settings shell border token'
  );
  // 2026-07 redesign: the content header is a flush strip (no masthead card
  // surface); its remaining theme wiring is the hairline separator token.
  assert.match(
    settingsCss,
    /\.settings-content-header\s*\{[\s\S]*?border-bottom:\s*[^;]*var\(--settings-shell-muted-border\)[^;]*;/,
    'settings content header should consume the shared settings shell border token'
  );
  assert.match(
    settingsCss,
    /\.settings-appearance-proof\s*\{[\s\S]*?var\(--settings-shell-chip-border\)[\s\S]*?var\(--settings-shell-chip-bg\)/,
    'the appearance proof chip should consume the shared settings chip tokens (the retired overview chip family is gone — hyg-W5-09-F18)'
  );
  // 2026-07 open-sections polish: section cards are flush (no panel surface);
  // theme wiring is the header hairline plus the data-surface-state tints.
  assert.match(
    settingsCss,
    /\.settings-card-header\s*\{[\s\S]*?border-bottom:\s*[^;]*var\(--settings-shell-muted-border\)[^;]*;/,
    'settings card headers should consume the shared settings shell border token'
  );
  assert.match(
    settingsCss,
    /\.settings-card\[data-surface-state~="busy"\]\s*\{[\s\S]*?var\(--state-warning\)/,
    'settings card surface states should stay wired to the shared state tokens'
  );
});

test('font scale presets expose the curated text-size ladder', () => {
  assert.deepEqual(getFontScalePresets().map((preset) => preset.id), [
    'small',
    'default',
    'large',
    'xlarge',
  ]);
  // Each preset carries the numeric multiplier the apply step writes to
  // --font-scale.
  const byId = Object.fromEntries(getFontScalePresets().map((p) => [p.id, p.value]));
  assert.equal(byId.default, 1);
  assert.equal(byId.small, 0.85);
  assert.equal(byId.large, 1.15);
  assert.equal(byId.xlarge, 1.3);
});

test('normalizeAppearancePreferences defaults and coerces fontScaleId', () => {
  assert.equal(normalizeAppearancePreferences({}).fontScaleId, 'default');
  assert.equal(normalizeAppearancePreferences({ fontScaleId: 'LARGE' }).fontScaleId, 'large');
  assert.equal(normalizeAppearancePreferences({ fontScaleId: 'bogus' }).fontScaleId, 'default');
});

test('applyAppearanceToDocument writes the resolved --font-scale multiplier and dataset id', () => {
  const appliedStyle = new Map();
  const root = {
    dataset: {},
    style: {
      setProperty(name, value) {
        appliedStyle.set(name, value);
      },
    },
  };

  applyAppearanceToDocument(root, { fontScaleId: 'large' });
  assert.equal(root.dataset.fontScale, 'large');
  assert.equal(appliedStyle.get('--font-scale'), '1.15');

  applyAppearanceToDocument(root, {});
  assert.equal(root.dataset.fontScale, 'default');
  assert.equal(appliedStyle.get('--font-scale'), '1');
});

test('font scale axis is wired through foundation tokens and isolated from chat zoom', () => {
  const foundationCss = readStyleFile('foundation.css');
  // The font-size tokens multiply by --font-scale.
  assert.match(foundationCss, /--font-size-base:\s*calc\(12px \* var\(--font-scale, 1\)\);/);
  assert.match(foundationCss, /--font-scale:\s*1;/);
  // The clamp-based display alias distributes the factor across the vw arm too.
  assert.match(foundationCss, /--font-size-display-1:\s*clamp\(calc\(76px \* var\(--font-scale, 1\)\), calc\(8\.8vw \* var\(--font-scale, 1\)\), calc\(126px \* var\(--font-scale, 1\)\)\);/);
  // --font-scale must NOT touch the spacing scale (overall app zoom owns that).
  assert.doesNotMatch(foundationCss, /--space-4:[^;]*var\(--font-scale/);

  // The chat hero avatar rules no longer multiply a --font-size-* token by the
  // chat zoom factor, so font-scale and chat-zoom never compound there.
  const chatThreadCss = readStyleFile('chat-thread.css');
  const chatMediaCss = readStyleFile('chat-media-queries.css');
  assert.doesNotMatch(chatThreadCss, /var\(--font-size-[a-z0-9]+\)\s*\*\s*var\(--chat-zoom-factor/);
  assert.doesNotMatch(chatMediaCss, /var\(--font-size-[a-z0-9]+\)\s*\*\s*var\(--chat-zoom-factor/);
});

test('Chats and Settings share a flat rail visual contract without reviving active-rail clutter', () => {
  const foundationCss = readStyleFile('foundation.css');
  const shellChromeCss = readStyleFile('shell-chrome.css');
  const chatsCss = readStyleFile('chats-panel.css');
  const collapsedChatsCss = readStyleFile('chats-panel-collapsed.css');
  const settingsCss = readStyleFile('settings-nav.css');
  const searchAsset = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'inventory', 'assets', 'search.svg'),
    'utf8'
  );

  for (const token of [
    'rail-divider',
    'rail-hover-bg',
    'rail-selected-bg',
    'rail-search-bg',
    'rail-search-border',
    'rail-search-focus-border',
    'rail-scrollbar-color',
  ]) {
    assert.match(foundationCss, new RegExp(`--${token}:\\s*[^;]+;`), `foundation exposes --${token}`);
  }
  assert.match(
    foundationCss,
    /--settings-shell-nav-item-active-bg:\s*var\(--rail-selected-bg\);/,
    'Settings aliases active navigation to the shared neutral selection token'
  );
  assert.match(shellChromeCss, /\.rail-search-field\s*\{/);
  assert.match(shellChromeCss, /renderer\/inventory\/assets\/search\.svg/);
  assert.match(settingsCss, /\.settings-nav-item\.active\s*\{[\s\S]*?var\(--settings-shell-nav-item-active-bg\)/);

  const selectedRule = chatsCss.match(
    /\.session-row\.active,\s*\.session-row\.active:is\(:hover, :focus-within\)\s*\{([\s\S]*?)\}/
  )?.[1] || '';
  assert.match(selectedRule, /background:\s*var\(--session-row-selected-bg\)/);
  assert.doesNotMatch(selectedRule, /border-left|box-shadow|glow|sidebar-active-rail/);
  assert.doesNotMatch(chatsCss, /--sidebar-active-rail|\.conversation-state-badge/);
  assert.match(foundationCss, /--font-size-2xl:\s*calc\(18px \* var\(--font-scale, 1\)\);/);
  assert.match(chatsCss, /\.sidebar-title\s*\{[\s\S]*?font-size:\s*var\(--font-size-2xl\)/);
  assert.match(chatsCss, /\.session-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) 32px/);
  assert.match(chatsCss, /\.session-row__menu\s*\{[\s\S]*?width:\s*32px;[\s\S]*?height:\s*32px;/);
  assert.match(
    chatsCss,
    /\.session-row__open\s*\{[\s\S]*?display:\s*flex;[\s\S]*?gap:\s*var\(--space-4\);/
  );
  assert.match(chatsCss, /\.session-row__dot\s*\{[\s\S]*?display:\s*none;[\s\S]*?order:\s*1;/);
  assert.match(
    chatsCss,
    /\.session-row\[data-session-dominant-state="streaming"\] \.session-row__dot,[\s\S]*?display:\s*block;/,
    'exceptional-state dots reveal without reserving space for inactive rows'
  );
  const narrowStart = chatsCss.indexOf('@container viewpanel (max-width: 279px)');
  const narrowEnd = chatsCss.indexOf('@media (prefers-reduced-motion: reduce)', narrowStart);
  const narrowRule = chatsCss.slice(narrowStart, narrowEnd);
  assert.ok(narrowStart >= 0 && narrowEnd > narrowStart, 'the narrow-width contract remains explicit');
  assert.doesNotMatch(narrowRule, /\.session-row__title[^{]*\{[^}]*display:\s*none/);
  assert.match(
    chatsCss,
    /\.chats-scope-slot \.chats-scope-control \.inv-segmented-option--on\s*\{[\s\S]*?inset 0 -2px 0 var\(--accent\)/,
    'Chats uses a scoped selector strong enough to retain the active underline after inventory CSS loads'
  );

  assert.match(searchAsset, /Tabler Icons/i);
  assert.match(searchAsset, /v3\.46\.0/);
  assert.match(searchAsset, /MIT License/i);
  assert.match(
    chatsCss,
    /@media \(forced-colors: active\)[\s\S]*?\.session-row\.active[\s\S]*?background:\s*Highlight;[\s\S]*?color:\s*HighlightText;/
  );
  assert.match(
    collapsedChatsCss,
    /@media \(forced-colors: active\)[\s\S]*?\.chats-strip__chip--active[\s\S]*?border-color:\s*Highlight;[\s\S]*?background:\s*Highlight;/
  );
  assert.match(
    settingsCss,
    /@media \(forced-colors: active\)[\s\S]*?\.settings-nav-item\.active[\s\S]*?border-color:\s*Highlight;[\s\S]*?background:\s*Highlight;/
  );
  assert.match(searchAsset, /Copyright \(c\) 2020-2026 Paweł Kuna/);
});
