(function exposeAppearanceUtils(globalScope, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  if (globalScope && typeof globalScope === 'object') {
    globalScope.appearanceUtils = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function appearanceUtilsFactory() {
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
    timelineStyleId: 'default',
    fontScaleId: 'default',
    chatWidthId: 'default',
  };
  // DEFAULT_FRESH_APPEARANCE is for brand-new profiles; existing profiles retain
  // stored preferences, and its no-effect surface choice intentionally matches
  // the conservative baseline.
  var DEFAULT_FRESH_APPEARANCE = Object.assign({}, DEFAULT_APPEARANCE, {
    paletteId: 'slate',
    typographyId: 'technical',
    fontScaleId: 'xlarge',
  });
  var PALETTE_PRESETS = {
    midnight: {
      id: 'midnight',
      label: 'Midnight',
      description: 'Current dark Jenny shell baseline.',
    },
    pewter: {
      id: 'pewter',
      label: 'Pewter',
      description: 'Tinted-charcoal monochrome with a quiet steel accent; vivid holo, syntax and live-cyan.',
    },
    obsidian: {
      id: 'obsidian',
      label: 'Obsidian',
      description: 'Deep rich-black surfaces with neutral seams and a single vivid cyan signal accent — high-contrast dark theme.',
    },
    darkroom: {
      id: 'darkroom',
      label: 'Darkroom',
      description: 'Matte warm near-black studio instrument — near-monochrome chalk-on-ink with a single muted lavender accent.',
    },
    slate: {
      id: 'slate',
      label: 'Slate',
      description: 'One solid slate canvas — no gradients, no background effect, no timeline shading; hairlines and spacing carry the structure, with a quiet ice-blue accent.',
    },
    paper: {
      id: 'paper',
      label: 'Paper',
      description: 'Light neutral surfaces with softer accents.',
    },
    signal: {
      id: 'signal',
      label: 'Signal',
      description: 'Sharper contrast with brighter accent energy.',
    },
    woolly: {
      id: 'woolly',
      label: 'Woolly World',
      description: 'Warm craft-paper tones with leaf green accents.',
    },
    lexicon: {
      id: 'lexicon',
      label: 'Lexicon',
      description: 'Dark editorial surfaces with text-forward glow accents.',
    },
    rocko: {
      id: 'rocko',
      label: 'Retro Teal',
      description: 'Dark teal surfaces with orange and hot-pink 90s cartoon energy.',
    },
    'jenny-day': {
      id: 'jenny-day',
      label: 'Jenny XJ-9 — Daytime',
      description: 'Cool icy teal-slate panels with Jenny-cyan body brand, dark-teal ink lines, and pigtail-amber and Brad-red pops.',
    },
    'jenny-night': {
      id: 'jenny-night',
      label: 'Jenny XJ-9 — Night Patrol',
      description: 'Deep blue-black combat sky with neon cyan eye-glow, hot pink, and pigtail yellow.',
    },
  };
  var TYPOGRAPHY_PRESETS = {
    system: {
      id: 'system',
      label: 'System',
      description: 'Segoe-forward UI stack for default shell readability.',
    },
    editorial: {
      id: 'editorial',
      label: 'Editorial',
      description: 'Serif-forward display feel with readable body fallback.',
    },
    technical: {
      id: 'technical',
      label: 'Technical',
      description: 'Utilitarian sans stack with stronger code/editor influence.',
    },
  };
  /* Typography-scale axis (independent of palette/typography family).
     `value` is the numeric multiplier applied to the --font-scale CSS variable;
     it scales the app-shell font-size tokens. The chat column is governed by its
     own --chat-zoom-factor and is intentionally not affected. */
  var FONT_SCALE_PRESETS = {
    small: {
      id: 'small',
      label: 'Small',
      description: 'Denser shell text for more on screen.',
      value: 0.85,
    },
    default: {
      id: 'default',
      label: 'Default',
      description: 'Standard Jenny text size.',
      value: 1,
    },
    large: {
      id: 'large',
      label: 'Large',
      description: 'Larger, easier-to-read shell text.',
      value: 1.15,
    },
    xlarge: {
      id: 'xlarge',
      label: 'Extra Large',
      description: 'Maximum shell text size.',
      value: 1.3,
    },
  };
  /* Chat reading-measure axis (independent of palette, typography, and the
     chat zoom factor). `wide` raises the transcript + composer cap from 760px
     to 1100px by swapping --chat-measure-max; the actual geometry lives in
     styles/foundation.css under :root[data-chat-width="wide"]. Palette files
     set only color tokens, so this axis is palette-agnostic by construction. */
  var CHAT_WIDTH_PRESETS = {
    default: {
      id: 'default',
      label: 'Default',
      description: 'Standard 760px reading measure.',
    },
    wide: {
      id: 'wide',
      label: 'Wide',
      description: 'Roughly 45% more text per line, capped at 1100px.',
    },
  };
  var SURFACE_EFFECT_PRESETS = {
    none: {
      id: 'none',
      label: 'None',
      description: 'No background surface effect.',
    },
    'reactive-grid': {
      id: 'reactive-grid',
      label: 'Reactive Grid',
      description: 'Animated dot grid that responds to pointer movement.',
      contractVersion: 3,
      inputMode: 'manager',
      activityMode: 'native',
      renderer: 'canvas2d',
      interaction: Object.freeze({ hover: true, click: true, press: false, captureOnPress: false }),
      costClass: 'medium',
      paletteSupport: 'all',
      recommendedPalettes: Object.freeze([]),
      requiredTokens: Object.freeze([
        '--widget-reactive-grid-dot-idle',
        '--widget-reactive-grid-dot-active',
        '--widget-reactive-grid-dot-glow',
      ]),
      freshInstallCandidate: false,
    },
    'playlist-scroll': {
      id: 'playlist-scroll',
      label: 'Playlist Scroll',
      description: 'Music-sequencer arrangement backdrop with scrolling lanes and bar markers.',
      contractVersion: 3,
      inputMode: 'manager',
      activityMode: 'native',
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
        '--playlist-scroll-band-alpha',
        '--playlist-scroll-edge-fade',
      ]),
      freshInstallCandidate: false,
    },
    'atomic-burst': {
      id: 'atomic-burst',
      label: 'Atomic Burst',
      description: 'Sparse Y2K twinkles that breathe and flare under the pointer — XJ-9 sparkle field.',
      contractVersion: 3,
      inputMode: 'manager',
      activityMode: 'native',
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
        '--widget-atomic-burst-bloom',
        '--widget-atomic-burst-link-radius',
        '--widget-atomic-burst-link-max',
        '--widget-atomic-burst-wave-speed',
        '--widget-atomic-burst-wave-lifetime',
      ]),
      freshInstallCandidate: false,
    },
    'circuit-trace': {
      id: 'circuit-trace',
      label: 'Circuit Trace',
      description: 'Faint hex grid with flowing trace heads — XJ-9 internal HUD / motherboard.',
      contractVersion: 3,
      inputMode: 'manager',
      activityMode: 'native',
      renderer: 'canvas2d',
      interaction: Object.freeze({ hover: true, click: true, press: true, captureOnPress: true }),
      costClass: 'high',
      paletteSupport: 'all',
      recommendedPalettes: Object.freeze(['obsidian']),
      requiredTokens: Object.freeze([
        '--widget-circuit-trace-grid-color',
        '--widget-circuit-trace-line-color',
        '--widget-circuit-trace-glow-color',
        '--widget-circuit-trace-accent-color',
        '--widget-circuit-trace-version',
        '--widget-circuit-trace-hex-size',
        '--widget-circuit-trace-density',
        '--widget-circuit-trace-trail-length',
        '--widget-circuit-trace-speed',
        '--widget-circuit-trace-bloom',
        '--widget-circuit-trace-lift-px',
        '--widget-circuit-trace-energy',
      ]),
      // No effect preset is a fresh-install candidate while the fresh default uses no surface effect.
      freshInstallCandidate: false,
    },
    'context-weave': {
      id: 'context-weave',
      label: 'Context Weave',
      description: 'A woven cloth of warp and weft threads that catches the light around your pointer; click to pluck a thread.',
      contractVersion: 3,
      inputMode: 'manager',
      activityMode: 'native',
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
      ]),
      freshInstallCandidate: false,
    },
  };

  var COMPOSER_HOLO_OPTIONS = {
    off: {
      id: 'off',
      label: 'Off',
      description: 'Disable the holographic typing border.',
    },
    on: {
      id: 'on',
      label: 'On',
      description: 'Show a cycling holographic gradient border on the chat input bar while typing.',
    },
  };

  var TIMELINE_STYLE_PRESETS = {
    // explorer-minimal was retired by the 2026-07-05 quiet-timeline overhaul
    // (per-row one-liners superseded its coalesced runs). normalizePresetId
    // maps any persisted 'explorer-minimal' preference back to 'default'.
    default: {
      id: 'default',
      label: 'Default',
      description: 'Standard chat row timeline.',
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

  var DISABLED_SPRITE_HOLO_CSS_VARIABLES = {
    '--sprite-holo-opacity-idle': '0',
    '--sprite-holo-filter-idle': 'none',
    '--sprite-holo-ring-width-idle': '0px',
    '--sprite-holo-shadow-idle':
      '0 10px 22px rgba(0, 0, 0, 0.2), inset 0 1px 0 color-mix(in srgb, var(--text-primary) 8%, transparent)',
    '--sprite-holo-opacity-streaming': '0',
    '--sprite-holo-filter-streaming': 'none',
    '--sprite-holo-ring-width-streaming': '0px',
    '--sprite-holo-shadow-streaming':
      '0 0 0 1px rgba(0, 0, 0, 0.2), 0 10px 22px rgba(109, 130, 255, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
    '--sprite-holo-border-width': '0px',
    '--sprite-holo-draw-enabled': '0',
    '--sprite-holo-draw-stroke-scale': '0',
    '--sprite-holo-draw-glow-scale': '0',
    '--sprite-holo-draw-alpha-scale': '0',
    '--sprite-holo-draw-glow-alpha-scale': '0',
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
      label: 'Jenny Default',
      description: 'Current Jenny shell baseline bundle.',
      preferences: Object.assign({}, DEFAULT_FRESH_APPEARANCE),
    },
    pewter: {
      id: 'pewter',
      label: 'Pewter',
      description: 'Tinted-charcoal monochrome with a quiet steel accent and vivid expressive layer.',
      preferences: {
        paletteId: 'pewter',
        typographyId: 'technical',
        surfaceEffectId: 'none',
        composerHoloId: 'on',
      },
    },
    obsidian: {
      id: 'obsidian',
      label: 'Obsidian',
      description: 'Deep rich-black surfaces with vivid cyan accents — high-contrast dark theme.',
      preferences: {
        paletteId: 'obsidian',
        typographyId: 'technical',
        surfaceEffectId: 'none',
        composerHoloId: 'on',
      },
    },
    slate: {
      id: 'slate',
      label: 'Slate',
      description: 'Blank-space reading surface — flat dark canvas, no ambient background effect, crisp ice-blue holo accents.',
      preferences: {
        paletteId: 'slate',
        typographyId: 'system',
        surfaceEffectId: 'none',
        composerHoloId: 'on',
      },
    },
    lexicon: {
      id: 'lexicon',
      label: 'Lexicon',
      description: 'Dark editorial palette with a quiet, text-forward chrome.',
      preferences: {
        paletteId: 'lexicon',
        typographyId: 'editorial',
        surfaceEffectId: 'none',
        composerHoloId: 'on',
      },
    },
    rocko: {
      id: 'rocko',
      label: 'Retro Teal',
      description: 'Teal + orange 90s palette with a bright, playful shell.',
      preferences: {
        paletteId: 'rocko',
        typographyId: 'system',
        surfaceEffectId: 'none',
        composerHoloId: 'on',
      },
    },
    'jenny-day': {
      id: 'jenny-day',
      label: 'Jenny XJ-9 — Daytime',
      description: 'Cool icy teal slate with Jenny-cyan brand and bold dark-teal ink — bright daytime mood with twinkling sparkles.',
      preferences: {
        paletteId: 'jenny-day',
        typographyId: 'system',
        surfaceEffectId: 'atomic-burst',
        composerHoloId: 'on',
      },
    },
    'jenny-night': {
      id: 'jenny-night',
      label: 'Jenny XJ-9 — Night Patrol',
      description: 'Magenta-led combat sky with violet undertones and circuit-trace HUD overlay.',
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

  function normalizeBinaryHoloId(value) {
    var token = String(value || '').trim().toLowerCase();
    return token === 'off' ? 'off' : 'on';
  }

  function normalizeAppearancePreferences(raw) {
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
      timelineStyleId: normalizePresetId(source.timelineStyleId, TIMELINE_STYLE_PRESETS, DEFAULT_APPEARANCE.timelineStyleId),
      fontScaleId: normalizePresetId(source.fontScaleId, FONT_SCALE_PRESETS, DEFAULT_APPEARANCE.fontScaleId),
      chatWidthId: normalizePresetId(source.chatWidthId, CHAT_WIDTH_PRESETS, DEFAULT_APPEARANCE.chatWidthId),
    };
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

  function getTimelineStylePresets() {
    return clonePresetCollection(TIMELINE_STYLE_PRESETS);
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
  // effect choices. They do not own fontScaleId, timelineStyleId, or
  // chatWidthId -- normalizeAppearancePreferences() fills every missing field
  // with DEFAULT_APPEARANCE's value regardless, so a naive "apply the bundle's
  // full normalized preferences" (or "compare every normalized field")
  // silently reset an Extra Large / non-default text size (and the timeline
  // style) back to Default on every bundle switch. Keep this list in sync
  // with what THEME_BUNDLES entries actually set.
  var THEME_BUNDLE_APPLY_AXES = [
    'paletteId',
    'typographyId',
    'surfaceEffectId',
    'composerHoloId',
  ];

  // Project a (possibly partial) preferences object down to only the
  // documented bundle axes, normalized. Used to APPLY a bundle (merge onto
  // -- never replace -- the caller's current preferences), so a bundle
  // switch never touches fontScaleId/timelineStyleId/chatWidthId (no bundle
  // defines any of them, but normalizeAppearancePreferences fills them
  // regardless).
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

  function removeCssVariables(target, variables) {
    if (!target || !target.style || typeof target.style.removeProperty !== 'function' || !variables) {
      return;
    }
    Object.keys(variables).forEach(function removeVariable(name) {
      target.style.removeProperty(name);
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
    var spriteHoloEnabled = normalized.paletteId === 'slate';
    rootElement.dataset.palette = normalized.paletteId;
    rootElement.dataset.typography = normalized.typographyId;
    rootElement.dataset.motion = 'standard';
    rootElement.dataset.surfaceEffect = normalized.surfaceEffectId;
    rootElement.dataset.composerHolo = normalized.composerHoloId;
    rootElement.dataset.spriteHolo = spriteHoloEnabled ? 'on' : 'off';
    rootElement.dataset.threadStyle = 'subtle';
    rootElement.dataset.timelineStyle = normalized.timelineStyleId;
    rootElement.dataset.fontScale = normalized.fontScaleId;
    rootElement.dataset.chatWidth = normalized.chatWidthId;
    if (typeof rootElement.style?.removeProperty === 'function') {
      LEGACY_THREAD_STYLE_VARIABLE_NAMES.forEach(function removeLegacyThreadVariable(name) {
        rootElement.style.removeProperty(name);
      });
    }
    applyCssVariables(rootElement, COMPOSER_HOLO_CSS_VARIABLES[normalized.composerHoloId]);
    if (spriteHoloEnabled) {
      removeCssVariables(rootElement, DISABLED_SPRITE_HOLO_CSS_VARIABLES);
    } else {
      applyCssVariables(rootElement, DISABLED_SPRITE_HOLO_CSS_VARIABLES);
    }
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
          var migrated = normalizeAppearancePreferences(JSON.parse(legacyRaw));
          try {
            storage.setItem(STORAGE_KEY, JSON.stringify(migrated));
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
      return normalizeAppearancePreferences(JSON.parse(raw));
    } catch (error) {
      return getDefaultAppearancePreferences();
    }
  }

  function saveAppearancePreferences(storage, preferences) {
    var normalized = normalizeAppearancePreferences(preferences);
    if (!storage || typeof storage.setItem !== 'function') {
      return normalized;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
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
    getPalettePresets: getPalettePresets,
    getSurfaceEffectPresets: getSurfaceEffectPresets,
    getThemeBundles: getThemeBundles,
    pickThemeBundleAxes: pickThemeBundleAxes,
    getTimelineStylePresets: getTimelineStylePresets,
    getTypographyPresets: getTypographyPresets,
    getFontScalePresets: getFontScalePresets,
    getChatWidthPresets: getChatWidthPresets,
    loadAppearancePreferences: loadAppearancePreferences,
    normalizeAppearancePreferences: normalizeAppearancePreferences,
    detectActiveThemeBundle: detectActiveThemeBundle,
    resolveThemeBundle: resolveThemeBundle,
    saveAppearancePreferences: saveAppearancePreferences,
  };
});
