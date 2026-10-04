(function exposeAppearanceUtils(globalScope, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  if (globalScope && typeof globalScope === 'object') {
    globalScope.appearanceUtils = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function appearanceUtilsFactory() {
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var STORAGE_KEY = 'jenny.appearance.v2';
  var LEGACY_STORAGE_KEY = 'jenny.appearance.v1';
  // Conservative per-field fallback baseline used when normalizing existing or
  // partial stored preferences. Keeping this neutral (midnight / no surface
  // effect) means an existing user with a missing or retired field never gets a
  // surprise animated surface; brand-new users get DEFAULT_FRESH_APPEARANCE
  // below instead.
  var DEFAULT_APPEARANCE = {
    paletteId: 'midnight',
    typographyId: 'system',
    surfaceEffectId: 'none',
    composerHoloId: 'on',
    fontScaleId: 'default',
    chatWidthId: 'standard',
    // The boot curtain's starfield (status loader, 2026-09-29). Default on;
    // a record written before the field existed normalizes to on, which is
    // the whole migration: no other field changes, so it is lossless.
    startupAnimation: true,
    // The title bar's machine-load read-out (top chrome, 2026-09-29). Default
    // off; a record without the field normalizes to off, a lossless migration.
    // CPU, GPU and VRAM always stay in the health popover.
    titlebarLoad: false,
    artifactAutoOpen: false,
  };
  // DEFAULT_FRESH_APPEARANCE is for brand-new profiles; existing profiles retain
  // stored preferences, and its no-effect surface choice intentionally matches
  // the conservative baseline.
  var DEFAULT_FRESH_APPEARANCE = Object.assign({}, DEFAULT_APPEARANCE, {
    paletteId: 'slate',
    typographyId: 'technical',
  });
  // Type-scale generation stamped on every persisted record. Only the storage
  // load path migrates; a live UI choice is never remapped. Each entry maps a
  // stored fontScaleId written under generation N to its generation N+1 id;
  // an unstamped record is generation 1 and walks every step in order.
  //   Generation 2 (2026-09-28) rebased the role tokens ~17-20% larger, so a
  //   generation-1 record steps down one preset to keep roughly the size its
  //   owner picked.
  //   Generation 3 (2026-09-29) rebased the presets around the old Extra Large
  //   (1.2 is now Default, with one step either side) and retired `xlarge`.
  //   A generation-2 record keeps its multiplier where one still exists
  //   (xlarge -> default, large -> small); the two smaller old presets land on
  //   the new Small, the closest remaining size.
  var TYPE_SCALE_VERSION = 3;
  var FONT_SCALE_MIGRATIONS = {
    1: { xlarge: 'large', large: 'default' },
    2: { xlarge: 'default', large: 'small', default: 'small' },
  };
  var PALETTE_PRESETS = {
    midnight: {
      id: 'midnight',
      label: jt('appearance.palette.midnight.name', 'Midnight'),
      description: jt('appearance.palette.midnight.description', 'Current dark Jenny shell baseline.'),
    },
    pewter: {
      id: 'pewter',
      label: jt('appearance.palette.pewter.name', 'Pewter'),
      description: jt('appearance.palette.pewter.description', 'Tinted-charcoal monochrome with a quiet steel accent; vivid holo, syntax and live-cyan.'),
    },
    obsidian: {
      id: 'obsidian',
      label: jt('appearance.palette.obsidian.name', 'Obsidian'),
      description: jt('appearance.palette.obsidian.description', 'Deep rich-black surfaces with neutral seams and a single vivid cyan signal accent — high-contrast dark theme.'),
    },
    darkroom: {
      id: 'darkroom',
      label: jt('appearance.palette.darkroom.name', 'Darkroom'),
      description: jt('appearance.palette.darkroom.description', 'Matte warm near-black studio instrument — near-monochrome chalk-on-ink with a single muted lavender accent.'),
    },
    slate: {
      id: 'slate',
      label: jt('appearance.palette.slate.name', 'Slate'),
      description: jt('appearance.palette.slate.description', 'One solid slate canvas — no gradients, no background effect, no timeline shading; hairlines and spacing carry the structure, with a quiet ice-blue accent.'),
    },
    paper: {
      id: 'paper',
      label: jt('appearance.palette.paper.name', 'Paper'),
      description: jt('appearance.palette.paper.description', 'Light neutral surfaces with softer accents.'),
    },
    signal: {
      id: 'signal',
      label: jt('appearance.palette.signal.name', 'Signal'),
      description: jt('appearance.palette.signal.description', 'Sharper contrast with brighter accent energy.'),
    },
    woolly: {
      id: 'woolly',
      label: jt('appearance.palette.woolly.name', 'Woolly World'),
      description: jt('appearance.palette.woolly.description', 'Warm craft-paper tones with leaf green accents.'),
    },
    lexicon: {
      id: 'lexicon',
      label: jt('appearance.palette.lexicon.name', 'Lexicon'),
      description: jt('appearance.palette.lexicon.description', 'Dark editorial surfaces with text-forward glow accents.'),
    },
    rocko: {
      id: 'rocko',
      label: jt('appearance.palette.rocko.name', 'Retro Teal'),
      description: jt('appearance.palette.rocko.description', 'Dark teal surfaces with orange and hot-pink 90s cartoon energy.'),
    },
    'jenny-day': {
      id: 'jenny-day',
      label: jt('appearance.palette.jennyDay.name', 'Jenny XJ-9 — Daytime'),
      description: jt('appearance.palette.jennyDay.description', 'Cool icy teal-slate panels with Jenny-cyan body brand, dark-teal ink lines, and pigtail-amber and Brad-red pops.'),
    },
    'jenny-night': {
      id: 'jenny-night',
      label: jt('appearance.palette.jennyNight.name', 'Jenny XJ-9 — Night Patrol'),
      description: jt('appearance.palette.jennyNight.description', 'Deep blue-black combat sky with neon cyan eye-glow, hot pink, and pigtail yellow.'),
    },
  };
  var TYPOGRAPHY_PRESETS = {
    system: {
      id: 'system',
      label: jt('appearance.typography.system.name', 'System'),
      description: jt('appearance.typography.system.description', 'Segoe-forward UI stack for default shell readability.'),
    },
    editorial: {
      id: 'editorial',
      label: jt('appearance.typography.editorial.name', 'Editorial'),
      description: jt('appearance.typography.editorial.description', 'Serif-forward display feel with readable body fallback.'),
    },
    technical: {
      id: 'technical',
      label: jt('appearance.typography.technical.name', 'Technical'),
      description: jt('appearance.typography.technical.description', 'Utilitarian sans stack with stronger code/editor influence.'),
    },
  };
  /* Text size axis (independent of palette/typography family).
     `value` is the numeric multiplier applied to the --font-scale CSS variable;
     it scales every role font-size token app-wide: shell, chat, IDE chrome, and
     (through resolveCodeFontPx) the code editors, terminal, and diagrams.
     Default is 1.2 (the owner found 1.0 too small; 2026-09-29), with one
     0.1 step either side; styles/foundation.css seeds the same 1.2 so the
     pre-script paint matches. */
  var FONT_SCALE_PRESETS = {
    small: {
      id: 'small',
      label: jt('appearance.typography.fontScale.small.name', 'Small'),
      description: jt('appearance.typography.fontScale.small.description', 'Denser text for more on screen.'),
      value: 1.1,
    },
    default: {
      id: 'default',
      label: jt('appearance.typography.fontScale.default.name', 'Default'),
      description: jt('appearance.typography.fontScale.default.description', 'Standard Jenny text size.'),
      value: 1.2,
    },
    large: {
      id: 'large',
      label: jt('appearance.typography.fontScale.large.name', 'Large'),
      description: jt('appearance.typography.fontScale.large.description', 'Larger, easier-to-read text.'),
      value: 1.3,
    },
  };
  /* Chat reading-measure axis (independent of palette, typography, and the
     chat zoom factor). `standard` (the default, owner 2026-10-02) raises the
     transcript + composer cap from the 760px `narrow` base to 1100px by
     swapping --chat-measure-max; the geometry lives in styles/foundation.css
     under :root[data-chat-width="standard"]. Palette files set only color
     tokens, so this axis is palette-agnostic by construction. */
  var CHAT_WIDTH_PRESETS = {
    narrow: {
      id: 'narrow',
      label: jt('appearance.typography.chatWidth.narrow.name', 'Narrow'),
      description: jt('appearance.typography.chatWidth.narrow.description', 'Shorter lines, capped at 760px.'),
    },
    standard: {
      id: 'standard',
      label: jt('appearance.typography.chatWidth.standard.name', 'Standard'),
      description: jt('appearance.typography.chatWidth.standard.description', 'Roomy reading measure, capped at 1100px.'),
    },
  };
  /* Ids stored before the 2026-10-02 rename. `default` was written for every
     profile whether or not the user chose it, so both old ids land on the new
     Standard default; Narrow is one click away. */
  var LEGACY_CHAT_WIDTH_IDS = { default: 'standard', wide: 'standard' };
  var SURFACE_EFFECT_PRESETS = {
    none: {
      id: 'none',
      label: jt('appearance.effect.surface.none.name', 'None'),
      description: jt('appearance.effect.surface.none.description', 'No background surface effect.'),
    },
    'reactive-grid': {
      id: 'reactive-grid',
      label: jt('appearance.effect.surface.reactiveGrid.name', 'Reactive Grid'),
      description: jt('appearance.effect.surface.reactiveGrid.description', 'Animated dot grid that responds to pointer movement.'),
      contractVersion: 3,
      inputMode: 'manager',
      // Owner direction 2026-09-30: the grid answers the pointer, never the model.
      activityMode: 'none',
      renderer: 'canvas2d',
      interaction: Object.freeze({ hover: true, click: true, press: false, captureOnPress: false }),
      costClass: 'medium',
      paletteSupport: 'all',
      recommendedPalettes: Object.freeze([]),
      requiredTokens: Object.freeze([
        '--widget-reactive-grid-dot-idle',
        '--widget-reactive-grid-dot-active',
      ]),
      freshInstallCandidate: false,
    },
    'playlist-scroll': {
      id: 'playlist-scroll',
      label: jt('appearance.effect.surface.playlistScroll.name', 'Playlist Scroll'),
      description: jt('appearance.effect.surface.playlistScroll.description', 'Music-sequencer arrangement backdrop with scrolling lanes and bar markers.'),
      contractVersion: 3,
      inputMode: 'manager',
      // Owner direction 2026-09-30: background effects never react to the model.
      activityMode: 'none',
      renderer: 'canvas2d',
      interaction: Object.freeze({ hover: true, click: true, press: true, captureOnPress: true }),
      costClass: 'low',
      paletteSupport: 'all',
      recommendedPalettes: Object.freeze([]),
      requiredTokens: Object.freeze([
        '--playlist-scroll-line-color',
        '--playlist-scroll-lane-alpha',
        '--playlist-scroll-bar-alpha',
        '--playlist-scroll-ghost-color',
        '--playlist-scroll-accent-color',
        '--playlist-scroll-lane-height',
        '--playlist-scroll-subdivisions',
        '--playlist-scroll-bar-width',
        '--playlist-scroll-speed',
        '--playlist-scroll-sub-alpha',
        '--playlist-scroll-edge-fade',
        '--playlist-scroll-contrast',
      ]),
      freshInstallCandidate: false,
    },
    'atomic-burst': {
      id: 'atomic-burst',
      label: jt('appearance.effect.surface.atomicBurst.name', 'Atomic Burst'),
      description: jt('appearance.effect.surface.atomicBurst.description', 'Sparse Y2K twinkles that breathe and flare under the pointer — XJ-9 sparkle field.'),
      contractVersion: 3,
      inputMode: 'manager',
      // Owner direction 2026-09-30: background effects never react to the model.
      activityMode: 'none',
      renderer: 'canvas2d',
      interaction: Object.freeze({ hover: true, click: true, press: false, captureOnPress: false }),
      costClass: 'medium',
      paletteSupport: 'all',
      recommendedPalettes: Object.freeze([]),
      requiredTokens: Object.freeze([
        '--widget-atomic-burst-color-a',
        '--widget-atomic-burst-color-b',
        '--widget-atomic-burst-color-c',
        '--widget-atomic-burst-flare-color',
        '--widget-atomic-burst-link-color',
        '--widget-atomic-burst-wave-color',
        '--widget-atomic-burst-link-radius',
        '--widget-atomic-burst-link-max',
        '--widget-atomic-burst-wave-lifetime',
      ]),
      freshInstallCandidate: false,
    },
    'circuit-trace': {
      id: 'circuit-trace',
      label: jt('appearance.effect.surface.circuitTrace.name', 'Circuit Trace'),
      description: jt('appearance.effect.surface.circuitTrace.description', 'Routed circuit board: hover probes a signal, click sends current node to node.'),
      contractVersion: 3,
      inputMode: 'manager',
      // Owner direction 2026-09-30: background effects never react to the model.
      activityMode: 'none',
      renderer: 'canvas2d',
      interaction: Object.freeze({ hover: true, click: true, press: false, captureOnPress: false }),
      costClass: 'high',
      paletteSupport: 'all',
      recommendedPalettes: Object.freeze(['obsidian']),
      requiredTokens: Object.freeze([
        '--widget-circuit-trace-grid-color',
        '--widget-circuit-trace-line-color',
        '--widget-circuit-trace-glow-color',
        '--widget-circuit-trace-accent-color',
        '--widget-circuit-trace-inner-color',
        '--widget-circuit-trace-shadow-color',
        '--widget-circuit-trace-pitch',
        '--widget-circuit-trace-density',
        '--widget-circuit-trace-speed',
      ]),
      // No effect preset is a fresh-install candidate while the fresh default uses no surface effect.
      freshInstallCandidate: false,
    },
    'context-weave': {
      id: 'context-weave',
      label: jt('appearance.effect.surface.contextWeave.name', 'Context Weave'),
      description: jt('appearance.effect.surface.contextWeave.description', 'A woven cloth of warp and weft threads that catches the light around your pointer; click to pluck a thread.'),
      contractVersion: 3,
      inputMode: 'manager',
      // Owner direction 2026-09-30: background effects never react to the model.
      activityMode: 'none',
      renderer: 'canvas2d',
      // The static lattice has no press interaction because there is no spring simulation to gather beneath a held pointer.
      interaction: Object.freeze({ hover: true, click: true, press: false, captureOnPress: false }),
      costClass: 'low',
      paletteSupport: 'all',
      recommendedPalettes: Object.freeze([]),
      requiredTokens: Object.freeze([
        '--widget-context-weave-line-color',
        '--widget-context-weave-spacing',
        '--widget-context-weave-density',
        '--widget-context-weave-pointer-radius',
        '--widget-context-weave-interlace',
        '--widget-context-weave-weft-alpha',
        '--widget-context-weave-lit-gain',
        '--widget-context-weave-motion-scale',
      ]),
      freshInstallCandidate: false,
    },
  };

  var COMPOSER_HOLO_OPTIONS = {
    off: {
      id: 'off',
      label: jt('appearance.effect.composerHolo.off.name', 'Off'),
      description: jt('appearance.effect.composerHolo.off.description', 'Disable the holographic typing border.'),
    },
    on: {
      id: 'on',
      label: jt('appearance.effect.composerHolo.on.name', 'On'),
      description: jt('appearance.effect.composerHolo.on.description', 'Show a cycling holographic gradient border on the chat input bar while typing.'),
    },
  };

  var COMPOSER_HOLO_CSS_VARIABLES = {
    off: {
      '--composer-holo-opacity-idle': '0',
      '--composer-holo-opacity-hover': '0',
      '--composer-holo-opacity-active': '0',
      '--composer-holo-opacity-streaming': '0',
      '--composer-holo-border-width-idle': '0px',
      '--composer-holo-border-width-active': '0px',
      '--composer-holo-filter-idle': 'none',
      '--composer-holo-filter-active': 'none',
      '--composer-holo-shell-ring-strength': '0%',
      '--composer-holo-shell-glow-strength': '0%',
      '--composer-holo-draw-enabled': '0',
      '--composer-holo-draw-stroke-scale': '0',
      '--composer-holo-draw-glow-scale': '0',
      '--composer-holo-draw-alpha-scale': '0',
      '--composer-holo-draw-glow-alpha-scale': '0',
    },
    on: {
      '--composer-holo-opacity-idle': '1',
      '--composer-holo-opacity-hover': '1',
      '--composer-holo-opacity-active': '1',
      '--composer-holo-opacity-streaming': '1',
      '--composer-holo-border-width-idle': '2px',
      '--composer-holo-border-width-active': '2px',
      '--composer-holo-filter-idle': 'none',
      '--composer-holo-filter-active': 'none',
      '--composer-holo-shell-ring-strength': '22%',
      '--composer-holo-shell-glow-strength': '13%',
      '--composer-holo-draw-enabled': '1',
      '--composer-holo-draw-stroke-scale': '1',
      '--composer-holo-draw-glow-scale': '1',
      '--composer-holo-draw-alpha-scale': '1',
      '--composer-holo-draw-glow-alpha-scale': '1',
    },
  };

  var LEGACY_THREAD_STYLE_VARIABLE_NAMES = [
    '--thread-dot-size',
    '--thread-dot-hit-size',
    '--thread-rail-width',
    '--thread-rail-opacity',
    '--thread-node-gap',
  ];

  var THREAD_HOLO_SCALE = {
    off: 0.42,
    on: 1,
  };

  var THEME_BUNDLES = {
    'jenny-default': {
      id: 'jenny-default',
      label: jt('appearance.palette.jennyDefaultTheme.name', 'Jenny Default'),
      description: jt('appearance.palette.jennyDefaultTheme.description', 'Current Jenny shell baseline bundle.'),
      preferences: Object.assign({}, DEFAULT_FRESH_APPEARANCE),
    },
    pewter: {
      id: 'pewter',
      label: jt('appearance.palette.pewterTheme.name', 'Pewter'),
      description: jt('appearance.palette.pewterTheme.description', 'Tinted-charcoal monochrome with a quiet steel accent and vivid expressive layer.'),
      preferences: {
        paletteId: 'pewter',
        typographyId: 'technical',
        surfaceEffectId: 'none',
        composerHoloId: 'on',
      },
    },
    obsidian: {
      id: 'obsidian',
      label: jt('appearance.palette.obsidianTheme.name', 'Obsidian'),
      description: jt('appearance.palette.obsidianTheme.description', 'Deep rich-black surfaces with vivid cyan accents — high-contrast dark theme.'),
      preferences: {
        paletteId: 'obsidian',
        typographyId: 'technical',
        surfaceEffectId: 'none',
        composerHoloId: 'on',
      },
    },
    slate: {
      id: 'slate',
      label: jt('appearance.palette.slateTheme.name', 'Slate'),
      description: jt('appearance.palette.slateTheme.description', 'Blank-space reading surface — flat dark canvas, no ambient background effect, crisp ice-blue holo accents.'),
      preferences: {
        paletteId: 'slate',
        typographyId: 'system',
        surfaceEffectId: 'none',
        composerHoloId: 'on',
      },
    },
    lexicon: {
      id: 'lexicon',
      label: jt('appearance.palette.lexiconTheme.name', 'Lexicon'),
      description: jt('appearance.palette.lexiconTheme.description', 'Dark editorial palette with a quiet, text-forward chrome.'),
      preferences: {
        paletteId: 'lexicon',
        typographyId: 'editorial',
        surfaceEffectId: 'none',
        composerHoloId: 'on',
      },
    },
    rocko: {
      id: 'rocko',
      label: jt('appearance.palette.rockoTheme.name', 'Retro Teal'),
      description: jt('appearance.palette.rockoTheme.description', 'Teal + orange 90s palette with a bright, playful shell.'),
      preferences: {
        paletteId: 'rocko',
        typographyId: 'system',
        surfaceEffectId: 'none',
        composerHoloId: 'on',
      },
    },
    'jenny-day': {
      id: 'jenny-day',
      label: jt('appearance.palette.jennyDayTheme.name', 'Jenny XJ-9 — Daytime'),
      description: jt('appearance.palette.jennyDayTheme.description', 'Cool icy teal slate with Jenny-cyan brand and bold dark-teal ink — bright daytime mood with twinkling sparkles.'),
      preferences: {
        paletteId: 'jenny-day',
        typographyId: 'system',
        surfaceEffectId: 'atomic-burst',
        composerHoloId: 'on',
      },
    },
    'jenny-night': {
      id: 'jenny-night',
      label: jt('appearance.palette.jennyNightTheme.name', 'Jenny XJ-9 — Night Patrol'),
      description: jt('appearance.palette.jennyNightTheme.description', 'Magenta-led combat sky with violet undertones and circuit-trace HUD overlay.'),
      preferences: {
        paletteId: 'jenny-night',
        typographyId: 'technical',
        surfaceEffectId: 'circuit-trace',
        composerHoloId: 'on',
      },
    },
  };

  function clonePresetCollection(collection) {
    return Object.keys(collection).map(function mapPreset(key) {
      return Object.assign({}, collection[key]);
    });
  }

  function getDefaultAppearancePreferences() {
    return Object.assign({}, DEFAULT_FRESH_APPEARANCE);
  }

  function normalizePresetId(value, collection, fallback) {
    var token = String(value || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(collection, token) ? token : fallback;
  }

  function normalizeChatWidthId(value) {
    var token = String(value || '').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LEGACY_CHAT_WIDTH_IDS, token)) return LEGACY_CHAT_WIDTH_IDS[token];
    return normalizePresetId(token, CHAT_WIDTH_PRESETS, DEFAULT_APPEARANCE.chatWidthId);
  }

  function normalizeBinaryHoloId(value) {
    var token = String(value || '').trim().toLowerCase();
    return token === 'off' ? 'off' : 'on';
  }

  function normalizeAppearancePreferences(raw) {
    // spriteHoloId is still accepted in stored preferences and ignored: the
    // sprite holo was retired 2026-10-02.
    var source = raw && typeof raw === 'object' ? raw : {};
    return {
      paletteId: normalizePresetId(source.paletteId, PALETTE_PRESETS, DEFAULT_APPEARANCE.paletteId),
      typographyId: normalizePresetId(
        source.typographyId,
        TYPOGRAPHY_PRESETS,
        DEFAULT_APPEARANCE.typographyId
      ),
      surfaceEffectId: normalizePresetId(source.surfaceEffectId, SURFACE_EFFECT_PRESETS, DEFAULT_APPEARANCE.surfaceEffectId),
      composerHoloId: normalizeBinaryHoloId(source.composerHoloId),
      fontScaleId: normalizePresetId(source.fontScaleId, FONT_SCALE_PRESETS, DEFAULT_APPEARANCE.fontScaleId),
      chatWidthId: normalizeChatWidthId(source.chatWidthId),
      startupAnimation: source.startupAnimation === false ? false : DEFAULT_APPEARANCE.startupAnimation,
      titlebarLoad: source.titlebarLoad === true,
      artifactAutoOpen: source.artifactAutoOpen === true,
    };
  }

  // Persisted copies carry the type-scale stamp; in-memory preferences do not.
  function stampTypeScale(preferences) {
    return Object.assign({}, preferences, { typeScaleVersion: TYPE_SCALE_VERSION });
  }

  // Storage-boundary migration for records written under an earlier
  // type-scale generation. Idempotent: a current-generation record passes
  // through untouched; an older one walks FONT_SCALE_MIGRATIONS from its
  // generation up to the current one.
  function migrateStoredAppearancePreferences(raw) {
    var source = raw && typeof raw === 'object' ? raw : {};
    var storedVersion = Number(source.typeScaleVersion);
    if (storedVersion >= TYPE_SCALE_VERSION) {
      return normalizeAppearancePreferences(source);
    }
    var generation = Number.isFinite(storedVersion) && storedVersion >= 1 ? Math.floor(storedVersion) : 1;
    var fontScaleId = String(source.fontScaleId || '').trim().toLowerCase();
    for (; generation < TYPE_SCALE_VERSION; generation += 1) {
      var step = FONT_SCALE_MIGRATIONS[generation];
      if (step && Object.prototype.hasOwnProperty.call(step, fontScaleId)) {
        fontScaleId = step[fontScaleId];
      }
    }
    var migrated = Object.assign({}, source, { fontScaleId: fontScaleId });
    return normalizeAppearancePreferences(migrated);
  }

  function getPalettePresets() {
    return clonePresetCollection(PALETTE_PRESETS);
  }

  function getTypographyPresets() {
    return clonePresetCollection(TYPOGRAPHY_PRESETS);
  }

  function getFontScalePresets() {
    return clonePresetCollection(FONT_SCALE_PRESETS);
  }

  function resolveFontScaleValue(fontScaleId) {
    var preset = FONT_SCALE_PRESETS[fontScaleId] || FONT_SCALE_PRESETS[DEFAULT_APPEARANCE.fontScaleId];
    return preset.value;
  }

  function getChatWidthPresets() {
    return clonePresetCollection(CHAT_WIDTH_PRESETS);
  }

  function getSurfaceEffectPresets() {
    return clonePresetCollection(SURFACE_EFFECT_PRESETS);
  }

  function getComposerHoloOptions() {
    return clonePresetCollection(COMPOSER_HOLO_OPTIONS);
  }

  function cloneThemeBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') {
      return null;
    }
    return {
      id: bundle.id,
      label: bundle.label,
      description: bundle.description,
      preferences: normalizeAppearancePreferences(bundle.preferences),
    };
  }

  function getThemeBundles() {
    return Object.keys(THEME_BUNDLES).map(function mapBundle(key) {
      return cloneThemeBundle(THEME_BUNDLES[key]);
    });
  }

  function resolveThemeBundle(bundleId) {
    var normalizedId = String(bundleId || '').trim().toLowerCase();
    if (!normalizedId || !Object.prototype.hasOwnProperty.call(THEME_BUNDLES, normalizedId)) {
      return null;
    }
    return cloneThemeBundle(THEME_BUNDLES[normalizedId]);
  }

  // Theme bundles own coordinated palette, typography, surface, and Composer
  // effect choices. They do not own fontScaleId or chatWidthId --
  // normalizeAppearancePreferences() fills every missing field with
  // DEFAULT_APPEARANCE's value regardless, so a naive "apply the bundle's
  // full normalized preferences" (or "compare every normalized field")
  // silently reset a non-default text size back to Default on every bundle
  // switch. Keep this list in sync with what THEME_BUNDLES
  // entries actually set.
  var THEME_BUNDLE_APPLY_AXES = [
    'paletteId',
    'typographyId',
    'surfaceEffectId',
    'composerHoloId',
  ];

  // Project a (possibly partial) preferences object down to only the
  // documented bundle axes, normalized. Used to APPLY a bundle (merge onto
  // -- never replace -- the caller's current preferences), so a bundle
  // switch never touches fontScaleId/chatWidthId (no bundle defines either,
  // but normalizeAppearancePreferences fills them regardless).
  function pickThemeBundleAxes(preferences) {
    var normalized = normalizeAppearancePreferences(preferences);
    var picked = {};
    THEME_BUNDLE_APPLY_AXES.forEach(function pickAxis(key) {
      picked[key] = normalized[key];
    });
    return picked;
  }

  function bundleMatchesPreferences(bundle, preferences) {
    if (!bundle || !preferences) {
      return false;
    }
    var normalizedBundlePreferences = normalizeAppearancePreferences(bundle.preferences);
    var normalizedPreferences = normalizeAppearancePreferences(preferences);
    return THEME_BUNDLE_APPLY_AXES.every(function axisMatches(key) {
      return normalizedBundlePreferences[key] === normalizedPreferences[key];
    });
  }

  function detectActiveThemeBundle(preferences) {
    var normalizedPreferences = normalizeAppearancePreferences(preferences);
    var bundleKeys = Object.keys(THEME_BUNDLES);
    for (var index = 0; index < bundleKeys.length; index += 1) {
      var bundle = THEME_BUNDLES[bundleKeys[index]];
      if (bundleMatchesPreferences(bundle, normalizedPreferences)) {
        return cloneThemeBundle(bundle);
      }
    }
    return null;
  }

  function resolveRootElement(docOrRoot) {
    if (!docOrRoot) {
      return null;
    }
    if (docOrRoot.documentElement && docOrRoot.documentElement.dataset) {
      return docOrRoot.documentElement;
    }
    if (docOrRoot.dataset) {
      return docOrRoot;
    }
    return null;
  }

  function applyCssVariables(target, variables) {
    if (!target || !target.style || typeof target.style.setProperty !== 'function' || !variables) {
      return;
    }
    Object.keys(variables).forEach(function applyVariable(name) {
      target.style.setProperty(name, variables[name]);
    });
  }

  function buildThreadAppearanceVariables(normalized) {
    var composerScale = THREAD_HOLO_SCALE[normalized.composerHoloId] || THREAD_HOLO_SCALE[DEFAULT_APPEARANCE.composerHoloId];
    return {
      '--thread-holo-scale': String(composerScale),
    };
  }

  function applyAppearanceToDocument(docOrRoot, preferences) {
    var normalized = normalizeAppearancePreferences(preferences);
    var rootElement = resolveRootElement(docOrRoot);
    if (!rootElement) {
      return normalized;
    }
    rootElement.dataset.palette = normalized.paletteId;
    rootElement.dataset.typography = normalized.typographyId;
    rootElement.dataset.motion = 'standard';
    rootElement.dataset.surfaceEffect = normalized.surfaceEffectId;
    rootElement.dataset.composerHolo = normalized.composerHoloId;
    rootElement.dataset.threadStyle = 'subtle';
    rootElement.dataset.fontScale = normalized.fontScaleId;
    rootElement.dataset.chatWidth = normalized.chatWidthId;
    // Read by the boot curtain (renderer-lifecycle-progress-utils.js) at mount;
    // theme-bootstrap.js applies this before first paint.
    rootElement.dataset.startupAnimation = normalized.startupAnimation ? 'on' : 'off';
    // Not styled: it lets the portable-preferences sync observer see the change.
    rootElement.dataset.titlebarLoad = normalized.titlebarLoad ? 'on' : 'off';
    rootElement.dataset.artifactAutoOpen = normalized.artifactAutoOpen ? 'on' : 'off';
    if (typeof rootElement.style?.removeProperty === 'function') {
      LEGACY_THREAD_STYLE_VARIABLE_NAMES.forEach(function removeLegacyThreadVariable(name) {
        rootElement.style.removeProperty(name);
      });
    }
    applyCssVariables(rootElement, COMPOSER_HOLO_CSS_VARIABLES[normalized.composerHoloId]);
    applyCssVariables(rootElement, buildThreadAppearanceVariables(normalized));
    applyCssVariables(rootElement, {
      '--font-scale': String(resolveFontScaleValue(normalized.fontScaleId)),
    });
    return normalized;
  }

  function loadAppearancePreferences(storage) {
    try {
      if (!storage || typeof storage.getItem !== 'function') {
        return getDefaultAppearancePreferences();
      }
      var raw = storage.getItem(STORAGE_KEY);
      if (!raw) {
        var legacyRaw = storage.getItem(LEGACY_STORAGE_KEY);
        if (legacyRaw) {
          var migrated = migrateStoredAppearancePreferences(JSON.parse(legacyRaw));
          try {
            storage.setItem(STORAGE_KEY, JSON.stringify(stampTypeScale(migrated)));
            if (typeof storage.removeItem === 'function') storage.removeItem(LEGACY_STORAGE_KEY);
          } catch (_migrationError) {
            // The normalized legacy value remains usable for this run. A later
            // successful save retries the v2 write and legacy cleanup.
          }
          return migrated;
        }
      }
      if (!raw) {
        return getDefaultAppearancePreferences();
      }
      var parsed = JSON.parse(raw);
      var loaded = migrateStoredAppearancePreferences(parsed);
      if (!(parsed && Number(parsed.typeScaleVersion) >= TYPE_SCALE_VERSION)) {
        try {
          storage.setItem(STORAGE_KEY, JSON.stringify(stampTypeScale(loaded)));
        } catch (_stampError) {
          // The migrated value is still used for this run and the next save
          // stamps it. Until then the unstamped record re-migrates to the
          // same result on every load.
        }
      }
      return loaded;
    } catch (error) {
      return getDefaultAppearancePreferences();
    }
  }

  function getAppearanceToggleFields({ jt, composerHoloOption, appearancePreferences, startupAnimationFlagOff }) {
    return [
      { id: 'appearanceComposerHoloToggle', label: jt('settings.appearance.holographicTypingBorderLabel', 'Holographic typing border'), checked: composerHoloOption.id !== 'off' },
      { id: 'appearanceStartupAnimationToggle', checked: appearancePreferences.startupAnimation !== false, disabled: startupAnimationFlagOff },
      { id: 'appearanceTitlebarLoadToggle', checked: appearancePreferences.titlebarLoad === true },
    ];
  }

  function saveAppearancePreferences(storage, preferences) {
    var normalized = normalizeAppearancePreferences(preferences);
    if (!storage || typeof storage.setItem !== 'function') {
      return normalized;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(stampTypeScale(normalized)));
    if (typeof storage.removeItem === 'function') {
      try {
        storage.removeItem(LEGACY_STORAGE_KEY);
      } catch (_cleanupError) {
        // The canonical v2 write is already committed. Legacy cleanup is
        // best-effort and will be retried by a later successful save.
      }
    }
    return normalized;
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    LEGACY_STORAGE_KEY: LEGACY_STORAGE_KEY,
    applyAppearanceToDocument: applyAppearanceToDocument,
    getDefaultAppearancePreferences: getDefaultAppearancePreferences,
    getComposerHoloOptions: getComposerHoloOptions,
    getAppearanceToggleFields: getAppearanceToggleFields,
    getPalettePresets: getPalettePresets,
    getSurfaceEffectPresets: getSurfaceEffectPresets,
    getThemeBundles: getThemeBundles,
    pickThemeBundleAxes: pickThemeBundleAxes,
    getTypographyPresets: getTypographyPresets,
    getFontScalePresets: getFontScalePresets,
    getChatWidthPresets: getChatWidthPresets,
    loadAppearancePreferences: loadAppearancePreferences,
    normalizeAppearancePreferences: normalizeAppearancePreferences,
    migrateStoredAppearancePreferences: migrateStoredAppearancePreferences,
    stampTypeScale: stampTypeScale,
    TYPE_SCALE_VERSION: TYPE_SCALE_VERSION,
    detectActiveThemeBundle: detectActiveThemeBundle,
    resolveThemeBundle: resolveThemeBundle,
    saveAppearancePreferences: saveAppearancePreferences,
  };
});
